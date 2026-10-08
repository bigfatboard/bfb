// ABOUTME: Exercises author-private checkpoints through genuine OAuth MCP and registered staged Hub commands.
// ABOUTME: Exact delegation origins, retained credential ceilings and late cuts cannot disclose another origin's history.

import type { SqlDatabase } from "@bfb/db";
import {
  FIX,
  WorkspaceHub,
  createTaskCommand,
  grantTaskSharingCommand,
  loadPrincipal,
  randomUlid,
  readPrivateProgress,
  reportPrivateProgressCommand,
  revokeDelegation,
  revokeTaskSharingCommand,
  type CommandOutcome,
} from "@bfb/domain";
import { describe, expect, it } from "vitest";

import { issueSyntheticMcpAccess, openDomainDb } from "../../../packages/domain/test/helpers.js";
import { success } from "../../../packages/domain/test/launch-fixture.js";
import { resultStagedD1 } from "../../../packages/domain/test/result-fixture.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { handleMcpRequest } from "../src/mcp/handler.js";

const BODY = "SYNTHETIC MCP author-private checkpoint";
const admissions = new WeakMap<SqlDatabase, number>();
type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;
type Receipt = { task_id: string; checkpoint_id: string; content_hash: string };
type View = {
  task_id: string;
  checkpoints: Array<{
    id: string;
    body: string;
    content_hash: string;
    created_at: string;
    origin: "human" | "delegation";
  }>;
  has_more: boolean;
};
type Token = Awaited<ReturnType<typeof issueSyntheticMcpAccess>>;
type Reply = { body?: Row; text: string; isError: boolean; protocolError?: unknown };

