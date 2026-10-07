// ABOUTME: Exercises the final canonical delegated task selector with retained identity and current read authority.
// ABOUTME: Read-only history, parent redaction and database-clock expiry must not create business effects.

import { setTimeout as delay } from "node:timers/promises";

import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { revokeDelegation } from "../src/oauth.js";
import {
  createTaskCommand,
  getDelegatedTask,
  getTask,
  updateTaskCommand,
} from "../src/work-commands.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";

const TITLE = "SYNTHETIC-C11-FINAL-DELEGATED-TASK-TITLE";
const PUNCHLINE = "SYNTHETIC-C11-FINAL-DELEGATED-TASK-PUNCHLINE";
const EFFECT_TABLES = [
  "tasks",
  "semantic_events",
  "audit_events",
  "outbox_records",
  "idempotency_records",
  "task_context_items",
  "task_context_deliveries",
  "comments",
  "runs",
  "attention_requests",
  "attention_observations",
  "notification_deliveries",
] as const;

beforeEach(() => vi.useRealTimers());

async function fixture(
  humanId: string = FIX.member,
  options: { state?: "ready" | "done" | "cancelled"; parent?: boolean; expiry?: string } = {},
) {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db),
    owner = { workspaceId: FIX.workspace, actorHumanId: FIX.owner, authorizationEpoch: 1 };
  const parent = options.parent
    ? success(
        await hub.execute(createTaskCommand, {
          ...owner,
          idempotencyKey: randomUlid(),
          input: { projectId: FIX.projectA, title: "Synthetic final task parent", priority: "P2" },
        }),
      )
    : undefined;
  let task = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: {
        projectId: FIX.projectA,
        title: TITLE,
        punchline: PUNCHLINE,
        priority: "P2",
        ...(parent ? { parentTaskId: parent.id } : {}),
      },
    }),
  );
  for (const state of options.state === "done"
    ? (["active", "review", "done"] as const)
    : options.state === "cancelled"
      ? (["cancelled"] as const)
      : [])
    task = success(
      await hub.execute(updateTaskCommand, {
        ...owner,
        idempotencyKey: randomUlid(),
        input: { taskId: task.id, expectedVersion: task.resource_version, state },
      }),
    );
  const clock = (await db
    .prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS observed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at",
    )
    .get(options.expiry ?? "+1 hour")) as { observed_at: string; expires_at: string };
  const delegationId = randomUlid();
  await db
    .prepare(
      `INSERT INTO oauth_delegations
    (workspace_id,id,human_id,client_id,resource,project_id,task_id,scopes_json,
     authorization_epoch,expires_at,created_at) VALUES (?,?,?,?,'https://bfb.example.test/mcp',?,NULL,?,1,?,?)`,
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
  expect(await getTask(db, FIX.workspace, task.id, access)).toEqual(task);
  return { db, hub, owner, humanId, task, parent, delegationId, access, ...clock };
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
async function grant(f: Fixture, taskId: string, id = randomUlid()) {
  await f.db
    .prepare(
      "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)",
    )
    .run(FIX.workspace, id, taskId, f.humanId, new Date().toISOString());
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

describe("final delegated task selector", () => {
  it.each([
    { humanId: FIX.owner, state: "ready" as const },
    { humanId: FIX.member, state: "done" as const },
    { humanId: FIX.reviewer, state: "cancelled" as const },
  ])(
    "$humanId read-only $state history uses one final SELECT without effects",
    async ({ humanId, state }) => {
      const f = await fixture(humanId, { state }),
        before = await effects(f),
        reads: string[] = [];
      await delay(250);
      const db = {
        ...f.db,
        prepare(sql: string) {
          const statement = f.db.prepare(sql);
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
      } satisfies SqlDatabase;
      expect(await getDelegatedTask(db, FIX.workspace, f.task, f.access)).toEqual(f.task);
      expect(reads).toEqual(["get"]);
      expect(await credential(f)).toMatchObject({ scopes_json: JSON.stringify(["bfb:read"]) });
      expect(await effects(f)).toEqual(before);
    },
  );

  it.each(["revoked", "scope", "client", "project_to_null", "task_to_target"] as const)(
    "%s cannot be adopted after preliminary task selection",
    async (loss) => {
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
          .run("synthetic-other-final-task-client", FIX.workspace, f.delegationId);
        expect(await credential(f)).toMatchObject({
          client_id: "synthetic-other-final-task-client",
        });
      } else if (loss === "project_to_null") {
        await f.db
          .prepare("UPDATE oauth_delegations SET project_id=NULL WHERE workspace_id=? AND id=?")
          .run(FIX.workspace, f.delegationId);
        expect(await credential(f)).toMatchObject({ project_id: null, task_id: null });
      } else {
        await f.db
          .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
          .run(f.task.id, FIX.workspace, f.delegationId);
        expect(await credential(f)).toMatchObject({ project_id: FIX.projectA, task_id: f.task.id });
      }
      expect(await getDelegatedTask(f.db, FIX.workspace, f.task, f.access)).toBeUndefined();
      expect(await effects(f)).toEqual(before);
    },
  );

  it("current target read-grant revocation denies and a genuine fresh current grant restores canonical delivery", async () => {
    const f = await fixture();
    // Synthetic dormant privacy uses the actual Owner creator and a distinct Member read grantee.
    await f.db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, f.task.id, FIX.owner, f.observed_at);
    const first = await grant(f, f.task.id),
      before = await effects(f);
    expect(await getDelegatedTask(f.db, FIX.workspace, f.task, f.access)).toEqual(f.task);
    await revokeGrant(f, first);
    expect(await getDelegatedTask(f.db, FIX.workspace, f.task, f.access)).toBeUndefined();
    expect(await effects(f)).toEqual(before);
    const fresh = await grant(f, f.task.id);
    expect(fresh).not.toBe(first);
    expect(await getDelegatedTask(f.db, FIX.workspace, f.task, f.access)).toEqual(f.task);
    expect(await effects(f)).toEqual(before);
  });

  it("a genuine concurrent Hub task edit returns canonical fields rather than the preliminary snapshot", async () => {
    const f = await fixture();
    const edited = success(
      await f.hub.execute(updateTaskCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: {
          taskId: f.task.id,
          expectedVersion: f.task.resource_version,
          title: `${TITLE}-NEW`,
          punchline: `${PUNCHLINE}-NEW`,
          priority: "P1",
        },
      }),
    );
    const before = await effects(f);
    expect(await getDelegatedTask(f.db, FIX.workspace, f.task, f.access)).toEqual(edited);
    expect(await effects(f)).toEqual(before);
  });

  it("parent-only private grant loss redacts the parent while preserving the readable shared child", async () => {
    const f = await fixture(FIX.member, { parent: true });
    await f.db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, f.parent!.id, FIX.owner, f.observed_at);
    const first = await grant(f, f.parent!.id),
      before = await effects(f);
    expect(await getDelegatedTask(f.db, FIX.workspace, f.task, f.access)).toEqual(f.task);
    await revokeGrant(f, first);
    expect(await getDelegatedTask(f.db, FIX.workspace, f.task, f.access)).toEqual({
      ...f.task,
      parent_task_id: null,
    });
    expect(await effects(f)).toEqual(before);
  });

  it("unchanged credential expiry after SQL preparation but before actual final selection denies", async () => {
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
            expect(sql).toContain("FROM tasks AS task");
            observed = true;
            const preparedTimes = parameters.filter(
              (parameter) =>
                typeof parameter === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(parameter),
            ) as string[];
            expect(preparedTimes.length).toBeGreaterThan(0);
            for (const at of preparedTimes)
              expect(Date.parse(at)).toBeLessThan(Date.parse(f.expires_at));
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
    expect(await getDelegatedTask(db, FIX.workspace, f.task, f.access)).toBeUndefined();
    expect(observed).toBe(true);
    expect(await credential(f)).toEqual(originalCredential);
    expect(await effects(f)).toEqual(before);
  });

  it("robustness: malformed retained IDs deny before SQL and exact retained project/identity mismatches cannot select another task", async () => {
    const f = await fixture(FIX.member, { parent: true }),
      before = await effects(f);
    let prepared = false;
    const db = {
      ...f.db,
      prepare(sql: string) {
        prepared = true;
        return f.db.prepare(sql);
      },
    } satisfies SqlDatabase;
    for (const retained of [
      { id: `${f.task.id}\n`, project_id: f.task.project_id },
      { id: f.task.id, project_id: `${f.task.project_id}\n` },
    ])
      expect(await getDelegatedTask(db, FIX.workspace, retained, f.access)).toBeUndefined();
    expect(prepared).toBe(false);
    expect(
      await getDelegatedTask(
        f.db,
        FIX.workspace,
        { id: f.task.id, project_id: FIX.projectB },
        f.access,
      ),
    ).toBeUndefined();
    expect(
      await getDelegatedTask(
        f.db,
        FIX.workspace,
        { id: randomUlid(), project_id: FIX.projectA },
        f.access,
      ),
    ).toBeUndefined();
    expect(await getDelegatedTask(f.db, FIX.workspace, f.task, f.access)).toEqual(f.task);
    expect(await effects(f)).toEqual(before);
  });
});
