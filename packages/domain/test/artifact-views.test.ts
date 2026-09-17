// ABOUTME: Exercises one-time artifact view grants bound to epoch, version, nonce, and expiry.
// ABOUTME: Synthetic available versions prove replay, revocation, expiry, and hash-only storage.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  artifactHash,
  createArtifactCommand,
  finalizeArtifactCommand,
  mintUploadGrantSecret,
  recordVerifiedUpload,
  redeemUploadGrant,
} from "../src/artifacts.js";
import {
  assertViewNonce,
  assertViewSecret,
  createViewGrantCommand,
  issueViewGrantResponse,
  mintViewGrantSecret,
  mintViewNonce,
  redeemViewGrant,
  viewSubject,
  VIEW_GRANT_TTL_MS,
  type ViewGrant,
} from "../src/artifact-views.js";
import { bumpMemberEpoch } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type CommandOutcome, type HubCommand } from "../src/hub.js";
import { randomUlid, syntheticUlid } from "../src/ids.js";
import { openDomainDb } from "./helpers.js";

const NOW = "2026-09-17T12:00:00.000Z";
const LATE = "2026-09-17T12:05:01.000Z";
const DIGEST = createHash("sha256").update("synthetic-artifact").digest("hex");
const SESSION_HASH = createHash("sha256").update("synthetic-session").digest("hex");

type Issued = ViewGrant & { secret: string };

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
  async function available(
    format = "html",
    now: string = NOW,
  ): Promise<{ version_id: string; content_hash: string }> {
    const minted = mintUploadGrantSecret();
    const created = result(
      await human(
        createArtifactCommand,
        {
          artifactId: null,
          runId: null,
          format: format as never,
          role: "review" as never,
          declaredSize: 18,
          expectedDigest: DIGEST,
          grantSecretHash: minted.secretHash,
        },
        { now },
      ),
    );
    await redeemUploadGrant(db, {
      grantId: created.upload_grant.grant_id,
      secret: minted.secret,
      now,
    });
    const key = `workspaces/${FIX.workspace}/artifacts/sha256/${DIGEST}`;
    await recordVerifiedUpload(db, {
      workspaceId: FIX.workspace,
      versionId: created.version_id,
      runId: null,
      role: "review",
      contentHash: DIGEST,
      r2Key: key,
      size: 18,
      now,
    });
    result(
      await human(
        finalizeArtifactCommand,
        { versionId: created.version_id, contentHash: DIGEST, size: 18 },
        { now },
      ),
    );
    return { version_id: created.version_id, content_hash: DIGEST };
  }
  async function issue(
    versionId: string,
    overrides: { humanId?: string; epoch?: number; now?: string } = {},
  ): Promise<Issued> {
    const minted = mintViewGrantSecret();
    const nonce = mintViewNonce();
    const grant = result(
      await human(
        createViewGrantCommand,
        {
          versionId,
          grantSecretHash: minted.secretHash,
          viewNonce: nonce,
          sessionHash: SESSION_HASH,
        },
        overrides,
      ),
    );
    return { ...issueViewGrantResponse(grant, minted.secret, nonce), secret: minted.secret };
  }
  return { db, hub, human, available, issue };
}

