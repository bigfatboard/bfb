// ABOUTME: Exercises one final canonical delegated attention selector against retained parent and credential authority.
// ABOUTME: Synthetic historical attention records isolate read permissions without active execution or lease assumptions.

import { setTimeout as delay } from "node:timers/promises";

import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  answerAttentionCommand,
  getAttention,
  getDelegatedAttention,
  type AttentionRecord,
} from "../src/attention.js";
import { bumpMemberEpoch } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { revokeDelegation } from "../src/oauth.js";
import { createTaskCommand } from "../src/work-commands.js";
import {
  createExecutionCommand,
  createRunCommand,
  transitionExecutionCommand,
} from "../src/work-records.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";

const QUESTION = "SYNTHETIC-C11-DOMAIN-ATTENTION-READ-QUESTION";
const ANSWER = "SYNTHETIC-C11-DOMAIN-ATTENTION-READ-ANSWER";
const EFFECT_TABLES = [
  "tasks",
  "runs",
  "run_executions",
  "execution_assignments",
  "attention_requests",
  "attention_observations",
  "semantic_events",
  "audit_events",
  "outbox_records",
  "idempotency_records",
  "notification_deliveries",
  "task_context_deliveries",
  "result_submissions",
  "artifacts",
  "artifact_versions",
  "artifact_upload_grants",
] as const;

beforeEach(() => vi.useRealTimers());

