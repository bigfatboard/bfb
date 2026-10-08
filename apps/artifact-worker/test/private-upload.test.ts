// ABOUTME: Proves private upload receipt effects require current contribution after byte awaits.
// ABOUTME: Mounted fake R2 and request-body interleavings never disclose rejected artifact metadata.

import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "@bfb/db";
import {
  artifactHash,
  bumpMemberEpoch,
  createArtifactCommand,
  FIX,
  loadPrincipal,
  mintUploadGrantSecret,
  randomUlid,
  redeemUploadGrant,
  type RedeemedGrant,
  type VerifiedUpload,
  WorkspaceHub,
} from "@bfb/domain";
import { openDomainDb } from "../../../packages/domain/test/helpers.js";
import { createArtifactFetchHandler } from "../src/index.js";

const ORIGIN = "https://artifacts.bfb.example.test";
const TEXT = "SYNTHETIC_PRIVATE_UPLOAD_BYTES";
const BYTES = new TextEncoder().encode(TEXT);
const DIGEST = artifactHash(BYTES);

async function fixture() {
  const db = await openDomainDb(),
    taskId = randomUlid(),
    runId = randomUlid(),
    taskGrantId = randomUlid();
  const { now } = (await db
    .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
    .get()) as { now: string };
  await db
    .prepare(
      `INSERT INTO tasks
    (workspace_id,id,project_id,title,state,priority,next_owner_type,punchline,resource_version,created_by_human_id,created_at)
    VALUES (?,?,?,'Synthetic private upload task','ready','P2','unassigned','Synthetic',1,?,?)`,
    )
    .run(FIX.workspace, taskId, FIX.projectA, FIX.member, now);
  await db
    .prepare(
      `INSERT INTO runs
    (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,resource_version,created_at)
    VALUES (?,?,?,?,?,?,'open','unknown',1,?)`,
    )
    .run(FIX.workspace, runId, FIX.projectA, taskId, FIX.member, FIX.profileCodex, now);
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, taskId, FIX.member, now);
  await db
    .prepare(
      `INSERT INTO task_human_grants
    (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'contribute',?)`,
    )
    .run(FIX.workspace, taskGrantId, taskId, FIX.owner, now);
  const minted = mintUploadGrantSecret(),
    outcome = await new WorkspaceHub(db).execute(createArtifactCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now,
      idempotencyKey: randomUlid(),
      input: {
        runId,
        format: "markdown",
        role: "review",
        declaredSize: BYTES.length,
        expectedDigest: DIGEST,
        grantSecretHash: minted.secretHash,
      },
    });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  const created = outcome.result,
    hooks: { put?: () => Promise<void>; body?: () => Promise<void> } = {};
  let puts = 0;
  const bucket = {
    async put() {
      puts++;
      await hooks.put?.();
      return { key: "synthetic" };
    },
  } as unknown as R2Bucket;
  const revoke = async () => {
    await db.prepare("UPDATE task_human_grants SET revoked_at=? WHERE id=?").run(now, taskGrantId);
  };
  const upload = async (uploadDb: SqlDatabase = db) => {
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          await hooks.body?.();
          controller.enqueue(BYTES);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    return createArtifactFetchHandler({ db: uploadDb, now })(
      new Request(`${ORIGIN}/upload/${created.upload_grant.grant_id}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${minted.secret}`,
          "cf-connecting-ip": "192.0.2.78",
        },
        body,
        duplex: "half",
      } as RequestInit),
      {
        ARTIFACTS: bucket,
        DB: {} as D1Database,
        ARTIFACT_ORIGIN: ORIGIN,
        APP_ORIGIN: "https://bfb.example.test",
        ENVIRONMENT: "local",
        ARTIFACT_VIEWER_ENABLED: "true",
        UPLOAD_ABUSE_SECRET: "synthetic-private-upload-abuse-secret-71aa90xx",
      },
    );
  };
  return { db, now, created, taskId, runId, taskGrantId, hooks, revoke, upload, puts: () => puts };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function canonicalSnapshot(db: SqlDatabase): Promise<Record<string, unknown[]>> {
  const snapshot: Record<string, unknown[]> = {};
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) {
    if (
      name.startsWith("sqlite_") ||
      name.startsWith("_cf_") ||
      ["d1_migrations", "rate_limit_buckets"].includes(name)
    )
      continue;
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    snapshot[name] = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return snapshot;
}

