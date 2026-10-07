// ABOUTME: Exercises current delegated context delivery through genuine OAuth MCP and the committing Hub.
// ABOUTME: Selection, cache, batch and post-Hub revocation retain history while withholding unauthorized context.

import { setTimeout as delay } from "node:timers/promises";

import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FIX } from "../../../packages/domain/src/fixtures.js";
import { WorkspaceHub, type CommandOutcome } from "../../../packages/domain/src/hub.js";
import { randomUlid } from "../../../packages/domain/src/ids.js";
import { revokeDelegation } from "../../../packages/domain/src/oauth.js";
import {
  addContextCommand,
  createTaskCommand,
  type AgentContextItem,
} from "../../../packages/domain/src/work-commands.js";
import { issueSyntheticMcpAccess, openDomainDb } from "../../../packages/domain/test/helpers.js";
import { success } from "../../../packages/domain/test/launch-fixture.js";
import { resultStagedD1 } from "../../../packages/domain/test/result-fixture.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { handleMcpRequest } from "../src/mcp/handler.js";

const BODY = "SYNTHETIC-C11-MCP-DELEGATED-CONTEXT-BODY";
const HUMAN_BODY = "SYNTHETIC-C11-MCP-HUMAN-ONLY-CONTEXT";
const EFFECT_TABLES = [
  "task_context_items",
  "task_context_deliveries",
  "semantic_events",
  "audit_events",
  "outbox_records",
  "idempotency_records",
] as const;
type ContextReply = {
  context?: AgentContextItem[];
  error?: string | { code: string; message: string };
};

beforeEach(() => {
  vi.useRealTimers();
});