async function fixture(
  humanId: string = FIX.member,
  options: { state?: "open" | "answered" | "resolved"; expiry?: string } = {},
) {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db),
    owner = { workspaceId: FIX.workspace, actorHumanId: FIX.owner, authorizationEpoch: 1 };
  const task = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: {
        projectId: FIX.projectA,
        title: "Synthetic final attention selector task",
        priority: "P2",
      },
    }),
  );
  const unrelated = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: {
        projectId: FIX.projectA,
        title: "Synthetic unrelated attention task",
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
  const execution = success(
    await hub.execute(createExecutionCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: { runId: run.run.id },
    }),
  );
  const runnerId = randomUlid(),
    keyThumbprint = "synthetic-final-attention-read-key";
  // Disposable retained assignment fixture, not provider execution or an active lease.
  await db
    .prepare(
      `INSERT INTO runners
    (workspace_id,id,owner_human_id,device_label,public_key_json,key_thumbprint,
     authorization_epoch,grant_epoch,token_epoch,enrolled_at)
    VALUES (?,?,?,'Synthetic final attention context Mac','{}',?,1,1,1,?)`,
    )
    .run(FIX.workspace, runnerId, FIX.owner, keyThumbprint, execution.created_at);
  await db
    .prepare("INSERT INTO runner_project_grants (workspace_id,runner_id,project_id) VALUES (?,?,?)")
    .run(FIX.workspace, runnerId, FIX.projectA);
  await db
    .prepare(
      `INSERT INTO execution_assignments
    (workspace_id,execution_id,assignment_generation,run_id,task_id,project_id,runner_id,
     checkout_id,physical_worktree_hash,requesting_human_id,requesting_human_epoch,
     runner_authorization_epoch,runner_grant_epoch,runner_key_thumbprint,created_at)
    VALUES (?,?,1,?,?,?,?,?,?,?,1,1,1,?,?)`,
    )
    .run(
      FIX.workspace,
      execution.id,
      run.run.id,
      task.id,
      FIX.projectA,
      runnerId,
      randomUlid(),
      `sha256:${"e".repeat(64)}`,
      FIX.owner,
      keyThumbprint,
      execution.created_at,
    );
  success(
    await hub.execute(transitionExecutionCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: {
        runId: run.run.id,
        executionId: execution.id,
        expectedVersion: 1,
        state: "ended",
        endReason: "process_exit",
      },
    }),
  );
  const newer = success(
    await hub.execute(createExecutionCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: { runId: run.run.id },
    }),
  );
  const clock = (await db
    .prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS observed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at",
    )
    .get(options.expiry ?? "+1 hour")) as { observed_at: string; expires_at: string };
  const state = options.state ?? "resolved",
    attentionId = randomUlid();
  // Explicit synthetic historical request. Genuine MCP lifecycle tests cover request/answer/resolve commands.
  await db
    .prepare(
      `INSERT INTO attention_requests
    (workspace_id,id,project_id,task_id,run_id,run_execution_id,assignment_generation,
     kind,required_role,reference_kind,reference_id,question,blocking,state,answer,
     answered_by_human_id,requested_at,first_response_at,answered_at,resolved_at,resource_version)
    VALUES (?,?,?,?,?,?,1,'clarification','reviewer',NULL,NULL,?,1,?,?,?,?,?,?,?,?)`,
    )
    .run(
      FIX.workspace,
      attentionId,
      FIX.projectA,
      task.id,
      run.run.id,
      execution.id,
      QUESTION,
      state,
      state === "open" ? null : ANSWER,
      state === "open" ? null : FIX.owner,
      clock.observed_at,
      state === "open" ? null : clock.observed_at,
      state === "open" ? null : clock.observed_at,
      state === "resolved" ? clock.observed_at : null,
      state === "open" ? 1 : state === "answered" ? 2 : 3,
    );
  const delegationId = randomUlid();
  await db
    .prepare(
      `INSERT INTO oauth_delegations
    (workspace_id,id,human_id,client_id,resource,project_id,task_id,scopes_json,
     authorization_epoch,expires_at,created_at)
    VALUES (?,?,?,?,'https://bfb.example.test/mcp',?,NULL,?,1,?,?)`,
    )
    .run(
      FIX.workspace,
      delegationId,
      humanId,
      FIX.client,
      FIX.projectA,
      JSON.stringify(["bfb:read"]),
      clock.expires_at,
      clock.observed_at,
    );
  const access = {
    workspaceId: FIX.workspace,
    humanId,
    authorizationEpoch: 1,
    delegationId,
    clientId: FIX.client,
    projectBoundaryId: FIX.projectA,
  };
  const record = await getAttention(db, FIX.workspace, [FIX.projectA], attentionId, access);
  expect(record).not.toBeNull();
  return {
    db,
    hub,
    owner,
    humanId,
    taskId: task.id,
    otherTaskId: unrelated.id,
    runId: run.run.id,
    executionId: execution.id,
    newerExecutionId: newer.id,
    delegationId,
    access,
    record: record!,
    ...clock,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function credential(f: Fixture) {
  return f.db
    .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
    .get(FIX.workspace, f.delegationId);
}
async function effects(f: Fixture) {
  const rows: Record<string, unknown[]> = {};
  for (const table of EFFECT_TABLES)
    rows[table] = await f.db
      .prepare(`SELECT * FROM ${table} WHERE workspace_id=? ORDER BY rowid`)
      .all(FIX.workspace);
  return {
    rows,
    cursor: await f.db
      .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
      .get(FIX.workspace),
    artifactGuards: await f.db.prepare("SELECT * FROM artifact_mutation_guards ORDER BY id").all(),
    runnerGuards: await f.db.prepare("SELECT * FROM runner_mutation_guards ORDER BY id").all(),
  };
}
function observeFinal(db: SqlDatabase) {
  const reads: string[] = [];
  return {
    db: {
      ...db,
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          ...statement,
          async get(...parameters) {
            reads.push("get");
            return statement.get(...parameters);
          },
          async all(...parameters) {
            reads.push("all");
            return statement.all(...parameters);
          },
        };
      },
    } satisfies SqlDatabase,
    reads,
  };
}

