// ABOUTME: Exercises delegated attention commit authority through genuine OAuth MCP and the staged committing Hub.
// ABOUTME: Witnessed revocation, private grants and real expiry prove rollback while preserving historical waiter context.

import { setTimeout as delay } from "node:timers/promises";

import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AttentionRecord } from "../../../packages/domain/src/attention.js";
import { FIX } from "../../../packages/domain/src/fixtures.js";
import { WorkspaceHub } from "../../../packages/domain/src/hub.js";
import { randomUlid } from "../../../packages/domain/src/ids.js";
import { revokeDelegation } from "../../../packages/domain/src/oauth.js";
import { createTaskCommand } from "../../../packages/domain/src/work-commands.js";
import {
  createExecutionCommand,
  createRunCommand,
  transitionExecutionCommand,
} from "../../../packages/domain/src/work-records.js";
import { issueSyntheticMcpAccess, openDomainDb } from "../../../packages/domain/test/helpers.js";
import { success } from "../../../packages/domain/test/launch-fixture.js";
import { resultStagedD1 } from "../../../packages/domain/test/result-fixture.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { handleMcpRequest } from "../src/mcp/handler.js";

const QUESTION = "SYNTHETIC-C11-MCP-DELEGATED-ATTENTION-COMMIT-QUESTION";
const EFFECT_TABLES = [
  "attention_requests",
  "attention_observations",
  "semantic_events",
  "audit_events",
  "outbox_records",
  "idempotency_records",
  "notification_deliveries",
] as const;
type Outcome =
  | { ok: true; result: AttentionRecord; replayed: boolean }
  | { ok: false; error: { code: string; message: string } };

beforeEach(() => {
  vi.useRealTimers();
});

async function fixture(humanId: string = FIX.member, expiry = "+10 minutes") {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db),
    owner = { workspaceId: FIX.workspace, actorHumanId: FIX.owner, authorizationEpoch: 1 };
  const task = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: {
        projectId: FIX.projectA,
        title: "Synthetic MCP attention commit task",
        priority: "P2",
      },
    }),
  );
  const otherTask = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: {
        projectId: FIX.projectA,
        title: "Synthetic unrelated MCP attention task",
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
    keyThumbprint = "synthetic-mcp-attention-commit-runner-key";
  // Historical synthetic context, not an enrolled live runner or a provider start.
  await db
    .prepare(
      `INSERT INTO runners
     (workspace_id,id,owner_human_id,device_label,public_key_json,key_thumbprint,
      authorization_epoch,grant_epoch,token_epoch,enrolled_at)
     VALUES (?,?,?,'Synthetic MCP attention context Mac','{}',?,1,1,1,?)`,
    )
    .run(FIX.workspace, runnerId, FIX.owner, keyThumbprint, execution.created_at);
  await db
    .prepare("INSERT INTO runner_project_grants (workspace_id,runner_id,project_id) VALUES (?,?,?)")
    .run(FIX.workspace, runnerId, FIX.projectA);
  await db
    .prepare(
      `INSERT INTO execution_assignments
     (workspace_id,execution_id,assignment_generation,run_id,task_id,project_id,
      runner_id,checkout_id,physical_worktree_hash,requesting_human_id,
      requesting_human_epoch,runner_authorization_epoch,runner_grant_epoch,runner_key_thumbprint,created_at)
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
      `sha256:${"c".repeat(64)}`,
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
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS observed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at",
    )
    .get(expiry)) as { observed_at: string; expires_at: string };
  const auth = await issueSyntheticMcpAccess(db, {
    humanId,
    projectId: FIX.projectA,
    taskId: task.id,
    scopes: ["bfb:task:write", "offline_access"],
    now: clock.observed_at,
    expiresAt: clock.expires_at,
  });
  return {
    db,
    humanId,
    taskId: task.id,
    otherTaskId: otherTask.id,
    runId: run.run.id,
    executionId: execution.id,
    newerExecutionId: newer.id,
    ...clock,
    ...auth,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function call(f: Fixture, committingDb: SqlDatabase, key: string, question = QUESTION) {
  const response = await handleMcpRequest(
    new Request("https://bfb.example.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "bfb_request_human",
        Host: "bfb.example.test",
        authorization: `Bearer ${f.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "bfb_request_human",
          arguments: {
            run_id: f.runId,
            kind: "clarification",
            question,
            blocking: true,
            request_id: key,
          },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "bfb-synthetic-attention-commit",
              version: "1.0.0",
            },
          },
        },
      }),
    }),
    {
      // OAuth resolution uses the original DB; only the genuine committing Hub is staged.
      db: f.db,
      workspaceHubNs: createTestWorkspaceHubNamespace(committingDb),
      allowedHostnames: ["bfb.example.test"],
      appOrigin: "https://bfb.example.test",
      abuseSecret: "c11-synthetic-attention-commit-abuse-secret-97ab42",
      jurisdiction: "eu",
      now: new Date().toISOString(),
    },
  );
  expect(response.status).toBe(200);
  const reply = (await response.json()) as {
    error?: unknown;
    result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
  };
  expect(reply.error).toBeUndefined();
  expect(reply.result?.content?.[0]?.type).toBe("text");
  const text = reply.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return { outcome: JSON.parse(text!) as Outcome, isError: reply.result?.isError };
}

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
    cursor: (await f.db
      .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
      .get(FIX.workspace)) as { cursor: number },
    task: await f.db
      .prepare("SELECT * FROM tasks WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.taskId),
    run: await f.db
      .prepare("SELECT * FROM runs WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.runId),
    executions: await f.db
      .prepare("SELECT * FROM run_executions WHERE workspace_id=? AND run_id=? ORDER BY rowid")
      .all(FIX.workspace, f.runId),
    assignments: await f.db
      .prepare(
        "SELECT * FROM execution_assignments WHERE workspace_id=? AND run_id=? ORDER BY assignment_generation",
      )
      .all(FIX.workspace, f.runId),
    grants: await f.db
      .prepare("SELECT * FROM task_human_grants WHERE workspace_id=? AND task_id=? ORDER BY rowid")
      .all(FIX.workspace, f.taskId),
    credential: await credential(f),
    guards: await f.db.prepare("SELECT * FROM artifact_mutation_guards ORDER BY id").all(),
    runnerGuards: await f.db.prepare("SELECT * FROM runner_mutation_guards ORDER BY id").all(),
  };
}

