// ABOUTME: Exercises delegated artifact authority at the staged D1 commit boundary.
// ABOUTME: Genuine upload receipts and competing finalization prove atomic rollback without rewriting immutable history.

import { setTimeout as delay } from "node:timers/promises";

import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ARTIFACT_GRANT_TTL_MS,
  artifactHash,
  artifactObjectKey,
  mintUploadGrantSecret,
  recordVerifiedUpload,
  redeemUploadGrant,
} from "../src/artifacts.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import {
  createDelegatedArtifactCommand,
  finalizeDelegatedArtifactCommand,
  type CreateDelegatedArtifactResult,
} from "../src/remote-parity.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createRunCommand } from "../src/work-records.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";
import { resultStagedD1 } from "./result-fixture.js";

const BYTES = Buffer.from("SYNTHETIC-DELEGATED-ARTIFACT-COMMIT");
const DIGEST = artifactHash(BYTES);
const SIZE = BYTES.byteLength;
const EFFECT_TABLES = [
  "artifacts",
  "artifact_versions",
  "artifact_upload_grants",
  "artifact_upload_receipts",
  "artifact_objects",
  "artifact_audit_outbox",
  "semantic_events",
  "audit_events",
  "outbox_records",
  "idempotency_records",
] as const;
type Operation = "new_create" | "existing_create" | "finalize";

beforeEach(() => {
  vi.useRealTimers();
});