async function snapshot(db: SqlDatabase): Promise<Snapshot> {
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  const result: Snapshot = {};
  for (const { name } of tables) {
    if (["sqlite_sequence", "d1_migrations", "_cf_METADATA", "rate_limit_buckets"].includes(name))
      continue;
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    if (name.startsWith("sqlite_") || name.startsWith("_cf_"))
      throw new Error("unexpected engine table");
    result[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()) as Row[];
  }
  return result;
}
async function budgets(db: SqlDatabase) {
  return db.prepare("SELECT * FROM rate_limit_buckets ORDER BY rowid").all();
}
async function integrity(db: SqlDatabase) {
  expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  for (const [name, rows] of Object.entries(await snapshot(db)))
    if (name.endsWith("_guards")) expect(rows, name).toEqual([]);
}
async function unchanged<T>(db: SqlDatabase, run: () => Promise<T>) {
  const before = await snapshot(db),
    http = await budgets(db),
    calls = admissions.get(db) ?? 0,
    result = await run();
  expect(await snapshot(db)).toEqual(before);
  const total = (rows: unknown[]) =>
    rows.reduce<number>((count, row) => count + Number((row as Row).count), 0);
  // MCP admission intentionally increments its abuse bucket; this is not a business effect.
  expect(total(await budgets(db)) - total(http)).toBe((admissions.get(db) ?? 0) - calls);
  await integrity(db);
  return result;
}
async function fixture(humanId: string = FIX.member, scopes = ["bfb:read", "bfb:task:write"]) {
  // The unchanged OAuth helper requires refresh consent; offline_access grants no task read/write authority.
  scopes = [...new Set([...scopes, "offline_access"])];
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db);
  const creator = { workspaceId: FIX.workspace, actorHumanId: FIX.owner, authorizationEpoch: 1 };
  const task = success(
    await hub.execute(createTaskCommand, {
      ...creator,
      idempotencyKey: randomUlid(),
      input: {
        projectId: FIX.projectA,
        title: "SYNTHETIC dormant OAuth checkpoint task",
        priority: "P2",
      },
    }),
  );
  const other = success(
    await hub.execute(createTaskCommand, {
      ...creator,
      idempotencyKey: randomUlid(),
      input: {
        projectId: FIX.projectA,
        title: "SYNTHETIC unrelated checkpoint task",
        priority: "P2",
      },
    }),
  );
  // Explicit dormant creator-private task; no private-create command or provider run.
  await db
    .prepare(
      "INSERT INTO task_privacy(workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, task.id, FIX.owner, new Date().toISOString());
  const grant = success(
    await hub.execute(grantTaskSharingCommand, {
      ...creator,
      idempotencyKey: randomUlid(),
      input: { taskId: task.id, humanId, permission: "contribute", expectedAccessVersion: 1 },
    }),
  );
  const token = await issueSyntheticMcpAccess(db, { humanId, projectId: FIX.projectA, scopes });
  await integrity(db);
  return { db, hub, task, other, creator, grant, humanId, scopes, token };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function call(
  f: Fixture,
  tool: "bfb_get_private_progress" | "bfb_report_private_progress",
  args: Row,
  options: { token?: Token; namespace?: DurableObjectNamespace; database?: SqlDatabase } = {},
): Promise<Reply> {
  const beforeBudget = await budgets(f.db);
  const response = await handleMcpRequest(
    new Request("https://bfb.example.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": tool,
        Host: "bfb.example.test",
        authorization: `Bearer ${(options.token ?? f.token).accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: tool,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "bfb-synthetic-private-checkpoint",
              version: "1.0.0",
            },
          },
        },
      }),
    }),
    {
      db: options.database ?? f.db,
      workspaceHubNs: options.namespace ?? createTestWorkspaceHubNamespace(f.db),
      allowedHostnames: ["bfb.example.test"],
      appOrigin: "https://bfb.example.test",
      abuseSecret: "c11-synthetic-private-checkpoint-abuse-secret-6375ac",
      jurisdiction: "eu",
      now: new Date().toISOString(),
    },
  );
  expect(response.status).toBe(200);
  admissions.set(f.db, (admissions.get(f.db) ?? 0) + 1);
  const total = (rows: unknown[]) =>
    rows.reduce<number>((count, row) => count + Number((row as Row).count), 0);
  expect(total(await budgets(f.db)) - total(beforeBudget)).toBe(1);
  const envelope = (await response.json()) as {
    error?: unknown;
    result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
  };
  const text = envelope.result?.content?.[0]?.text ?? "";
  let body: Row | undefined;
  try {
    body = JSON.parse(text) as Row;
  } catch {
    /* SDK validation and thrown domain errors retain their text wire. */
  }
  return {
    ...(body ? { body } : {}),
    text,
    isError: envelope.result?.isError === true || envelope.error !== undefined,
    ...(envelope.error === undefined ? {} : { protocolError: envelope.error }),
  };
}
async function report(
  f: Fixture,
  options: Parameters<typeof call>[3] = {},
  input = { task_id: f.task.id, body: BODY, request_id: randomUlid() },
) {
  return call(f, "bfb_report_private_progress", input, options);
}
async function view(f: Fixture, options: Parameters<typeof call>[3] = {}): Promise<View> {
  const result = await call(f, "bfb_get_private_progress", { task_id: f.task.id }, options);
  expect(result.isError).toBe(false);
  expect(Object.keys(result.body!)).toEqual(["progress"]);
  const progress = result.body!.progress as View;
  expect(Object.keys(progress).sort()).toEqual(["checkpoints", "has_more", "task_id"]);
  for (const entry of progress.checkpoints)
    expect(Object.keys(entry).sort()).toEqual([
      "body",
      "content_hash",
      "created_at",
      "id",
      "origin",
    ]);
  return progress;
}
function receipt(result: Reply, replayed = false): Receipt {
  expect(result.isError).toBe(false);
  expect(Object.keys(result.body!).sort()).toEqual(["ok", "replayed", "result"]);
  expect(result.body).toMatchObject({ ok: true, replayed });
  const value = result.body!.result as Receipt;
  expect(Object.keys(value).sort()).toEqual(["checkpoint_id", "content_hash", "task_id"]);
  expect(result.text).not.toContain(BODY);
  return value;
}
function denied(result: Reply, code = "not_found") {
  expect(result.isError).toBe(true);
  if (result.body)
    expect(
      typeof result.body.error === "string" ? result.body.error : (result.body.error as Row)?.code,
    ).toBe(code);
  else expect(result.text).toContain(code === "not_found" ? "private progress not found" : code);
  expect(result.text).not.toContain(BODY);
  expect(result.body?.progress).toBeUndefined();
}
function namespaceCut(f: Fixture, phase: "before" | "rpc" | "body", change: () => Promise<void>) {
  const original = createTestWorkspaceHubNamespace(f.db);
  let observed = false,
    after: Snapshot | undefined,
    http: unknown[] | undefined,
    actual: CommandOutcome<Receipt> | undefined;
  const apply = async () => {
    if (observed) return;
    observed = true;
    await change();
    after = await snapshot(f.db);
    http = await budgets(f.db);
  };
  const namespace = {
    idFromName: (name: string) => original.idFromName(name),
    jurisdiction() {
      return namespace;
    },
    get(id: DurableObjectId) {
      const stub = original.get(id);
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          if (phase === "before") await apply();
          const response = await stub.fetch(input, init);
          if (phase === "rpc") {
            actual = (await response.clone().json()) as CommandOutcome<Receipt>;
            expect(actual.ok).toBe(true);
            await apply();
          }
          if (phase === "body") {
            const json = response.json.bind(response);
            response.json = async () => {
              const result: unknown = await json();
              actual = result as CommandOutcome<Receipt>;
              expect(actual.ok).toBe(true);
              await apply();
              return result;
            };
          }
          return response;
        },
      } as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return {
    namespace,
    async unchanged() {
      expect(observed).toBe(true);
      expect(await snapshot(f.db)).toEqual(after);
      expect(await budgets(f.db)).toEqual(http);
      await integrity(f.db);
      return actual;
    },
  };
}
async function revoke(f: Fixture) {
  const cursor = await f.db.prepare("SELECT * FROM workspace_cursors ORDER BY rowid").all();
  await revokeDelegation(f.db, FIX.workspace, f.token.delegationId, new Date().toISOString());
  expect(
    await f.db
      .prepare("SELECT revoked_at FROM oauth_delegations WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.token.delegationId),
  ).toMatchObject({ revoked_at: expect.any(String) });
  expect(await f.db.prepare("SELECT * FROM workspace_cursors ORDER BY rowid").all()).toEqual(
    cursor,
  );
}

describe("remote author-private checkpoints", () => {
  it("same sponsor's two genuine delegations see only their own origins while the human sees both", async () => {
    const f = await fixture(),
      second = await issueSyntheticMcpAccess(f.db, {
        humanId: f.humanId,
        projectId: FIX.projectA,
        scopes: f.scopes,
      });
    const firstReceipt = receipt(await report(f)),
      secondReceipt = receipt(
        await report(
          f,
          { token: second },
          {
            task_id: f.task.id,
            body: "SYNTHETIC second delegation checkpoint",
            request_id: randomUlid(),
          },
        ),
      );
    success(
      await f.hub.execute(reportPrivateProgressCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: f.humanId,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: { taskId: f.task.id, body: "SYNTHETIC direct human checkpoint" },
      }),
    );
    await unchanged(f.db, async () => {
      expect((await view(f)).checkpoints.map((entry) => entry.id)).toEqual([
        firstReceipt.checkpoint_id,
      ]);
      expect((await view(f, { token: second })).checkpoints.map((entry) => entry.id)).toEqual([
        secondReceipt.checkpoint_id,
      ]);
      const human = await readPrivateProgress(
        f.db,
        await loadPrincipal(f.db, FIX.workspace, f.humanId),
        f.task.id,
      );
      expect(human.checkpoints).toHaveLength(3);
      expect(
        human.checkpoints
          .filter((entry) => entry.origin === "delegation")
          .map((entry) => entry.id)
          .sort(),
      ).toEqual([firstReceipt.checkpoint_id, secondReceipt.checkpoint_id].sort());
    });
    await revoke(f);
    expect(
      (
        await readPrivateProgress(
          f.db,
          await loadPrincipal(f.db, FIX.workspace, f.humanId),
          f.task.id,
        )
      ).checkpoints,
    ).toHaveLength(3);
  });

  it("write-only delegation receives a stable minimal receipt without checkpoint read access", async () => {
    const f = await fixture(FIX.member, ["bfb:task:write"]),
      input = { task_id: f.task.id, body: BODY, request_id: randomUlid() };
    const first = receipt(await report(f, {}, input));
    await unchanged(f.db, async () => {
      expect(receipt(await report(f, {}, input), true)).toEqual(first);
      const result = await call(f, "bfb_get_private_progress", { task_id: f.task.id });
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain(BODY);
      denied(await report(f, {}, { ...input, body: `${BODY} changed` }), "request_rejected");
    });
  });

  it("Reviewer task contribution and read-only scope ceilings remain independent", async () => {
    const f = await fixture(FIX.reviewer),
      own = receipt(await report(f));
    expect((await view(f)).checkpoints).toMatchObject([
      { id: own.checkpoint_id, body: BODY, origin: "delegation" },
    ]);
    const readOnly = await issueSyntheticMcpAccess(f.db, {
      humanId: FIX.reviewer,
      projectId: FIX.projectA,
      scopes: ["bfb:read", "offline_access"],
    });
    await unchanged(f.db, async () => {
      expect((await view(f, { token: readOnly })).checkpoints).toEqual([]);
      const result = await report(f, { token: readOnly });
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain(BODY);
    });
  });

  it("strict tool shapes cannot select an owner, audience, run or read request ID", async () => {
    const f = await fixture();
    await unchanged(f.db, async () => {
      for (const extra of [
        { owner_human_id: FIX.owner },
        { audience: "both" },
        { run_id: randomUlid() },
      ]) {
        const result = await call(f, "bfb_report_private_progress", {
          task_id: f.task.id,
          body: BODY,
          request_id: randomUlid(),
          ...extra,
        });
        expect(result.isError).toBe(true);
      }
      expect(
        (
          await call(f, "bfb_get_private_progress", {
            task_id: f.task.id,
            request_id: randomUlid(),
          })
        ).isError,
      ).toBe(true);
      const invalid = await call(f, "bfb_report_private_progress", {
        task_id: f.task.id,
        body: "\u0000",
        request_id: randomUlid(),
      });
      denied(invalid, "invalid_argument");
    });
  });

  it.each(["project_to_null", "task_to_target", "client"] as const)(
    "%s before actual Hub cannot replace the captured nullable credential ceiling",
    async (loss) => {
      const f = await fixture();
      const cut = namespaceCut(f, "before", async () => {
        if (loss === "project_to_null")
          await f.db
            .prepare("UPDATE oauth_delegations SET project_id=NULL WHERE workspace_id=? AND id=?")
            .run(FIX.workspace, f.token.delegationId);
        if (loss === "task_to_target")
          await f.db
            .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
            .run(f.task.id, FIX.workspace, f.token.delegationId);
        if (loss === "client") {
          // A genuine existing client is unnecessary for this cut: the FK permits the recorded client string.
          await f.db
            .prepare("UPDATE oauth_delegations SET client_id=? WHERE workspace_id=? AND id=?")
            .run("bfb-synthetic-other-client", FIX.workspace, f.token.delegationId);
        }
        expect(
          await f.db
            .prepare(
              "SELECT project_id,task_id,client_id FROM oauth_delegations WHERE workspace_id=? AND id=?",
            )
            .get(FIX.workspace, f.token.delegationId),
        ).toMatchObject(
          loss === "project_to_null"
            ? { project_id: null }
            : loss === "task_to_target"
              ? { task_id: f.task.id }
              : { client_id: "bfb-synthetic-other-client" },
        );
      });
      denied(await report(f, { namespace: cut.namespace }));
      await cut.unchanged();
    },
  );

  it("independent production revocation before staged batch rolls back all checkpoint effects", async () => {
    const f = await fixture();
    let after: Snapshot | undefined,
      http: unknown[] | undefined,
      observed = false;
    const staged = resultStagedD1(f.db, async () => {
      observed = true;
      await revoke(f);
      after = await snapshot(f.db);
      http = await budgets(f.db);
    });
    denied(
      await report(f, { namespace: createTestWorkspaceHubNamespace(staged.db) }),
      "command_failed",
    );
    expect(observed).toBe(true);
    expect(await snapshot(f.db)).toEqual(after);
    expect(await budgets(f.db)).toEqual(http);
    await integrity(f.db);
  });

  it.each(["rpc", "body", "cached_body"] as const)(
    "post-Hub %s revocation withholds the receipt but preserves committed history",
    async (phase) => {
      const f = await fixture(),
        input = { task_id: f.task.id, body: BODY, request_id: randomUlid() };
      if (phase === "cached_body") receipt(await report(f, {}, input));
      const cut = namespaceCut(f, phase === "rpc" ? "rpc" : "body", () => revoke(f));
      denied(await report(f, { namespace: cut.namespace }, input));
      const actual = await cut.unchanged();
      expect(actual).toMatchObject({ ok: true, replayed: phase === "cached_body" });
      expect(
        await f.db
          .prepare("SELECT count(*) AS n FROM task_private_checkpoints WHERE task_id=?")
          .get(f.task.id),
      ).toEqual({ n: 1 });
    },
  );

  it("task contribution loss before final read denies useful history, not an empty success", async () => {
    const f = await fixture();
    receipt(await report(f));
    let observed = false,
      after: Snapshot | undefined;
    const database: SqlDatabase = {
      prepare(sql) {
        const statement = f.db.prepare(sql);
        return {
          run: (...values) => statement.run(...values),
          all: (...values) => statement.all(...values),
          async get(...values) {
            if (!observed && sql.includes("private_checkpoint_task AS MATERIALIZED")) {
              observed = true;
              success(
                await f.hub.execute(revokeTaskSharingCommand, {
                  ...f.creator,
                  idempotencyKey: randomUlid(),
                  input: { taskId: f.task.id, grantId: f.grant.grant_id, expectedAccessVersion: 2 },
                }),
              );
              after = await snapshot(f.db);
            }
            return statement.get(...values);
          },
        };
      },
      withTransaction: (run) => f.db.withTransaction(run),
    };
    denied(await call(f, "bfb_get_private_progress", { task_id: f.task.id }, { database }));
    expect(observed).toBe(true);
    expect(await snapshot(f.db)).toEqual(after);
    await integrity(f.db);
  });
});
