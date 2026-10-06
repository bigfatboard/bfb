// ABOUTME: Proves current shared-only retention delivery and atomic Owner upload recovery.
// ABOUTME: Synthetic parent, authority, proof and D1-batch races leave private work unavailable.

import type { SqlDatabase } from "@bfb/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import {
  applyOpsRecovery,
  assertOperationsUploadRecoveryAccess,
  collectWorkspaceHealth,
  filterOperationsStuckWork,
  listRetentionEligibleChunks,
  listSystemRetentionEligibleChunks,
  recoveryActionId,
  resolveStuckUploadCommand,
} from "../src/operations.js";
import { issueStepUpProof } from "../src/step-up.js";
import type { TaskAccessContext } from "../src/task-access.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createRunCommand } from "../src/work-records.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";
import { resultStagedD1 } from "./result-fixture.js";

const NOW = "2026-09-18T12:00:00.000Z";
const OLD = "2026-07-01T12:00:00.000Z";
const STUCK = "2026-09-18T10:00:00.000Z";
const access = (humanId = FIX.owner, authorizationEpoch = 1): TaskAccessContext => ({
  workspaceId: FIX.workspace,
  humanId,
  authorizationEpoch,
});
const denial = {
  ok: false,
  error: { code: "not_found", message: "upload recovery target not found" },
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

function human<I, R>(
  db: SqlDatabase,
  command: HubCommand<I, R>,
  input: I,
  actor = FIX.owner,
  key = randomUlid(),
) {
  return new WorkspaceHub(db).execute(command, {
    workspaceId: FIX.workspace,
    actorHumanId: actor,
    authorizationEpoch: 1,
    idempotencyKey: key,
    now: NOW,
    input,
  });
}
async function fixture() {
  const db = await openDomainDb();
  const task = success(
    await human(
      db,
      createTaskCommand,
      {
        projectId: FIX.projectA,
        title: "Synthetic operations retention/recovery parent",
        priority: "P2",
      },
      FIX.member,
    ),
  );
  const run = success(
    await human(db, createRunCommand, {
      taskId: task.id,
      expectedTaskVersion: 1,
      agentProfileId: FIX.profileCodex,
      workspacePolicyVersion: 1,
      projectPolicyVersion: 1,
      repositoryConfigVersion: 1,
      agentProfileVersion: 1,
    }),
  );
  return { db, taskId: task.id, runId: run.run.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function artifact(
  f: Fixture,
  state: "available" | "uploading" = "available",
  runId: string | null = f.runId,
  key?: string | ((versionId: string) => string),
  at = state === "available" ? OLD : STUCK,
) {
  const artifactId = randomUlid(),
    versionId = randomUlid();
  await f.db
    .prepare(
      "INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,?,'log','log',?,?)",
    )
    .run(FIX.workspace, artifactId, runId, FIX.member, at);
  // Synthetic immutable metadata only; no bucket object or upload capability is created.
  await f.db
    .prepare(
      `INSERT INTO artifact_versions (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,content_hash,r2_key,created_at,available_at)
    VALUES (?,?,?,?,'log',64,?,?,?,?,?)`,
    )
    .run(
      FIX.workspace,
      versionId,
      artifactId,
      state,
      "a".repeat(64),
      state === "available" ? "b".repeat(64) : null,
      state === "available"
        ? typeof key === "function"
          ? key(versionId)
          : (key ?? `workspaces/${FIX.workspace}/runs/${runId}/logs/${versionId}.jsonl.zst`)
        : null,
      at,
      state === "available" ? at : null,
    );
  return { artifactId, versionId };
}
async function privatize(f: Fixture) {
  await f.db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, f.taskId, FIX.member, NOW);
}
async function malformedRun(f: Fixture, kind: "missing_task" | "wrong_project") {
  const runId = randomUlid();
  // Synthetic historical corruption bypasses only the fixture's foreign-key
  // validation; delivery must still bind the exact run/task/project lineage.
  await f.db.prepare("PRAGMA foreign_keys = OFF").run();
  try {
    await f.db
      .prepare(
        `INSERT INTO runs
      (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,resource_version,created_at)
      VALUES (?,?,?,?,?,?,'open','unknown',1,?)`,
      )
      .run(
        FIX.workspace,
        runId,
        kind === "wrong_project" ? FIX.projectB : FIX.projectA,
        kind === "missing_task" ? randomUlid() : f.taskId,
        FIX.owner,
        FIX.profileCodex,
        NOW,
      );
  } finally {
    await f.db.prepare("PRAGMA foreign_keys = ON").run();
  }
  return runId;
}
async function foreignVersion(f: Fixture) {
  const workspaceId = randomUlid(),
    artifactId = randomUlid(),
    versionId = randomUlid();
  await f.db
    .prepare(
      "INSERT INTO workspaces (id,slug,jurisdiction,created_at,resource_version) VALUES (?,'operations-foreign','eu',?,1)",
    )
    .run(workspaceId, NOW);
  await f.db
    .prepare(
      "INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,NULL,'log','log',?,?)",
    )
    .run(workspaceId, artifactId, FIX.owner, STUCK);
  await f.db
    .prepare(
      "INSERT INTO artifact_versions (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,created_at) VALUES (?,?,?,'uploading','log',64,?,?)",
    )
    .run(workspaceId, versionId, artifactId, "a".repeat(64), STUCK);
  return versionId;
}
async function proof(
  db: SqlDatabase,
  humanId = FIX.owner,
  targetId = `ops-recover:resolve_stuck_upload:${FIX.workspace}`,
  action = "ops.recover",
) {
  return issueStepUpProof(
    db,
    humanId,
    {
      action,
      workspaceId: FIX.workspace,
      targetId,
      scopes: [],
      authorizationEpoch: 1,
      expiresAt: "2026-09-18T12:05:00.000Z",
    },
    NOW,
  );
}
async function rotate(db: SqlDatabase) {
  await db
    .prepare(
      "UPDATE workspace_members SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
    )
    .run(FIX.workspace, FIX.owner);
  await db
    .prepare(
      "UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
    )
    .run(FIX.workspace, FIX.owner);
}
async function demote(db: SqlDatabase, role = "reviewer") {
  await db.prepare("UPDATE workspace_members SET role='owner' WHERE human_id=?").run(FIX.member);
  await db.prepare("UPDATE workspace_members SET role=? WHERE human_id=?").run(role, FIX.owner);
}
async function uploadGrant(
  db: SqlDatabase,
  versionId: string,
  expiresAt = "2026-09-18T12:10:00.000Z",
  consumedAt: string | null = null,
) {
  await db
    .prepare(
      `INSERT INTO artifact_upload_grants
    (workspace_id,id,version_id,grant_hash,human_id,authorization_epoch,format,declared_size,expected_digest,expires_at,consumed_at,created_at)
    VALUES (?,?,?,?,?,1,'log',64,?,?,?,?)`,
    )
    .run(
      FIX.workspace,
      randomUlid(),
      versionId,
      "c".repeat(64),
      FIX.owner,
      "a".repeat(64),
      expiresAt,
      consumedAt,
      STUCK,
    );
}
function before(db: SqlDatabase, match: RegExp, change: () => Promise<void>): SqlDatabase {
  let fired = false;
  return {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        ...statement,
        async all(...params: unknown[]) {
          if (!fired && match.test(sql)) {
            fired = true;
            await change();
          }
          return statement.all(...params);
        },
        async get(...params: unknown[]) {
          if (!fired && match.test(sql)) {
            fired = true;
            await change();
          }
          return statement.get(...params);
        },
      };
    },
  };
}
async function noRecoveryEffects(
  db: SqlDatabase,
  ids: string[],
  proofId: string,
  failedId?: string,
) {
  expect(
    await db
      .prepare(
        "SELECT id,state FROM artifact_versions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
      )
      .all(JSON.stringify(ids)),
  ).toEqual([...ids].sort().map((id) => ({ id, state: id === failedId ? "failed" : "uploading" })));
  expect(
    await db
      .prepare("SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id=?")
      .get(proofId),
  ).toEqual({ consumed_at: null });
  expect(await db.prepare("SELECT action_id FROM ops_recovery_ledger").all()).toEqual([]);
  expect(await db.prepare("SELECT id FROM artifact_audit_outbox").all()).toEqual([]);
  expect(await db.prepare("SELECT id FROM artifact_mutation_guards").all()).toEqual([]);
  expect(await db.prepare("SELECT id FROM runner_mutation_guards").all()).toEqual([]);
  expect(
    await db
      .prepare("SELECT audit_id FROM audit_events WHERE action='ops.recovery.resolve_stuck_upload'")
      .all(),
  ).toEqual([]);
  expect(
    await db
      .prepare(
        "SELECT event_id FROM semantic_events WHERE kind='ops.recovery.resolve_stuck_upload'",
      )
      .all(),
  ).toEqual([]);
}

