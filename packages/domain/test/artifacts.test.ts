// ABOUTME: Exercises the artifact grant/upload/finalize state machine and recovery sweep.
// ABOUTME: Synthetic bytes prove replay, revocation, size, MIME, digest, and race fences.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_LOG_MAX_BYTES,
  ARTIFACT_REVIEW_MAX_BYTES,
  artifactHash,
  artifactObjectKey,
  artifactSubject,
  assertRoleKind,
  consumeArtifactBudget,
  createArtifactCommand,
  finalizeArtifactCommand,
  formatAllowsKind,
  issueArtifactGrantCommand,
  issueGrantResponse,
  markArtifactFailedCommand,
  mintUploadGrantSecret,
  recordVerifiedUpload,
  redeemUploadGrant,
  roleMaxBytes,
  sniffArtifactKind,
  sweepAbandonedArtifactUploads,
  type ArtifactFormat,
  type ArtifactRole,
  type CreateArtifactResult,
} from "../src/artifacts.js";
import { bumpMemberEpoch } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type CommandOutcome, type HubCommand } from "../src/hub.js";
import { randomUlid, syntheticUlid } from "../src/ids.js";
import { openDomainDb } from "./helpers.js";

const NOW = "2026-09-17T12:00:00.000Z";
const SWEEP = "2026-09-17T12:40:00.000Z";
const DIGEST = createHash("sha256").update("synthetic-artifact").digest("hex");

type Created = CreateArtifactResult & { secret: string };

function result<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error(outcome.error.code);
  return outcome.result;
}

async function failure(promise: Promise<CommandOutcome<unknown>>): Promise<string> {
  const outcome = await promise;
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected failure");
  return outcome.error.code;
}

async function fixture() {
  const db = await openDomainDb();
  const hub = new WorkspaceHub(db);
  function human<T, R>(
    command: HubCommand<T, R>,
    input: T,
    overrides: { humanId?: string; epoch?: number; now?: string; key?: string } = {},
  ) {
    return hub.execute(command, {
      workspaceId: FIX.workspace,
      actorHumanId: overrides.humanId ?? FIX.owner,
      authorizationEpoch: overrides.epoch ?? 1,
      now: overrides.now ?? NOW,
      idempotencyKey: overrides.key ?? randomUlid(),
      input,
    });
  }
  function createInput(overrides: Record<string, unknown> = {}) {
    return {
      artifactId: null,
      runId: null,
      format: "markdown" as ArtifactFormat,
      role: "review" as ArtifactRole,
      declaredSize: 18,
      expectedDigest: DIGEST,
      grantSecretHash: mintUploadGrantSecret().secretHash,
      ...overrides,
    };
  }
  async function create(
    overrides: Record<string, unknown> = {},
    exec: { now?: string } = {},
  ): Promise<Created> {
    const minted = mintUploadGrantSecret();
    const created = result(
      await human(
        createArtifactCommand,
        {
          ...createInput(),
          grantSecretHash: minted.secretHash,
          ...overrides,
        },
        exec,
      ),
    );
    return { ...created, secret: minted.secret };
  }
  return { db, hub, human, create, createInput };
}

