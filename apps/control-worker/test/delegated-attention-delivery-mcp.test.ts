// ABOUTME: Exercises final delegated attention reads through genuine authenticated OAuth MCP.
// ABOUTME: Post-preliminary permission and clock changes must withhold bodies without changing business history.

import { setTimeout as delay } from "node:timers/promises";

import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  answerAttentionCommand,
  getAttention,
  resolveAttentionCommand,
  type AttentionRecord,
} from "../../../packages/domain/src/attention.js";
import { bumpMemberEpoch } from "../../../packages/domain/src/authorization.js";
import { FIX } from "../../../packages/domain/src/fixtures.js";
import { WorkspaceHub } from "../../../packages/domain/src/hub.js";
import { randomUlid } from "../../../packages/domain/src/ids.js";
import { revokeDelegation } from "../../../packages/domain/src/oauth.js";
import { requestDelegatedAttentionCommand } from "../../../packages/domain/src/remote-parity.js";
import { createTaskCommand } from "../../../packages/domain/src/work-commands.js";
import {
  createExecutionCommand,
  createRunCommand,
  transitionExecutionCommand,
} from "../../../packages/domain/src/work-records.js";
import { issueSyntheticMcpAccess, openDomainDb } from "../../../packages/domain/test/helpers.js";
import { success } from "../../../packages/domain/test/launch-fixture.js";
import { handleMcpRequest } from "../src/mcp/handler.js";

const QUESTION = "SYNTHETIC-C11-DELEGATED-ATTENTION-READ-QUESTION";
const ANSWER = "SYNTHETIC-C11-DELEGATED-ATTENTION-READ-ANSWER";
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
type AttentionReply = { attention?: AttentionRecord; error?: string };

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
        title: "Synthetic delegated attention history",
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
        title: "Synthetic unrelated attention parent",
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
    keyThumbprint = "synthetic-attention-read-context-key";
  // Synthetic retained assignment context only; no launch, provider start or live lease.
  await db
    .prepare(
      `INSERT INTO runners
    (workspace_id,id,owner_human_id,device_label,public_key_json,key_thumbprint,
     authorization_epoch,grant_epoch,token_epoch,enrolled_at)
    VALUES (?,?,?,'Synthetic attention history Mac','{}',?,1,1,1,?)`,
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
      `sha256:${"d".repeat(64)}`,
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
  const writerClock = (await db
    .prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') AS expires_at",
    )
    .get()) as { now: string; expires_at: string };
  const writer = randomUlid();
  await db
    .prepare(
      `INSERT INTO oauth_delegations
    (workspace_id,id,human_id,client_id,resource,project_id,task_id,scopes_json,
     authorization_epoch,expires_at,created_at) VALUES (?,?,?,?,'https://bfb.example.test/mcp',?,?,?,1,?,?)`,
    )
    .run(
      FIX.workspace,
      writer,
      FIX.owner,
      FIX.client,
      FIX.projectA,
      task.id,
      JSON.stringify(["bfb:task:write"]),
      writerClock.expires_at,
      writerClock.now,
    );
  let record = success(
    await hub.execute(requestDelegatedAttentionCommand, {
      ...owner,
      actorDelegationId: writer,
      idempotencyKey: randomUlid(),
      input: {
        runId: run.run.id,
        kind: "clarification",
        question: QUESTION,
        blocking: true,
      },
    }),
  );
  if (options.state !== "open")
    record = success(
      await hub.execute(answerAttentionCommand, {
        ...owner,
        idempotencyKey: randomUlid(),
        input: { attentionId: record.id, expectedVersion: record.resource_version, answer: ANSWER },
      }),
    );
  if ((options.state ?? "resolved") === "resolved")
    record = success(
      await hub.execute(resolveAttentionCommand, {
        ...owner,
        idempotencyKey: randomUlid(),
        input: { attentionId: record.id, expectedVersion: record.resource_version },
      }),
    );
  // A newer execution does not invalidate an older attention request's retained waiter context.
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
    .get(options.expiry ?? "+10 minutes")) as { observed_at: string; expires_at: string };
  const auth = await issueSyntheticMcpAccess(db, {
    humanId,
    projectId: FIX.projectA,
    scopes: ["bfb:read", "offline_access"],
    now: clock.observed_at,
    expiresAt: clock.expires_at,
  });
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
    record,
    ...clock,
    ...auth,
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

function afterPreliminary(f: Fixture, change: () => Promise<void>) {
  let observed = false,
    after: Awaited<ReturnType<typeof effects>> | undefined;
  return {
    db: {
      ...f.db,
      prepare(sql) {
        const statement = f.db.prepare(sql);
        return {
          ...statement,
          async get(...parameters) {
            const row = await statement.get(...parameters);
            if (
              !observed &&
              sql.includes("SELECT attention.* FROM attention_requests AS attention") &&
              parameters.includes(f.record.id) &&
              row
            ) {
              observed = true;
              expect(row).toMatchObject({ id: f.record.id, question: QUESTION });
              await change();
              after = await effects(f);
            }
            return row;
          },
        };
      },
    } satisfies SqlDatabase,
    observed: () => observed,
    after: () => after,
  };
}

