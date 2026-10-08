// ABOUTME: Exercises creator-only sharing through signed browser sessions and the registered WorkspaceHub.
// ABOUTME: Dormant private fixtures distinguish useful grant history, effective access and late receipt withholding.

import type { SqlDatabase } from "@bfb/db";
import {
  FIX,
  assertTaskAccess,
  bumpMemberEpoch,
  randomUlid,
  seedSyntheticWorkspace,
  type TaskRecord,
  type TaskSharingReceipt,
  type TaskSharingView,
} from "@bfb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const DENIED = { error: "not_found", message: "task sharing not found" };
const contexts: AuthTestContext[] = [];
type Actor = "owner" | "member" | "reviewer";
type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;
type Rpc = { commandName: string; request: { idempotencyKey: string; input: Row } };
type PublicSuccess<T> = { ok: true; result: T; replayed: boolean };

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => {
  vi.restoreAllMocks();
  for (const context of contexts.splice(0)) context.raw.close();
  vi.useRealTimers();
});

async function snapshot(db: SqlDatabase): Promise<Snapshot> {
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  const result: Snapshot = {};
  for (const { name } of tables) {
    if (["sqlite_sequence", "d1_migrations", "_cf_METADATA"].includes(name)) continue;
    if (name.startsWith("sqlite_") || name.startsWith("_cf_"))
      throw new Error("unexpected canonical snapshot engine table");
    if (name === "rate_limit_buckets") continue;
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
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
async function noBusinessEffects<T>(db: SqlDatabase, run: () => Promise<T>): Promise<T> {
  const before = await snapshot(db),
    http = await budgets(db),
    result = await run();
  expect(await snapshot(db)).toEqual(before);
  // HTTP abuse bookkeeping is collected separately, never silently excluded from the proof.
  expect(await budgets(db)).toEqual(http);
  await integrity(db);
  return result;
}
async function denied(response: Response) {
  expect(response.status).toBe(404);
  const value = (await response.json()) as Row;
  if ("ok" in value)
    expect(value).toEqual({ ok: false, error: { code: "not_found", message: DENIED.message } });
  else expect(value).toEqual(DENIED);
}
async function receipt(response: Response, replayed = false) {
  expect(response.status).toBe(200);
  const value = (await response.json()) as PublicSuccess<TaskSharingReceipt>;
  expect(Object.keys(value).sort()).toEqual(["ok", "replayed", "result"]);
  expect(value.ok).toBe(true);
  expect(value.replayed).toBe(replayed);
  expect(Object.keys(value.result).sort()).toEqual(["access_version", "grant_id", "task_id"]);
  return value.result;
}
async function errorCode(response: Response, code: string, status: number) {
  expect(response.status).toBe(status);
  const value = (await response.json()) as Row;
  expect(typeof value.error === "string" ? value.error : (value.error as Row).code).toBe(code);
}

async function fixture() {
  const context = openAuthTestContext();
  contexts.push(context);
  const db = context.db;
  const clock = (await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").get()) as {
    now: string;
  };
  const now = clock.now;
  vi.setSystemTime(now);
  await seedSyntheticWorkspace(db, now);
  await db
    .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
    .run(FIX.workspace, FIX.projectA);
  const actors = {} as Record<Actor, { cookie: string; csrf: string }>;
  const calls: Rpc[] = [];
  const genuine = createTestWorkspaceHubNamespace(db);
  let cut: { phase: "rpc" | "body"; run: () => Promise<void> } | undefined;
  let fired = false;
  let committed: Snapshot | undefined;
  let afterCut: Snapshot | undefined;
  let afterCutBudgets: unknown[] | undefined;
  let retainedOutcome: PublicSuccess<TaskSharingReceipt> | undefined;
  const namespace = {
    idFromName: (name: string) => genuine.idFromName(name),
    jurisdiction() {
      return namespace;
    },
    get(id: DurableObjectId) {
      const stub = genuine.get(id);
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const call = JSON.parse(String(init?.body)) as Rpc;
          calls.push(call);
          const response = await stub.fetch(input, init);
          const apply = async (outcome: unknown) => {
            if (!cut || fired || !call.commandName.startsWith("task.sharing.")) return;
            expect(outcome).toMatchObject({ ok: true, result: { task_id: expect.any(String) } });
            retainedOutcome = outcome as PublicSuccess<TaskSharingReceipt>;
            fired = true;
            committed = await snapshot(db);
            await cut.run();
            afterCut = await snapshot(db);
            afterCutBudgets = await budgets(db);
            await integrity(db);
          };
          if (cut?.phase === "rpc") await apply(await response.clone().json());
          if (cut?.phase === "body") {
            const readBody = response.json.bind(response);
            response.json = async () => {
              const value = await readBody();
              await apply(value);
              return value;
            };
          }
          return response;
        },
      } as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  const mounted = (database = db) => {
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
  };
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
    ["reviewer", FIX.reviewer],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `sharing-${actor}`,
      sessionId: `sharing-${actor}-session`,
      token: `sharing-${actor}-token`,
      email: `${actor}@sharing.synthetic.test`,
      humanId,
      now,
    });
    const { app, bindings } = mounted();
    const response = await app.request(
      new Request(ORIGIN + "/auth/session", {
        headers: { cookie: session.cookie },
      }),
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
    const { app, bindings } = mounted(options.database);
    const actor = actors[options.actor ?? "member"];
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
  const sharedResponse = await request("", {
    body: {
      project_id: FIX.projectA,
      title: "SYNTHETIC dormant sharing fixture",
      priority: "P2",
      request_id: randomUlid(),
    },
  });
  expect(sharedResponse.status).toBe(200);
  const task = ((await sharedResponse.json()) as PublicSuccess<TaskRecord>).result;
  const sharedResponse2 = await request("", {
    body: {
      project_id: FIX.projectA,
      title: "SYNTHETIC shared sharing-denial control",
      priority: "P2",
      request_id: randomUlid(),
    },
  });
  expect(sharedResponse2.status).toBe(200);
  const shared = ((await sharedResponse2.json()) as PublicSuccess<TaskRecord>).result;
  // Explicit dormant private policy: no private-create endpoint or rollout is exercised.
  await db
    .prepare(
      `INSERT INTO task_privacy
    (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)`,
    )
    .run(FIX.workspace, task.id, FIX.member, now);
  await integrity(db);
  const grantBody = (
    permission = "read",
    expected = 1,
    human = FIX.reviewer,
    key = randomUlid(),
  ) => ({
    human_id: human,
    permission,
    expected_access_version: expected,
    request_id: key,
  });
  return {
    db,
    now,
    task,
    shared,
    calls,
    request,
    grantBody,
    grant: (body = grantBody(), actor: Actor = "member") =>
      request(`/${task.id}/sharing/grants`, { body, actor }),
    revoke: (id: string, expected: number, key = randomUlid()) =>
      request(`/${task.id}/sharing/grants/${id}/revoke`, {
        body: {
          expected_access_version: expected,
          request_id: key,
        },
      }),
    read: (actor: Actor = "member", database = db) =>
      request(`/${task.id}/sharing`, { actor, database }),
    afterHub(phase: "rpc" | "body", run: () => Promise<void>) {
      cut = { phase, run };
    },
    async unchangedAfterCut() {
      expect(fired).toBe(true);
      expect(committed).toBeDefined();
      expect(afterCut).toBeDefined();
      expect(retainedOutcome).toBeDefined();
      expect(await snapshot(db)).toEqual(afterCut);
      expect(await budgets(db)).toEqual(afterCutBudgets);
      await integrity(db);
      return committed!;
    },
    retainedOutcome: () => retainedOutcome,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function view(f: Fixture) {
  const response = await f.read();
  expect(response.status).toBe(200);
  const body = (await response.json()) as { sharing: TaskSharingView };
  expect(Object.keys(body)).toEqual(["sharing"]);
  return body.sharing;
}
function beforeSharing(db: SqlDatabase, run: () => Promise<void>) {
  let fired = false;
  let after: Snapshot | undefined;
  const database: SqlDatabase = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...values) => statement.run(...values),
        all: (...values) => statement.all(...values),
        async get(...values) {
          if (!fired && sql.includes("sharing_task AS MATERIALIZED")) {
            fired = true;
            await run();
            after = await snapshot(db);
          }
          return statement.get(...values);
        },
      };
    },
    withTransaction: (fn) => db.withTransaction(fn),
  };
  return {
    database,
    async unchanged() {
      expect(fired).toBe(true);
      expect(await snapshot(db)).toEqual(after);
      await integrity(db);
    },
  };
}