describe("artifact state machine", () => {
  it("creates an uploading version plus a one-time grant bound to every dimension", async () => {
    const { db, create } = await fixture();
    const created = await create();
    expect(created.state).toBe("uploading");
    expect(created.upload_grant.grant_hash).toBe(artifactHash(created.secret));
    const grant = (await db
      .prepare(`SELECT * FROM artifact_upload_grants WHERE id = ?`)
      .get(created.upload_grant.grant_id)) as Record<string, unknown>;
    expect(grant.grant_hash).toBe(artifactHash(created.secret));
    expect(grant.authorization_epoch).toBe(1);
    expect(grant.declared_size).toBe(18);
    expect(grant.expected_digest).toBe(DIGEST);
    expect(grant.consumed_at).toBeNull();
    const version = (await db
      .prepare(`SELECT state, content_hash, r2_key FROM artifact_versions WHERE id = ?`)
      .get(created.version_id)) as Record<string, unknown>;
    expect(version).toMatchObject({ state: "uploading", content_hash: null, r2_key: null });
    const issued = issueGrantResponse(created.upload_grant, created.secret);
    expect(issued.secret).toBe(created.secret);
  });

  it("stores hashes only and never the plaintext secret", async () => {
    const { db, create } = await fixture();
    const created = await create();
    const dump = JSON.stringify({
      grants: await db.prepare(`SELECT * FROM artifact_upload_grants`).all(),
      versions: await db.prepare(`SELECT * FROM artifact_versions`).all(),
      audit: await db.prepare(`SELECT payload_json FROM artifact_audit_outbox`).all(),
      idempotency: await db.prepare(`SELECT result_json FROM idempotency_records`).all(),
      buckets: await db.prepare(`SELECT bucket_key FROM rate_limit_buckets`).all(),
    });
    expect(dump.includes(created.secret)).toBe(false);
  });

  it("rejects invalid format, role, size, digest, run, and reviewer authority", async () => {
    const { human, createInput } = await fixture();
    const attempt = (overrides: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      failure(human(createArtifactCommand, createInput(overrides), extra));
    expect(await attempt({ format: "exe" })).toBe("request_rejected");
    expect(await attempt({ role: "viewer" })).toBe("request_rejected");
    expect(await attempt({ declaredSize: 0 })).toBe("request_rejected");
    expect(await attempt({ declaredSize: ARTIFACT_REVIEW_MAX_BYTES + 1 })).toBe("request_rejected");
    expect(await attempt({ role: "log", declaredSize: ARTIFACT_LOG_MAX_BYTES + 1 })).toBe(
      "request_rejected",
    );
    expect(await attempt({ expectedDigest: "not-a-digest" })).toBe("request_rejected");
    expect(await attempt({ expectedDigest: "z".repeat(64) })).toBe("request_rejected");
    expect(await attempt({ grantSecretHash: "not-a-hash" })).toBe("request_rejected");
    expect(await attempt({ runId: syntheticUlid("NORUN") })).toBe("request_rejected");
    // Domain keeps honest authorization codes; the route layer maps every
    // failure to a uniform rejection so authority cannot be probed.
    expect(await attempt({}, { humanId: FIX.restricted })).toBe("forbidden");
    expect(await attempt({}, { epoch: 2 })).toBe("stale_authorization");
    expect(await attempt({ extraField: true })).toBe("request_rejected");
  });

  it("keeps format and role consistent across versions of one artifact", async () => {
    const { human, createInput, create } = await fixture();
    const first = await create({ format: "markdown", role: "review" });
    const second = await create({
      artifactId: first.artifact_id,
      format: "markdown",
      role: "review",
    });
    expect(second.artifact_id).toBe(first.artifact_id);
    expect(second.version_id).not.toBe(first.version_id);
    expect(
      await failure(
        human(createArtifactCommand, createInput({ artifactId: first.artifact_id, format: "html" })),
      ),
    ).toBe("request_rejected");
    expect(
      await failure(
        human(createArtifactCommand, createInput({ artifactId: syntheticUlid("NOART") })),
      ),
    ).toBe("request_rejected");
  });

  it("reissues grants for recovery but never for terminal versions", async () => {
    const { db, human, create } = await fixture();
    const created = await create();
    const minted = mintUploadGrantSecret();
    const reissued = result(
      await human(issueArtifactGrantCommand, {
        versionId: created.version_id,
        grantSecretHash: minted.secretHash,
      }),
    );
    expect(reissued.grant_id).not.toBe(created.upload_grant.grant_id);
    expect(reissued.grant_hash).toBe(minted.secretHash);
    await redeemUploadGrant(db, {
      grantId: created.upload_grant.grant_id,
      secret: created.secret,
      now: NOW,
    });
    await recordVerifiedUpload(db, {
      workspaceId: FIX.workspace,
      versionId: created.version_id,
      runId: null,
      role: "review",
      contentHash: DIGEST,
      r2Key: artifactObjectKey({
        workspaceId: FIX.workspace,
        role: "review",
        runId: null,
        versionId: created.version_id,
        contentHash: DIGEST,
      }),
      size: 18,
      now: NOW,
    });
    result(
      await human(finalizeArtifactCommand, {
        versionId: created.version_id,
        contentHash: DIGEST,
        size: 18,
      }),
    );
    const late = mintUploadGrantSecret();
    expect(
      await failure(
        human(issueArtifactGrantCommand, {
          versionId: created.version_id,
          grantSecretHash: late.secretHash,
        }),
      ),
    ).toBe("request_rejected");
  });

  it("rejects replay, wrong secrets, and expired grants", async () => {
    const { db, human, create } = await fixture();
    const created = await create();
    await redeemUploadGrant(db, {
      grantId: created.upload_grant.grant_id,
      secret: created.secret,
      now: NOW,
    });
    await expect(
      redeemUploadGrant(db, {
        grantId: created.upload_grant.grant_id,
        secret: created.secret,
        now: NOW,
      }),
    ).rejects.toThrow();
    await expect(
      redeemUploadGrant(db, {
        grantId: created.upload_grant.grant_id,
        secret: "wrong-secret-value-0123456789",
        now: NOW,
      }),
    ).rejects.toThrow();
    const aged = await create();
    await expect(
      redeemUploadGrant(db, {
        grantId: aged.upload_grant.grant_id,
        secret: aged.secret,
        now: "2026-09-17T12:16:01.000Z",
      }),
    ).rejects.toThrow();
    const minted = mintUploadGrantSecret();
    expect(
      await failure(
        human(issueArtifactGrantCommand, {
          versionId: "not-a-ulid",
          grantSecretHash: minted.secretHash,
        }),
      ),
    ).toBe("request_rejected");
  });

  it("rejects redemption after membership revocation", async () => {
    const { db, create } = await fixture();
    const created = await create();
    await bumpMemberEpoch(db, FIX.workspace, FIX.owner);
    await expect(
      redeemUploadGrant(db, {
        grantId: created.upload_grant.grant_id,
        secret: created.secret,
        now: NOW,
      }),
    ).rejects.toThrow();
  });

  it("finalizes only with a matching verified receipt and object", async () => {
    const { db, human, create } = await fixture();
    const created = await create();
    expect(
      await failure(
        human(finalizeArtifactCommand, {
          versionId: created.version_id,
          contentHash: DIGEST,
          size: 18,
        }),
      ),
    ).toBe("request_rejected");
    await redeemUploadGrant(db, {
      grantId: created.upload_grant.grant_id,
      secret: created.secret,
      now: NOW,
    });
    const key = artifactObjectKey({
      workspaceId: FIX.workspace,
      role: "review",
      runId: null,
      versionId: created.version_id,
      contentHash: DIGEST,
    });
    await expect(
      recordVerifiedUpload(db, {
        workspaceId: FIX.workspace,
        versionId: created.version_id,
        runId: null,
        role: "review",
        contentHash: DIGEST,
        r2Key: "workspaces/other/artifacts/sha256/" + DIGEST,
        size: 18,
        now: NOW,
      }),
    ).rejects.toThrow();
    await expect(
      recordVerifiedUpload(db, {
        workspaceId: FIX.workspace,
        versionId: created.version_id,
        runId: null,
        role: "review",
        contentHash: "b".repeat(64),
        r2Key: key,
        size: 18,
        now: NOW,
      }),
    ).rejects.toThrow();
    await recordVerifiedUpload(db, {
      workspaceId: FIX.workspace,
      versionId: created.version_id,
      runId: null,
      role: "review",
      contentHash: DIGEST,
      r2Key: key,
      size: 18,
      now: NOW,
    });
    const finalized = result(
      await human(finalizeArtifactCommand, {
        versionId: created.version_id,
        contentHash: DIGEST,
        size: 18,
      }),
    );
    expect(finalized.state).toBe("available");
    expect(finalized.r2_key).toBe(key);
    expect(
      await failure(
        human(finalizeArtifactCommand, {
          versionId: created.version_id,
          contentHash: DIGEST,
          size: 18,
        }),
      ),
    ).toBe("request_rejected");
  });

  it("lets distinct logical versions share one hash without overwriting", async () => {
    const { db, human, create } = await fixture();
    const first = await create();
    const second = await create();
    for (const created of [first, second]) {
      await redeemUploadGrant(db, {
        grantId: created.upload_grant.grant_id,
        secret: created.secret,
        now: NOW,
      });
      await recordVerifiedUpload(db, {
        workspaceId: FIX.workspace,
        versionId: created.version_id,
        runId: null,
        role: "review",
        contentHash: DIGEST,
        r2Key: artifactObjectKey({
          workspaceId: FIX.workspace,
          role: "review",
          runId: null,
          versionId: created.version_id,
          contentHash: DIGEST,
        }),
        size: 18,
        now: NOW,
      });
      result(
        await human(finalizeArtifactCommand, {
          versionId: created.version_id,
          contentHash: DIGEST,
          size: 18,
        }),
      );
    }
    const objects = (await db
      .prepare(`SELECT COUNT(*) AS count FROM artifact_objects WHERE content_hash = ?`)
      .get(DIGEST)) as { count: number };
    expect(objects.count).toBe(1);
    const available = (await db
      .prepare(`SELECT COUNT(*) AS count FROM artifact_versions WHERE state = 'available'`)
      .get()) as { count: number };
    expect(available.count).toBe(2);
  });

  it("marks abandoned rows failed and leaves terminal history alone", async () => {
    const { db, human, create } = await fixture();
    const created = await create();
    const failed = result(
      await human(markArtifactFailedCommand, { versionId: created.version_id }),
    );
    expect(failed.state).toBe("failed");
    expect(await failure(human(markArtifactFailedCommand, { versionId: created.version_id }))).toBe(
      "request_rejected",
    );
    const minted = mintUploadGrantSecret();
    expect(
      await failure(
        human(issueArtifactGrantCommand, {
          versionId: created.version_id,
          grantSecretHash: minted.secretHash,
        }),
      ),
    ).toBe("request_rejected");
    const marked = await sweepAbandonedArtifactUploads(db, SWEEP);
    expect(marked).toEqual([]);
  });

  it("sweeps only uploading versions whose grants all expired past grace", async () => {
    const { db, hub, human, create } = await fixture();
    const stale = await create();
    const fresh = await create({}, { now: "2026-09-17T12:39:00.000Z" });
    const marked = await sweepAbandonedArtifactUploads(db, SWEEP);
    expect(marked).toEqual([stale.version_id]);
    const states = (await db
      .prepare(`SELECT id, state FROM artifact_versions ORDER BY created_at`)
      .all()) as Array<{ id: string; state: string }>;
    expect(states.find((row) => row.id === stale.version_id)?.state).toBe("failed");
    expect(states.find((row) => row.id === fresh.version_id)?.state).toBe("uploading");
    const system = await hub.execute(markArtifactFailedCommand, {
      workspaceId: FIX.workspace,
      actorSystemId: syntheticUlid("CRON"),
      authorizationEpoch: 1,
      now: SWEEP,
      idempotencyKey: randomUlid(),
      input: { versionId: fresh.version_id },
    });
    expect(system.ok).toBe(true);
    expect(await failure(human(markArtifactFailedCommand, { versionId: stale.version_id }))).toBe(
      "request_rejected",
    );
  });

  it("enforces database immutability guards on versions, grants, and objects", async () => {
    const { db, create } = await fixture();
    const created = await create();
    await expect(
      db
        .prepare(`UPDATE artifact_versions SET state = 'available' WHERE id = ?`)
        .run(created.version_id),
    ).rejects.toThrow();
    await expect(
      db.prepare(`DELETE FROM artifact_versions WHERE id = ?`).run(created.version_id),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(`UPDATE artifact_upload_grants SET human_id = ? WHERE id = ?`)
        .run(FIX.member, created.upload_grant.grant_id),
    ).rejects.toThrow();
    await redeemUploadGrant(db, {
      grantId: created.upload_grant.grant_id,
      secret: created.secret,
      now: NOW,
    });
    await expect(
      db
        .prepare(`UPDATE artifact_upload_grants SET consumed_at = NULL WHERE id = ?`)
        .run(created.upload_grant.grant_id),
    ).rejects.toThrow();
    await db
      .prepare(
        `INSERT INTO artifact_objects (content_hash, r2_key, size, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(DIGEST, "workspaces/w/artifacts/sha256/" + DIGEST, 18, NOW);
    await expect(
      db.prepare(`DELETE FROM artifact_objects WHERE content_hash = ?`).run(DIGEST),
    ).rejects.toThrow();
  });

  it("sniffs formats, binds MIME, and restricts log chunks to compressed bytes", () => {
    expect(sniffArtifactKind(new TextEncoder().encode("# synthetic\n"))).toBe("text");
    expect(sniffArtifactKind(new TextEncoder().encode('{"synthetic":true}'))).toBe("json");
    expect(sniffArtifactKind(new TextEncoder().encode('<svg viewBox="0 0 1 1"></svg>'))).toBe(
      "svg",
    );
    expect(sniffArtifactKind(new TextEncoder().encode("<!doctype html><html></html>"))).toBe(
      "html",
    );
    expect(
      sniffArtifactKind(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])),
    ).toBe("png");
    expect(sniffArtifactKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("jpeg");
    expect(sniffArtifactKind(Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]))).toBe("zstd");
    expect(sniffArtifactKind(Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]))).toBe("gzip");
    expect(sniffArtifactKind(Uint8Array.from([0x00, 0x01, 0x02, 0xff]))).toBe("unknown");
    expect(formatAllowsKind("markdown", "text")).toBe(true);
    expect(formatAllowsKind("markdown", "html")).toBe(false);
    expect(formatAllowsKind("png", "png")).toBe(true);
    expect(formatAllowsKind("png", "jpeg")).toBe(false);
    expect(formatAllowsKind("html", "text")).toBe(false);
    expect(formatAllowsKind("log", "zstd")).toBe(true);
    expect(formatAllowsKind("log", "png")).toBe(false);
    expect(() => assertRoleKind("log", "text")).toThrow();
    assertRoleKind("log", "zstd");
    assertRoleKind("review", "text");
  });

  it("derives workspace-prefixed keys without caller input", () => {
    expect(
      artifactObjectKey({
        workspaceId: FIX.workspace,
        role: "review",
        runId: null,
        versionId: "v",
        contentHash: DIGEST,
      }),
    ).toBe(`workspaces/${FIX.workspace}/artifacts/sha256/${DIGEST}`);
    const runId = syntheticUlid("RUN");
    expect(
      artifactObjectKey({
        workspaceId: FIX.workspace,
        role: "log",
        runId,
        versionId: "v",
        contentHash: DIGEST,
      }),
    ).toBe(`workspaces/${FIX.workspace}/runs/${runId}/logs/v.jsonl.zst`);
  });

  it("keeps abuse budgets durable, hashed, and bounded", async () => {
    const { db } = await fixture();
    const seeds = {
      ipSeed: artifactHash("ip-seed"),
      subjectSeed: artifactHash("subject-seed"),
    };
    const subject = artifactSubject("synthetic-principal");
    for (let index = 0; index < 20; index += 1) {
      expect(
        await consumeArtifactBudget(db, {
          ...seeds,
          surface: "artifact:grant-create",
          subject,
          activity: "attempt",
          now: NOW,
        }),
      ).toBe(true);
    }
    expect(
      await consumeArtifactBudget(db, {
        ...seeds,
        surface: "artifact:grant-create",
        subject,
        activity: "attempt",
        now: NOW,
      }),
    ).toBe(false);
    // The shared per-IP budget stays exhausted, but a fresh IP gets its own budget.
    expect(
      await consumeArtifactBudget(db, {
        ipSeed: artifactHash("other-ip-seed"),
        subjectSeed: artifactHash("subject-seed"),
        surface: "artifact:grant-create",
        subject: artifactSubject("other-principal"),
        activity: "attempt",
        now: NOW,
      }),
    ).toBe(true);
    const buckets = (await db
      .prepare(`SELECT bucket_key FROM rate_limit_buckets`)
      .all()) as Array<{ bucket_key: string }>;
    expect(buckets.length).toBeGreaterThan(0);
    for (const bucket of buckets) expect(bucket.bucket_key).toMatch(/^[0-9a-f]{64}$/);
    expect(mintUploadGrantSecret().secret).not.toBe(mintUploadGrantSecret().secret);
    expect(roleMaxBytes("review")).toBe(ARTIFACT_REVIEW_MAX_BYTES);
    expect(roleMaxBytes("log")).toBe(ARTIFACT_LOG_MAX_BYTES);
  });
});