describe("artifact view grants", () => {
  it("mints channel-bound secrets and nonces with the documented shapes", () => {
    const minted = mintViewGrantSecret();
    expect(minted.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted.secretHash).toBe(artifactHash(minted.secret));
    expect(mintViewNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(assertViewSecret(minted.secret)).toBe(minted.secret);
    expect(assertViewNonce(mintViewNonce())).toMatch(/^[0-9a-f]{32}$/);
    expect(() => assertViewSecret("short")).toThrow();
    expect(() => assertViewSecret("has space in it 0123456789")).toThrow();
    expect(() => assertViewNonce("not-a-nonce")).toThrow();
    expect(() => assertViewNonce("z".repeat(32))).toThrow();
    expect(viewSubject("view:example")).toMatch(/^[0-9a-f]{64}$/);
    expect(VIEW_GRANT_TTL_MS).toBe(5 * 60_000);
  });

  it("issues a grant bound to epoch, exact version, nonce, and expiry", async () => {
    const { db, available, issue } = await fixture();
    const version = await available();
    const grant = await issue(version.version_id);
    expect(grant.version_id).toBe(version.version_id);
    expect(grant.content_hash).toBe(DIGEST);
    expect(grant.grant_hash).toBe(artifactHash(grant.secret));
    expect(Date.parse(grant.expires_at) - Date.parse(NOW)).toBe(VIEW_GRANT_TTL_MS);
    const row = (await db
      .prepare(`SELECT * FROM artifact_view_grants WHERE id = ?`)
      .get(grant.view_id)) as Record<string, unknown>;
    expect(row.grant_hash).toBe(artifactHash(grant.secret));
    expect(row.view_nonce_hash).toBe(artifactHash(grant.nonce));
    expect(row.human_id).toBe(FIX.owner);
    expect(row.session_hash).toBe(SESSION_HASH);
    expect(row.authorization_epoch).toBe(1);
    expect(row.content_hash).toBe(DIGEST);
    expect(row.consumed_at).toBeNull();
  });

  it("stores hashes only and audits the non-secret view ID", async () => {
    const { db, available, issue } = await fixture();
    const version = await available();
    const grant = await issue(version.version_id);
    const dump = JSON.stringify({
      grants: await db.prepare(`SELECT * FROM artifact_view_grants`).all(),
      audit: await db.prepare(`SELECT payload_json FROM artifact_audit_outbox`).all(),
      idempotency: await db.prepare(`SELECT result_json FROM idempotency_records`).all(),
      buckets: await db.prepare(`SELECT bucket_key FROM rate_limit_buckets`).all(),
    });
    expect(dump.includes(grant.secret)).toBe(false);
    expect(dump.includes(grant.nonce)).toBe(false);
    const audit = (await db
      .prepare(
        `SELECT action, payload_json FROM artifact_audit_outbox WHERE grant_id = ? ORDER BY created_at`,
      )
      .all(grant.view_id)) as Array<{ action: string; payload_json: string }>;
    expect(audit.map((entry) => entry.action)).toContain("artifact.view_issued");
    for (const entry of audit) {
      expect(entry.payload_json.includes(grant.secret)).toBe(false);
      expect(entry.payload_json.includes(grant.nonce)).toBe(false);
      expect(JSON.parse(entry.payload_json).view_id).toBe(grant.view_id);
    }
  });

  it("lets reviewers open previews but refuses uploading versions and bad inputs", async () => {
    const { human, available, issue } = await fixture();
    const version = await available();
    const reviewer = await issue(version.version_id, { humanId: FIX.restricted });
    expect(reviewer.version_id).toBe(version.version_id);
    const minted = mintViewGrantSecret();
    const input = {
      versionId: version.version_id,
      grantSecretHash: minted.secretHash,
      viewNonce: mintViewNonce(),
      sessionHash: SESSION_HASH,
    };
    expect(
      await failure(
        human(createViewGrantCommand, { ...input, versionId: syntheticUlid("NOVIEW") }),
      ),
    ).toBe("request_rejected");
    expect(await failure(human(createViewGrantCommand, { ...input, versionId: "bad" }))).toBe(
      "request_rejected",
    );
    expect(await failure(human(createViewGrantCommand, { ...input, grantSecretHash: "bad" }))).toBe(
      "request_rejected",
    );
    expect(await failure(human(createViewGrantCommand, { ...input, viewNonce: "bad" }))).toBe(
      "request_rejected",
    );
    expect(await failure(human(createViewGrantCommand, { ...input, sessionHash: "bad" }))).toBe(
      "request_rejected",
    );
    expect(await failure(human(createViewGrantCommand, { ...input, extra: true } as never))).toBe(
      "request_rejected",
    );
    expect(await failure(human(createViewGrantCommand, input, { epoch: 2 }))).toBe(
      "stale_authorization",
    );
  });

  it("refuses view grants for versions that are not available", async () => {
    const { db, human } = await fixture();
    const minted = mintUploadGrantSecret();
    const hub = new WorkspaceHub(db);
    const created = result(
      await hub.execute(createArtifactCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        now: NOW,
        idempotencyKey: randomUlid(),
        input: {
          artifactId: null,
          runId: null,
          format: "html" as never,
          role: "review" as never,
          declaredSize: 18,
          expectedDigest: DIGEST,
          grantSecretHash: minted.secretHash,
        },
      }),
    );
    const viewMinted = mintViewGrantSecret();
    expect(
      await failure(
        human(createViewGrantCommand, {
          versionId: created.version_id,
          grantSecretHash: viewMinted.secretHash,
          viewNonce: mintViewNonce(),
          sessionHash: SESSION_HASH,
        }),
      ),
    ).toBe("request_rejected");
  });

  it("redeems exactly once and gates bytes on the second attempt", async () => {
    const { db, available, issue } = await fixture();
    const version = await available();
    const grant = await issue(version.version_id);
    const redeemed = await redeemViewGrant(db, {
      viewId: grant.view_id,
      secret: grant.secret,
      nonce: grant.nonce,
      now: NOW,
    });
    expect(redeemed).toMatchObject({
      workspaceId: FIX.workspace,
      viewId: grant.view_id,
      versionId: version.version_id,
      contentHash: DIGEST,
      format: "html",
    });
    await expect(
      redeemViewGrant(db, {
        viewId: grant.view_id,
        secret: grant.secret,
        nonce: grant.nonce,
        now: NOW,
      }),
    ).rejects.toThrow();
    const row = (await db
      .prepare(`SELECT consumed_at FROM artifact_view_grants WHERE id = ?`)
      .get(grant.view_id)) as { consumed_at: string };
    expect(row.consumed_at).toBe(NOW);
  });

  it("rejects wrong secrets, wrong nonces, unknown views, and malformed shapes", async () => {
    const { db, available, issue } = await fixture();
    const version = await available();
    const grant = await issue(version.version_id);
    const cases: Array<{ viewId: string; secret: string; nonce: string }> = [
      { viewId: grant.view_id, secret: mintViewGrantSecret().secret, nonce: grant.nonce },
      { viewId: grant.view_id, secret: grant.secret, nonce: mintViewNonce() },
      { viewId: syntheticUlid("NOVIEW"), secret: grant.secret, nonce: grant.nonce },
      { viewId: grant.view_id, secret: "short", nonce: grant.nonce },
      { viewId: grant.view_id, secret: grant.secret, nonce: "not-a-nonce" },
      { viewId: "bad", secret: grant.secret, nonce: grant.nonce },
    ];
    for (const candidate of cases) {
      await expect(redeemViewGrant(db, { ...candidate, now: NOW })).rejects.toThrow();
    }
    // None of the failures consumed the grant, so the exact credential still redeems.
    const redeemed = await redeemViewGrant(db, {
      viewId: grant.view_id,
      secret: grant.secret,
      nonce: grant.nonce,
      now: NOW,
    });
    expect(redeemed.viewId).toBe(grant.view_id);
  });

  it("rejects expired grants and revoked epochs before bytes", async () => {
    const { db, available, issue } = await fixture();
    const version = await available();
    const expired = await issue(version.version_id);
    await expect(
      redeemViewGrant(db, {
        viewId: expired.view_id,
        secret: expired.secret,
        nonce: expired.nonce,
        now: LATE,
      }),
    ).rejects.toThrow();
    const live = await issue(version.version_id);
    await bumpMemberEpoch(db, FIX.workspace, FIX.owner);
    await expect(
      redeemViewGrant(db, {
        viewId: live.view_id,
        secret: live.secret,
        nonce: live.nonce,
        now: NOW,
      }),
    ).rejects.toThrow();
  });

  it("keeps view grants single-use and immutable through direct writes", async () => {
    const { db, available, issue } = await fixture();
    const version = await available();
    const grant = await issue(version.version_id);
    await expect(
      db
        .prepare(`UPDATE artifact_view_grants SET view_nonce_hash = ? WHERE id = ?`)
        .run(artifactHash(mintViewNonce()), grant.view_id),
    ).rejects.toThrow();
    await expect(
      db.prepare(`DELETE FROM artifact_view_grants WHERE id = ?`).run(grant.view_id),
    ).rejects.toThrow();
  });

  it("verifies the issued secret against the stored hash", async () => {
    const { available, issue } = await fixture();
    const version = await available();
    const grant = await issue(version.version_id);
    expect(issueViewGrantResponse(grant, grant.secret, grant.nonce).secret).toBe(grant.secret);
    expect(() =>
      issueViewGrantResponse(grant, mintViewGrantSecret().secret, grant.nonce),
    ).toThrow();
    expect(() => issueViewGrantResponse(grant, grant.secret, mintViewNonce())).not.toThrow();
  });
});