async function fixture(expiry = "+1 hour") {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db),
    owner = { workspaceId: FIX.workspace, actorHumanId: FIX.owner, authorizationEpoch: 1 };
  const task = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title: "Synthetic artifact commit task", priority: "P2" },
    }),
  );
  const otherTask = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: {
        projectId: FIX.projectA,
        title: "Synthetic unrelated artifact task",
        priority: "P2",
      },
    }),
  );
  const run = success(
    await hub.execute(createRunCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: {
        taskId: task.id,
        expectedTaskVersion: 1,
        agentProfileId: FIX.profileCodex,
        workspacePolicyVersion: 1,
        projectPolicyVersion: 1,
        repositoryConfigVersion: 1,
        agentProfileVersion: 1,
      },
    }),
  );
  const clock = (await db
    .prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS observed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at",
    )
    .get(expiry)) as { observed_at: string; expires_at: string };
  const delegationId = randomUlid();
  // A write-only delegation is sufficient: the repair must not add a read-scope requirement.
  await db
    .prepare(
      `INSERT INTO oauth_delegations
       (workspace_id,id,human_id,client_id,resource,project_id,task_id,scopes_json,
        authorization_epoch,expires_at,created_at)
       VALUES (?,?,?,?,'https://bfb.example.test/mcp',?,?,?,1,?,?)`,
    )
    .run(
      FIX.workspace,
      delegationId,
      FIX.member,
      FIX.client,
      FIX.projectA,
      task.id,
      JSON.stringify(["bfb:task:write"]),
      clock.expires_at,
      clock.observed_at,
    );
  return {
    db,
    hub,
    taskId: task.id,
    otherTaskId: otherTask.id,
    runId: run.run.id,
    delegationId,
    ...clock,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function request(f: Fixture, key = randomUlid()) {
  return {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.member,
    actorDelegationId: f.delegationId,
    authorizationEpoch: 1,
    idempotencyKey: key,
    // Caller time cannot replace the Hub's retained preparation observation.
    now: "2025-01-01T00:00:00.000Z",
  };
}

function createInput(f: Fixture, secretHash: string, artifactId?: string) {
  return {
    ...(artifactId === undefined ? {} : { artifactId }),
    runId: f.runId,
    format: "markdown" as const,
    role: "review" as const,
    declaredSize: SIZE,
    expectedDigest: DIGEST,
    grantSecretHash: secretHash,
  };
}

async function upload(f: Fixture) {
  const minted = mintUploadGrantSecret();
  const created = success(
    await f.hub.execute(createDelegatedArtifactCommand, {
      ...request(f),
      input: createInput(f, minted.secretHash),
    }),
  );
  const consumed = await redeemUploadGrant(f.db, {
    grantId: created.upload_grant.grant_id,
    secret: minted.secret,
    now: new Date().toISOString(),
  });
  await f.db.withTransaction((tx) =>
    recordVerifiedUpload(tx, {
      grantId: consumed.grantId,
      consumeAttemptId: consumed.consumeAttemptId,
      contentHash: DIGEST,
      size: SIZE,
      now: new Date().toISOString(),
    }),
  );
  return { created, secret: minted.secret };
}

async function effects(f: Fixture) {
  const rows: Record<string, unknown[]> = {};
  for (const table of EFFECT_TABLES)
    rows[table] = await f.db
      .prepare(`SELECT * FROM ${table} WHERE workspace_id=? ORDER BY rowid`)
      .all(FIX.workspace);
  return {
    rows,
    cursor: (await f.db
      .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
      .get(FIX.workspace)) as { cursor: number },
    guards: await f.db.prepare("SELECT * FROM artifact_mutation_guards ORDER BY id").all(),
    task: await f.db
      .prepare("SELECT * FROM tasks WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.taskId),
    run: await f.db
      .prepare("SELECT * FROM runs WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.runId),
  };
}

async function verifiedSource(f: Fixture, created: CreateDelegatedArtifactResult) {
  const key = artifactObjectKey({
    workspaceId: FIX.workspace,
    role: "review",
    runId: f.runId,
    versionId: created.version_id,
    contentHash: DIGEST,
  });
  const tuple = await f.db
    .prepare(
      `SELECT version.workspace_id,version.id AS version_id,version.artifact_id,
        version.state,version.format AS version_format,version.declared_size,version.expected_digest,
        artifact.run_id,artifact.format AS artifact_format,artifact.role,
        run.task_id,run.purpose,task.project_id
       FROM artifact_versions AS version
       JOIN artifacts AS artifact ON artifact.workspace_id=version.workspace_id AND artifact.id=version.artifact_id
       JOIN runs AS run ON run.workspace_id=artifact.workspace_id AND run.id=artifact.run_id
       JOIN tasks AS task ON task.workspace_id=run.workspace_id AND task.id=run.task_id
       WHERE version.workspace_id=? AND version.id=?`,
    )
    .get(FIX.workspace, created.version_id);
  expect(tuple).toEqual({
    workspace_id: FIX.workspace,
    version_id: created.version_id,
    artifact_id: created.artifact_id,
    state: "uploading",
    version_format: "markdown",
    declared_size: SIZE,
    expected_digest: DIGEST,
    run_id: f.runId,
    artifact_format: "markdown",
    role: "review",
    task_id: f.taskId,
    purpose: "work",
    project_id: FIX.projectA,
  });
  const receipt = await f.db
    .prepare("SELECT * FROM artifact_upload_receipts WHERE workspace_id=? AND version_id=?")
    .get(FIX.workspace, created.version_id);
  const object = await f.db
    .prepare("SELECT * FROM artifact_objects WHERE workspace_id=? AND r2_key=?")
    .get(FIX.workspace, key);
  expect(receipt).toMatchObject({ content_hash: DIGEST, size: SIZE });
  expect(object).toMatchObject({ content_hash: DIGEST, size: SIZE, r2_key: key });
  expect(
    await f.db
      .prepare("SELECT consumed_at FROM artifact_upload_grants WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, created.upload_grant.grant_id),
  ).toMatchObject({ consumed_at: expect.any(String) });
  return { tuple, receipt, object };
}

function observePreparation(db: SqlDatabase, observe: (at: string) => void): SqlDatabase {
  return {
    ...db,
    withTransaction(work) {
      return db.withTransaction((tx) =>
        work({
          ...tx,
          prepare(sql) {
            const statement = tx.prepare(sql);
            return {
              ...statement,
              run(...parameters) {
                const at = sql.includes("INSERT INTO artifact_versions")
                  ? parameters.at(-1)
                  : /UPDATE artifact_versions\s+SET state = 'available'/.test(sql)
                    ? parameters[2]
                    : undefined;
                if (at !== undefined) {
                  expect(typeof at).toBe("string");
                  observe(at as string);
                }
                return statement.run(...parameters);
              },
            };
          },
        }),
      );
    },
  };
}

async function execute(
  f: Fixture,
  hub: WorkspaceHub,
  operation: Operation,
  key: string,
  secretHash: string,
  created?: CreateDelegatedArtifactResult,
) {
  if (operation === "finalize") {
    if (!created) throw new Error("Verified source required");
    return hub.execute(finalizeDelegatedArtifactCommand, {
      ...request(f, key),
      input: { versionId: created.version_id, contentHash: DIGEST, size: SIZE },
    });
  }
  return hub.execute(createDelegatedArtifactCommand, {
    ...request(f, key),
    input: createInput(
      f,
      secretHash,
      operation === "existing_create" ? created?.artifact_id : undefined,
    ),
  });
}

async function privateContribution(f: Fixture) {
  await f.db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, f.taskId, FIX.owner, f.observed_at);
  return grant(f, "contribute");
}

async function grant(f: Fixture, permission: "read" | "contribute") {
  const id = randomUlid();
  await f.db
    .prepare(
      `INSERT INTO task_human_grants
       (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
       VALUES (?,?,?,?,1,?,?)`,
    )
    .run(FIX.workspace, id, f.taskId, FIX.member, permission, new Date().toISOString());
  return id;
}

async function revokeGrant(f: Fixture, id: string) {
  await f.db
    .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
    .run(new Date().toISOString(), FIX.workspace, id);
}

async function clockWitness(f: Fixture) {
  return (await f.db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS database_now,
        julianday(expires_at)>julianday('now') AS live
       FROM oauth_delegations WHERE workspace_id=? AND id=?`,
    )
    .get(FIX.workspace, f.delegationId)) as { database_now: string; live: number };
}

describe("delegated artifact commit authority", () => {
  it.each<Operation>(["new_create", "existing_create", "finalize"])(
    "%s commits a delayed healthy operation with retained observation and secret-free receipts",
    async (operation) => {
      const f = await fixture(),
        uploaded = operation === "new_create" ? undefined : await upload(f),
        before = await effects(f),
        minted = mintUploadGrantSecret(),
        key = randomUlid();
      let reached = false,
        observedAt = "",
        flushAt = "";
      const staged = resultStagedD1(f.db, async () => {
        reached = true;
        expect(observedAt).not.toBe("");
        if (operation === "finalize") await verifiedSource(f, uploaded!.created);
        await delay(250);
        const flush = await clockWitness(f);
        expect(flush.live).toBe(1);
        flushAt = flush.database_now;
      });
      const started = Date.now();
      const outcome = await execute(
        f,
        new WorkspaceHub(observePreparation(staged.db, (at) => (observedAt = at))),
        operation,
        key,
        minted.secretHash,
        uploaded?.created,
      );
      expect(reached).toBe(true);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.error.code);
      expect(outcome.replayed).toBe(false);
      expect(Date.parse(observedAt)).toBeGreaterThanOrEqual(started);
      expect(Date.parse(flushAt) - Date.parse(observedAt)).toBeGreaterThanOrEqual(200);
      const after = await effects(f);
      for (const table of EFFECT_TABLES) {
        const delta =
          [
            "semantic_events",
            "audit_events",
            "outbox_records",
            "idempotency_records",
            "artifact_audit_outbox",
          ].includes(table) ||
          (operation !== "finalize" &&
            ["artifact_versions", "artifact_upload_grants"].includes(table)) ||
          (operation === "new_create" && table === "artifacts")
            ? 1
            : 0;
        expect(after.rows[table]!.length).toBe(before.rows[table]!.length + delta);
      }
      expect(after.cursor.cursor).toBe(before.cursor.cursor + 1);
      expect(after.task).toEqual(before.task);
      expect(after.run).toEqual(before.run);
      expect(after.guards).toEqual([]);
      const versionId = outcome.result.version_id;
      expect(
        await f.db
          .prepare(
            `SELECT ${operation === "finalize" ? "available_at" : "created_at"} AS at FROM artifact_versions WHERE workspace_id=? AND id=?`,
          )
          .get(FIX.workspace, versionId),
      ).toEqual({ at: observedAt });
      if (operation !== "finalize") {
        const result = outcome.result as CreateDelegatedArtifactResult;
        expect(Date.parse(result.upload_grant.expires_at) - Date.parse(observedAt)).toBe(
          ARTIFACT_GRANT_TTL_MS,
        );
      }
      for (const table of [
        "semantic_events",
        "audit_events",
        "outbox_records",
        "idempotency_records",
      ])
        expect((after.rows[table]!.at(-1) as { created_at: string }).created_at).toBe(observedAt);
      expect(JSON.stringify(after.rows)).not.toContain(minted.secret);
      if (uploaded) expect(JSON.stringify(after.rows)).not.toContain(uploaded.secret);
      const replayBefore = await effects(f);
      expect(
        (await execute(f, f.hub, operation, key, minted.secretHash, uploaded?.created)).ok,
      ).toBe(false);
      expect(await effects(f)).toEqual(replayBefore);
    },
  );

  it.each(["revoked", "epoch", "role", "project", "write_scope", "boundary"] as const)(
    "new creation rolls back all effects after independent %s loss before batch",
    async (loss) => {
      const f = await fixture(),
        before = await effects(f),
        minted = mintUploadGrantSecret();
      let reached = false,
        lossApplied = false,
        observedAt = "";
      const staged = resultStagedD1(f.db, async () => {
        reached = true;
        expect(observedAt).not.toBe("");
        if (loss === "revoked")
          await f.db
            .prepare("UPDATE oauth_delegations SET revoked_at=? WHERE workspace_id=? AND id=?")
            .run(new Date().toISOString(), FIX.workspace, f.delegationId);
        else if (loss === "epoch") {
          await f.db
            .prepare(
              "UPDATE workspace_members SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.member);
          await f.db
            .prepare(
              "UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.member);
        } else if (loss === "role")
          await f.db
            .prepare(
              "UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.member);
        else if (loss === "project")
          await f.db
            .prepare(
              "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.projectA, FIX.member);
        else if (loss === "write_scope")
          await f.db
            .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
            .run(JSON.stringify(["bfb:read"]), FIX.workspace, f.delegationId);
        else
          await f.db
            .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
            .run(f.otherTaskId, FIX.workspace, f.delegationId);
        lossApplied = true;
      });
      const outcome = await execute(
        f,
        new WorkspaceHub(observePreparation(staged.db, (at) => (observedAt = at))),
        "new_create",
        randomUlid(),
        minted.secretHash,
      );
      expect(reached).toBe(true);
      expect(lossApplied).toBe(true);
      expect(outcome).toEqual({
        ok: false,
        error: { code: "command_failed", message: "command failed" },
      });
      expect(await effects(f)).toEqual(before);
      expect(JSON.stringify(outcome)).not.toContain(minted.secret);
    },
  );

  it.each(["existing_create", "finalize"] as const)(
    "%s loses private contribution atomically; a failed creation key may retry after a fresh grant",
    async (operation) => {
      const f = await fixture(),
        uploaded = await upload(f),
        contributionId = await privateContribution(f),
        before = await effects(f),
        minted = mintUploadGrantSecret(),
        key = randomUlid();
      let reached = false,
        readGrantId = "";
      const staged = resultStagedD1(f.db, async () => {
        reached = true;
        await verifiedSource(f, uploaded.created);
        await revokeGrant(f, contributionId);
        if (operation === "existing_create") readGrantId = await grant(f, "read");
      });
      const outcome = await execute(
        f,
        new WorkspaceHub(staged.db),
        operation,
        key,
        minted.secretHash,
        uploaded.created,
      );
      expect(reached).toBe(true);
      expect(outcome).toEqual({
        ok: false,
        error: { code: "command_failed", message: "command failed" },
      });
      expect(await effects(f)).toEqual(before);
      await verifiedSource(f, uploaded.created);
      if (operation === "existing_create") {
        await revokeGrant(f, readGrantId);
        await grant(f, "contribute");
        const retry = await execute(f, f.hub, operation, key, minted.secretHash, uploaded.created);
        expect(retry.ok).toBe(true);
        if (!retry.ok) throw new Error(retry.error.code);
        expect(retry.replayed).toBe(false);
        const completed = await effects(f);
        expect(
          (await execute(f, f.hub, operation, key, minted.secretHash, uploaded.created)).ok,
        ).toBe(false);
        expect(await effects(f)).toEqual(completed);
        expect(JSON.stringify(completed.rows)).not.toContain(minted.secret);
      }
    },
  );

  it("rejects a legitimate competing finalize without a second artifact or Hub receipt", async () => {
    const f = await fixture(),
      uploaded = await upload(f);
    let reached = false,
      afterCompetitor: Awaited<ReturnType<typeof effects>> | undefined;
    const staged = resultStagedD1(f.db, async () => {
      reached = true;
      await verifiedSource(f, uploaded.created);
      const competing = await execute(f, f.hub, "finalize", randomUlid(), "", uploaded.created);
      expect(competing.ok).toBe(true);
      afterCompetitor = await effects(f);
    });
    const outcome = await execute(
      f,
      new WorkspaceHub(staged.db),
      "finalize",
      randomUlid(),
      "",
      uploaded.created,
    );
    expect(reached).toBe(true);
    expect(outcome).toEqual({
      ok: false,
      error: { code: "command_failed", message: "command failed" },
    });
    expect(await effects(f)).toEqual(afterCompetitor);
    expect(
      await f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM artifact_audit_outbox WHERE workspace_id=? AND version_id=? AND action='artifact.finalized'",
        )
        .get(FIX.workspace, uploaded.created.version_id),
    ).toEqual({ n: 1 });
  });

  it.each(["new_create", "finalize"] as const)(
    "%s rolls back when the unchanged live credential naturally expires before flush",
    async (operation) => {
      const f = await fixture("+3 seconds"),
        uploaded = operation === "finalize" ? await upload(f) : undefined,
        before = await effects(f),
        original = await f.db
          .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.delegationId),
        minted = mintUploadGrantSecret();
      let reachedWhileLive = false,
        expired = false,
        observedAt = "";
      const staged = resultStagedD1(f.db, async () => {
        reachedWhileLive = (await clockWitness(f)).live === 1;
        expect(reachedWhileLive).toBe(true);
        expect(Date.parse(observedAt)).toBeLessThan(Date.parse(f.expires_at));
        if (uploaded) await verifiedSource(f, uploaded.created);
        const deadline = performance.now() + 10_000;
        while ((await clockWitness(f)).live === 1) {
          if (performance.now() >= deadline)
            throw new Error("Synthetic delegation did not naturally expire");
          await delay(50);
        }
        expired = (await clockWitness(f)).live === 0;
        expect(expired).toBe(true);
        expect(
          await f.db
            .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
            .get(FIX.workspace, f.delegationId),
        ).toEqual(original);
      });
      const outcome = await execute(
        f,
        new WorkspaceHub(observePreparation(staged.db, (at) => (observedAt = at))),
        operation,
        randomUlid(),
        minted.secretHash,
        uploaded?.created,
      );
      expect(reachedWhileLive).toBe(true);
      expect(expired).toBe(true);
      expect(outcome).toEqual({
        ok: false,
        error: { code: "command_failed", message: "command failed" },
      });
      expect(await effects(f)).toEqual(before);
      expect(
        await f.db
          .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.delegationId),
      ).toEqual(original);
    },
  );
});
