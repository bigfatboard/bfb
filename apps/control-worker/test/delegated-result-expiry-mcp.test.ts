// ABOUTME: Exercises natural delegated result expiry through genuine authenticated MCP and the committing Hub.
// ABOUTME: Staged batches compare complete rollback with a delayed live control using unchanged credential rows.

import { setTimeout as delay } from "node:timers/promises";

import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FIX } from "../../../packages/domain/src/fixtures.js";
import { WorkspaceHub } from "../../../packages/domain/src/hub.js";
import { randomUlid } from "../../../packages/domain/src/ids.js";
import type { SubmitDelegatedResultResult } from "../../../packages/domain/src/remote-parity.js";
import { createTaskCommand } from "../../../packages/domain/src/work-commands.js";
import { createRunCommand } from "../../../packages/domain/src/work-records.js";
import { issueSyntheticMcpAccess, openDomainDb } from "../../../packages/domain/test/helpers.js";
import { success } from "../../../packages/domain/test/launch-fixture.js";
import { resultStagedD1 } from "../../../packages/domain/test/result-fixture.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { handleMcpRequest } from "../src/mcp/handler.js";

const SUMMARY = "SYNTHETIC-C11-MCP-DELEGATED-RESULT-EXPIRY";
const RECEIPTS = ["semantic_events", "audit_events", "outbox_records", "idempotency_records"];

beforeEach(() => {
  vi.useRealTimers();
});

