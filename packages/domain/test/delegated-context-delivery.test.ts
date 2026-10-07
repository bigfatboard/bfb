// ABOUTME: Exercises delegated context selection, commit and cached delivery under current authority.
// ABOUTME: Canonical immutable identities and independent revocation distinguish empty success from denied delivery.

import { setTimeout as delay } from "node:timers/promises";

import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bumpMemberEpoch } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { revokeDelegation } from "../src/oauth.js";
import {
  addContextCommand,
  createTaskCommand,
  deliverDelegatedAgentContextCommand,
  type AgentContextItem,
} from "../src/work-commands.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";
import { resultStagedD1 } from "./result-fixture.js";

const BODY = "SYNTHETIC-C11-DELEGATED-CONTEXT-BODY";
const HUMAN_BODY = "SYNTHETIC-C11-HUMAN-ONLY-CONTEXT";
const EFFECT_TABLES = [
  "task_context_items",
  "task_context_deliveries",
  "semantic_events",
  "audit_events",
  "outbox_records",
  "idempotency_records",
] as const;

beforeEach(() => {
  vi.useRealTimers();
});

async function fixture(
  humanId: string = FIX.member,
  options: { empty?: boolean; expiry?: string } = {},
) {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db),
    owner = { workspaceId: FIX.workspace, actorHumanId: FIX.owner, authorizationEpoch: 1 };
  const task = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title: "Synthetic delegated context task", priority: "P2" },
    }),
  );
  const other = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title: "Synthetic unrelated context task", priority: "P2" },
    }),
  );
  if (!options.empty) {
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
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS observed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at",
    )
    .get(options.expiry ?? "+1 hour")) as { observed_at: string; expires_at: string };
  const delegationId = randomUlid();
  await db
    .prepare(
      `INSERT INTO oauth_delegations
     (workspace_id,id,human_id,client_id,resource,project_id,task_id,scopes_json,authorization_epoch,expires_at,created_at)
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
  return {
    db,
    hub,
    owner,
    humanId,
    taskId: task.id,
    otherTaskId: other.id,
    delegationId,
    ...clock,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function request(f: Fixture, key: string, taskId = f.taskId) {
  return {
    workspaceId: FIX.workspace,
    actorHumanId: f.humanId,
    actorDelegationId: f.delegationId,
    authorizationEpoch: 1,
    idempotencyKey: key,
    now: "2025-01-01T00:00:00.000Z",
    input: { taskId },
  };
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
              const statement = tx.prepare(sql);
              const selection = sql.includes("task_context_items");
              const cache = sql.includes("FROM idempotency_records");
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
                  parameters[3] === deliverDelegatedAgentContextCommand.name
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

async function grant(f: Fixture) {
  const id = randomUlid();
  await f.db
    .prepare(
      "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)",
    )
    .run(FIX.workspace, id, f.taskId, f.humanId, new Date().toISOString());
  return id;
}

async function clockWitness(f: Fixture) {
  return (await f.db
    .prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS database_now,julianday(expires_at)>julianday('now') AS live FROM oauth_delegations WHERE workspace_id=? AND id=?",
    )
    .get(FIX.workspace, f.delegationId)) as { database_now: string; live: number };
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
  const deliveries = await f.db
    .prepare(
      "SELECT context_version,content_hash,delegation_id,client_id,run_id,delivered_at FROM task_context_deliveries WHERE workspace_id=? AND delegation_id=? ORDER BY context_version",
    )
    .all(FIX.workspace, f.delegationId);
  expect(deliveries).toEqual(
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

describe("delegated context delivery", () => {
  it.each([FIX.owner, FIX.member, FIX.reviewer])(
    "%s delayed read-only delivery and appended-context retry retain canonical subset",
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
        const witness = await clockWitness(f);
        expect(witness.live).toBe(1);
        flushAt = witness.database_now;
      });
      const started = Date.now();
      const outcome = await new WorkspaceHub(
        observePreparation(staged.db, (value) => (at = value)),
      ).execute(deliverDelegatedAgentContextCommand, request(f, key));
      expect(reached).toBe(true);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.error.code);
      expect(outcome.replayed).toBe(false);
      expect(identities(outcome.result)).toEqual(identities(original));
      expect(outcome.result).toEqual(original);
      expect(JSON.stringify(outcome)).not.toContain(HUMAN_BODY);
      expect(Date.parse(at)).toBeGreaterThanOrEqual(started);
      expect(Date.parse(flushAt) - Date.parse(at)).toBeGreaterThanOrEqual(200);
      await assertCommitted(f, before, original, at);
      success(
        await f.hub.execute(addContextCommand, {
          ...f.owner,
          idempotencyKey: randomUlid(),
          input: {
            taskId: f.taskId,
            kind: "constraint",
            audience: "agent",
            body: `${BODY}-APPENDED`,
          },
        }),
      );
      const afterAppend = await effects(f),
        retry = await f.hub.execute(deliverDelegatedAgentContextCommand, request(f, key));
      expect(retry).toEqual({ ...outcome, replayed: true });
      expect(retry.ok && identities(retry.result)).toEqual(identities(original));
      expect(await effects(f)).toEqual(afterAppend);
    },
  );

  it("empty retry remains empty after append and changed-task same key rejects without effects", async () => {
    const f = await fixture(FIX.member, { empty: true }),
      key = randomUlid(),
      before = await effects(f);
    const outcome = await f.hub.execute(deliverDelegatedAgentContextCommand, request(f, key));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.error.code);
    expect(outcome.result).toEqual([]);
    const at = (await f.db
      .prepare(
        "SELECT created_at FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
      )
      .get(FIX.workspace, key)) as { created_at: string };
    await assertCommitted(f, before, [], at.created_at);
    success(
      await f.hub.execute(addContextCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: { taskId: f.taskId, kind: "brief", audience: "agent", body: `${BODY}-AFTER-EMPTY` },
      }),
    );
    const appended = await effects(f),
      retry = await f.hub.execute(deliverDelegatedAgentContextCommand, request(f, key));
    expect(retry).toEqual({ ...outcome, replayed: true });
    expect(await effects(f)).toEqual(appended);
    expect(
      await f.hub.execute(deliverDelegatedAgentContextCommand, request(f, key, f.otherTaskId)),
    ).toMatchObject({ ok: false, error: { code: "request_rejected" } });
    expect(await effects(f)).toEqual(appended);
  });

  it.each([false, true])(
    "production revoke before selection denies with empty=%s without effects",
    async (empty) => {
      const f = await fixture(FIX.member, { empty }),
        before = await effects(f),
        staged = resultStagedD1(f.db),
        key = randomUlid();
      const hooked = hookReads(staged.db, "selection", key, () => revoke(f));
      const outcome = await new WorkspaceHub(hooked.db).execute(
        deliverDelegatedAgentContextCommand,
        request(f, key),
      );
      expect(hooked.observed()).toBe(true);
      expect(outcome).toEqual({
        ok: false,
        error: { code: "not_found", message: "task not found" },
      });
      expect(JSON.stringify(outcome)).not.toContain(BODY);
      expect(await effects(f)).toEqual(before);
      expect(await credential(f)).toMatchObject({ revoked_at: expect.any(String) });
    },
  );

  it("production revoke before staged flush rejects an empty delivery and rolls back its receipts", async () => {
    const f = await fixture(FIX.member, { empty: true }),
      before = await effects(f);
    let reached = false;
    const staged = resultStagedD1(f.db, async () => {
      reached = true;
      await revoke(f);
    });
    const outcome = await new WorkspaceHub(staged.db).execute(
      deliverDelegatedAgentContextCommand,
      request(f, randomUlid()),
    );
    expect(reached).toBe(true);
    expect(outcome).toEqual({
      ok: false,
      error: { code: "command_failed", message: "command failed" },
    });
    expect(await effects(f)).toEqual(before);
    expect(await credential(f)).toMatchObject({ revoked_at: expect.any(String) });
  });

  it.each(["revoked", "epoch", "project", "read_scope", "subtree", "read_grant"] as const)(
    "%s loss before staged flush rolls back all delivery effects",
    async (loss) => {
      const f = await fixture(),
        key = randomUlid();
      let grantId = "";
      if (loss === "read_grant") {
        await f.db
          .prepare(
            "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
          )
          .run(FIX.workspace, f.taskId, FIX.owner, f.observed_at);
        grantId = await grant(f);
      }
      const before = await effects(f);
      let reached = false;
      const staged = resultStagedD1(f.db, async () => {
        reached = true;
        if (loss === "revoked") await revoke(f);
        else if (loss === "epoch")
          expect(await bumpMemberEpoch(f.db, FIX.workspace, f.humanId)).toBe(2);
        else if (loss === "project") {
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
        } else if (loss === "read_scope") {
          await f.db
            .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
            .run(JSON.stringify(["offline_access"]), FIX.workspace, f.delegationId);
          expect(await credential(f)).toMatchObject({
            scopes_json: JSON.stringify(["offline_access"]),
          });
        } else if (loss === "subtree") {
          await f.db
            .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
            .run(f.otherTaskId, FIX.workspace, f.delegationId);
          expect(f.otherTaskId).not.toBe(f.taskId);
          expect(await credential(f)).toMatchObject({ task_id: f.otherTaskId });
        } else {
          await f.db
            .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
            .run(new Date().toISOString(), FIX.workspace, grantId);
          expect(
            await f.db
              .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
              .get(FIX.workspace, grantId),
          ).toMatchObject({ revoked_at: expect.any(String) });
        }
        expect(await cursor(f)).toEqual(before.cursor);
      });
      const outcome = await new WorkspaceHub(staged.db).execute(
        deliverDelegatedAgentContextCommand,
        request(f, key),
      );
      expect(reached).toBe(true);
      expect(outcome).toEqual({
        ok: false,
        error: { code: "command_failed", message: "command failed" },
      });
      expect(await effects(f)).toEqual(before);
      expect(JSON.stringify(outcome)).not.toContain(BODY);
      if (loss === "read_grant") {
        const fresh = await grant(f);
        expect(fresh).not.toBe(grantId);
        const retry = await f.hub.execute(deliverDelegatedAgentContextCommand, request(f, key));
        expect(retry.ok).toBe(true);
        if (!retry.ok) throw new Error(retry.error.code);
        expect(retry.replayed).toBe(false);
        expect(identities(retry.result)).toEqual(identities(await canonical(f)));
        await assertCommitted(
          f,
          before,
          retry.result,
          (
            (await f.db
              .prepare(
                "SELECT created_at FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
              )
              .get(FIX.workspace, key)) as { created_at: string }
          ).created_at,
        );
      }
    },
  );

  it.each([false, true])(
    "revocation after cache hydration denies with empty=%s without rewriting history",
    async (empty) => {
      const f = await fixture(FIX.member, { empty }),
        key = randomUlid();
      success(await f.hub.execute(deliverDelegatedAgentContextCommand, request(f, key)));
      const before = await effects(f),
        hooked = hookReads(resultStagedD1(f.db).db, "cache", key, () => revoke(f));
      const outcome = await new WorkspaceHub(hooked.db).execute(
        deliverDelegatedAgentContextCommand,
        request(f, key),
      );
      expect(hooked.observed()).toBe(true);
      expect(outcome).toEqual({
        ok: false,
        error: { code: "not_found", message: "task not found" },
      });
      expect(JSON.stringify(outcome)).not.toContain(BODY);
      expect(await effects(f)).toEqual(before);
      expect(await credential(f)).toMatchObject({ revoked_at: expect.any(String) });
    },
  );

  it("unchanged credential naturally expires after live batch arrival and rolls back delivery", async () => {
    const f = await fixture(FIX.member, { expiry: "+3 seconds" }),
      before = await effects(f),
      original = await credential(f);
    let liveArrival = false,
      expired = false,
      at = "";
    const staged = resultStagedD1(f.db, async () => {
      liveArrival = (await clockWitness(f)).live === 1;
      expect(liveArrival).toBe(true);
      expect(Date.parse(at)).toBeLessThan(Date.parse(f.expires_at));
      const deadline = performance.now() + 10_000;
      while ((await clockWitness(f)).live === 1) {
        if (performance.now() >= deadline)
          throw new Error("Synthetic context credential did not naturally expire");
        await delay(50);
      }
      expired = (await clockWitness(f)).live === 0;
      expect(expired).toBe(true);
      expect(await credential(f)).toEqual(original);
    });
    const outcome = await new WorkspaceHub(
      observePreparation(staged.db, (value) => (at = value)),
    ).execute(deliverDelegatedAgentContextCommand, request(f, randomUlid()));
    expect(liveArrival).toBe(true);
    expect(expired).toBe(true);
    expect(outcome).toEqual({
      ok: false,
      error: { code: "command_failed", message: "command failed" },
    });
    expect(await effects(f)).toEqual(before);
    expect(await credential(f)).toEqual(original);
  });

  it("robustness: a substituted cached identity is denied while canonical rows and delivery history remain immutable", async () => {
    const f = await fixture(),
      key = randomUlid();
    const original = success(
      await f.hub.execute(deliverDelegatedAgentContextCommand, request(f, key)),
    );
    const row = (await f.db
      .prepare(
        "SELECT result_json FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
      )
      .get(FIX.workspace, key)) as { result_json: string };
    const stored = JSON.parse(row.result_json) as { result: AgentContextItem[] };
    stored.result = [{ ...original[0]!, id: randomUlid(), body: "SYNTHETIC-CORRUPT-CACHED-BODY" }];
    // Deliberate corruption of a disposable cache, not mutation of immutable context/delivery records.
    await f.db
      .prepare(
        "UPDATE idempotency_records SET result_json=? WHERE workspace_id=? AND idempotency_key=?",
      )
      .run(JSON.stringify(stored), FIX.workspace, key);
    const before = await effects(f),
      outcome = await f.hub.execute(deliverDelegatedAgentContextCommand, request(f, key));
    expect(outcome).toEqual({ ok: false, error: { code: "not_found", message: "task not found" } });
    expect(JSON.stringify(outcome)).not.toContain("SYNTHETIC-CORRUPT-CACHED-BODY");
    expect(await effects(f)).toEqual(before);
    expect(identities(await canonical(f))).toEqual(identities(original));
  });

  it("robustness: a retained ID with a trailing newline rejects before canonical selection", async () => {
    const f = await fixture(),
      key = randomUlid();
    const original = success(
      await f.hub.execute(deliverDelegatedAgentContextCommand, request(f, key)),
    );
    const row = (await f.db
      .prepare(
        "SELECT result_json FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
      )
      .get(FIX.workspace, key)) as { result_json: string };
    const stored = JSON.parse(row.result_json) as { result: AgentContextItem[] };
    stored.result = [{ ...original[0]!, id: `${original[0]!.id}\n` }];
    await f.db
      .prepare(
        "UPDATE idempotency_records SET result_json=? WHERE workspace_id=? AND idempotency_key=?",
      )
      .run(JSON.stringify(stored), FIX.workspace, key);
    const before = await effects(f);
    const hooked = hookReads(resultStagedD1(f.db).db, "selection", key, async () => {
      throw new Error("malformed retained identity reached canonical selection");
    });
    const outcome = await new WorkspaceHub(hooked.db).execute(
      deliverDelegatedAgentContextCommand,
      request(f, key),
    );
    expect(hooked.observed()).toBe(false);
    expect(outcome).toEqual({ ok: false, error: { code: "not_found", message: "task not found" } });
    expect(await effects(f)).toEqual(before);
  });

  it("robustness: cached body corruption returns canonical bodies without rewriting the cache", async () => {
    const f = await fixture(),
      key = randomUlid();
    const original = success(
      await f.hub.execute(deliverDelegatedAgentContextCommand, request(f, key)),
    );
    const row = (await f.db
      .prepare(
        "SELECT result_json FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
      )
      .get(FIX.workspace, key)) as { result_json: string };
    const stored = JSON.parse(row.result_json) as { result: AgentContextItem[] };
    stored.result = stored.result.map((item) => ({
      ...item,
      body: "SYNTHETIC-CORRUPT-CACHED-BODY",
    }));
    // Disposable cache body corruption leaves all canonical identities and immutable history intact.
    await f.db
      .prepare(
        "UPDATE idempotency_records SET result_json=? WHERE workspace_id=? AND idempotency_key=?",
      )
      .run(JSON.stringify(stored), FIX.workspace, key);
    const before = await effects(f),
      outcome = await f.hub.execute(deliverDelegatedAgentContextCommand, request(f, key));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.error.code);
    expect(outcome.replayed).toBe(true);
    expect(identities(outcome.result)).toEqual(identities(original));
    expect(outcome.result).toEqual(original);
    expect(JSON.stringify(outcome)).not.toContain("SYNTHETIC-CORRUPT-CACHED-BODY");
    expect(await effects(f)).toEqual(before);
    expect(await canonical(f)).toEqual(original);
  });

  it("robustness: a valid appended item absent from retained delivery history cannot replace the cached subset", async () => {
    const f = await fixture(),
      key = randomUlid();
    const original = success(
      await f.hub.execute(deliverDelegatedAgentContextCommand, request(f, key)),
    );
    const appended = success(
      await f.hub.execute(addContextCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: {
          taskId: f.taskId,
          kind: "constraint",
          audience: "agent",
          body: `${BODY}-NEVER-DELIVERED`,
        },
      }),
    );
    const items = await canonical(f),
      substituted = items.find((item) => item.id === appended.id);
    expect(substituted).toBeDefined();
    expect(identities(original).map((item) => item.id)).not.toContain(appended.id);
    expect(
      await f.db
        .prepare(
          "SELECT id FROM task_context_deliveries WHERE workspace_id=? AND task_id=? AND delegation_id=? AND client_id=? AND context_version=? AND content_hash=?",
        )
        .get(
          FIX.workspace,
          f.taskId,
          f.delegationId,
          FIX.client,
          substituted!.version,
          substituted!.content_hash,
        ),
    ).toBeUndefined();
    const row = (await f.db
      .prepare(
        "SELECT result_json FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
      )
      .get(FIX.workspace, key)) as { result_json: string };
    const stored = JSON.parse(row.result_json) as { result: AgentContextItem[] };
    stored.result = [substituted!];
    // A valid immutable item is deliberately substituted into the disposable cache, not its ledger.
    await f.db
      .prepare(
        "UPDATE idempotency_records SET result_json=? WHERE workspace_id=? AND idempotency_key=?",
      )
      .run(JSON.stringify(stored), FIX.workspace, key);
    const before = await effects(f),
      outcome = await f.hub.execute(deliverDelegatedAgentContextCommand, request(f, key));
    expect(outcome).toEqual({ ok: false, error: { code: "not_found", message: "task not found" } });
    expect(JSON.stringify(outcome)).not.toContain(`${BODY}-NEVER-DELIVERED`);
    expect(await effects(f)).toEqual(before);
    expect(await canonical(f)).toEqual(items);
  });
});
