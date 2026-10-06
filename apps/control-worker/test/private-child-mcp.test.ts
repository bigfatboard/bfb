// ABOUTME: Exercises private child delivery and strict intent validation through mounted MCP requests.
// ABOUTME: Real synthetic OAuth grants prove revoked or expired delegations cannot deliver attention content.

import type { SqlDatabase } from "@bfb/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  answerAttentionCommand,
  getAttention,
  type AttentionRecord,
} from "../../../packages/domain/src/attention.js";
import { FIX } from "../../../packages/domain/src/fixtures.js";
import { randomUlid } from "../../../packages/domain/src/ids.js";
import { captureFixture } from "../../../packages/domain/test/agent-capture-fixture.js";
import { issueSyntheticMcpAccess } from "../../../packages/domain/test/helpers.js";
import { LAUNCH_NOW, success } from "../../../packages/domain/test/launch-fixture.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { handleMcpRequest } from "../src/mcp/handler.js";

const EXPIRES_AT = "2026-09-12T12:10:00.000Z";
const QUESTION = "SYNTHETIC-C11-PRIVATE-MCP-CHILD-QUESTION";
const ANSWER = "SYNTHETIC-C11-PRIVATE-MCP-CHILD-ANSWER";
const SUMMARY = "SYNTHETIC-C11-MCP-STRICT-RESULT-SUMMARY";
const handlerEnv = {
  allowedHostnames: ["bfb.example.test"],
  appOrigin: "https://bfb.example.test",
  abuseSecret: "c11-synthetic-child-mcp-abuse-secret-6827b09",
  jurisdiction: "eu" as const,
  now: LAUNCH_NOW,
};
const CHILD_TOOLS = ["bfb_request_human", "bfb_submit_result", "bfb_publish_artifact"] as const;
const UNSUPPORTED_INTENT = [
  ["audience", "private"],
  ["visibility", "private"],
  ["private", true],
] as const;
const BUSINESS_TABLES = [
  "tasks",
  "runs",
  "comments",
  "attention_requests",
  "attention_observations",
  "result_submissions",
  "artifacts",
  "artifact_versions",
  "artifact_upload_grants",
  "artifact_audit_outbox",
  "idempotency_records",
  "semantic_events",
  "audit_events",
  "outbox_records",
] as const;

type ChildTool = (typeof CHILD_TOOLS)[number];
type Fixture = Awaited<ReturnType<typeof captureFixture>>;
interface McpReply {
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
  error?: { code: number; message: string };
}
interface CommandReply<T> {
  ok: boolean;
  result: T;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());

async function fixture() {
  const f = await captureFixture(undefined, false, false, {
    taskCreatorHumanId: FIX.member,
    requestingHumanId: FIX.owner,
  });
  const credential = await issueSyntheticMcpAccess(f.db, {
    humanId: FIX.owner,
    projectId: FIX.projectA,
    taskId: f.task.id,
    scopes: ["bfb:read", "bfb:task:write", "offline_access"],
    now: LAUNCH_NOW,
    expiresAt: EXPIRES_AT,
  });
  return { ...f, ...credential, namespace: createTestWorkspaceHubNamespace(f.db) };
}
type McpFixture = Awaited<ReturnType<typeof fixture>>;

async function call(
  f: McpFixture,
  name: string,
  args: Record<string, unknown>,
  queryDb: SqlDatabase = f.db,
): Promise<McpReply> {
  const response = await handleMcpRequest(
    new Request(`${handlerEnv.appOrigin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
        Host: "bfb.example.test",
        authorization: `Bearer ${f.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "bfb-private-child-test",
              version: "1.0.0",
            },
          },
        },
      }),
    }),
    { db: queryDb, workspaceHubNs: f.namespace, ...handlerEnv },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as McpReply;
}

function value<T>(reply: McpReply): T {
  expect(reply.error).toBeUndefined();
  expect(reply.result?.isError).not.toBe(true);
  const text = reply.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text!) as T;
}

function denied(reply: McpReply): void {
  expect(reply.result?.isError === true || reply.error !== undefined).toBe(true);
}