describe("private operations retention", () => {
  it("requires explicit current human context and counts only exact authorized candidates", async () => {
    const f = await fixture();
    const visible = await artifact(f);
    await artifact(f, "available", null);
    await artifact(
      f,
      "available",
      f.runId,
      `workspaces/${FIX.workspace}/runs/${f.runId}/logs/foreign-version.jsonl.zst`,
    );
    const found = await listRetentionEligibleChunks(f.db, FIX.workspace, NOW, access());
    expect(found.examined).toBe(1);
    expect(found.eligible.map((row) => row.version_id)).toEqual([visible.versionId]);
    await expect(
      listRetentionEligibleChunks(f.db, FIX.workspace, NOW, undefined as never),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      collectWorkspaceHealth(f.db, FIX.workspace, NOW, undefined as never),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
  it.each(["creator", "read", "contribute", "edit"] as const)(
    "never exposes private retention to %s",
    async (permission) => {
      const f = await fixture();
      await artifact(f);
      await privatize(f);
      if (permission !== "creator")
        await f.db
          .prepare(
            "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,?,?)",
          )
          .run(FIX.workspace, randomUlid(), f.taskId, FIX.owner, permission, NOW);
      expect(
        await listRetentionEligibleChunks(
          f.db,
          FIX.workspace,
          NOW,
          access(permission === "creator" ? FIX.member : FIX.owner),
        ),
      ).toMatchObject({ examined: 0, eligible: [] });
    },
  );
  it.each([
    "workspace",
    "run",
    "version",
    "suffix",
    "missing_run",
    "missing_task",
    "wrong_project",
  ] as const)(
    "excludes %s key or parent mismatch from both human and system counts",
    async (kind) => {
      const f = await fixture();
      const valid = await artifact(f);
      const runId =
        kind === "missing_run"
          ? randomUlid()
          : kind === "missing_task" || kind === "wrong_project"
            ? await malformedRun(f, kind)
            : f.runId;
      await artifact(
        f,
        "available",
        runId,
        (versionId) =>
          `workspaces/${kind === "workspace" ? randomUlid() : FIX.workspace}/runs/${kind === "run" ? randomUlid() : runId}/logs/${kind === "version" ? randomUlid() : versionId}${kind === "suffix" ? ".jsonl.zst/extra" : ".jsonl.zst"}`,
      );
      await f.db
        .prepare(
          "INSERT INTO retention_policies (workspace_id,raw_log_retention_days,version,updated_by_human_id,updated_at) VALUES (?,30,1,?,?)",
        )
        .run(FIX.workspace, FIX.owner, NOW);
      for (const read of [
        listRetentionEligibleChunks(f.db, FIX.workspace, NOW, access()),
        listSystemRetentionEligibleChunks(f.db, FIX.workspace, NOW),
      ]) {
        const selected = await read;
        expect(selected.examined).toBe(1);
        expect(selected.eligible.map((row) => row.version_id)).toEqual([valid.versionId]);
      }
    },
  );
  it.each(["epoch", "role"] as const)(
    "does not deliver hydrated policy or empty health after %s loss with no references",
    async (loss) => {
      const f = await fixture();
      await f.db
        .prepare(
          "INSERT INTO retention_policies (workspace_id,raw_log_retention_days,version,updated_by_human_id,updated_at) VALUES (?,7,1,?,?)",
        )
        .run(FIX.workspace, FIX.owner, NOW);
      const db = before(f.db, /SELECT v.id AS version_id/, () =>
        loss === "epoch" ? rotate(f.db) : demote(f.db),
      );
      await expect(
        listRetentionEligibleChunks(db, FIX.workspace, NOW, access()),
      ).rejects.toMatchObject({ code: "not_found", message: "operations scope not found" });
      await expect(
        filterOperationsStuckWork(
          f.db,
          FIX.workspace,
          NOW,
          { uploads: [], launches: [], retention: [] },
          access(),
        ),
      ).rejects.toMatchObject({ code: "not_found", message: "operations scope not found" });
    },
  );
  it.each(["key", "age", "state"] as const)(
    "final retention composition drops %s-ineligible cached candidates",
    async (kind) => {
      const f = await fixture();
      await artifact(f);
      const candidates = (await listRetentionEligibleChunks(f.db, FIX.workspace, NOW, access()))
        .eligible;
      if (kind === "key") candidates[0].r2_key += "/extra";
      else if (kind === "state")
        await f.db
          .prepare("UPDATE artifact_versions SET state='retained' WHERE id=?")
          .run(candidates[0].version_id);
      else
        await f.db
          .prepare(
            "INSERT INTO retention_policies (workspace_id,raw_log_retention_days,version,updated_by_human_id,updated_at) VALUES (?,365,1,?,?)",
          )
          .run(FIX.workspace, FIX.owner, NOW);
      expect(
        await filterOperationsStuckWork(
          f.db,
          FIX.workspace,
          NOW,
          { uploads: [], launches: [], retention: candidates },
          access(),
        ),
      ).toEqual({ uploads: [], launches: [], retention: [] });
    },
  );
  it.each(["epoch", "role", "project", "privacy"] as const)(
    "rechecks %s in final retention content/count selection",
    async (loss) => {
      const f = await fixture();
      await artifact(f);
      const change = async () => {
        if (loss === "epoch") await rotate(f.db);
        else if (loss === "role") await demote(f.db);
        else if (loss === "privacy") await privatize(f);
        else {
          await f.db
            .prepare("UPDATE projects SET access_mode='restricted' WHERE id=?")
            .run(FIX.projectA);
          await f.db
            .prepare("DELETE FROM project_access WHERE project_id=? AND human_id=?")
            .run(FIX.projectA, FIX.owner);
        }
      };
      const db = before(f.db, /SELECT v.id AS version_id/, change);
      const read = listRetentionEligibleChunks(db, FIX.workspace, NOW, access());
      if (loss === "epoch" || loss === "role")
        await expect(read).rejects.toMatchObject({
          code: "not_found",
          message: "operations scope not found",
        });
      else expect(await read).toMatchObject({ examined: 0, eligible: [] });
    },
  );
  it("has a separate configured system selector and exact key binding", async () => {
    const f = await fixture();
    const valid = await artifact(f);
    await artifact(f, "available", null);
    await privatize(f);
    expect((await listSystemRetentionEligibleChunks(f.db, FIX.workspace, NOW)).eligible).toEqual(
      [],
    );
    await f.db
      .prepare(
        "INSERT INTO retention_policies (workspace_id,raw_log_retention_days,version,updated_by_human_id,updated_at) VALUES (?,30,1,?,?)",
      )
      .run(FIX.workspace, FIX.owner, NOW);
    const system = await listSystemRetentionEligibleChunks(f.db, FIX.workspace, NOW);
    expect(system.examined).toBe(1);
    expect(system.eligible.map((row) => row.version_id)).toEqual([valid.versionId]);
    expect(
      (await listRetentionEligibleChunks(f.db, FIX.workspace, NOW, access())).eligible,
    ).toEqual([]);
  });
  it("remasks retention with stuck-work in one final selection and preserves old response shape", async () => {
    const f = await fixture();
    await artifact(f);
    const candidates = (await listRetentionEligibleChunks(f.db, FIX.workspace, NOW, access()))
      .eligible;
    expect(
      await filterOperationsStuckWork(
        f.db,
        FIX.workspace,
        NOW,
        { uploads: [], launches: [] },
        access(),
      ),
    ).toEqual({ uploads: [], launches: [] });
    await privatize(f);
    expect(
      await filterOperationsStuckWork(
        f.db,
        FIX.workspace,
        NOW,
        { uploads: [], launches: [], retention: candidates },
        access(),
      ),
    ).toEqual({ uploads: [], launches: [], retention: [] });
  });
  it.each(["privacy", "epoch", "role", "project"] as const)(
    "health count cannot retain retention authority lost during later %s hydration",
    async (loss) => {
      const f = await fixture();
      await artifact(f);
      const db = before(f.db, /SELECT id FROM runners/, async () => {
        if (loss === "privacy") await privatize(f);
        else if (loss === "epoch") await rotate(f.db);
        else if (loss === "role") await demote(f.db);
        else {
          await f.db
            .prepare("UPDATE projects SET access_mode='restricted' WHERE id=?")
            .run(FIX.projectA);
          await f.db
            .prepare("DELETE FROM project_access WHERE project_id=? AND human_id=?")
            .run(FIX.projectA, FIX.owner);
        }
      });
      const read = collectWorkspaceHealth(db, FIX.workspace, NOW, access());
      if (loss === "epoch" || loss === "role")
        await expect(read).rejects.toMatchObject({
          code: "not_found",
          message: "operations scope not found",
        });
      else expect((await read).retention.eligible_chunks).toBe(0);
    },
  );
});

describe("private operations Hub upload recovery", () => {
  it("resolves shared and genuine runfree targets once with safe Hub receipts", async () => {
    const f = await fixture();
    const refs = [await artifact(f, "uploading"), await artifact(f, "uploading", null)];
    const result = success(
      await human(f.db, resolveStuckUploadCommand, {
        versionIds: refs.map((row) => row.versionId),
        stepUpProofId: await proof(f.db),
      }),
    );
    expect(result).toMatchObject({
      kind: "resolve_stuck_upload",
      replayed: false,
      detail: { resolved: 2 },
    });
    await assertOperationsUploadRecoveryAccess(
      f.db,
      FIX.workspace,
      refs.map((row) => row.versionId),
      access(),
    );
    expect(
      await f.db.prepare("SELECT action FROM audit_events WHERE action='ops.recover'").all(),
    ).toEqual([]);
    expect(
      await f.db
        .prepare("SELECT action FROM audit_events WHERE action='ops.recovery.resolve_stuck_upload'")
        .all(),
    ).toHaveLength(1);
  });
  it.each([
    "private",
    "missing",
    "young",
    "available",
    "live_grant",
    "recently_expired_grant",
    "consumed_future_grant",
    "project",
    "missing_run",
    "missing_task",
    "wrong_project",
    "foreign",
  ] as const)("uniformly denies %s targets without proof/effects", async (kind) => {
    const f = await fixture();
    const runId =
      kind === "missing_run"
        ? randomUlid()
        : kind === "missing_task" || kind === "wrong_project"
          ? await malformedRun(f, kind)
          : f.runId;
    const ref = await artifact(
      f,
      kind === "available" ? "available" : "uploading",
      runId,
      undefined,
      kind === "young" ? NOW : STUCK,
    );
    if (kind === "private") {
      await privatize(f);
      await f.db
        .prepare(
          "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'edit',?)",
        )
        .run(FIX.workspace, randomUlid(), f.taskId, FIX.owner, NOW);
    }
    if (kind === "project") {
      await f.db
        .prepare("UPDATE projects SET access_mode='restricted' WHERE id=?")
        .run(FIX.projectA);
      await f.db
        .prepare("DELETE FROM project_access WHERE project_id=? AND human_id=?")
        .run(FIX.projectA, FIX.owner);
    }
    if (
      kind === "live_grant" ||
      kind === "recently_expired_grant" ||
      kind === "consumed_future_grant"
    )
      await uploadGrant(
        f.db,
        ref.versionId,
        kind === "recently_expired_grant" ? "2026-09-18T11:58:00.000Z" : undefined,
        kind === "consumed_future_grant" ? NOW : null,
      );
    const proofId = await proof(f.db);
    expect(
      await human(f.db, resolveStuckUploadCommand, {
        versionIds: [
          kind === "missing"
            ? randomUlid()
            : kind === "foreign"
              ? await foreignVersion(f)
              : ref.versionId,
        ],
        stepUpProofId: proofId,
      }),
    ).toEqual(denial);
    expect(
      await f.db
        .prepare("SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id=?")
        .get(proofId),
    ).toEqual({ consumed_at: null });
    expect(await f.db.prepare("SELECT action_id FROM ops_recovery_ledger").all()).toEqual([]);
  });
  it.each([[], ["bad"], Array.from({ length: 51 }, () => randomUlid())])(
    "rejects malformed or excessive targets before effects %j",
    async (ids) => {
      const f = await fixture();
      const ref = await artifact(f, "uploading");
      const proofId = await proof(f.db);
      expect(
        await human(f.db, resolveStuckUploadCommand, { versionIds: ids, stepUpProofId: proofId }),
      ).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
      await noRecoveryEffects(f.db, [ref.versionId], proofId);
    },
  );
  it("rejects duplicate and mixed targets atomically", async () => {
    const f = await fixture();
    const ref = await artifact(f, "uploading");
    const proofId = await proof(f.db);
    expect(
      await human(f.db, resolveStuckUploadCommand, {
        versionIds: [ref.versionId, ref.versionId],
        stepUpProofId: proofId,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(
      await human(f.db, resolveStuckUploadCommand, {
        versionIds: [ref.versionId, randomUlid()],
        stepUpProofId: proofId,
      }),
    ).toEqual(denial);
    await noRecoveryEffects(f.db, [ref.versionId], proofId);
  });
  it("requires fresh proof for target-ledger replay and creates no duplicate abandonment", async () => {
    const f = await fixture();
    const ref = await artifact(f, "uploading");
    const proofId = await proof(f.db);
    const key = randomUlid();
    const first = success(
      await human(
        f.db,
        resolveStuckUploadCommand,
        { versionIds: [ref.versionId], stepUpProofId: proofId },
        FIX.owner,
        key,
      ),
    );
    expect(
      await human(
        f.db,
        resolveStuckUploadCommand,
        { versionIds: [ref.versionId], stepUpProofId: proofId },
        FIX.owner,
        key,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await human(f.db, resolveStuckUploadCommand, {
        versionIds: [ref.versionId],
        stepUpProofId: proofId,
      }),
    ).toMatchObject({ ok: false, error: { code: "step_up_replayed" } });
    const replay = success(
      await human(f.db, resolveStuckUploadCommand, {
        versionIds: [ref.versionId],
        stepUpProofId: await proof(f.db),
      }),
    );
    expect(replay).toEqual({ ...first, replayed: true });
    expect(
      await f.db
        .prepare("SELECT id FROM artifact_audit_outbox WHERE action='artifact.abandoned'")
        .all(),
    ).toHaveLength(1);
    expect(await f.db.prepare("SELECT attempt_count FROM ops_recovery_ledger").get()).toEqual({
      attempt_count: 1,
    });
  });
  it.each(["ledger", "proof", "private_parent"] as const)(
    "stored retry %s tampering before batch preserves prior effects and rolls back new receipts",
    async (tamper) => {
      const f = await fixture();
      const refs = [await artifact(f, "uploading"), await artifact(f, "uploading", null)];
      const ids = refs.map((row) => row.versionId);
      const first = success(
        await human(f.db, resolveStuckUploadCommand, {
          versionIds: ids,
          stepUpProofId: await proof(f.db),
        }),
      );
      expect(first).toMatchObject({ replayed: false, detail: { resolved: 2 } });
      const freshProof = await proof(f.db);
      const retryKey = randomUlid();
      const effectTables = [
        "artifacts",
        "artifact_versions",
        "artifact_upload_grants",
        "artifact_upload_consumptions",
        "artifact_objects",
        "artifact_upload_receipts",
        "artifact_upload_receipt_sources",
        "artifact_agent_operations",
        "artifact_agent_grants",
        "artifact_view_grants",
        "artifact_reviews",
        "artifact_audit_outbox",
        "ops_recovery_ledger",
        "passkey_step_up_proofs",
        "task_privacy",
        "audit_events",
        "semantic_events",
        "idempotency_records",
        "outbox_records",
        "workspace_cursors",
      ];
      const snapshot = () =>
        Promise.all(
          effectTables.map(async (table) => ({
            table,
            rows: await f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          })),
        );
      const prior = await snapshot();
      let expected = prior;
      let changed = false;
      const competingConsumption = "synthetic-independent-proof-consumer";
      const changedTable =
        tamper === "ledger"
          ? "ops_recovery_ledger"
          : tamper === "proof"
            ? "passkey_step_up_proofs"
            : "task_privacy";
      const staged = resultStagedD1(f.db, async () => {
        if (tamper === "ledger")
          await f.db
            .prepare("UPDATE ops_recovery_ledger SET result_json=? WHERE action_id=?")
            .run(JSON.stringify({ resolved: 99 }), first.action_id);
        else if (tamper === "proof")
          await f.db
            .prepare("UPDATE passkey_step_up_proofs SET consumed_at=? WHERE proof_id=?")
            .run(competingConsumption, freshProof);
        else await privatize(f);
        changed = true;
        // Capture only the independent mutation, before the queued Hub batch.
        // A failed retry must leave these rows intact and add no new effect.
        expected = await snapshot();
        for (const [index, table] of effectTables.entries())
          if (table !== changedTable) expect(expected[index]).toEqual(prior[index]);
      });
      expect(
        await human(
          staged.db,
          resolveStuckUploadCommand,
          { versionIds: ids, stepUpProofId: freshProof },
          FIX.owner,
          retryKey,
        ),
      ).toEqual({ ok: false, error: { code: "command_failed", message: "command failed" } });
      expect(changed).toBe(true);
      expect(await snapshot()).toEqual(expected);
      expect(
        await f.db.prepare("SELECT id,state FROM artifact_versions ORDER BY id").all(),
      ).toEqual([...ids].sort().map((id) => ({ id, state: "failed" })));
      expect(
        await f.db
          .prepare("SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id=?")
          .get(freshProof),
      ).toEqual({ consumed_at: tamper === "proof" ? competingConsumption : null });
      expect(
        await f.db
          .prepare("SELECT idempotency_key FROM idempotency_records WHERE idempotency_key=?")
          .all(retryKey),
      ).toEqual([]);
      expect(await f.db.prepare("SELECT id FROM artifact_mutation_guards").all()).toEqual([]);
      expect(await f.db.prepare("SELECT id FROM runner_mutation_guards").all()).toEqual([]);
    },
  );
  it.each(["extra", "wrong_kind", "wrong_count", "nonfailed"] as const)(
    "rejects malformed %s historical ledger without consuming proof",
    async (kind) => {
      const f = await fixture();
      let ref = await artifact(f, "uploading");
      const first = success(
        await human(f.db, resolveStuckUploadCommand, {
          versionIds: [ref.versionId],
          stepUpProofId: await proof(f.db),
        }),
      );
      if (kind === "nonfailed") {
        ref = await artifact(f, "uploading");
        const target = { version_ids: [ref.versionId] };
        // Synthetic malformed historical ledger points to a non-terminal version.
        await f.db
          .prepare(
            `INSERT INTO ops_recovery_ledger (workspace_id,action_id,kind,target_json,state,attempt_count,result_json,created_by_human_id,created_at,updated_at)
        VALUES (?,?,'resolve_stuck_upload',?,'applied',1,'{"resolved":1}',?,?,?)`,
          )
          .run(
            FIX.workspace,
            recoveryActionId("resolve_stuck_upload", target),
            JSON.stringify(target),
            FIX.owner,
            NOW,
            NOW,
          );
      } else
        await f.db
          .prepare("UPDATE ops_recovery_ledger SET kind=?,result_json=? WHERE action_id=?")
          .run(
            kind === "wrong_kind" ? "clear_recovery_state" : "resolve_stuck_upload",
            JSON.stringify(
              kind === "extra"
                ? { resolved: 1, extra: "SYNTHETIC-PRIVATE-CANARY" }
                : { resolved: kind === "wrong_count" ? 2 : 1 },
            ),
            first.action_id,
          );
      const fresh = await proof(f.db);
      expect(
        await human(f.db, resolveStuckUploadCommand, {
          versionIds: [ref.versionId],
          stepUpProofId: fresh,
        }),
      ).toEqual(denial);
      expect(
        await f.db
          .prepare("SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id=?")
          .get(fresh),
      ).toEqual({ consumed_at: null });
    },
  );
  it("rejects the old resolution branch before historical cache lookup", async () => {
    const f = await fixture();
    const ref = await artifact(f, "uploading");
    const target = { version_ids: [ref.versionId] };
    await f.db
      .prepare(
        `INSERT INTO ops_recovery_ledger (workspace_id,action_id,kind,target_json,state,attempt_count,result_json,created_by_human_id,created_at,updated_at) VALUES (?,?,'resolve_stuck_upload',?,'applied',1,'{"resolved":1}',?,?,?)`,
      )
      .run(
        FIX.workspace,
        recoveryActionId("resolve_stuck_upload", target),
        JSON.stringify(target),
        FIX.owner,
        NOW,
        NOW,
      );
    await expect(
      applyOpsRecovery({
        db: f.db,
        workspaceId: FIX.workspace,
        kind: "resolve_stuck_upload",
        target,
        actorHumanId: FIX.owner,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "request_rejected" });
  });
  it.each([
    "privacy",
    "epoch",
    "role",
    "state",
    "live_grant",
    "recently_expired_grant",
    "consumed_future_grant",
    "ledger",
  ] as const)("pre-batch %s loss rolls back proof/version/ledger/outbox/audit", async (loss) => {
    const f = await fixture();
    const refs = [await artifact(f, "uploading"), await artifact(f, "uploading")];
    const ids = refs.map((row) => row.versionId);
    const proofId = await proof(f.db);
    let changed = false;
    const staged = resultStagedD1(f.db, async () => {
      if (loss === "privacy") await privatize(f);
      else if (loss === "epoch") await rotate(f.db);
      else if (loss === "role") await demote(f.db, "member");
      else if (loss === "state")
        await f.db.prepare("UPDATE artifact_versions SET state='failed' WHERE id=?").run(ids[1]);
      else if (
        loss === "live_grant" ||
        loss === "recently_expired_grant" ||
        loss === "consumed_future_grant"
      )
        await uploadGrant(
          f.db,
          ids[1]!,
          loss === "recently_expired_grant" ? "2026-09-18T11:58:00.000Z" : undefined,
          loss === "consumed_future_grant" ? NOW : null,
        );
      else
        await f.db
          .prepare(
            `INSERT INTO ops_recovery_ledger (workspace_id,action_id,kind,target_json,state,attempt_count,result_json,created_by_human_id,created_at,updated_at) VALUES (?,?,'resolve_stuck_upload',?,'failed',1,'{}',?,?,?)`,
          )
          .run(
            FIX.workspace,
            recoveryActionId("resolve_stuck_upload", { version_ids: ids }),
            JSON.stringify({ version_ids: ids }),
            FIX.owner,
            NOW,
            NOW,
          );
      changed = true;
    });
    expect(
      await human(staged.db, resolveStuckUploadCommand, {
        versionIds: ids,
        stepUpProofId: proofId,
      }),
    ).toEqual({ ok: false, error: { code: "command_failed", message: "command failed" } });
    expect(changed).toBe(true);
    if (loss === "ledger") await f.db.prepare("DELETE FROM ops_recovery_ledger").run();
    await noRecoveryEffects(f.db, ids, proofId, loss === "state" ? ids[1] : undefined);
  });
});