function afterReceiptCommit(
  f: Fixture,
  mutation: (consumed: RedeemedGrant, receipt: VerifiedUpload) => Promise<void>,
) {
  let receiptCommits = 0;
  let mutationCompleted = false;
  let consumed: RedeemedGrant | undefined;
  let postMutation: Record<string, unknown[]> | undefined;
  const db: SqlDatabase = {
    prepare: (sql) => f.db.prepare(sql),
    async withTransaction(operation) {
      let recordedReceipt = false;
      let recordedConsume = false;
      const result = await f.db.withTransaction((tx) =>
        operation({
          prepare(sql) {
            const statement = tx.prepare(sql);
            return {
              get: (...parameters) => statement.get(...parameters),
              all: (...parameters) => statement.all(...parameters),
              async run(...parameters) {
                const value = await statement.run(...parameters);
                if (sql.includes("INSERT INTO artifact_upload_receipts")) recordedReceipt = true;
                if (sql.includes("INSERT INTO artifact_upload_consumptions"))
                  recordedConsume = true;
                return value;
              },
            };
          },
          withTransaction: (nested) => tx.withTransaction(nested),
        }),
      );
      if (recordedConsume) consumed = result as RedeemedGrant;
      if (recordedReceipt) {
        // The original adapter has committed before this independent mutation.
        // Reads from its outer handle prove this is withholding, not rollback.
        receiptCommits++;
        expect(consumed).toBeDefined();
        const committed = await canonicalSnapshot(f.db);
        expect(committed.artifact_objects).toHaveLength(1);
        expect(committed.artifact_upload_receipts).toHaveLength(1);
        expect(committed.artifact_upload_receipt_sources).toHaveLength(1);
        expect(
          committed.artifact_audit_outbox?.filter(
            (row) => (row as { action: string }).action === "artifact.upload_verified",
          ),
        ).toHaveLength(1);
        await mutation(consumed!, result as VerifiedUpload);
        mutationCompleted = true;
        postMutation = await canonicalSnapshot(f.db);
        // Independent authority changes or retained-result substitution must not
        // undo or manufacture any of the already verified publication effects.
        for (const table of [
          "artifact_objects",
          "artifact_upload_receipts",
          "artifact_upload_receipt_sources",
          "artifact_audit_outbox",
        ])
          expect(postMutation[table]).toEqual(committed[table]);
        expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      }
      return result;
    },
  };
  return {
    db,
    async assertCommitted() {
      expect(receiptCommits).toBe(1);
      expect(mutationCompleted).toBe(true);
      expect(await canonicalSnapshot(f.db)).toEqual(postMutation);
      expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(f.puts()).toBe(1);
      expect(
        await f.db
          .prepare("SELECT state FROM artifact_versions WHERE id=?")
          .get(f.created.version_id),
      ).toEqual({ state: "uploading" });
    },
  };
}