async function fixture(modifier: "+3 seconds" | "+10 minutes") {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db),
    request = {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
    };
  const task = success(
    await hub.execute(createTaskCommand, {
      ...request,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title: "Synthetic MCP commit-expiry task", priority: "P2" },
    }),
  );
  const run = success(
    await hub.execute(createRunCommand, {
      ...request,
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
    .get(modifier)) as { observed_at: string; expires_at: string };
  const auth = await issueSyntheticMcpAccess(db, {
    humanId: FIX.member,
    projectId: FIX.projectA,
    taskId: task.id,
    scopes: ["bfb:read", "bfb:task:write", "offline_access"],
    now: clock.observed_at,
    expiresAt: clock.expires_at,
  });
  return { db, taskId: task.id, runId: run.run.id, ...clock, ...auth };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Outcome =
  | { ok: true; result: SubmitDelegatedResultResult; replayed: boolean }
  | { ok: false; error: { code: string; message: string } };

async function credential(f: Fixture) {
  return f.db
    .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
    .get(FIX.workspace, f.delegationId);
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

async function effects(f: Fixture) {
  const receipts: Record<string, number> = {};
  for (const table of [...RECEIPTS, "result_submissions"]) {
    const row = (await f.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id=?`)
      .get(FIX.workspace)) as { n: number };
    receipts[table] = row.n;
  }
  return {
    receipts,
    run: (await f.db
      .prepare("SELECT result_state,resource_version FROM runs WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.runId)) as { result_state: string; resource_version: number },
    task: (await f.db
      .prepare("SELECT state,resource_version FROM tasks WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.taskId)) as { state: string; resource_version: number },
    cursor: (await f.db
      .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
      .get(FIX.workspace)) as { cursor: number },
    artifactGuards: await f.db.prepare("SELECT id FROM artifact_mutation_guards").all(),
    runnerGuards: await f.db.prepare("SELECT id FROM runner_mutation_guards").all(),
  };
}

function observeSubmission(db: SqlDatabase, observe: (at: string) => void): SqlDatabase {
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
                if (sql.includes("INSERT INTO result_submissions")) {
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

async function call(f: Fixture, committingDb: SqlDatabase, requestId: string) {
  const response = await handleMcpRequest(
    new Request("https://bfb.example.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "bfb_submit_result",
        Host: "bfb.example.test",
        authorization: `Bearer ${f.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "bfb_submit_result",
          arguments: {
            run_id: f.runId,
            summary: SUMMARY,
            evidence_refs: [],
            request_id: requestId,
          },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "bfb-synthetic-result-expiry",
              version: "1.0.0",
            },
          },
        },
      }),
    }),
    {
      // OAuth resolution stays on the original DB; the actual committing Hub is staged.
      db: f.db,
      workspaceHubNs: createTestWorkspaceHubNamespace(committingDb),
      allowedHostnames: ["bfb.example.test"],
      appOrigin: "https://bfb.example.test",
      abuseSecret: "c11-synthetic-result-expiry-abuse-secret-6953bb",
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

describe("mounted delegated result commit expiry", () => {
  it.each(["natural_expiry", "unexpired"] as const)(
    "%s retains authenticated admission and the staged Hub commit boundary",
    async (mode) => {
      const f = await fixture(mode === "natural_expiry" ? "+3 seconds" : "+10 minutes"),
        before = await effects(f),
        originalCredential = await credential(f),
        key = randomUlid();
      let reachedWhileLive = false,
        flushWitness = false,
        observedAt = "",
        flushAt = "";
      const staged = resultStagedD1(f.db, async () => {
        const reached = await clockWitness(f);
        reachedWhileLive = reached.live === 1;
        expect(reachedWhileLive).toBe(true);
        expect(Date.parse(observedAt)).toBeLessThan(Date.parse(f.expires_at));
        if (mode === "natural_expiry") {
          const deadline = performance.now() + 10_000;
          while ((await clockWitness(f)).live === 1) {
            if (performance.now() >= deadline)
              throw new Error("Synthetic MCP delegation did not naturally expire in time");
            await delay(50);
          }
        } else await delay(250);
        const flush = await clockWitness(f);
        flushWitness = flush.live === (mode === "natural_expiry" ? 0 : 1);
        flushAt = flush.database_now;
        expect(flushWitness).toBe(true);
        expect(await credential(f)).toEqual(originalCredential);
      });
      const started = Date.now(),
        { outcome, isError } = await call(
          f,
          observeSubmission(staged.db, (at) => (observedAt = at)),
          key,
        );
      expect(reachedWhileLive).toBe(true);
      expect(flushWitness).toBe(true);
      expect(Date.parse(observedAt)).toBeGreaterThanOrEqual(started);
      expect(await credential(f)).toEqual(originalCredential);
      if (mode === "natural_expiry") {
        expect(Date.parse(flushAt)).toBeGreaterThanOrEqual(Date.parse(f.expires_at));
        expect(isError).toBe(true);
        expect(outcome).toEqual({
          ok: false,
          error: { code: "command_failed", message: "command failed" },
        });
        expect(JSON.stringify(outcome)).not.toContain(SUMMARY);
        expect(await effects(f)).toEqual(before);
      } else {
        expect(isError).not.toBe(true);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw new Error(outcome.error.code);
        expect(Object.keys(outcome).sort()).toEqual(["ok", "replayed", "result"]);
        expect(outcome.replayed).toBe(false);
        expect(outcome.result.submission.evidence_refs).toEqual([]);
        expect(outcome.result.submission.submitted_at).toBe(observedAt);
        expect(Date.parse(flushAt) - Date.parse(observedAt)).toBeGreaterThanOrEqual(200);
        expect(await effects(f)).toEqual({
          ...before,
          receipts: Object.fromEntries(
            Object.entries(before.receipts).map(([table, n]) => [table, n + 1]),
          ),
          run: { result_state: "submitted", resource_version: before.run.resource_version + 1 },
          task: { state: "review", resource_version: before.task.resource_version + 1 },
          cursor: { cursor: before.cursor.cursor + 1 },
        });
        for (const [table, field] of [
          ["semantic_events", "kind"],
          ["audit_events", "action"],
          ["outbox_records", "kind"],
        ])
          expect(
            await f.db
              .prepare(`SELECT created_at FROM ${table} WHERE workspace_id=? AND ${field}=?`)
              .all(FIX.workspace, "result.submit.delegation"),
          ).toEqual([{ created_at: observedAt }]);
        expect(
          await f.db
            .prepare(
              "SELECT created_at FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
            )
            .get(FIX.workspace, key),
        ).toEqual({ created_at: observedAt });
      }
    },
  );
});
