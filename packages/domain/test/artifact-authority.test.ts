// ABOUTME: Proves artifact publication and redemption use current project and human authority.
// ABOUTME: Staged D1 races exercise exact one-time consumption and complete batch rollback.

import Database from "better-sqlite3";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  adaptBetterSqlite3,
  adaptD1,
  applyMigrationsForVerification,
  type D1Like,
  type D1StatementLike,
} from "@bfb/db";

import {
  ARTIFACT_ABANDON_GRACE_MS,
  ARTIFACT_GRANT_TTL_MS,
  ARTIFACT_RECOVERY_SYSTEM_ID,
  artifactHash,
  artifactObjectKey,
  createArtifactCommand,
  finalizeArtifactCommand,
  issueArtifactGrantCommand,
  listAbandonedArtifactUploads,
  markArtifactFailedCommand,
  mintUploadGrantSecret,
  recordVerifiedUpload,
  redeemUploadGrant,
} from "../src/artifacts.js";
import { FIX, seedSyntheticWorkspace } from "../src/fixtures.js";
import { WorkspaceHub, type HubCommand } from "../src/hub.js";
import { randomUlid, syntheticUlid } from "../src/ids.js";
import {
  createViewGrantCommand,
  mintViewGrantSecret,
  mintViewNonce,
  redeemViewGrant,
} from "../src/artifact-views.js";

const NOW = "2026-10-06T12:00:00.000Z";
const DIGEST = artifactHash("synthetic artifact authority");

interface StagedStatement extends D1StatementLike {
  sql: string;
  params: unknown[];
}

function stagedDatabase(raw: Database.Database, beforeBatch?: () => Promise<void>) {
  const d1: D1Like = {
    prepare(sql) {
      const statement: StagedStatement = {
        sql,
        params: [],
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async first() {
          return raw.prepare(sql).get(...statement.params) ?? null;
        },
        async all() {
          return { results: raw.prepare(sql).all(...statement.params) };
        },
        async run() {
          return { meta: { changes: raw.prepare(sql).run(...statement.params).changes } };
        },
      };
      return statement;
    },
    async batch(statements) {
      await beforeBatch?.();
      return raw.transaction(() =>
        (statements as StagedStatement[]).map((statement) => ({
          meta: { changes: raw.prepare(statement.sql).run(...statement.params).changes },
        })),
      )();
    },
  };
  return adaptD1(d1);
}