async function fixture(humanId: string = FIX.member, empty = false) {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db),
    owner = { workspaceId: FIX.workspace, actorHumanId: FIX.owner, authorizationEpoch: 1 };
  const task = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title: "Synthetic MCP context task", priority: "P2" },
    }),
  );
  const other = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: {
        projectId: FIX.projectA,
        title: "Synthetic unrelated MCP context task",
        priority: "P2",
      },
    }),
  );
  if (!empty) {
    for (const [audience, body] of [
      ["human", HUMAN_BODY],
      ["agent", BODY],
      ["both", `${BODY}-BOTH`],
    ] as const)
      success(
        await hub.execute(addContextCommand, {
          ...owner,
          idempotencyKey: randomUlid(),
          input: { taskId: task.id, kind: "brief", audience, body },
        }),
      );
  }
  const clock = (await db
    .prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS observed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes') AS expires_at",
    )
    .get()) as { observed_at: string; expires_at: string };
  const auth = await issueSyntheticMcpAccess(db, {
    humanId,
    projectId: FIX.projectA,
    scopes: ["bfb:read", "offline_access"],
    now: clock.observed_at,
    expiresAt: clock.expires_at,
  });
  return { db, humanId, taskId: task.id, otherTaskId: other.id, ...clock, ...auth };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function call(f: Fixture, namespace: DurableObjectNamespace, key: string) {
  const response = await handleMcpRequest(
    new Request("https://bfb.example.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "bfb_get_context",
        Host: "bfb.example.test",
        authorization: `Bearer ${f.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "bfb_get_context",
          arguments: { task_id: f.taskId, request_id: key },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "bfb-synthetic-context-delivery",
              version: "1.0.0",
            },
          },
        },
      }),
    }),
    {
      // Resolve actual OAuth through the original database, not the staged mutation adapter.
      db: f.db,
      workspaceHubNs: namespace,
      allowedHostnames: ["bfb.example.test"],
      appOrigin: "https://bfb.example.test",
      abuseSecret: "c11-synthetic-context-delivery-abuse-secret-6375ac",
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
  return { body: JSON.parse(text!) as ContextReply, isError: reply.result?.isError };
}

async function canonical(f: Fixture) {
  return (await f.db
    .prepare(
      "SELECT id,kind,body,version,audience,content_hash,created_at FROM task_context_items WHERE workspace_id=? AND task_id=? AND audience IN ('agent','both') ORDER BY version",
    )
    .all(FIX.workspace, f.taskId)) as AgentContextItem[];
}
const identities = (items: AgentContextItem[]) =>
  items.map(({ id, version, content_hash, audience }) => ({ id, version, content_hash, audience }));

async function cursor(f: Fixture) {
  return f.db
    .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
    .get(FIX.workspace);
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
    cursor: await cursor(f),
    tasks: await f.db
      .prepare("SELECT * FROM tasks WHERE workspace_id=? ORDER BY rowid")
      .all(FIX.workspace),
    artifactGuards: await f.db.prepare("SELECT * FROM artifact_mutation_guards ORDER BY id").all(),
    runnerGuards: await f.db.prepare("SELECT * FROM runner_mutation_guards ORDER BY id").all(),
  };
}
async function revoke(f: Fixture) {
  const beforeCursor = await cursor(f);
  await revokeDelegation(f.db, FIX.workspace, f.delegationId, new Date().toISOString());
  expect(await credential(f)).toMatchObject({ revoked_at: expect.any(String) });
  expect(await cursor(f)).toEqual(beforeCursor);
}

function hookReads(
  db: SqlDatabase,
  mode: "selection" | "cache",
  key: string,
  change: () => Promise<void>,
) {
  let changed = false;
  return {
    db: {
      ...db,
      withTransaction(work) {
        return db.withTransaction((tx) =>
          work({
            ...tx,
            prepare(sql) {
              const statement = tx.prepare(sql),
                selection = sql.includes("task_context_items"),
                cache = sql.includes("FROM idempotency_records");
              return {
                ...statement,
                async get(...parameters) {
                  if (!changed && mode === "selection" && selection) {
                    changed = true;
                    await change();
                  }
                  const row = await statement.get(...parameters);
                  if (!changed && mode === "cache" && cache && parameters.includes(key) && row) {
                    changed = true;
                    await change();
                  }
                  return row;
                },
                async all(...parameters) {
                  if (!changed && mode === "selection" && selection) {
                    changed = true;
                    await change();
                  }
                  return statement.all(...parameters);
                },
              };
            },
          }),
        );
      },
    } satisfies SqlDatabase,
    observed: () => changed,
  };
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
                if (
                  sql.includes("INSERT INTO semantic_events") &&
                  parameters[3] === "context.deliver.delegation"
                ) {
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

function beforeActualHub(db: SqlDatabase, change: () => Promise<void>): DurableObjectNamespace {
  const original = createTestWorkspaceHubNamespace(db);
  const namespace = {
    ...original,
    get(id: DurableObjectId) {
      const stub = original.get(id);
      return {
        ...stub,
        async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          // The genuine MCP handler has already resolved OAuth and captured its original boundary.
          await change();
          return stub.fetch(input, init);
        },
      } as DurableObjectStub;
    },
    jurisdiction() {
      return namespace as DurableObjectNamespace;
    },
  };
  return namespace as DurableObjectNamespace;
}

function afterActualHub(
  db: SqlDatabase,
  change: (outcome: CommandOutcome<AgentContextItem[]>) => Promise<void>,
): DurableObjectNamespace {
  const original = createTestWorkspaceHubNamespace(db);
  const namespace = {
    ...original,
    get(id: DurableObjectId) {
      const stub = original.get(id);
      return {
        ...stub,
        async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          const response = await stub.fetch(input, init);
          expect(response.ok).toBe(true);
          const outcome = (await response.clone().json()) as CommandOutcome<AgentContextItem[]>;
          expect(outcome.ok).toBe(true);
          await change(outcome);
          return response;
        },
      } as DurableObjectStub;
    },
    jurisdiction() {
      return namespace as DurableObjectNamespace;
    },
  };
  return namespace as DurableObjectNamespace;
}

async function assertCommitted(
  f: Fixture,
  before: Awaited<ReturnType<typeof effects>>,
  items: AgentContextItem[],
  at: string,
) {
  const after = await effects(f);
  for (const table of EFFECT_TABLES)
    expect(after.rows[table]!.length).toBe(
      before.rows[table]!.length +
        (table === "task_context_items"
          ? 0
          : table === "task_context_deliveries"
            ? items.length
            : 1),
    );
  expect(after.tasks).toEqual(before.tasks);
  expect(after.artifactGuards).toEqual(before.artifactGuards);
  expect(after.runnerGuards).toEqual(before.runnerGuards);
  expect(after.cursor).toEqual({ cursor: (before.cursor as { cursor: number }).cursor + 1 });
  expect(
    await f.db
      .prepare(
        "SELECT context_version,content_hash,delegation_id,client_id,run_id,delivered_at FROM task_context_deliveries WHERE workspace_id=? AND delegation_id=? ORDER BY context_version",
      )
      .all(FIX.workspace, f.delegationId),
  ).toEqual(
    items.map((item) => ({
      context_version: item.version,
      content_hash: item.content_hash,
      delegation_id: f.delegationId,
      client_id: FIX.client,
      run_id: null,
      delivered_at: at,
    })),
  );
  for (const table of ["semantic_events", "audit_events", "outbox_records"])
    expect(JSON.stringify(after.rows[table])).not.toContain(BODY);
  for (const table of ["semantic_events", "audit_events", "outbox_records", "idempotency_records"])
    expect((after.rows[table]!.at(-1) as { created_at: string }).created_at).toBe(at);
  return after;
}

describe("mounted delegated context delivery", () => {
  it.each([FIX.owner, FIX.member, FIX.reviewer])(
    "%s genuine read-only OAuth delivery commits after a healthy delay",
    async (humanId) => {
      const f = await fixture(humanId),
        original = await canonical(f),
        before = await effects(f),
        key = randomUlid();
      let reached = false,
        at = "",
        flushAt = "";
      const staged = resultStagedD1(f.db, async () => {
        reached = true;
        expect(at).not.toBe("");
        await delay(250);
        const witness = (await f.db
          .prepare(
            "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS database_now,julianday(expires_at)>julianday('now') AS live FROM oauth_delegations WHERE workspace_id=? AND id=?",
          )
          .get(FIX.workspace, f.delegationId)) as { database_now: string; live: number };
        expect(witness.live).toBe(1);
        flushAt = witness.database_now;
      });
      const started = Date.now(),
        reply = await call(
          f,
          createTestWorkspaceHubNamespace(observePreparation(staged.db, (value) => (at = value))),
          key,
        );
      expect(reached).toBe(true);
      expect(reply.isError).not.toBe(true);
      expect(reply.body).toEqual({ context: original });
      expect(identities(reply.body.context!)).toEqual(identities(original));
      expect(JSON.stringify(reply.body)).not.toContain(HUMAN_BODY);
      expect(Date.parse(at)).toBeGreaterThanOrEqual(started);
      expect(Date.parse(flushAt) - Date.parse(at)).toBeGreaterThanOrEqual(200);
      const committed = await assertCommitted(f, before, original, at),
        retry = await call(f, createTestWorkspaceHubNamespace(f.db), key);
      expect(retry.isError).not.toBe(true);
      expect(retry.body).toEqual({ context: original });
      expect(identities(retry.body.context!)).toEqual(identities(original));
      expect(await effects(f)).toEqual(committed);
    },
  );

  it("revocation immediately before selection denies even an empty authorized page without effects", async () => {
    const f = await fixture(FIX.member, true),
      before = await effects(f),
      key = randomUlid();
    const hooked = hookReads(resultStagedD1(f.db).db, "selection", key, () => revoke(f));
    const reply = await call(f, createTestWorkspaceHubNamespace(hooked.db), key);
    expect(hooked.observed()).toBe(true);
    expect(reply.isError).toBe(true);
    expect(reply.body).toEqual({ error: { code: "not_found", message: "task not found" } });
    expect(reply.body.context).toBeUndefined();
    expect(await effects(f)).toEqual(before);
  });

  it("production revocation after preparation but before batch rolls back all context delivery effects", async () => {
    const f = await fixture(),
      before = await effects(f);
    let reached = false;
    const staged = resultStagedD1(f.db, async () => {
      reached = true;
      await revoke(f);
    });
    const reply = await call(f, createTestWorkspaceHubNamespace(staged.db), randomUlid());
    expect(reached).toBe(true);
    expect(reply.isError).toBe(true);
    expect(reply.body).toEqual({ error: { code: "command_failed", message: "command failed" } });
    expect(JSON.stringify(reply.body)).not.toContain(BODY);
    expect(await effects(f)).toEqual(before);
    expect(await credential(f)).toMatchObject({ revoked_at: expect.any(String) });
  });

  it("revocation after actual idempotency hydration withholds a nonempty saved subset without erasing history", async () => {
    const f = await fixture(),
      key = randomUlid(),
      original = await canonical(f);
    const initial = await call(f, createTestWorkspaceHubNamespace(f.db), key);
    expect(initial.isError).not.toBe(true);
    expect(identities(initial.body.context!)).toEqual(identities(original));
    const before = await effects(f),
      hooked = hookReads(resultStagedD1(f.db).db, "cache", key, () => revoke(f));
    const reply = await call(f, createTestWorkspaceHubNamespace(hooked.db), key);
    expect(hooked.observed()).toBe(true);
    expect(reply.isError).toBe(true);
    expect(reply.body).toEqual({ error: { code: "not_found", message: "task not found" } });
    expect(reply.body.context).toBeUndefined();
    expect(JSON.stringify(reply.body)).not.toContain(BODY);
    expect(await effects(f)).toEqual(before);
    expect(await credential(f)).toMatchObject({ revoked_at: expect.any(String) });
  });

  it.each(["project_to_null", "task_to_current_target"] as const)(
    "%s before genuine Hub fetch cannot replace the originally authenticated nullable boundary",
    async (change) => {
      const f = await fixture(),
        before = await effects(f);
      expect(await credential(f)).toMatchObject({ project_id: FIX.projectA, task_id: null });
      let observed = false;
      const namespace = beforeActualHub(resultStagedD1(f.db).db, async () => {
        observed = true;
        if (change === "project_to_null") {
          await f.db
            .prepare("UPDATE oauth_delegations SET project_id=NULL WHERE workspace_id=? AND id=?")
            .run(FIX.workspace, f.delegationId);
          expect(await credential(f)).toMatchObject({ project_id: null, task_id: null });
        } else {
          await f.db
            .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
            .run(f.taskId, FIX.workspace, f.delegationId);
          expect(await credential(f)).toMatchObject({
            project_id: FIX.projectA,
            task_id: f.taskId,
          });
        }
        expect(await cursor(f)).toEqual(before.cursor);
        expect(await effects(f)).toEqual(before);
      });
      const reply = await call(f, namespace, randomUlid());
      expect(observed).toBe(true);
      expect(reply.isError).toBe(true);
      expect(reply.body).toEqual({ error: { code: "not_found", message: "task not found" } });
      expect(reply.body.context).toBeUndefined();
      expect(JSON.stringify(reply.body)).not.toContain(BODY);
      expect(await effects(f)).toEqual(before);
      expect(await credential(f)).toMatchObject(
        change === "project_to_null"
          ? { project_id: null, task_id: null }
          : { project_id: FIX.projectA, task_id: f.taskId },
      );
    },
  );

  it.each(["revoked", "project_to_null"] as const)(
    "genuine namespace post-Hub %s withholds context but preserves the already committed delivery",
    async (change) => {
      const f = await fixture(),
        before = await effects(f),
        original = await canonical(f);
      let observed = false,
        committed: Awaited<ReturnType<typeof effects>> | undefined;
      const namespace = afterActualHub(resultStagedD1(f.db).db, async (outcome) => {
        observed = true;
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw new Error(outcome.error.code);
        expect(identities(outcome.result)).toEqual(identities(original));
        const row = (await f.db
          .prepare(
            "SELECT delivered_at FROM task_context_deliveries WHERE workspace_id=? AND delegation_id=? ORDER BY context_version LIMIT 1",
          )
          .get(FIX.workspace, f.delegationId)) as { delivered_at: string };
        committed = await assertCommitted(f, before, original, row.delivered_at);
        if (change === "revoked") await revoke(f);
        else {
          expect(await credential(f)).toMatchObject({ project_id: FIX.projectA, task_id: null });
          await f.db
            .prepare("UPDATE oauth_delegations SET project_id=NULL WHERE workspace_id=? AND id=?")
            .run(FIX.workspace, f.delegationId);
          expect(await credential(f)).toMatchObject({ project_id: null, task_id: null });
          expect(await cursor(f)).toEqual(committed.cursor);
        }
        expect(await effects(f)).toEqual(committed);
      });
      const reply = await call(f, namespace, randomUlid());
      expect(observed).toBe(true);
      expect(committed).toBeDefined();
      expect(reply.isError).toBe(true);
      expect(reply.body).toEqual({ error: "not_found" });
      expect(reply.body.context).toBeUndefined();
      expect(JSON.stringify(reply.body)).not.toContain(BODY);
      expect(await effects(f)).toEqual(committed);
      expect(await credential(f)).toMatchObject(
        change === "revoked"
          ? { revoked_at: expect.any(String) }
          : { project_id: null, task_id: null },
      );
    },
  );
});