async function expectWithheld(response: Response, f: Fixture) {
  const text = await response.text();
  expect(response.status).toBe(403);
  expect(JSON.parse(text)).toEqual({ error: "request_rejected", message: "request rejected" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("etag")).toBeNull();
  for (const retained of [
    TEXT,
    DIGEST,
    FIX.workspace,
    f.created.version_id,
    f.created.artifact_id,
    f.created.upload_grant.grant_id,
    `workspaces/${FIX.workspace}/artifacts/sha256/${DIGEST}`,
  ])
    expect(text).not.toContain(retained);
}

describe("private upload receipt delivery", () => {
  it("records verified bytes while contribution remains current", async () => {
    const f = await fixture(),
      response = await f.upload();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version_id: f.created.version_id,
      content_hash: DIGEST,
    });
    expect(
      await f.db.prepare("SELECT COUNT(*) AS total FROM artifact_upload_receipt_sources").get(),
    ).toEqual({ total: 1 });
    expect(
      await f.db
        .prepare("SELECT state FROM artifact_versions WHERE id=?")
        .get(f.created.version_id),
    ).toEqual({ state: "uploading" });
  });
  it.each(["before", "body", "put"] as const)(
    "denies contribution revoke at %s without receipt or metadata",
    async (timing) => {
      const f = await fixture();
      if (timing === "before") await f.revoke();
      else f.hooks[timing] = f.revoke;
      const response = await f.upload(),
        text = await response.text();
      expect(response.status).toBe(timing === "before" ? 403 : 409);
      expect(JSON.parse(text)).toEqual(
        timing === "before"
          ? { error: "request_rejected", message: "request rejected" }
          : { error: "upload_conflict" },
      );
      for (const privateValue of [
        TEXT,
        DIGEST,
        f.created.version_id,
        f.created.artifact_id,
        FIX.workspace,
      ])
        expect(text).not.toContain(privateValue);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("etag")).toBeNull();
      expect(f.puts()).toBe(timing === "before" ? 0 : 1);
      for (const table of [
        "artifact_objects",
        "artifact_upload_receipts",
        "artifact_upload_receipt_sources",
      ])
        expect(await f.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
      expect(
        await f.db
          .prepare("SELECT * FROM artifact_audit_outbox WHERE action='artifact.upload_verified'")
          .all(),
      ).toEqual([]);
      expect(
        await f.db
          .prepare("SELECT state FROM artifact_versions WHERE id=?")
          .get(f.created.version_id),
      ).toEqual({ state: "uploading" });
    },
  );
  it("withholds receipt metadata after contribution is revoked following its committed transaction", async () => {
    const f = await fixture();
    const cut = afterReceiptCommit(f, async () => {
      await f.revoke();
      expect(
        await f.db
          .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.taskGrantId),
      ).toEqual({ revoked_at: f.now });
    });
    const response = await f.upload(cut.db);
    await cut.assertCommitted();
    await expectWithheld(response, f);
  });
  it.each(["epoch", "role", "contribute_to_read", "project"] as const)(
    "withholds committed receipt metadata after independent %s loss",
    async (kind) => {
      const f = await fixture();
      if (kind === "project") {
        await f.db
          .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
          .run(FIX.workspace, FIX.projectA);
        expect((await loadPrincipal(f.db, FIX.workspace, FIX.owner)).projectIds).toContain(
          FIX.projectA,
        );
      }
      const cut = afterReceiptCommit(f, async () => {
        if (kind === "epoch") {
          expect(await bumpMemberEpoch(f.db, FIX.workspace, FIX.owner)).toBe(2);
          expect((await loadPrincipal(f.db, FIX.workspace, FIX.owner)).authorizationEpoch).toBe(2);
        } else if (kind === "role") {
          await f.db
            .prepare(
              "UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.member);
          await f.db
            .prepare(
              "UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.owner);
          expect((await loadPrincipal(f.db, FIX.workspace, FIX.owner)).role).toBe("reviewer");
        } else if (kind === "contribute_to_read") {
          await f.revoke();
          const readGrant = randomUlid();
          await f.db
            .prepare(
              `INSERT INTO task_human_grants
            (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
            VALUES (?,?,?,?,1,'read',?)`,
            )
            .run(FIX.workspace, readGrant, f.taskId, FIX.owner, f.now);
          expect(
            await f.db
              .prepare(
                "SELECT permission,revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?",
              )
              .get(FIX.workspace, readGrant),
          ).toEqual({ permission: "read", revoked_at: null });
          expect(
            await f.db
              .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
              .get(FIX.workspace, f.taskGrantId),
          ).toEqual({ revoked_at: f.now });
        } else {
          await f.db
            .prepare(
              "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.projectA, FIX.owner);
          expect((await loadPrincipal(f.db, FIX.workspace, FIX.owner)).projectIds).not.toContain(
            FIX.projectA,
          );
        }
      });
      const response = await f.upload(cut.db);
      await cut.assertCommitted();
      await expectWithheld(response, f);
    },
  );
  it("retains the consume-time project ceiling despite a newly readable moved parent", async () => {
    const f = await fixture();
    await f.db
      .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id IN (?,?)")
      .run(FIX.workspace, FIX.projectA, FIX.projectB);
    await f.db
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .run(FIX.workspace, FIX.projectB, FIX.owner);
    expect((await loadPrincipal(f.db, FIX.workspace, FIX.owner)).projectIds).toEqual([
      FIX.projectA,
    ]);
    const cut = afterReceiptCommit(f, async (consumed, receipt) => {
      expect(consumed.humanProjectIds).toEqual([FIX.projectA]);
      // Synthetic task/run relocation is FK-clean, not a product move command.
      // A fresh B principal can read it; the retained A ceiling cannot widen.
      await f.db.withTransaction(async (tx) => {
        await tx.prepare("PRAGMA defer_foreign_keys=ON").run();
        await tx
          .prepare("UPDATE tasks SET project_id=? WHERE workspace_id=? AND id=?")
          .run(FIX.projectB, FIX.workspace, f.taskId);
        await tx
          .prepare("UPDATE runs SET project_id=? WHERE workspace_id=? AND id=?")
          .run(FIX.projectB, FIX.workspace, f.runId);
        await tx
          .prepare(
            "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
          )
          .run(FIX.workspace, FIX.projectA, FIX.owner);
        await tx
          .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
          .run(FIX.workspace, FIX.projectB, FIX.owner);
      });
      const fresh = await loadPrincipal(f.db, FIX.workspace, FIX.owner);
      expect(fresh.projectIds).toEqual([FIX.projectB]);
      const { assertHumanUploadDelivery } = await import("@bfb/domain");
      await expect(
        assertHumanUploadDelivery(
          f.db,
          { ...consumed, humanProjectIds: fresh.projectIds },
          receipt,
        ),
      ).resolves.toBeUndefined();
    });
    const response = await f.upload(cut.db);
    await cut.assertCommitted();
    await expectWithheld(response, f);
  });
  it("rejects a substituted retained consume attempt while canonical history stays unchanged", async () => {
    const f = await fixture();
    const mint = mintUploadGrantSecret();
    const created = await new WorkspaceHub(f.db).execute(createArtifactCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: f.now,
      idempotencyKey: randomUlid(),
      input: {
        runId: f.runId,
        format: "markdown",
        role: "review",
        declaredSize: BYTES.length,
        expectedDigest: DIGEST,
        grantSecretHash: mint.secretHash,
      },
    });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const otherConsume = await f.db.withTransaction((tx) =>
      redeemUploadGrant(tx, {
        grantId: created.result.upload_grant.grant_id,
        secret: mint.secret,
        now: f.now,
      }),
    );
    const cut = afterReceiptCommit(f, async (consumed) => {
      expect(consumed.consumeAttemptId).not.toBe(otherConsume.consumeAttemptId);
      const before = await canonicalSnapshot(f.db);
      // Retained-result substitution robustness, not a reachable row mutation
      // or authority race: every immutable source and claim remains untouched.
      consumed.consumeAttemptId = otherConsume.consumeAttemptId;
      expect(await canonicalSnapshot(f.db)).toEqual(before);
    });
    const response = await f.upload(cut.db);
    await cut.assertCommitted();
    await expectWithheld(response, f);
  });
});