async function fixture() {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  applyMigrationsForVerification(raw, path.resolve("migrations/d1"));
  const db = adaptBetterSqlite3(raw);
  await seedSyntheticWorkspace(db, NOW);
  const hub = new WorkspaceHub(db);
  const taskId = randomUlid();
  const runId = randomUlid();
  raw
    .prepare(
      `INSERT INTO tasks (workspace_id, id, project_id, title, state, priority,
      next_owner_type, punchline, resource_version, created_by_human_id, created_at)
     VALUES (?, ?, ?, 'Synthetic', 'ready', 'P2', 'unassigned', 'Synthetic', 1, ?, ?)`,
    )
    .run(FIX.workspace, taskId, FIX.projectA, FIX.owner, NOW);
  raw
    .prepare(
      `INSERT INTO runs (workspace_id, id, project_id, task_id, requested_by_human_id,
      agent_profile_id, result_state, activity, resource_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', 'unknown', 1, ?)`,
    )
    .run(FIX.workspace, runId, FIX.projectA, taskId, FIX.owner, FIX.profileCodex, NOW);
  function human<I, R>(
    command: HubCommand<I, R>,
    input: I,
    humanId = FIX.owner,
    key = randomUlid(),
  ) {
    return hub.execute(command, {
      workspaceId: FIX.workspace,
      actorHumanId: humanId,
      authorizationEpoch: 1,
      idempotencyKey: key,
      now: NOW,
      input,
    });
  }
  async function create(boundRun: string | null = runId, humanId = FIX.owner) {
    const minted = mintUploadGrantSecret();
    const outcome = await human(
      createArtifactCommand,
      {
        runId: boundRun,
        format: "markdown",
        role: "review",
        declaredSize: 18,
        expectedDigest: DIGEST,
        grantSecretHash: minted.secretHash,
      },
      humanId,
    );
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    return { ...outcome.result, secret: minted.secret };
  }
  function removeProject() {
    raw
      .prepare(
        "DELETE FROM project_access WHERE workspace_id = ? AND project_id = ? AND human_id = ?",
      )
      .run(FIX.workspace, FIX.projectA, FIX.member);
  }
  async function receipt(created: Awaited<ReturnType<typeof create>>) {
    const redeemed = await db.withTransaction((tx) =>
      redeemUploadGrant(tx, {
        grantId: created.upload_grant.grant_id,
        secret: created.secret,
        now: NOW,
      }),
    );
    await db.withTransaction((tx) =>
      recordVerifiedUpload(tx, {
        grantId: redeemed.grantId,
        consumeAttemptId: redeemed.consumeAttemptId,
        contentHash: DIGEST,
        size: 18,
        now: NOW,
      }),
    );
  }
  return { raw, db, hub, runId, human, create, removeProject, receipt };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

/** Migration drills seed the historical schema rather than executing current policy commands. */
function seedHistoricalUpload(raw: Database.Database, grantHash: string) {
  const artifactId = randomUlid(),
    versionId = randomUlid(),
    grantId = randomUlid();
  raw
    .prepare(
      `INSERT INTO artifacts
    (workspace_id,id,run_id,format,role,created_by_human_id,created_at)
    VALUES (?,?,NULL,'markdown','review',?,?)`,
    )
    .run(FIX.workspace, artifactId, FIX.owner, NOW);
  raw
    .prepare(
      `INSERT INTO artifact_versions
    (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,content_hash,r2_key,created_at,available_at)
    VALUES (?,?,?,'uploading','markdown',18,?,NULL,NULL,?,NULL)`,
    )
    .run(FIX.workspace, versionId, artifactId, DIGEST, NOW);
  raw
    .prepare(
      `INSERT INTO artifact_upload_grants
    (workspace_id,id,version_id,grant_hash,human_id,authorization_epoch,run_id,format,declared_size,expected_digest,expires_at,consumed_at,created_at)
    VALUES (?,?,?,?,?,1,NULL,'markdown',18,?,?,NULL,?)`,
    )
    .run(
      FIX.workspace,
      grantId,
      versionId,
      grantHash,
      FIX.owner,
      DIGEST,
      new Date(Date.parse(NOW) + ARTIFACT_GRANT_TTL_MS).toISOString(),
      NOW,
    );
  return { version_id: versionId, upload_grant: { grant_id: grantId } };
}

describe("current artifact authority", () => {
  it("requires the exact recovery actor and fresh expiry grace before system abandonment", async () => {
    const f = await fixture();
    const created = await f.create();
    async function recover(actor = syntheticUlid("ARTIFACTRECOVERY"), epoch = 1) {
      return f.hub.execute(markArtifactFailedCommand, {
        workspaceId: FIX.workspace,
        actorSystemId: actor,
        authorizationEpoch: epoch,
        idempotencyKey: randomUlid(),
        now: "2099-01-01T00:00:00.000Z",
        input: { versionId: created.version_id },
      });
    }
    expect(await recover()).toMatchObject({ ok: false, error: { code: "request_rejected" } });
    vi.setSystemTime(Date.parse(NOW) + ARTIFACT_GRANT_TTL_MS + ARTIFACT_ABANDON_GRACE_MS);
    expect(await recover(syntheticUlid("OTHERCRON"))).toMatchObject({
      ok: false,
      error: { code: "request_rejected" },
    });
    expect(await recover(syntheticUlid("ARTIFACTRECOVERY"), 2)).toMatchObject({
      ok: false,
      error: { code: "request_rejected" },
    });
    expect(await recover()).toMatchObject({ ok: true, result: { state: "failed" } });
  });

  it("preserves a stale recovery candidate while a reissued grant remains inside grace", async () => {
    const f = await fixture();
    const created = await f.create();
    vi.setSystemTime(Date.parse(NOW) + ARTIFACT_GRANT_TTL_MS + ARTIFACT_ABANDON_GRACE_MS);
    const minted = mintUploadGrantSecret();
    const regrant = await f.human(issueArtifactGrantCommand, {
      versionId: created.version_id,
      grantSecretHash: minted.secretHash,
    });
    expect(regrant, JSON.stringify(regrant)).toMatchObject({ ok: true });
    const request = {
      workspaceId: FIX.workspace,
      actorSystemId: syntheticUlid("ARTIFACTRECOVERY"),
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: { versionId: created.version_id },
    };
    vi.setSystemTime(Date.parse(NOW) + 2 * ARTIFACT_GRANT_TTL_MS + ARTIFACT_ABANDON_GRACE_MS + 1);
    expect(await f.hub.execute(markArtifactFailedCommand, request)).toMatchObject({
      ok: false,
      error: { code: "request_rejected" },
    });
    vi.setSystemTime(Date.parse(NOW) + 2 * (ARTIFACT_GRANT_TTL_MS + ARTIFACT_ABANDON_GRACE_MS));
    expect(await f.hub.execute(markArtifactFailedCommand, request)).toMatchObject({ ok: true });
  });

  it.each(["regrant", "consume", "finalize"] as const)(
    "rolls back abandonment after a commit-time %s",
    async (change) => {
      const f = await fixture();
      const created = await f.create();
      await f.receipt(created);
      vi.setSystemTime(Date.parse(NOW) + ARTIFACT_GRANT_TTL_MS + ARTIFACT_ABANDON_GRACE_MS);
      const now = new Date().toISOString();
      let injected = false;
      const hub = new WorkspaceHub(
        stagedDatabase(f.raw, async () => {
          if (injected) return;
          injected = true;
          if (change === "regrant" || change === "consume") {
            const grantId = randomUlid();
            const minted = mintUploadGrantSecret();
            f.raw
              .prepare(
                `INSERT INTO artifact_upload_grants
          (workspace_id,id,version_id,grant_hash,human_id,authorization_epoch,run_id,format,
           declared_size,expected_digest,expires_at,consumed_at,created_at)
          SELECT workspace_id, ?, version_id, ?, human_id, authorization_epoch, run_id, format,
           declared_size,expected_digest, ?, NULL, ? FROM artifact_upload_grants WHERE id = ?`,
              )
              .run(
                grantId,
                minted.secretHash,
                new Date(Date.now() + ARTIFACT_GRANT_TTL_MS).toISOString(),
                now,
                created.upload_grant.grant_id,
              );
            if (change === "consume")
              await f.db.withTransaction((tx) =>
                redeemUploadGrant(tx, {
                  grantId,
                  secret: minted.secret,
                  now,
                }),
              );
          } else {
            f.raw
              .prepare(
                `UPDATE artifact_versions SET state='available', content_hash=?, r2_key=?, available_at=?
          WHERE id=?`,
              )
              .run(
                DIGEST,
                artifactObjectKey({
                  workspaceId: FIX.workspace,
                  role: "review",
                  runId: f.runId,
                  versionId: created.version_id,
                  contentHash: DIGEST,
                }),
                now,
                created.version_id,
              );
          }
        }),
      );
      const outcome = await hub.execute(markArtifactFailedCommand, {
        workspaceId: FIX.workspace,
        actorSystemId: ARTIFACT_RECOVERY_SYSTEM_ID,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: { versionId: created.version_id },
      });
      expect(outcome.ok).toBe(false);
      expect(
        f.raw.prepare(`SELECT state FROM artifact_versions WHERE id=?`).get(created.version_id),
      ).toEqual({ state: change === "finalize" ? "available" : "uploading" });
      expect(
        f.raw
          .prepare(`SELECT COUNT(*) n FROM artifact_audit_outbox WHERE action='artifact.abandoned'`)
          .get(),
      ).toEqual({ n: 0 });
    },
  );

  it("retains a fresh consumed grant until its expiry plus grace", async () => {
    const f = await fixture();
    const created = await f.create();
    vi.setSystemTime(Date.parse(NOW) + ARTIFACT_GRANT_TTL_MS + ARTIFACT_ABANDON_GRACE_MS);
    const minted = mintUploadGrantSecret();
    const reissued = await f.human(issueArtifactGrantCommand, {
      versionId: created.version_id,
      grantSecretHash: minted.secretHash,
    });
    if (!reissued.ok) throw new Error(JSON.stringify(reissued));
    await f.db.withTransaction((tx) =>
      redeemUploadGrant(tx, {
        grantId: reissued.result.grant_id,
        secret: minted.secret,
        now: new Date().toISOString(),
      }),
    );
    expect(await listAbandonedArtifactUploads(f.db, new Date().toISOString())).toEqual([]);
    const outcome = await f.hub.execute(markArtifactFailedCommand, {
      workspaceId: FIX.workspace,
      actorSystemId: ARTIFACT_RECOVERY_SYSTEM_ID,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: { versionId: created.version_id },
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: "request_rejected" } });
  });

  it("bounds read-only recovery selection and leaves candidates unchanged", async () => {
    const f = await fixture();
    await f.create();
    await f.create();
    vi.setSystemTime(Date.parse(NOW) + ARTIFACT_GRANT_TTL_MS + ARTIFACT_ABANDON_GRACE_MS);
    const now = new Date().toISOString();
    expect(await listAbandonedArtifactUploads(f.db, now, { limit: 1 })).toHaveLength(1);
    expect(
      f.raw.prepare(`SELECT COUNT(*) n FROM artifact_versions WHERE state='uploading'`).get(),
    ).toEqual({ n: 2 });
    await expect(listAbandonedArtifactUploads(f.db, now, { limit: 101 })).rejects.toThrow();
    await expect(listAbandonedArtifactUploads(f.db, now, { limit: 0 })).rejects.toThrow();
  });

  it.each(["create", "issue", "finalize", "fail"] as const)(
    "rejects restricted-project %s without a mutation",
    async (action) => {
      const f = await fixture();
      const created = await f.create();
      await f.receipt(created);
      f.removeProject();
      const before = f.raw.prepare("SELECT COUNT(*) n FROM artifact_audit_outbox").get();
      const minted = mintUploadGrantSecret();
      const input = { versionId: created.version_id };
      const outcome =
        action === "create"
          ? await f.human(
              createArtifactCommand,
              {
                runId: f.runId,
                format: "markdown",
                role: "review",
                declaredSize: 18,
                expectedDigest: DIGEST,
                grantSecretHash: minted.secretHash,
              },
              FIX.member,
            )
          : action === "issue"
            ? await f.human(
                issueArtifactGrantCommand,
                { ...input, grantSecretHash: minted.secretHash },
                FIX.member,
              )
            : action === "finalize"
              ? await f.human(
                  finalizeArtifactCommand,
                  { ...input, contentHash: DIGEST, size: 18 },
                  FIX.member,
                )
              : await f.human(markArtifactFailedCommand, input, FIX.member);
      expect(outcome).toMatchObject({ ok: false, error: { code: "request_rejected" } });
      expect(f.raw.prepare("SELECT COUNT(*) n FROM artifact_audit_outbox").get()).toEqual(before);
      expect(
        f.raw.prepare("SELECT state FROM artifact_versions WHERE id = ?").get(created.version_id),
      ).toEqual({ state: "uploading" });
    },
  );

  it.each(["project", "role", "membership", "epoch"] as const)(
    "denies grant redemption after current %s changes",
    async (change) => {
      const f = await fixture();
      const created = await f.create(f.runId, FIX.member);
      if (change === "project") f.removeProject();
      if (change === "role")
        f.raw
          .prepare("UPDATE workspace_members SET role = 'reviewer' WHERE human_id = ?")
          .run(FIX.member);
      if (change === "membership")
        f.raw
          .prepare("UPDATE workspace_authorization_epochs SET revoked_at = ? WHERE human_id = ?")
          .run(NOW, FIX.member);
      if (change === "epoch")
        f.raw
          .prepare(
            "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE human_id = ?",
          )
          .run(FIX.member);
      await expect(
        f.db.withTransaction((tx) =>
          redeemUploadGrant(tx, {
            grantId: created.upload_grant.grant_id,
            secret: created.secret,
            now: NOW,
          }),
        ),
      ).rejects.toThrow();
      expect(
        f.raw
          .prepare("SELECT consumed_at FROM artifact_upload_grants WHERE id = ?")
          .get(created.upload_grant.grant_id),
      ).toEqual({ consumed_at: null });
      expect(
        f.raw
          .prepare(
            "SELECT COUNT(*) n FROM artifact_audit_outbox WHERE action = 'artifact.grant_consumed'",
          )
          .get(),
      ).toEqual({ n: 0 });
    },
  );

  it("preserves run-free member publication and current workspace-visible project access", async () => {
    const f = await fixture();
    f.removeProject();
    expect((await f.create(null, FIX.member)).state).toBe("uploading");
    f.raw.prepare("UPDATE projects SET access_mode = 'workspace' WHERE id = ?").run(FIX.projectA);
    const created = await f.create(f.runId, FIX.member);
    const redeemed = await f.db.withTransaction((tx) =>
      redeemUploadGrant(tx, {
        grantId: created.upload_grant.grant_id,
        secret: created.secret,
        now: NOW,
      }),
    );
    expect(redeemed.runId).toBe(f.runId);
  });
});