function argumentsFor(f: Fixture, name: ChildTool): Record<string, unknown> {
  const common = { run_id: f.launch.run_id, request_id: randomUlid() };
  switch (name) {
    case "bfb_request_human":
      return { ...common, kind: "clarification", question: QUESTION, blocking: true };
    case "bfb_submit_result":
      return {
        ...common,
        summary: SUMMARY,
        limitations: "Synthetic mounted schema limits",
        evidence_refs: [{ kind: "comment", ref: "synthetic-comment", version: "1" }],
      };
    case "bfb_publish_artifact":
      return {
        ...common,
        format: "markdown",
        role: "review",
        declared_size: 18,
        expected_digest: "d".repeat(64),
      };
  }
}

async function businessCounts(db: SqlDatabase): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of BUSINESS_TABLES) {
    const row = (await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()) as {
      count: number;
    };
    counts[table] = row.count;
  }
  return counts;
}

async function privateAttention(f: McpFixture): Promise<AttentionRecord> {
  const requested = value<CommandReply<AttentionRecord>>(
    await call(f, "bfb_request_human", argumentsFor(f, "bfb_request_human")),
  );
  expect(requested.ok).toBe(true);
  const answered = success(
    await f.human(answerAttentionCommand, {
      attentionId: requested.result.id,
      expectedVersion: requested.result.resource_version,
      answer: ANSWER,
    }),
  );
  await f.db
    .prepare(
      `INSERT INTO task_privacy
       (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, f.task.id, FIX.member, LAUNCH_NOW);
  await f.db
    .prepare(
      `INSERT INTO task_human_grants
       (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
       VALUES (?, ?, ?, ?, 1, 'read', ?)`,
    )
    .run(FIX.workspace, randomUlid(), f.task.id, FIX.owner, LAUNCH_NOW);
  return answered;
}

function noPrivateChildExistence(reply: McpReply, f: McpFixture, attention: AttentionRecord): void {
  const serialized = JSON.stringify(reply);
  for (const hidden of [
    QUESTION,
    ANSWER,
    attention.id,
    f.task.id,
    f.launch.run_id,
    FIX.projectA,
    FIX.owner,
    FIX.member,
  ]) {
    expect(serialized).not.toContain(hidden);
  }
}

function interleaveRead(
  source: SqlDatabase,
  point: "after_token_resolution" | "before_attention_selection",
  action: () => Promise<void>,
): { queryDb: SqlDatabase; observed: () => boolean } {
  let observed = false;
  const queryDb: SqlDatabase = {
    ...source,
    prepare(sql) {
      const statement = source.prepare(sql);
      return {
        ...statement,
        async get(...parameters) {
          if (
            !observed &&
            point === "before_attention_selection" &&
            sql.includes("SELECT attention.* FROM attention_requests AS attention")
          ) {
            observed = true;
            await action();
          }
          const row = await statement.get(...parameters);
          if (
            !observed &&
            point === "after_token_resolution" &&
            sql.includes("JOIN oauth_delegations d")
          ) {
            observed = true;
            await action();
          }
          return row;
        },
      };
    },
  };
  return { queryDb, observed: () => observed };
}

describe("mounted child MCP intent validation", () => {
  for (const name of CHILD_TOOLS) {
    it.each(UNSUPPORTED_INTENT)(
      `${name} rejects unsupported %s without business writes`,
      async (field, intent) => {
        const f = await fixture();
        const before = await businessCounts(f.db);
        const reply = await call(f, name, { ...argumentsFor(f, name), [field]: intent });
        denied(reply);
        expect(await businessCounts(f.db)).toEqual(before);
      },
    );
  }

  it.each(UNSUPPORTED_INTENT)(
    "bfb_submit_result rejects nested evidence %s without business writes",
    async (field, intent) => {
      const f = await fixture();
      const before = await businessCounts(f.db);
      const reply = await call(f, "bfb_submit_result", {
        ...argumentsFor(f, "bfb_submit_result"),
        evidence_refs: [
          { kind: "comment", ref: "synthetic-comment", version: "1", [field]: intent },
        ],
      });
      denied(reply);
      expect(await businessCounts(f.db)).toEqual(before);
    },
  );

  it.each(CHILD_TOOLS)("%s retains the valid delegated shared path", async (name) => {
    const f = await fixture();
    const before = await businessCounts(f.db);
    const reply = value<CommandReply<Record<string, unknown>>>(
      await call(f, name, argumentsFor(f, name)),
    );
    expect(reply.ok).toBe(true);
    const after = await businessCounts(f.db);
    const target = {
      bfb_request_human: "attention_requests",
      bfb_submit_result: "result_submissions",
      bfb_publish_artifact: "artifacts",
    } as const;
    expect(after[target[name]]).toBe(before[target[name]]! + 1);
    expect(after.idempotency_records).toBe(before.idempotency_records! + 1);
    if (name === "bfb_publish_artifact") {
      expect(after.artifact_versions).toBe(before.artifact_versions! + 1);
      expect(after.artifact_upload_grants).toBe(before.artifact_upload_grants! + 1);
      expect(reply.result.state).toBe("uploading");
    }
  });
});

describe("mounted private attention delegation delivery", () => {
  it("delivers question and committed answer to the current named read grantee", async () => {
    const f = await fixture();
    const attention = await privateAttention(f);
    const read = value<{ attention: AttentionRecord }>(
      await call(f, "bfb_get_attention", { attention_id: attention.id }),
    );
    expect(read.attention).toMatchObject({
      id: attention.id,
      task_id: f.task.id,
      run_id: f.launch.run_id,
      question: QUESTION,
      answer: ANSWER,
      state: "answered",
    });
  });

  it("returns the same missing reply after revoking only the task read grant", async () => {
    const f = await fixture();
    const attention = await privateAttention(f);
    const missing = await call(f, "bfb_get_attention", { attention_id: randomUlid() });
    denied(missing);
    await f.db
      .prepare("UPDATE task_human_grants SET revoked_at = ? WHERE workspace_id = ? AND task_id = ?")
      .run(LAUNCH_NOW, FIX.workspace, f.task.id);
    const hidden = await call(f, "bfb_get_attention", { attention_id: attention.id });
    expect(hidden).toEqual(missing);
    noPrivateChildExistence(hidden, f, attention);
  });

  for (const point of ["after_token_resolution", "before_attention_selection"] as const) {
    it.each(["revocation", "expiry"] as const)(
      `denies delegation %s ${point} while sponsor retains task read access`,
      async (change) => {
        const f = await fixture();
        const attention = await privateAttention(f);
        const missing = await call(f, "bfb_get_attention", { attention_id: randomUlid() });
        denied(missing);
        const interleaved = interleaveRead(f.db, point, async () => {
          const column = change === "revocation" ? "revoked_at" : "expires_at";
          await f.db
            .prepare(`UPDATE oauth_delegations SET ${column} = ? WHERE workspace_id = ? AND id = ?`)
            .run(LAUNCH_NOW, FIX.workspace, f.delegationId);
        });
        const hidden = await call(
          f,
          "bfb_get_attention",
          { attention_id: attention.id },
          interleaved.queryDb,
        );
        expect(interleaved.observed()).toBe(true);
        expect(hidden).toEqual(missing);
        noPrivateChildExistence(hidden, f, attention);
        expect(
          await getAttention(f.db, FIX.workspace, [FIX.projectA], attention.id, {
            workspaceId: FIX.workspace,
            humanId: FIX.owner,
            authorizationEpoch: 1,
          }),
        ).toMatchObject({ question: QUESTION, answer: ANSWER });
      },
    );
  }

  it("uses current selection time if the credential expires after token resolution", async () => {
    const f = await fixture();
    const attention = await privateAttention(f);
    const missing = await call(f, "bfb_get_attention", { attention_id: randomUlid() });
    denied(missing);
    const interleaved = interleaveRead(f.db, "after_token_resolution", async () => {
      vi.setSystemTime(new Date(EXPIRES_AT));
    });
    const hidden = await call(
      f,
      "bfb_get_attention",
      { attention_id: attention.id },
      interleaved.queryDb,
    );
    expect(interleaved.observed()).toBe(true);
    expect(hidden).toEqual(missing);
    noPrivateChildExistence(hidden, f, attention);
  });
});