async function waiterContext(f: Fixture) {
  expect(
    await f.db
      .prepare(
        `SELECT assignment.execution_id,assignment.assignment_generation,assignment.run_id,
      assignment.task_id,assignment.project_id,assignment.requesting_human_id,execution.state
     FROM execution_assignments AS assignment
     JOIN run_executions AS execution ON execution.workspace_id=assignment.workspace_id
       AND execution.id=assignment.execution_id AND execution.run_id=assignment.run_id
     WHERE assignment.workspace_id=? AND assignment.execution_id=?`,
      )
      .get(FIX.workspace, f.executionId),
  ).toEqual({
    execution_id: f.executionId,
    assignment_generation: 1,
    run_id: f.runId,
    task_id: f.taskId,
    project_id: FIX.projectA,
    requesting_human_id: FIX.owner,
    state: "ended",
  });
  expect(f.newerExecutionId).not.toBe(f.executionId);
  expect(
    await f.db
      .prepare("SELECT COUNT(*) AS n FROM checkout_leases WHERE workspace_id=?")
      .get(FIX.workspace),
  ).toEqual({ n: 0 });
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
                if (sql.includes("INSERT INTO attention_requests")) {
                  const at = parameters.at(-1);
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

async function clockWitness(f: Fixture) {
  return (await f.db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS database_now,
      julianday(expires_at)>julianday('now') AS live
     FROM oauth_delegations WHERE workspace_id=? AND id=?`,
    )
    .get(FIX.workspace, f.delegationId)) as { database_now: string; live: number };
}

async function grant(f: Fixture, permission: "read" | "contribute") {
  const id = randomUlid();
  await f.db
    .prepare(
      `INSERT INTO task_human_grants
     (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
     VALUES (?,?,?,?,1,?,?)`,
    )
    .run(FIX.workspace, id, f.taskId, f.humanId, permission, new Date().toISOString());
  return id;
}

async function revokeGrant(f: Fixture, id: string) {
  await f.db
    .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
    .run(new Date().toISOString(), FIX.workspace, id);
  expect(
    await f.db
      .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, id),
  ).toMatchObject({ revoked_at: expect.any(String) });
}

async function assertCommitted(
  f: Fixture,
  before: Awaited<ReturnType<typeof effects>>,
  record: AttentionRecord,
  observedAt: string,
) {
  const after = await effects(f);
  expect(record).toMatchObject({
    project_id: FIX.projectA,
    task_id: f.taskId,
    run_id: f.runId,
    run_execution_id: f.executionId,
    assignment_generation: 1,
    state: "open",
    requested_at: observedAt,
  });
  for (const table of EFFECT_TABLES)
    expect(after.rows[table]!.length).toBe(
      before.rows[table]!.length + (table === "notification_deliveries" ? 0 : 1),
    );
  expect(after.cursor.cursor).toBe(before.cursor.cursor + 1);
  for (const key of [
    "task",
    "run",
    "executions",
    "assignments",
    "grants",
    "credential",
    "guards",
    "runnerGuards",
  ] as const)
    expect(after[key]).toEqual(before[key]);
  expect(
    await f.db
      .prepare(
        "SELECT actor_type,actor_id,occurred_at FROM attention_observations WHERE workspace_id=? AND attention_id=?",
      )
      .get(FIX.workspace, record.id),
  ).toEqual({ actor_type: "human", actor_id: f.humanId, occurred_at: observedAt });
  for (const table of ["semantic_events", "audit_events", "outbox_records", "idempotency_records"])
    expect((after.rows[table]!.at(-1) as { created_at: string }).created_at).toBe(observedAt);
  for (const table of ["semantic_events", "audit_events", "outbox_records"])
    expect(JSON.stringify(after.rows[table])).not.toContain(QUESTION);
  return after;
}

describe("mounted delegated attention commit authority", () => {
  it.each([FIX.owner, FIX.member, FIX.reviewer])(
    "%s write-only OAuth request commits after a healthy delay and retries exactly once",
    async (humanId) => {
      const f = await fixture(humanId),
        before = await effects(f),
        key = randomUlid();
      let reached = false,
        observedAt = "",
        flushAt = "";
      const staged = resultStagedD1(f.db, async () => {
        reached = true;
        expect(observedAt).not.toBe("");
        await waiterContext(f);
        await delay(250);
        const flush = await clockWitness(f);
        expect(flush.live).toBe(1);
        flushAt = flush.database_now;
      });
      const started = Date.now();
      const { outcome, isError } = await call(
        f,
        observePreparation(staged.db, (at) => (observedAt = at)),
        key,
      );
      expect(reached).toBe(true);
      expect(isError).not.toBe(true);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.error.code);
      expect(Object.keys(outcome).sort()).toEqual(["ok", "replayed", "result"]);
      expect(outcome.replayed).toBe(false);
      expect(Date.parse(observedAt)).toBeGreaterThanOrEqual(started);
      expect(Date.parse(flushAt) - Date.parse(observedAt)).toBeGreaterThanOrEqual(200);
      const committed = await assertCommitted(f, before, outcome.result, observedAt);
      const retry = await call(f, f.db, key);
      expect(retry.isError).not.toBe(true);
      expect(retry.outcome).toEqual({ ...outcome, replayed: true });
      expect(await effects(f)).toEqual(committed);
      const changed = await call(f, f.db, key, `${QUESTION}-CHANGED`);
      expect(changed.isError).toBe(true);
      expect(changed.outcome).toEqual({
        ok: false,
        error: {
          code: "request_rejected",
          message: "operation input differs from its original request",
        },
      });
      expect(await effects(f)).toEqual(committed);
    },
  );

  it.each(["revoked", "boundary", "private_contribution"] as const)(
    "authenticated %s loss before batch has no attention or receipt effects",
    async (loss) => {
      const f = await fixture(),
        key = randomUlid();
      let contributionId = "";
      if (loss === "private_contribution") {
        await f.db
          .prepare(
            "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
          )
          .run(FIX.workspace, f.taskId, FIX.owner, f.observed_at);
        contributionId = await grant(f, "contribute");
      }
      let reached = false,
        observedAt = "",
        readGrantId = "",
        expected: Awaited<ReturnType<typeof effects>> | undefined;
      const staged = resultStagedD1(f.db, async () => {
        reached = true;
        expect(observedAt).not.toBe("");
        await waiterContext(f);
        if (loss === "revoked") {
          await revokeDelegation(f.db, FIX.workspace, f.delegationId, new Date().toISOString());
          expect(await credential(f)).toMatchObject({ revoked_at: expect.any(String) });
        } else if (loss === "boundary") {
          await f.db
            .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
            .run(f.otherTaskId, FIX.workspace, f.delegationId);
          expect(f.otherTaskId).not.toBe(f.taskId);
          expect(await credential(f)).toMatchObject({ task_id: f.otherTaskId });
        } else {
          await revokeGrant(f, contributionId);
          readGrantId = await grant(f, "read");
          expect(
            await f.db
              .prepare(
                "SELECT permission,revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?",
              )
              .get(FIX.workspace, readGrantId),
          ).toEqual({ permission: "read", revoked_at: null });
        }
        expected = await effects(f);
      });
      const { outcome, isError } = await call(
        f,
        observePreparation(staged.db, (at) => (observedAt = at)),
        key,
      );
      expect(reached).toBe(true);
      expect(expected).toBeDefined();
      expect(isError).toBe(true);
      expect(outcome).toEqual({
        ok: false,
        error: { code: "command_failed", message: "command failed" },
      });
      expect(JSON.stringify(outcome)).not.toContain(QUESTION);
      expect(await effects(f)).toEqual(expected);
      if (loss === "private_contribution") {
        await revokeGrant(f, readGrantId);
        await grant(f, "contribute");
        const restored = await effects(f);
        const retry = await call(f, f.db, key);
        expect(retry.isError).not.toBe(true);
        expect(retry.outcome.ok).toBe(true);
        if (!retry.outcome.ok) throw new Error(retry.outcome.error.code);
        expect(retry.outcome.replayed).toBe(false);
        const committed = await assertCommitted(
          f,
          restored,
          retry.outcome.result,
          retry.outcome.result.requested_at,
        );
        expect((await call(f, f.db, key)).outcome).toEqual({ ...retry.outcome, replayed: true });
        expect(await effects(f)).toEqual(committed);
      }
    },
  );

  it("unchanged authenticated credential naturally expires after live batch arrival and rolls back", async () => {
    const f = await fixture(FIX.member, "+3 seconds"),
      before = await effects(f),
      original = await credential(f);
    let reachedWhileLive = false,
      expired = false,
      observedAt = "";
    const staged = resultStagedD1(f.db, async () => {
      reachedWhileLive = (await clockWitness(f)).live === 1;
      expect(reachedWhileLive).toBe(true);
      expect(Date.parse(observedAt)).toBeLessThan(Date.parse(f.expires_at));
      await waiterContext(f);
      const deadline = performance.now() + 10_000;
      while ((await clockWitness(f)).live === 1) {
        if (performance.now() >= deadline)
          throw new Error("Synthetic MCP attention credential did not naturally expire");
        await delay(50);
      }
      expired = (await clockWitness(f)).live === 0;
      expect(expired).toBe(true);
      expect(await credential(f)).toEqual(original);
    });
    const { outcome, isError } = await call(
      f,
      observePreparation(staged.db, (at) => (observedAt = at)),
      randomUlid(),
    );
    expect(reachedWhileLive).toBe(true);
    expect(expired).toBe(true);
    expect(isError).toBe(true);
    expect(outcome).toEqual({
      ok: false,
      error: { code: "command_failed", message: "command failed" },
    });
    expect(await effects(f)).toEqual(before);
    expect(await credential(f)).toEqual(original);
  });
});