describe("exact upload consumption", () => {
  it("retains populated 0041 grants without inventing historical consumption identities", async () => {
    const raw = new Database(":memory:");
    applyMigrationsForVerification(raw, path.resolve("migrations/d1"), {
      stopBeforeId: "0042_artifact_upload_consumptions",
    });
    const db = adaptBetterSqlite3(raw);
    await seedSyntheticWorkspace(db, NOW);
    const minted = mintUploadGrantSecret();
    const created = seedHistoricalUpload(raw, minted.secretHash);
    raw
      .prepare("UPDATE artifact_upload_grants SET consumed_at = ? WHERE id = ?")
      .run(NOW, created.upload_grant.grant_id);
    const before = raw.prepare("SELECT * FROM artifact_upload_grants").all();
    applyMigrationsForVerification(raw, path.resolve("migrations/d1"));
    expect(raw.prepare("SELECT * FROM artifact_upload_grants").all()).toEqual(before);
    expect(raw.prepare("SELECT COUNT(*) n FROM artifact_upload_consumptions").get()).toEqual({
      n: 0,
    });
    await expect(
      db.withTransaction((tx) =>
        redeemUploadGrant(tx, {
          grantId: created.upload_grant.grant_id,
          secret: minted.secret,
          now: NOW,
        }),
      ),
    ).rejects.toThrow();
    expect(raw.prepare("SELECT COUNT(*) n FROM artifact_upload_consumptions").get()).toEqual({
      n: 0,
    });
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rolls back consumption and claim if its late audit insert fails", async () => {
    const f = await fixture();
    const created = await f.create();
    f.raw.exec(
      "CREATE TRIGGER synthetic_consume_audit_failure BEFORE INSERT ON artifact_audit_outbox WHEN NEW.action = 'artifact.grant_consumed' BEGIN SELECT RAISE(ABORT, 'synthetic late batch failure'); END",
    );
    const db = stagedDatabase(f.raw);
    await expect(
      db.withTransaction((tx) =>
        redeemUploadGrant(tx, {
          grantId: created.upload_grant.grant_id,
          secret: created.secret,
          now: NOW,
        }),
      ),
    ).rejects.toThrow();
    expect(
      f.raw
        .prepare("SELECT consumed_at FROM artifact_upload_grants WHERE id = ?")
        .get(created.upload_grant.grant_id),
    ).toEqual({ consumed_at: null });
    expect(f.raw.prepare("SELECT COUNT(*) n FROM artifact_upload_consumptions").get()).toEqual({
      n: 0,
    });
    f.raw.exec("DROP TRIGGER synthetic_consume_audit_failure");
    await db.withTransaction((tx) =>
      redeemUploadGrant(tx, {
        grantId: created.upload_grant.grant_id,
        secret: created.secret,
        now: NOW,
      }),
    );
    const claim = f.raw.prepare("SELECT * FROM artifact_upload_consumptions").get() as Record<
      string,
      unknown
    >;
    expect(claim.attempt_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(() =>
      f.raw.prepare("UPDATE artifact_upload_consumptions SET consumed_at = ?").run(NOW),
    ).toThrow();
    expect(() => f.raw.prepare("DELETE FROM artifact_upload_consumptions").run()).toThrow();
  });

  it("allows only one staged same-timestamp attempt and one consume audit", async () => {
    const f = await fixture();
    const created = await f.create();
    let batches = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db = stagedDatabase(f.raw, async () => {
      if (++batches === 2) release();
      await barrier;
    });
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        db.withTransaction((tx) =>
          redeemUploadGrant(tx, {
            grantId: created.upload_grant.grant_id,
            secret: created.secret,
            now: NOW,
          }),
        ),
      ),
    );
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(f.raw.prepare("SELECT COUNT(*) n FROM artifact_upload_consumptions").get()).toEqual({
      n: 1,
    });
    expect(
      f.raw
        .prepare(
          "SELECT COUNT(*) n FROM artifact_audit_outbox WHERE action = 'artifact.grant_consumed'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it("allows only one staged view redemption when both attempts share the same clock", async () => {
    const f = await fixture();
    const created = await f.create();
    await f.receipt(created);
    const finalized = await f.human(finalizeArtifactCommand, {
      versionId: created.version_id,
      contentHash: DIGEST,
      size: 18,
    });
    expect(finalized.ok).toBe(true);
    const minted = mintViewGrantSecret();
    const nonce = mintViewNonce();
    const issued = await f.human(createViewGrantCommand, {
      versionId: created.version_id,
      grantSecretHash: minted.secretHash,
      viewNonce: nonce,
      sessionHash: artifactHash("synthetic view session"),
    });
    if (!issued.ok) throw new Error(issued.error.code);
    let batches = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db = stagedDatabase(f.raw, async () => {
      if (++batches === 2) release();
      await barrier;
    });
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        db.withTransaction((tx) =>
          redeemViewGrant(tx, {
            viewId: issued.result.view_id,
            secret: minted.secret,
            nonce,
            now: NOW,
          }),
        ),
      ),
    );
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(
      f.raw
        .prepare(
          "SELECT COUNT(*) n FROM artifact_audit_outbox WHERE action = 'artifact.view_redeemed'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(f.raw.prepare("SELECT COUNT(*) n FROM artifact_mutation_guards").get()).toEqual({
      n: 0,
    });
    expect(f.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each(["project", "role", "membership", "epoch", "version"] as const)(
    "rolls back its claim and audit when %s changes before the D1 commit",
    async (change) => {
      const f = await fixture();
      const created = await f.create(f.runId, FIX.member);
      const db = stagedDatabase(f.raw, async () => {
        if (change === "project") f.removeProject();
        if (change === "role")
          f.raw
            .prepare("UPDATE workspace_members SET role = 'reviewer' WHERE human_id = ?")
            .run(FIX.member);
        if (change === "membership")
          f.raw
            .prepare("UPDATE workspace_authorization_epochs SET revoked_at = ? WHERE human_id = ?")
            .run(NOW, FIX.member);
        if (change === "epoch")
          f.raw
            .prepare(
              "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE human_id = ?",
            )
            .run(FIX.member);
        if (change === "version")
          f.raw
            .prepare("UPDATE artifact_versions SET state = 'failed' WHERE id = ?")
            .run(created.version_id);
      });
      await expect(
        db.withTransaction((tx) =>
          redeemUploadGrant(tx, {
            grantId: created.upload_grant.grant_id,
            secret: created.secret,
            now: NOW,
          }),
        ),
      ).rejects.toThrow();
      expect(
        f.raw
          .prepare("SELECT consumed_at FROM artifact_upload_grants WHERE id = ?")
          .get(created.upload_grant.grant_id),
      ).toEqual({ consumed_at: null });
      expect(f.raw.prepare("SELECT COUNT(*) n FROM artifact_upload_consumptions").get()).toEqual({
        n: 0,
      });
      expect(
        f.raw
          .prepare(
            "SELECT COUNT(*) n FROM artifact_audit_outbox WHERE action = 'artifact.grant_consumed'",
          )
          .get(),
      ).toEqual({ n: 0 });
    },
  );
});

describe("consume-bound physical receipts", () => {
  async function consumed(f: Awaited<ReturnType<typeof fixture>>) {
    const created = await f.create();
    const redeemed = await f.db.withTransaction((tx) =>
      redeemUploadGrant(tx, {
        grantId: created.upload_grant.grant_id,
        secret: created.secret,
        now: NOW,
      }),
    );
    return {
      created,
      input: {
        grantId: redeemed.grantId,
        consumeAttemptId: redeemed.consumeAttemptId,
        contentHash: DIGEST,
        size: 18,
        now: NOW,
      },
    };
  }

  it("derives exact scope/key and preserves one immutable verification source across retries", async () => {
    const f = await fixture();
    const { created, input } = await consumed(f);
    const first = await f.db.withTransaction((tx) => recordVerifiedUpload(tx, input));
    expect(first).toMatchObject({
      workspaceId: FIX.workspace,
      versionId: created.version_id,
      r2Key: artifactObjectKey({
        workspaceId: FIX.workspace,
        role: "review",
        runId: f.runId,
        versionId: created.version_id,
        contentHash: DIGEST,
      }),
      deduplicated: false,
    });
    await f.db.withTransaction((tx) => recordVerifiedUpload(tx, input));
    expect(
      f.raw
        .prepare("SELECT version_id,grant_id,attempt_id FROM artifact_upload_receipt_sources")
        .all(),
    ).toEqual([
      {
        version_id: created.version_id,
        grant_id: input.grantId,
        attempt_id: input.consumeAttemptId,
      },
    ]);
    expect(
      f.raw
        .prepare(
          "SELECT COUNT(*) n FROM artifact_audit_outbox WHERE action='artifact.upload_verified'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(() =>
      f.raw.prepare("UPDATE artifact_upload_receipt_sources SET grant_id=?").run(randomUlid()),
    ).toThrow();
    expect(() => f.raw.prepare("DELETE FROM artifact_upload_receipt_sources").run()).toThrow();
  });

  it.each(["grant", "attempt", "digest", "size", "caller_scope"] as const)(
    "rejects substituted %s without object/receipt/source writes",
    async (field) => {
      const f = await fixture();
      const { input } = await consumed(f);
      const other = await consumed(f);
      const changed =
        field === "grant"
          ? { ...input, grantId: other.input.grantId }
          : field === "attempt"
            ? { ...input, consumeAttemptId: other.input.consumeAttemptId }
            : field === "digest"
              ? { ...input, contentHash: "b".repeat(64) }
              : field === "size"
                ? { ...input, size: 19 }
                : { ...input, workspaceId: FIX.workspace };
      await expect(
        f.db.withTransaction((tx) => recordVerifiedUpload(tx, changed)),
      ).rejects.toThrow();
      for (const table of [
        "artifact_objects",
        "artifact_upload_receipts",
        "artifact_upload_receipt_sources",
      ])
        expect(f.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    },
  );

  it("rejects unconsumed grants and retains legacy receipts without invented source backfill", async () => {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    applyMigrationsForVerification(raw, path.resolve("migrations/d1"), {
      stopBeforeId: "0043_agent_artifact_publications",
    });
    const db = adaptBetterSqlite3(raw);
    await seedSyntheticWorkspace(db, NOW);
    const mint = mintUploadGrantSecret();
    const created = seedHistoricalUpload(raw, mint.secretHash);
    raw
      .prepare("INSERT INTO artifact_upload_receipts VALUES (?,?,?,?,?)")
      .run(FIX.workspace, created.version_id, DIGEST, 18, NOW);
    const before = raw.prepare("SELECT * FROM artifact_upload_receipts").all();
    applyMigrationsForVerification(raw, path.resolve("migrations/d1"));
    expect(raw.prepare("SELECT * FROM artifact_upload_receipts").all()).toEqual(before);
    expect(raw.prepare("SELECT * FROM artifact_upload_receipt_sources").all()).toEqual([]);
    await expect(
      db.withTransaction((tx) =>
        recordVerifiedUpload(tx, {
          grantId: created.upload_grant.grant_id,
          consumeAttemptId: randomUlid(),
          contentHash: DIGEST,
          size: 18,
          now: NOW,
        }),
      ),
    ).rejects.toThrow();
    expect(raw.prepare("SELECT * FROM artifact_upload_receipt_sources").all()).toEqual([]);
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects new verified receipt effects after membership changes without granting finalization", async () => {
    const f = await fixture();
    const { created, input } = await consumed(f);
    f.raw
      .prepare("UPDATE workspace_authorization_epochs SET revoked_at=? WHERE human_id=?")
      .run(NOW, FIX.owner);
    await expect(f.db.withTransaction((tx) => recordVerifiedUpload(tx, input))).rejects.toThrow();
    expect(f.raw.prepare("SELECT * FROM artifact_upload_receipts").all()).toEqual([]);
    expect(f.raw.prepare("SELECT * FROM artifact_upload_receipt_sources").all()).toEqual([]);
    expect(
      await f.human(finalizeArtifactCommand, {
        versionId: created.version_id,
        contentHash: DIGEST,
        size: 18,
      }),
    ).toMatchObject({ ok: false });
    expect(
      f.raw.prepare("SELECT state FROM artifact_versions WHERE id=?").get(created.version_id),
    ).toEqual({ state: "uploading" });
  });

  it.each(["failed", "late_audit"] as const)(
    "rolls back the complete staged receipt batch after %s",
    async (change) => {
      const f = await fixture();
      const { created, input } = await consumed(f);
      const db = stagedDatabase(f.raw, async () => {
        if (change === "failed")
          f.raw
            .prepare("UPDATE artifact_versions SET state='failed' WHERE id=?")
            .run(created.version_id);
      });
      if (change === "late_audit")
        f.raw.exec(
          "CREATE TRIGGER synthetic_receipt_fault BEFORE INSERT ON artifact_audit_outbox WHEN NEW.action='artifact.upload_verified' BEGIN SELECT RAISE(ABORT,'synthetic late receipt failure'); END",
        );
      await expect(db.withTransaction((tx) => recordVerifiedUpload(tx, input))).rejects.toThrow();
      for (const table of [
        "artifact_objects",
        "artifact_upload_receipts",
        "artifact_upload_receipt_sources",
        "artifact_mutation_guards",
      ])
        expect(f.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
      expect(
        f.raw
          .prepare(
            "SELECT COUNT(*) n FROM artifact_audit_outbox WHERE action='artifact.upload_verified'",
          )
          .get(),
      ).toEqual({ n: 0 });
    },
  );

  it("converges two staged consumed grants to one receipt source and verification outbox", async () => {
    const f = await fixture();
    const { created, input } = await consumed(f);
    const mint = mintUploadGrantSecret();
    const issued = await f.human(issueArtifactGrantCommand, {
      versionId: created.version_id,
      grantSecretHash: mint.secretHash,
    });
    if (!issued.ok) throw new Error(JSON.stringify(issued));
    const second = await f.db.withTransaction((tx) =>
      redeemUploadGrant(tx, { grantId: issued.result.grant_id, secret: mint.secret, now: NOW }),
    );
    let batches = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db = stagedDatabase(f.raw, async () => {
      if (++batches === 2) release();
      await barrier;
    });
    const outcomes = await Promise.all(
      [input, { ...input, grantId: second.grantId, consumeAttemptId: second.consumeAttemptId }].map(
        (request) => db.withTransaction((tx) => recordVerifiedUpload(tx, request)),
      ),
    );
    expect(outcomes).toHaveLength(2);
    for (const table of [
      "artifact_objects",
      "artifact_upload_receipts",
      "artifact_upload_receipt_sources",
    ])
      expect(f.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 1 });
    expect(
      f.raw
        .prepare(
          "SELECT COUNT(*) n FROM artifact_audit_outbox WHERE action='artifact.upload_verified'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(f.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
