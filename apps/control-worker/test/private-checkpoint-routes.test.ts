// ABOUTME: Exercises author-private checkpoint reads and receipts through genuine browser sessions and Hub routing.
// ABOUTME: Dormant task policies and late authority cuts retain committed history without sharing checkpoint bodies.

import type { SqlDatabase } from "@bfb/db";
import {
  FIX,
  bumpMemberEpoch,
  randomUlid,
  seedSyntheticWorkspace,
  type TaskRecord,
} from "@bfb/domain";
import { afterEach, describe, expect, it } from "vitest";

import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
  type AuthTestContext,
} from "./auth-helpers.js";

const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;
const BASE = `/api/v1/workspaces/${FIX.workspace}/tasks`;
const BODY = "SYNTHETIC browser author-private checkpoint";
const contexts: AuthTestContext[] = [];
type Actor = "owner" | "member" | "reviewer";
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
type Outcome<T> = { ok: true; result: T; replayed: boolean };

afterEach(() => {
  for (const context of contexts.splice(0)) context.raw.close();
});

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
    result = await run();
  expect(await snapshot(db)).toEqual(before);
  expect(await budgets(db)).toEqual(http);
  await integrity(db);
  return result;
}
async function value(response: Response) {
  return (await response.json()) as Row;
}
async function code(response: Response, expected: string, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = await value(response);
  expect(typeof body.error === "string" ? body.error : (body.error as Row).code).toBe(expected);
  expect(JSON.stringify(body)).not.toContain(BODY);
  return body;
}
async function receipt(response: Response, replayed = false): Promise<Receipt> {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = (await response.json()) as Outcome<Receipt>;
  expect(Object.keys(body).sort()).toEqual(["ok", "replayed", "result"]);
  expect(body.ok).toBe(true);
  expect(body.replayed).toBe(replayed);
  expect(Object.keys(body.result).sort()).toEqual(["checkpoint_id", "content_hash", "task_id"]);
  expect(body.result.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  return body.result;
}

async function fixture() {
  const context = openAuthTestContext();
  contexts.push(context);
  const db = context.db;
  const { now } = (await db
    .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
    .get()) as { now: string };
  await seedSyntheticWorkspace(db, now);
  await db
    .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
    .run(FIX.workspace, FIX.projectA);
  const genuine = createTestWorkspaceHubNamespace(db);
  let cut: { phase: "rpc" | "body"; run: () => Promise<void> } | undefined;
  let fired = false,
    after: Snapshot | undefined,
    afterBudgets: unknown[] | undefined;
  let committed: Snapshot | undefined, saved: Outcome<Receipt> | undefined;
  const namespace = {
    idFromName: (name: string) => genuine.idFromName(name),
    jurisdiction() {
      return namespace;
    },
    get(id: DurableObjectId) {
      const stub = genuine.get(id);
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const call = JSON.parse(String(init?.body)) as { commandName: string };
          const response = await stub.fetch(input, init);
          const apply = async (outcome: unknown) => {
            if (!cut || fired || call.commandName !== "progress.private.report") return;
            expect(outcome).toMatchObject({
              ok: true,
              result: { checkpoint_id: expect.any(String) },
            });
            fired = true;
            saved = outcome as Outcome<Receipt>;
            committed = await snapshot(db);
            await cut.run();
            after = await snapshot(db);
            afterBudgets = await budgets(db);
            await integrity(db);
          };
          if (cut?.phase === "rpc") await apply(await response.clone().json());
          if (cut?.phase === "body") {
            const json = response.json.bind(response);
            response.json = async () => {
              const result: unknown = await json();
              await apply(result);
              return result;
            };
          }
          return response;
        },
      } as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  function mounted(database = db) {
    const bindings = {
      DB: {},
      ARTIFACTS: {},
      ASSETS: {},
      JOBS: {},
      JOBS_DLQ: {},
      WORKSPACE_HUB: namespace,
      APP_ORIGIN: ORIGIN,
      ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
      LAUNCH_ORIGIN: "https://launch.bfb.example.test",
      JURISDICTION: "eu",
      ENVIRONMENT: "local",
    } as unknown as ControlBindings;
    const app = createControlApp(validateControlEnv(bindings), {
      db: database,
      now,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      humanAuth: () => ({
        auth: context.auth,
        keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
        abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      }),
    });
    return { app, bindings };
  }
  const actors = {} as Record<Actor, { cookie: string; csrf: string }>;
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
    ["reviewer", FIX.reviewer],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `checkpoint-${actor}`,
      sessionId: `checkpoint-${actor}-session`,
      token: `checkpoint-${actor}-token`,
      email: `${actor}@checkpoint.synthetic.test`,
      humanId,
      now,
    });
    const { app, bindings } = mounted();
    const response = await app.request(
      new Request(ORIGIN + "/auth/session", { headers: { cookie: session.cookie } }),
      undefined,
      bindings,
    );
    expect(response.status).toBe(200);
    actors[actor] = {
      cookie: session.cookie,
      csrf: ((await response.json()) as { csrf_token: string }).csrf_token,
    };
  }
  const request = (
    path: string,
    options: {
      actor?: Actor;
      body?: unknown;
      database?: SqlDatabase;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const { app, bindings } = mounted(options.database),
      actor = actors[options.actor ?? "member"];
    return app.request(
      new Request(ORIGIN + BASE + path, {
        method: options.body === undefined ? "GET" : "POST",
        headers: {
          cookie: actor.cookie,
          "x-bfb-csrf": actor.csrf,
          ...(options.body === undefined
            ? {}
            : {
                origin: ORIGIN,
                "content-type": "application/json",
                "sec-fetch-site": "same-origin",
              }),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
      undefined,
      bindings,
    );
  };
  const create = async (title: string) => {
    const response = await request("", {
      body: { project_id: FIX.projectA, title, priority: "P2", request_id: randomUlid() },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as Outcome<TaskRecord>).result;
  };
  const task = await create("SYNTHETIC dormant checkpoint task"),
    shared = await create("SYNTHETIC shared checkpoint control");
  // Explicit dormant policy, not private-create, inheritance or activation.
  await db
    .prepare(
      "INSERT INTO task_privacy(workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, task.id, FIX.member, now);
  let accessVersion = 1;
  async function grant(actor: "owner" | "reviewer", permission = "contribute") {
    const response = await request(`/${task.id}/sharing/grants`, {
      body: {
        request_id: randomUlid(),
        human_id: actor === "owner" ? FIX.owner : FIX.reviewer,
        permission,
        expected_access_version: accessVersion,
      },
    });
    expect(response.status).toBe(200);
    const result = (
      (await response.json()) as Outcome<{ grant_id: string; access_version: number }>
    ).result;
    accessVersion = result.access_version;
    return result.grant_id;
  }
  async function revoke(grantId: string) {
    const response = await request(`/${task.id}/sharing/grants/${grantId}/revoke`, {
      body: { request_id: randomUlid(), expected_access_version: accessVersion },
    });
    expect(response.status).toBe(200);
    accessVersion = ((await response.json()) as Outcome<{ access_version: number }>).result
      .access_version;
  }
  await integrity(db);
  return {
    db,
    task,
    shared,
    now,
    request,
    grant,
    revoke,
    report: (body: unknown = { request_id: randomUlid(), body: BODY }, actor: Actor = "member") =>
      request(`/${task.id}/checkpoints`, { body, actor }),
    read: (actor: Actor = "member", database = db) =>
      request(`/${task.id}/checkpoints`, { actor, database }),
    afterHub(phase: "rpc" | "body", run: () => Promise<void>) {
      cut = { phase, run };
    },
    async retainedAfterCut() {
      expect(fired && after && afterBudgets && committed && saved).toBeTruthy();
      expect(await snapshot(db)).toEqual(after);
      expect(await budgets(db)).toEqual(afterBudgets);
      await integrity(db);
      return { committed: committed!, saved: saved! };
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function view(f: Fixture, actor: Actor = "member") {
  const response = await f.read(actor);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = (await response.json()) as { progress: View };
  expect(Object.keys(body)).toEqual(["progress"]);
  expect(Object.keys(body.progress).sort()).toEqual(["checkpoints", "has_more", "task_id"]);
  for (const entry of body.progress.checkpoints)
    expect(Object.keys(entry).sort()).toEqual([
      "body",
      "content_hash",
      "created_at",
      "id",
      "origin",
    ]);
  return body.progress;
}
function beforeSelection(db: SqlDatabase, change: () => Promise<void>) {
  let observed = false,
    after: Snapshot | undefined,
    http: unknown[] | undefined;
  const database: SqlDatabase = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...values) => statement.run(...values),
        all: (...values) => statement.all(...values),
        async get(...values) {
          if (!observed && sql.includes("task_private_checkpoints")) {
            observed = true;
            await change();
            after = await snapshot(db);
            http = await budgets(db);
          }
          return statement.get(...values);
        },
      };
    },
    withTransaction: (run) => db.withTransaction(run),
  };
  return {
    database,
    async unchanged() {
      expect(observed).toBe(true);
      expect(await snapshot(db)).toEqual(after);
      expect(await budgets(db)).toEqual(http);
      await integrity(db);
    },
  };
}

describe("mounted author-private checkpoints", () => {
  it("records trimmed checkpoints with minimal receipts and no generic work effects", async () => {
    const f = await fixture(),
      before = await snapshot(f.db);
    const issued = await receipt(await f.report({ request_id: randomUlid(), body: `  ${BODY}  ` }));
    const current = await view(f);
    expect(current).toEqual({
      task_id: f.task.id,
      checkpoints: [
        {
          id: issued.checkpoint_id,
          body: BODY,
          content_hash: issued.content_hash,
          created_at: expect.any(String),
          origin: "human",
        },
      ],
      has_more: false,
    });
    const after = await snapshot(f.db);
    for (const name of [
      "tasks",
      "comments",
      "task_context_items",
      "measurement_intervals",
      "notification_deliveries",
    ])
      expect(after[name]).toEqual(before[name]);
    for (const name of [
      "semantic_events",
      "audit_events",
      "outbox_records",
      "idempotency_records",
    ]) {
      expect(after[name]!.length).toBe(before[name]!.length + 1);
      expect(JSON.stringify(after[name]!.at(-1))).not.toContain(BODY);
    }
    await unchanged(f.db, () => view(f));
  });

  it("sharing contribution never shares another human's checkpoints or grants Owner override", async () => {
    const f = await fixture();
    await receipt(await f.report());
    const denied = await code(await f.read("owner"), "not_found", 404);
    expect(
      await code(
        await f.request(`/${randomUlid()}/checkpoints`, { actor: "owner" }),
        "not_found",
        404,
      ),
    ).toEqual(denied);
    await f.grant("owner");
    expect(await view(f, "owner")).toEqual({
      task_id: f.task.id,
      checkpoints: [],
      has_more: false,
    });
    const own = await receipt(
      await f.report({ request_id: randomUlid(), body: "SYNTHETIC Owner private note" }, "owner"),
    );
    expect((await view(f, "owner")).checkpoints.map((entry) => entry.id)).toEqual([
      own.checkpoint_id,
    ]);
    expect((await view(f)).checkpoints.map((entry) => entry.body)).toEqual([BODY]);
    expect(await value(await f.request(`/${f.shared.id}/checkpoints`))).toEqual({
      progress: { task_id: f.shared.id, checkpoints: [], has_more: false },
    });
  });

  it("a current Reviewer contributor has useful own-origin checkpoints", async () => {
    const f = await fixture();
    await f.grant("reviewer");
    const own = await receipt(await f.report(undefined, "reviewer"));
    expect((await view(f, "reviewer")).checkpoints).toMatchObject([
      { id: own.checkpoint_id, origin: "human", body: BODY },
    ]);
    expect((await view(f)).checkpoints).toEqual([]);
  });

  it("preserves closed fields, body bounds, IDs and CSRF without any effects", async () => {
    const f = await fixture();
    await unchanged(f.db, async () => {
      for (const body of [
        { request_id: randomUlid(), body: BODY, owner_human_id: FIX.owner },
        { request_id: randomUlid(), body: BODY, audience: "both" },
        { request_id: randomUlid(), body: BODY, run_id: randomUlid() },
        { request_id: "short", body: BODY },
        { request_id: randomUlid(), body: "\u0000" },
        { request_id: randomUlid(), body: "x".repeat(2049) },
      ])
        await code(await f.report(body), "invalid_argument", 400);
      await code(
        await f.request(`/${f.task.id}/checkpoints`, {
          body: { request_id: randomUlid(), body: BODY },
          headers: { "x-bfb-csrf": "invalid" },
        }),
        "csrf_token",
        403,
      );
    });
  });

  it("exact retries retain historical receipt identity and changed retries reject", async () => {
    const f = await fixture(),
      input = { request_id: randomUlid(), body: BODY };
    const first = await receipt(await f.report(input));
    await receipt(await f.report({ request_id: randomUlid(), body: "SYNTHETIC newer checkpoint" }));
    await unchanged(f.db, async () => {
      expect(await receipt(await f.report(input), true)).toEqual(first);
      await code(await f.report({ ...input, body: `${BODY} changed` }), "request_rejected", 400);
    });
    expect((await view(f)).checkpoints).toHaveLength(2);
  });

  it("read-only sharing permits authorized emptiness but not checkpoint reporting", async () => {
    const f = await fixture(),
      grant = await f.grant("owner", "read");
    await unchanged(f.db, async () => {
      expect((await view(f, "owner")).checkpoints).toEqual([]);
      await code(await f.report(undefined, "owner"), "not_found", 404);
    });
    await f.revoke(grant);
    await unchanged(f.db, async () => code(await f.read("owner"), "not_found", 404));
  });

  it.each(["epoch", "project", "grant"] as const)(
    "final empty read rejects current %s loss after principal capture",
    async (loss) => {
      const f = await fixture(),
        grant = await f.grant("owner");
      const cut = beforeSelection(f.db, async () => {
        if (loss === "epoch") await bumpMemberEpoch(f.db, FIX.workspace, FIX.owner);
        if (loss === "project")
          await f.db
            .prepare(
              "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.projectA, FIX.owner);
        if (loss === "grant") await f.revoke(grant);
      });
      await code(await f.read("owner", cut.database), "not_found", 404);
      await cut.unchanged();
    },
  );

  it.each(["rpc", "body", "cached_body"] as const)(
    "withholds a %s receipt after actual Hub delivery loses contribution",
    async (phase) => {
      const f = await fixture(),
        grant = await f.grant("owner"),
        input = { request_id: randomUlid(), body: BODY };
      if (phase === "cached_body") await receipt(await f.report(input, "owner"));
      f.afterHub(phase === "rpc" ? "rpc" : "body", () => f.revoke(grant));
      await code(await f.report(input, "owner"), "not_found", 404);
      const retained = await f.retainedAfterCut();
      expect(retained.saved.replayed).toBe(phase === "cached_body");
      expect(retained.committed.task_private_checkpoints).toHaveLength(1);
      expect(
        retained.committed.idempotency_records!.filter(
          (row) => row.command_name === "progress.private.report",
        ),
      ).toHaveLength(1);
    },
  );
});