describe("final delegated attention selector", () => {
  it.each([
    { humanId: FIX.owner, state: "open" as const },
    { humanId: FIX.member, state: "answered" as const },
    { humanId: FIX.reviewer, state: "resolved" as const },
  ])(
    "$humanId delayed read-only $state history uses exactly one current selection",
    async ({ humanId, state }) => {
      const f = await fixture(humanId, { state }),
        before = await effects(f);
      await delay(250);
      expect(
        await f.db
          .prepare("SELECT state FROM run_executions WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.executionId),
      ).toEqual({ state: "ended" });
      expect(f.executionId).not.toBe(f.newerExecutionId);
      const observed = observeFinal(f.db);
      expect(await getDelegatedAttention(observed.db, FIX.workspace, f.record, f.access)).toEqual(
        f.record,
      );
      expect(observed.reads).toEqual(["get"]);
      expect(await credential(f)).toMatchObject({ scopes_json: JSON.stringify(["bfb:read"]) });
      expect(await effects(f)).toEqual(before);
    },
  );

  it.each([
    "revoked",
    "scope",
    "client",
    "project_to_null",
    "task_to_target",
    "epoch",
    "project_access",
  ] as const)("%s after preliminary read is denied without read effects", async (loss) => {
    const f = await fixture(),
      before = await effects(f);
    if (loss === "revoked") {
      await revokeDelegation(f.db, FIX.workspace, f.delegationId, new Date().toISOString());
      expect(await credential(f)).toMatchObject({ revoked_at: expect.any(String) });
    } else if (loss === "scope") {
      await f.db
        .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
        .run(JSON.stringify(["offline_access"]), FIX.workspace, f.delegationId);
      expect(await credential(f)).toMatchObject({
        scopes_json: JSON.stringify(["offline_access"]),
      });
    } else if (loss === "client") {
      await f.db
        .prepare("UPDATE oauth_delegations SET client_id=? WHERE workspace_id=? AND id=?")
        .run("synthetic-other-final-attention-client", FIX.workspace, f.delegationId);
      expect(await credential(f)).toMatchObject({
        client_id: "synthetic-other-final-attention-client",
      });
    } else if (loss === "project_to_null") {
      await f.db
        .prepare("UPDATE oauth_delegations SET project_id=NULL WHERE workspace_id=? AND id=?")
        .run(FIX.workspace, f.delegationId);
      expect(await credential(f)).toMatchObject({ project_id: null, task_id: null });
    } else if (loss === "task_to_target") {
      await f.db
        .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
        .run(f.taskId, FIX.workspace, f.delegationId);
      expect(await credential(f)).toMatchObject({ project_id: FIX.projectA, task_id: f.taskId });
    } else if (loss === "epoch") {
      expect(await bumpMemberEpoch(f.db, FIX.workspace, f.humanId)).toBe(2);
    } else {
      await f.db
        .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
        .run(FIX.workspace, FIX.projectA, f.humanId);
      expect(
        await f.db
          .prepare(
            "SELECT human_id FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
          )
          .get(FIX.workspace, FIX.projectA, f.humanId),
      ).toBeUndefined();
    }
    expect(await getDelegatedAttention(f.db, FIX.workspace, f.record, f.access)).toBeNull();
    expect(await effects(f)).toEqual(before);
  });

  it("private read-grant loss denies without changing history and a fresh current grant restores the canonical record", async () => {
    const f = await fixture(),
      first = randomUlid();
    // Dormant synthetic privacy uses the actual creator, never a workspace Owner override.
    await f.db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, f.taskId, FIX.owner, f.observed_at);
    const grant = async (id: string) =>
      f.db
        .prepare(
          "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)",
        )
        .run(FIX.workspace, id, f.taskId, f.humanId, new Date().toISOString());
    await grant(first);
    expect(await getDelegatedAttention(f.db, FIX.workspace, f.record, f.access)).toEqual(f.record);
    const before = await effects(f);
    await f.db
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(new Date().toISOString(), FIX.workspace, first);
    expect(
      await f.db
        .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, first),
    ).toMatchObject({ revoked_at: expect.any(String) });
    expect(await getDelegatedAttention(f.db, FIX.workspace, f.record, f.access)).toBeNull();
    expect(await effects(f)).toEqual(before);
    const fresh = randomUlid();
    expect(fresh).not.toBe(first);
    await grant(fresh);
    expect(await getDelegatedAttention(f.db, FIX.workspace, f.record, f.access)).toEqual(f.record);
    expect(await effects(f)).toEqual(before);
  });

  it("unchanged natural database-clock expiry after a live preliminary read denies", async () => {
    const f = await fixture(FIX.member, { expiry: "+3 seconds" }),
      before = await effects(f),
      originalCredential = await credential(f);
    const live = () =>
      f.db
        .prepare(
          "SELECT julianday(expires_at)>julianday('now') AS live FROM oauth_delegations WHERE workspace_id=? AND id=?",
        )
        .get(FIX.workspace, f.delegationId) as Promise<{ live: number }>;
    expect(await live()).toEqual({ live: 1 });
    const deadline = Date.now() + 10_000;
    while ((await live()).live === 1 && Date.now() < deadline) await delay(50);
    expect(await live()).toEqual({ live: 0 });
    expect(await credential(f)).toEqual(originalCredential);
    expect(await getDelegatedAttention(f.db, FIX.workspace, f.record, f.access)).toBeNull();
    expect(await effects(f)).toEqual(before);
  });

  it("a genuine newer answer is selected without binding preliminary state, version or answer fields", async () => {
    const f = await fixture(FIX.member, { state: "open" });
    const answered = success(
      await f.hub.execute(answerAttentionCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: {
          attentionId: f.record.id,
          expectedVersion: f.record.resource_version,
          answer: ANSWER,
        },
      }),
    );
    const before = await effects(f);
    expect(await getDelegatedAttention(f.db, FIX.workspace, f.record, f.access)).toEqual(answered);
    expect(await effects(f)).toEqual(before);
  });

  it("robustness: an initially misbound canonical request with a legal foreign assignment is omitted", async () => {
    const f = await fixture();
    const secondRun = success(
      await f.hub.execute(createRunCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: {
          taskId: f.otherTaskId,
          expectedTaskVersion: 1,
          agentProfileId: FIX.profileCodex,
          workspacePolicyVersion: 1,
          projectPolicyVersion: 1,
          repositoryConfigVersion: 1,
          agentProfileVersion: 1,
        },
      }),
    );
    const secondExecution = success(
      await f.hub.execute(createExecutionCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: { runId: secondRun.run.id },
      }),
    );
    // A new valid retained fixture tuple copies only immutable runner authority, never an assignment row.
    await f.db
      .prepare(
        `INSERT INTO execution_assignments
      (workspace_id,execution_id,assignment_generation,run_id,task_id,project_id,runner_id,
       checkout_id,physical_worktree_hash,requesting_human_id,requesting_human_epoch,
       runner_authorization_epoch,runner_grant_epoch,runner_key_thumbprint,created_at)
      SELECT workspace_id,?,1,?,?,project_id,runner_id,?,?,requesting_human_id,
       requesting_human_epoch,runner_authorization_epoch,runner_grant_epoch,runner_key_thumbprint,?
      FROM execution_assignments WHERE workspace_id=? AND execution_id=? AND assignment_generation=1`,
      )
      .run(
        secondExecution.id,
        secondRun.run.id,
        f.otherTaskId,
        randomUlid(),
        `sha256:${"f".repeat(64)}`,
        secondExecution.created_at,
        FIX.workspace,
        f.executionId,
      );
    expect(
      await f.db
        .prepare(
          `SELECT execution_id,assignment_generation,run_id,task_id,project_id
      FROM execution_assignments WHERE workspace_id=? AND execution_id=? AND assignment_generation=1`,
        )
        .get(FIX.workspace, secondExecution.id),
    ).toEqual({
      execution_id: secondExecution.id,
      assignment_generation: 1,
      run_id: secondRun.run.id,
      task_id: f.otherTaskId,
      project_id: FIX.projectA,
    });
    // Deliberately corrupt the disposable request, not its immutable assignment or a production permission.
    await f.db
      .prepare("UPDATE attention_requests SET run_execution_id=? WHERE workspace_id=? AND id=?")
      .run(secondExecution.id, FIX.workspace, f.record.id);
    expect(
      await getAttention(f.db, FIX.workspace, [FIX.projectA], f.record.id, f.access),
    ).toBeNull();
    // The preliminary reader now denies this fixture. Independently retain
    // the malformed tuple to prove the delegated final selector still denies it.
    const malformed = {
      ...f.record,
      run_execution_id: secondExecution.id,
    };
    const before = await effects(f);
    expect(await getDelegatedAttention(f.db, FIX.workspace, malformed, f.access)).toBeNull();
    expect(await effects(f)).toEqual(before);
  });

  it("robustness: a newline-suffixed retained identity denies before preparing SQL", async () => {
    const f = await fixture(),
      before = await effects(f);
    let prepared = false;
    const db = {
      ...f.db,
      prepare(sql: string) {
        prepared = true;
        return f.db.prepare(sql);
      },
    } satisfies SqlDatabase;
    expect(
      await getDelegatedAttention(
        db,
        FIX.workspace,
        { ...f.record, id: `${f.record.id}\n` },
        f.access,
      ),
    ).toBeNull();
    expect(prepared).toBe(false);
    expect(await effects(f)).toEqual(before);
  });

  it("database-clock expiry between getter SQL preparation and its actual selection denies unchanged authority", async () => {
    const f = await fixture(FIX.member, { expiry: "+3 seconds" }),
      originalCredential = await credential(f),
      before = await effects(f);
    let observed = false;
    const db = {
      ...f.db,
      prepare(sql: string) {
        const statement = f.db.prepare(sql);
        return {
          ...statement,
          async get(...parameters) {
            expect(observed).toBe(false);
            expect(sql).toContain("attention_requests");
            observed = true;
            const preparedTime = parameters.find(
              (parameter) =>
                typeof parameter === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(parameter),
            );
            expect(typeof preparedTime).toBe("string");
            expect(Date.parse(preparedTime as string)).toBeLessThan(Date.parse(f.expires_at));
            const live = () =>
              f.db
                .prepare(
                  "SELECT julianday(expires_at)>julianday('now') AS live FROM oauth_delegations WHERE workspace_id=? AND id=?",
                )
                .get(FIX.workspace, f.delegationId) as Promise<{ live: number }>;
            expect(await live()).toEqual({ live: 1 });
            const deadline = Date.now() + 10_000;
            while ((await live()).live === 1 && Date.now() < deadline) await delay(50);
            expect(await live()).toEqual({ live: 0 });
            expect(await credential(f)).toEqual(originalCredential);
            return statement.get(...parameters);
          },
        };
      },
    } satisfies SqlDatabase;
    expect(await getDelegatedAttention(db, FIX.workspace, f.record, f.access)).toBeNull();
    expect(observed).toBe(true);
    expect(await credential(f)).toEqual(originalCredential);
    expect(await effects(f)).toEqual(before);
  });

  it("robustness: different preliminary identity or exact parent/waiter tuple is omitted without history rewrites", async () => {
    const f = await fixture(),
      before = await effects(f);
    // Corrupted disposable preliminary envelopes, not reachable permission or immutable-assignment mutations.
    const mismatches: AttentionRecord[] = [
      { ...f.record, id: randomUlid() },
      { ...f.record, task_id: f.otherTaskId },
      { ...f.record, project_id: FIX.projectB },
      { ...f.record, run_id: randomUlid() },
      { ...f.record, run_execution_id: f.newerExecutionId },
      { ...f.record, assignment_generation: f.record.assignment_generation + 1 },
    ];
    for (const record of mismatches)
      expect(await getDelegatedAttention(f.db, FIX.workspace, record, f.access)).toBeNull();
    expect(await getDelegatedAttention(f.db, FIX.workspace, f.record, f.access)).toEqual(f.record);
    expect(await effects(f)).toEqual(before);
  });
});