function afterAdvisory(f: Fixture, change: () => Promise<void>) {
  let preliminary = false,
    observed = false;
  return {
    db: {
      ...f.db,
      prepare(sql) {
        const statement = f.db.prepare(sql);
        return {
          ...statement,
          async get(...parameters) {
            const row = await statement.get(...parameters);
            if (
              sql.includes("SELECT attention.* FROM attention_requests AS attention") &&
              parameters.includes(f.record.id) &&
              row
            )
              preliminary = true;
            if (
              preliminary &&
              !observed &&
              sql.includes("SELECT task.id AS taskId") &&
              parameters.includes(f.taskId) &&
              row
            ) {
              observed = true;
              expect(row).toMatchObject({ taskId: f.taskId, projectId: FIX.projectA });
              // The advisory's current-parent SELECT has succeeded; return its retained row after the loss.
              await change();
            }
            return row;
          },
        };
      },
    } satisfies SqlDatabase,
    observed: () => observed,
  };
}

async function call(f: Fixture, db: SqlDatabase, attentionId = f.record.id) {
  const response = await handleMcpRequest(
    new Request("https://bfb.example.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "bfb_get_attention",
        Host: "bfb.example.test",
        authorization: `Bearer ${f.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "bfb_get_attention",
          arguments: { attention_id: attentionId },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "bfb-synthetic-attention-read",
              version: "1.0.0",
            },
          },
        },
      }),
    }),
    {
      db,
      allowedHostnames: ["bfb.example.test"],
      appOrigin: "https://bfb.example.test",
      abuseSecret: "synthetic-attention-read-abuse-secret-c11-19a67d",
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
  return {
    body: JSON.parse(reply.result!.content![0]!.text) as AttentionReply,
    isError: reply.result?.isError,
  };
}

function denied(reply: Awaited<ReturnType<typeof call>>, f: Fixture) {
  expect(reply.isError).toBe(true);
  expect(reply.body).toEqual({ error: "not_found" });
  for (const canary of [QUESTION, ANSWER, f.record.id, f.taskId, f.runId, f.executionId])
    expect(JSON.stringify(reply.body)).not.toContain(canary);
}

describe("mounted delegated attention read delivery", () => {
  it.each([FIX.owner, FIX.member, FIX.reviewer])(
    "%s delayed read-only history remains readable without a live/latest execution",
    async (humanId) => {
      const f = await fixture(humanId),
        before = await effects(f);
      const hooked = afterPreliminary(f, async () => {
        await delay(250);
        expect(await credential(f)).toMatchObject({
          scopes_json: JSON.stringify(["bfb:read", "offline_access"]),
        });
        expect(
          await f.db
            .prepare("SELECT state FROM run_executions WHERE workspace_id=? AND id=?")
            .get(FIX.workspace, f.executionId),
        ).toEqual({ state: "ended" });
        expect(f.newerExecutionId).not.toBe(f.executionId);
      });
      const reply = await call(f, hooked.db);
      expect(hooked.observed()).toBe(true);
      expect(reply.isError).not.toBe(true);
      expect(reply.body).toEqual({ attention: f.record });
      expect(reply.body.attention).toMatchObject({ state: "resolved", answer: ANSWER });
      expect(await effects(f)).toEqual(before);
    },
  );

  it("production revoke after the preliminary attention body denies without effects", async () => {
    const f = await fixture(),
      before = await effects(f);
    const hooked = afterPreliminary(f, async () => {
      await revokeDelegation(f.db, FIX.workspace, f.delegationId, new Date().toISOString());
      expect(await credential(f)).toMatchObject({ revoked_at: expect.any(String) });
      expect(await effects(f)).toEqual(before);
    });
    denied(await call(f, hooked.db), f);
    expect(hooked.observed()).toBe(true);
    expect(await effects(f)).toEqual(before);
  });

  it.each([
    "read_scope",
    "client",
    "project_to_null",
    "task_to_target",
    "epoch",
    "project_access",
  ] as const)(
    "%s loss after preliminary selection cannot be adopted by final delivery",
    async (loss) => {
      const f = await fixture(),
        before = await effects(f);
      expect(await credential(f)).toMatchObject({
        project_id: FIX.projectA,
        task_id: null,
        client_id: FIX.client,
      });
      const hooked = afterPreliminary(f, async () => {
        if (loss === "read_scope") {
          await f.db
            .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
            .run(JSON.stringify(["offline_access"]), FIX.workspace, f.delegationId);
          expect(await credential(f)).toMatchObject({
            scopes_json: JSON.stringify(["offline_access"]),
          });
        } else if (loss === "client") {
          await f.db
            .prepare("UPDATE oauth_delegations SET client_id=? WHERE workspace_id=? AND id=?")
            .run("synthetic-other-attention-read-client", FIX.workspace, f.delegationId);
          expect(await credential(f)).toMatchObject({
            client_id: "synthetic-other-attention-read-client",
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
          expect(await credential(f)).toMatchObject({
            task_id: f.taskId,
            project_id: FIX.projectA,
          });
        } else if (loss === "epoch") {
          expect(await bumpMemberEpoch(f.db, FIX.workspace, f.humanId)).toBe(2);
        } else {
          await f.db
            .prepare(
              "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.projectA, f.humanId);
          expect(
            await f.db
              .prepare(
                "SELECT human_id FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
              )
              .get(FIX.workspace, FIX.projectA, f.humanId),
          ).toBeUndefined();
        }
        expect(await effects(f)).toEqual(before);
      });
      denied(await call(f, hooked.db), f);
      expect(hooked.observed()).toBe(true);
      expect(await effects(f)).toEqual(before);
    },
  );

  it("private read grant revocation after preliminary selection denies uniformly", async () => {
    const f = await fixture(),
      grantId = randomUlid();
    // Synthetic dormant privacy fixture uses the genuine task creator and a separate Member reader.
    await f.db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, f.taskId, FIX.owner, f.observed_at);
    await f.db
      .prepare(
        "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)",
      )
      .run(FIX.workspace, grantId, f.taskId, f.humanId, f.observed_at);
    const before = await effects(f);
    const hooked = afterPreliminary(f, async () => {
      await f.db
        .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
        .run(new Date().toISOString(), FIX.workspace, grantId);
      expect(
        await f.db
          .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, grantId),
      ).toMatchObject({ revoked_at: expect.any(String) });
    });
    denied(await call(f, hooked.db), f);
    expect(hooked.observed()).toBe(true);
    expect(await effects(f)).toEqual(before);
  });

  it.each(["private_read", "epoch", "project_access"] as const)(
    "%s loss after the successful advisory read withholds the selected body",
    async (loss) => {
      const f = await fixture(),
        grantId = randomUlid();
      if (loss === "private_read") {
        // Dormant synthetic privacy uses the real creator; the Member is only a named read grantee.
        await f.db
          .prepare(
            "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
          )
          .run(FIX.workspace, f.taskId, FIX.owner, f.observed_at);
        await f.db
          .prepare(
            "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)",
          )
          .run(FIX.workspace, grantId, f.taskId, f.humanId, f.observed_at);
      }
      const before = await effects(f);
      const hooked = afterAdvisory(f, async () => {
        if (loss === "private_read") {
          await f.db
            .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
            .run(new Date().toISOString(), FIX.workspace, grantId);
          expect(
            await f.db
              .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
              .get(FIX.workspace, grantId),
          ).toMatchObject({ revoked_at: expect.any(String) });
        } else if (loss === "epoch") {
          expect(await bumpMemberEpoch(f.db, FIX.workspace, f.humanId)).toBe(2);
        } else {
          await f.db
            .prepare(
              "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.projectA, f.humanId);
          expect(
            await f.db
              .prepare(
                "SELECT human_id FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
              )
              .get(FIX.workspace, FIX.projectA, f.humanId),
          ).toBeUndefined();
        }
        expect(await effects(f)).toEqual(before);
      });
      denied(await call(f, hooked.db), f);
      expect(hooked.observed()).toBe(true);
      expect(await effects(f)).toEqual(before);
    },
  );

  it("an unchanged credential live at preliminary selection but naturally expired before final delivery denies", async () => {
    const f = await fixture(FIX.member, { expiry: "+3 seconds" }),
      originalCredential = await credential(f),
      before = await effects(f);
    const hooked = afterPreliminary(f, async () => {
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
    });
    denied(await call(f, hooked.db), f);
    expect(hooked.observed()).toBe(true);
    expect(await effects(f)).toEqual(before);
    expect(await credential(f)).toEqual(originalCredential);
  });

  it("a genuine answer committed after preliminary open selection is returned canonically without read effects", async () => {
    const f = await fixture(FIX.member, { state: "open" });
    let answered: AttentionRecord | undefined;
    const hooked = afterPreliminary(f, async () => {
      answered = success(
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
    });
    const reply = await call(f, hooked.db);
    expect(hooked.observed()).toBe(true);
    expect(answered).toBeDefined();
    expect(reply.isError).not.toBe(true);
    expect(reply.body).toEqual({ attention: answered });
    expect(await effects(f)).toEqual(hooked.after());
  });

  it("a missing attention uses the same bounded unavailable wire without business effects", async () => {
    const f = await fixture(),
      before = await effects(f);
    denied(await call(f, f.db, randomUlid()), f);
    expect(await effects(f)).toEqual(before);
    expect(
      await getAttention(f.db, FIX.workspace, [FIX.projectA], f.record.id, {
        workspaceId: FIX.workspace,
        humanId: f.humanId,
        authorizationEpoch: 1,
      }),
    ).toEqual(f.record);
  });
});