describe("mounted creator task sharing", () => {
  it.each(["read", "contribute", "edit"])(
    "grants and revokes useful %s access without publishing task bodies",
    async (permission) => {
      const f = await fixture();
      expect(await view(f)).toEqual({
        task_id: f.task.id,
        access_version: 1,
        grants: [],
        has_more: false,
      });
      const issued = await receipt(await f.grant(f.grantBody(permission)));
      expect(issued).toMatchObject({ task_id: f.task.id, access_version: 2 });
      const current = await view(f);
      expect(current).toEqual({
        task_id: f.task.id,
        access_version: 2,
        has_more: false,
        grants: [
          {
            id: issued.grant_id,
            human_id: FIX.reviewer,
            authorization_epoch: 1,
            permission,
            created_at: f.now,
          },
        ],
      });
      const scope = { workspaceId: FIX.workspace, humanId: FIX.reviewer, authorizationEpoch: 1 };
      await assertTaskAccess(f.db, scope, f.task.id, "read");
      if (permission === "read")
        await expect(assertTaskAccess(f.db, scope, f.task.id, "contribute")).rejects.toMatchObject({
          code: "not_found",
        });
      else await assertTaskAccess(f.db, scope, f.task.id, "contribute");
      // An edit grant does not promote a Reviewer to the Owner/Member edit ceiling.
      await expect(assertTaskAccess(f.db, scope, f.task.id, "edit")).rejects.toMatchObject({
        code: "not_found",
      });
      expect(await receipt(await f.revoke(issued.grant_id, 2))).toEqual({
        ...issued,
        access_version: 3,
      });
      expect(await view(f)).toEqual({
        task_id: f.task.id,
        access_version: 3,
        grants: [],
        has_more: false,
      });
      expect(
        await f.db
          .prepare("SELECT revoked_at FROM task_human_grants WHERE id=?")
          .get(issued.grant_id),
      ).toEqual({ revoked_at: f.now });
      await expect(assertTaskAccess(f.db, scope, f.task.id)).rejects.toMatchObject({
        code: "not_found",
      });
      await integrity(f.db);
    },
  );

  it("does not give Owner or named Reviewer grantees creator sharing authority", async () => {
    const f = await fixture();
    await receipt(await f.grant(f.grantBody("edit", 1, FIX.owner)));
    await receipt(await f.grant(f.grantBody("edit", 2, FIX.reviewer)));
    for (const actor of ["owner", "reviewer"] as const) {
      await noBusinessEffects(f.db, async () => {
        await denied(await f.read(actor));
        await denied(await f.grant(f.grantBody("read", 3), actor));
      });
    }
  });

  it("uses the same sharing denial for shared, missing and inaccessible private targets", async () => {
    const f = await fixture();
    await noBusinessEffects(f.db, async () => {
      for (const id of [f.shared.id, randomUlid()]) {
        await denied(await f.request(`/${id}/sharing`));
        await denied(await f.request(`/${id}/sharing/grants`, { body: f.grantBody() }));
      }
      await denied(await f.read("owner"));
    });
  });

  it("retains closed body, permission, version, recipient and CSRF admission without effects", async () => {
    const f = await fixture();
    await noBusinessEffects(f.db, async () => {
      for (const body of [
        { ...f.grantBody(), authority: "owner" },
        { ...f.grantBody(), permission: "manage_sharing" },
        { ...f.grantBody(), expected_access_version: 1.5 },
        { ...f.grantBody(), request_id: "short" },
        { ...f.grantBody(), human_id: FIX.member },
      ]) {
        await errorCode(await f.grant(body), "invalid_argument", 400);
      }
      await errorCode(
        await f.request(`/${f.task.id}/sharing?cursor=${randomUlid()}`),
        "invalid_argument",
        400,
      );
      await errorCode(
        await f.request(`/${f.task.id}/sharing/grants`, {
          body: f.grantBody(),
          headers: { "x-bfb-csrf": "invalid" },
        }),
        "csrf_token",
        403,
      );
      await errorCode(
        await f.request(`/${f.task.id}/sharing/grants`, {
          body: f.grantBody(),
          headers: { origin: "https://foreign.synthetic.test" },
        }),
        "csrf_origin",
        403,
      );
      await errorCode(await f.grant(f.grantBody("read", 1, randomUlid())), "not_found", 404);
    });
  });

  it("binds exact and changed retries while historical receipts survive retained revocation", async () => {
    const f = await fixture(),
      key = randomUlid(),
      body = f.grantBody("contribute", 1, FIX.owner, key);
    const granted = await receipt(await f.grant(body));
    await noBusinessEffects(f.db, async () => {
      expect(await receipt(await f.grant(body), true)).toEqual(granted);
      await errorCode(await f.grant({ ...body, permission: "read" }), "request_rejected", 400);
      await errorCode(await f.grant(f.grantBody("read", 1)), "stale_version", 409);
      await errorCode(await f.grant(f.grantBody("read", 2, FIX.owner)), "already_exists", 409);
    });
    const revokeKey = randomUlid(),
      revoked = await receipt(await f.revoke(granted.grant_id, 2, revokeKey));
    await noBusinessEffects(f.db, async () => {
      expect(await receipt(await f.grant(body), true)).toEqual(granted);
      expect(await receipt(await f.revoke(granted.grant_id, 2, revokeKey), true)).toEqual(revoked);
      await errorCode(await f.revoke(granted.grant_id, 3), "not_found", 404);
    });
    const cache = (await f.db
      .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key=?")
      .get(key)) as { result_json: string };
    expect(JSON.parse(cache.result_json)).toMatchObject({ result: granted });
  });

  it("filters inert recipient epochs and projects, retaining history and permitting explicit re-share", async () => {
    const f = await fixture(),
      old = await receipt(await f.grant());
    await bumpMemberEpoch(f.db, FIX.workspace, FIX.reviewer);
    expect((await view(f)).grants).toEqual([]);
    const next = await receipt(await f.grant(f.grantBody("edit", 2)));
    expect((await view(f)).grants).toMatchObject([{ id: next.grant_id, authorization_epoch: 2 }]);
    await f.db
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .run(FIX.workspace, FIX.projectA, FIX.reviewer);
    const before = await snapshot(f.db);
    expect((await view(f)).grants).toEqual([]);
    await errorCode(await f.grant(f.grantBody("read", 3)), "not_found", 404);
    expect(await snapshot(f.db)).toEqual(before);
    expect(
      await f.db
        .prepare("SELECT id,revoked_at FROM task_human_grants WHERE task_id=? ORDER BY rowid")
        .all(f.task.id),
    ).toEqual([
      { id: old.grant_id, revoked_at: null },
      { id: next.grant_id, revoked_at: null },
    ]);
    await integrity(f.db);
  });

  it.each(["epoch", "project", "role"] as const)(
    "rejects current creator %s loss in final metadata selection, even empty",
    async (loss) => {
      const f = await fixture();
      const cut = beforeSharing(f.db, async () => {
        if (loss === "epoch") await bumpMemberEpoch(f.db, FIX.workspace, FIX.member);
        if (loss === "project")
          await f.db
            .prepare(
              "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.projectA, FIX.member);
        if (loss === "role")
          await f.db
            .prepare(
              "UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.member);
      });
      await denied(await f.read("member", cut.database));
      await cut.unchanged();
    },
  );

  it.each(["rpc", "body"] as const)(
    "withholds committed grant receipt after creator epoch loss at actual Hub %s await",
    async (phase) => {
      const f = await fixture();
      f.afterHub(phase, async () => {
        await bumpMemberEpoch(f.db, FIX.workspace, FIX.member);
      });
      await denied(await f.grant());
      const committed = await f.unchangedAfterCut();
      expect(committed.task_human_grants).toHaveLength(1);
      expect(committed.task_privacy).toMatchObject([{ task_id: f.task.id, access_version: 2 }]);
      expect(
        committed.idempotency_records?.filter((row) => row.command_name === "task.sharing.grant"),
      ).toHaveLength(1);
    },
  );

  it("withholds a historical cached receipt after actual body await without rewriting committed history", async () => {
    const f = await fixture(),
      body = f.grantBody();
    await receipt(await f.grant(body));
    f.afterHub("body", async () => {
      await f.db
        .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
        .run(FIX.workspace, FIX.projectA, FIX.member);
    });
    await denied(await f.grant(body));
    await f.unchangedAfterCut();
    expect(f.retainedOutcome()?.replayed).toBe(true);
  });

  it("withholds a committed revoke after creator role loss but preserves its retained grant and minimal receipt", async () => {
    const f = await fixture(),
      granted = await receipt(await f.grant());
    f.afterHub("body", async () => {
      await f.db
        .prepare("UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?")
        .run(FIX.workspace, FIX.member);
    });
    await denied(await f.revoke(granted.grant_id, 2));
    const committed = await f.unchangedAfterCut();
    expect(committed.task_human_grants).toMatchObject([
      { id: granted.grant_id, revoked_at: f.now },
    ]);
    const rows = committed.idempotency_records?.filter(
      (row) => row.command_name === "task.sharing.revoke",
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows![0]!.result_json))).toMatchObject({
      result: {
        task_id: f.task.id,
        grant_id: granted.grant_id,
        access_version: 3,
      },
    });
  });
});
