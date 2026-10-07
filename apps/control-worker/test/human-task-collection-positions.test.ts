// ABOUTME: Exercises opaque task child continuations through genuine browser sessions and registered Hub issuance.
// ABOUTME: Recipient, capture and committing races preserve canonical child history while withholding invalid pages.

import { createHash, randomBytes } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";
import { FIX, randomUlid, seedSyntheticWorkspace, type TaskRecord } from "@bfb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resultStagedD1 } from "../../../packages/domain/test/result-fixture.js";
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

const BASE = `/api/v1/workspaces/${FIX.workspace}`;
const MARKER = "SYNTHETIC-C11-TASK-POSITION";
const ISSUE = "task.collection_position.issue";
const contexts: AuthTestContext[] = [];
const families = ["comments", "dependencies", "links", "runs"] as const;
type Family = (typeof families)[number];
type Actor = "owner" | "member" | "reviewer";
type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;
type Page = Record<Family, Row[]> & {
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
};
type Rpc = { commandName: string; request: { input: Row; actorHumanId: string } };

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => {
  vi.restoreAllMocks();
  for (const context of contexts.splice(0)) context.raw.close();
  vi.useRealTimers();
});

async function snapshot(db: SqlDatabase): Promise<Snapshot> {
  const result: Snapshot = {};
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) {
    if (
      name.startsWith("sqlite_") ||
      name.startsWith("_cf_") ||
      ["d1_migrations", "rate_limit_buckets"].includes(name)
    )
      continue;
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    result[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()) as Row[];
  }
  return result;
}
async function foreignKeys(db: SqlDatabase) {
  expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}
async function unchanged<T>(db: SqlDatabase, action: () => Promise<T>): Promise<T> {
  const before = await snapshot(db),
    result = await action();
  expect(await snapshot(db)).toEqual(before);
  await foreignKeys(db);
  return result;
}
function assertIssuance(before: Snapshot, after: Snapshot, issued: number, handles: string[]) {
  const bookkeeping = new Set([
    "task_collection_positions",
    "workspace_cursors",
    "semantic_events",
    "audit_events",
    "outbox_records",
    "idempotency_records",
  ]);
  for (const [name, rows] of Object.entries(after)) {
    if (!bookkeeping.has(name)) expect(rows, name).toEqual(before[name]);
  }
  const previous = before.task_collection_positions ?? [],
    positions = after.task_collection_positions ?? [];
  expect(positions.slice(0, previous.length)).toEqual(previous);
  expect(positions.length - previous.length).toBe(issued);
  for (const row of positions.slice(previous.length)) {
    expect(row).toMatchObject({
      workspace_id: FIX.workspace,
      human_id: FIX.reviewer,
      authorization_epoch: 1,
      projection_version: 1,
    });
    expect(row.position_hash).toMatch(/^[0-9a-f]{64}$/u);
  }
  for (const [table, field] of [
    ["semantic_events", "kind"],
    ["audit_events", "action"],
    ["outbox_records", "kind"],
    ["idempotency_records", "command_name"],
  ] as const) {
    const oldRows = before[table] ?? [],
      rows = after[table] ?? [];
    expect(rows.slice(0, oldRows.length), table).toEqual(oldRows);
    expect(rows.length - oldRows.length, table).toBe(issued);
    for (const row of rows.slice(oldRows.length)) {
      expect(row[field], table).toBe(ISSUE);
      if (table !== "idempotency_records") {
        const receipt = JSON.parse(String(row.payload_json)) as { input: unknown; result: unknown };
        expect(receipt.input).toEqual({});
        expect(receipt.result).toEqual({ issued: true });
      } else {
        expect(JSON.parse(String(row.result_json))).toMatchObject({ result: { issued: true } });
      }
    }
  }
  expect(after.workspace_cursors).toEqual(
    before.workspace_cursors!.map((row) =>
      row.workspace_id === FIX.workspace ? { ...row, cursor: Number(row.cursor) + issued } : row,
    ),
  );
  for (const handle of handles) expect(JSON.stringify(after)).not.toContain(handle);
}
function identity(family: Family, row: Row): string {
  const id = row[family === "dependencies" ? "depends_on_task_id" : "id"];
  expect(typeof id).toBe("string");
  return id as string;
}
function assertHandle(value: unknown): asserts value is string {
  expect(typeof value).toBe("string");
  expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(Buffer.from(value as string, "base64url").toString("base64url")).toBe(value);
}
function positionHash(handle: string) {
  // The documented domain separation establishes a fixture hash, not a parallel page implementation.
  return createHash("sha256")
    .update("bfb/task-collection-position/v1\0")
    .update(handle)
    .digest("hex");
}

async function fixture(options: { movable?: boolean; extraProject?: boolean } = {}) {
  const context = openAuthTestContext();
  contexts.push(context);
  const db = context.db;
  const clock = (await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").get()) as {
    now: string;
  };
  // Date follows the same observed SQLite clock; historical business timestamps are not expiry witnesses.
  const now = clock.now;
  vi.setSystemTime(new Date(now));
  await seedSyntheticWorkspace(db, now);
  if (options.extraProject)
    await db
      .prepare("INSERT INTO project_access(workspace_id,project_id,human_id) VALUES (?,?,?)")
      .run(FIX.workspace, FIX.projectB, FIX.reviewer);
  const calls: Rpc[] = [];
  let namespace = createTestWorkspaceHubNamespace(db),
    afterIssue: (() => Promise<void>) | undefined;
  const rpcNamespace = {
    idFromName: (name: string) => namespace.idFromName(name),
    jurisdiction() {
      return rpcNamespace;
    },
    get(id: DurableObjectId) {
      const stub = namespace.get(id);
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const call = JSON.parse(String(init?.body)) as Rpc;
          calls.push(call);
          const response = await stub.fetch(input, init);
          if (call.commandName === ISSUE && afterIssue) {
            const outcome = (await response.clone().json()) as { ok: boolean; result: unknown };
            expect(outcome).toMatchObject({ ok: true, result: { issued: true } });
            await afterIssue();
          }
          return response;
        },
      } as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  const bindings = {
    DB: {},
    ARTIFACTS: {},
    ASSETS: {},
    JOBS: {},
    JOBS_DLQ: {},
    WORKSPACE_HUB: rpcNamespace,
    APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  } as unknown as ControlBindings;
  const app = createControlApp(validateControlEnv(bindings), {
    db,
    now,
    abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
  const actors = {} as Record<Actor, { cookie: string; csrf: string }>;
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
    ["reviewer", FIX.reviewer],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `position-${actor}-user`,
      sessionId: `position-${actor}-session`,
      token: `position-${actor}-token`,
      email: `${actor}@task-position.synthetic.test`,
      name: `Synthetic position ${actor}`,
      humanId,
      now,
      expiresAt: new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString(),
    });
    const response = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/session`, {
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
  async function request(path: string, actor: Actor = "reviewer", value?: Row) {
    return app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, {
        method: value ? "POST" : "GET",
        headers: {
          cookie: actors[actor].cookie,
          ...(value
            ? {
                "content-type": "application/json",
                origin: AUTH_TEST_ENV.APP_ORIGIN,
                "sec-fetch-site": "same-origin",
                "x-bfb-csrf": actors[actor].csrf,
              }
            : {}),
        },
        ...(value ? { body: JSON.stringify(value) } : {}),
      }),
      undefined,
      bindings,
    );
  }
  async function write<T>(path: string, input: Row): Promise<T> {
    const response = await request(path, "member", { ...input, request_id: randomUlid() });
    expect(response.status, await response.clone().text()).toBe(200);
    const outcome = (await response.json()) as { ok: boolean; result: T };
    expect(outcome.ok).toBe(true);
    return outcome.result;
  }
  const createTask = (label: string) =>
    write<TaskRecord>(`${BASE}/tasks`, {
      project_id: FIX.projectA,
      title: `${MARKER}-${label}`,
      priority: "P2",
    });
  const task = await createTask("PARENT"),
    otherTask = await createTask("OTHER-PARENT"),
    targets: TaskRecord[] = [];
  for (let index = 0; index < 3; index++) {
    await write(`${BASE}/tasks/${task.id}/comments`, {
      kind: "discussion",
      body: `${MARKER}-COMMENT-${index}`,
    });
    await write(`${BASE}/tasks/${task.id}/links`, {
      kind: "external",
      url: `https://synthetic.invalid/position-${index}`,
      label: `${MARKER}-LINK-${index}`,
    });
    if (!options.movable) {
      const target = await createTask(`DEPENDENCY-${index}`);
      targets.push(target);
      await write(`${BASE}/tasks/${task.id}/dependencies`, { depends_on_task_id: target.id });
    }
  }
  if (!options.movable) {
    const result = await write<{ run: { id: string } }>(`${BASE}/tasks/${task.id}/runs`, {
      expected_task_version: task.resource_version,
      agent_profile_id: FIX.profileCodex,
      workspace_policy_version: 1,
      project_policy_version: 1,
      repository_config_version: 1,
      agent_profile_version: 1,
    });
    expect(result.run.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    // Additional FK-clean recorded run history does not create executions or start a provider.
    for (let index = 0; index < 2; index++)
      await db
        .prepare(
          `INSERT INTO runs(workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,created_at)
           VALUES (?,?,?,?,?,?,'cancelled','unknown',?)`,
        )
        .run(FIX.workspace, randomUlid(), FIX.projectA, task.id, FIX.member, FIX.profileCodex, now);
  }
  const grantId = randomUlid();
  await db
    .prepare(
      "INSERT INTO task_privacy(workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, task.id, FIX.member, now);
  for (const [id, human] of [
    [grantId, FIX.reviewer],
    [randomUlid(), FIX.owner],
  ])
    await db
      .prepare(
        "INSERT INTO task_human_grants(workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)",
      )
      .run(FIX.workspace, id, task.id, human, now);
  async function revoke() {
    await db
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(now, FIX.workspace, grantId);
    expect(
      await db
        .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, grantId),
    ).toEqual({ revoked_at: now });
  }
  const path = (family: Family, query = "", taskId = task.id) =>
    `${BASE}/tasks/${taskId}/${family}${query ? `?${query}` : ""}`;
  const page = async (family: Family, query = "limit=2", actor: Actor = "reviewer") => {
    const response = await request(path(family, query), actor);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    return (await response.json()) as Page;
  };
  calls.length = 0;
  await foreignKeys(db);
  return {
    db,
    now,
    task,
    otherTask,
    targets,
    calls,
    path,
    request,
    page,
    revoke,
    useHub(database: SqlDatabase) {
      namespace = createTestWorkspaceHubNamespace(database);
    },
    afterIssue(change: () => Promise<void>) {
      afterIssue = change;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function reject(f: Fixture, path: string, actor: Actor = "reviewer") {
  const response = await unchanged(f.db, () => f.request(path, actor));
  expect(response.status, await response.clone().text()).toBe(400);
  expect(await response.json()).toEqual({
    error: "invalid_argument",
    message: "unknown task collection cursor",
  });
  expect(response.headers.get("cache-control")).toContain("no-store");
}
async function first(f: Fixture, family: Family, query = "limit=2") {
  const before = await snapshot(f.db),
    body = await f.page(family, query);
  expect(body.has_more).toBe(true);
  assertHandle(body.next_cursor);
  assertIssuance(before, await snapshot(f.db), 1, [body.next_cursor]);
  expect(f.calls.at(-1)).toMatchObject({
    commandName: ISSUE,
    request: { actorHumanId: FIX.reviewer, input: { taskId: f.task.id, collection: family } },
  });
  expect(JSON.stringify(f.calls)).not.toContain(body.next_cursor);
  return body;
}

describe("browser task child opaque positions", () => {
  it.each(families)(
    "%s traverses as a read-only Reviewer and reuses its terminal continuation",
    async (family) => {
      const f = await fixture(),
        root = await first(f, family);
      expect(Object.keys(root).sort()).toEqual([family, "has_more", "limit", "next_cursor"].sort());
      expect(root[family]).toHaveLength(2);
      const query = `limit=2&cursor=${root.next_cursor}`;
      const terminal = await unchanged(f.db, () => f.page(family, query));
      expect(terminal).toMatchObject({ limit: 2, has_more: false, next_cursor: null });
      expect(terminal[family]).toHaveLength(1);
      expect(
        identity(family, terminal[family][0]!).localeCompare(identity(family, root[family][1]!)),
      ).toBeGreaterThan(0);
      expect(await unchanged(f.db, () => f.page(family, query))).toEqual(terminal);
      expect(
        await f.db
          .prepare(
            "SELECT role,authorization_epoch FROM workspace_members WHERE workspace_id=? AND human_id=?",
          )
          .get(FIX.workspace, FIX.reviewer),
      ).toEqual({ role: "reviewer", authorization_epoch: 1 });
    },
  );

  it.each(families)(
    "%s rejects visible raw IDs and malformed handles without restarting",
    async (family) => {
      const f = await fixture(),
        full = await unchanged(f.db, () => f.page(family, "limit=50"));
      expect(full.has_more).toBe(false);
      const canonical = randomBytes(32).toString("base64url"),
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
        last = alphabet.indexOf(canonical.at(-1)!);
      // The low padding bits make this a 43-character but noncanonical base64url spelling.
      const noncanonical = canonical.slice(0, -1) + alphabet[last + 1]!;
      for (const cursor of [
        identity(family, full[family][0]!),
        "bad",
        `${canonical}\n`,
        noncanonical,
      ])
        await reject(f, f.path(family, `limit=2&cursor=${encodeURIComponent(cursor)}`));
      expect(full.next_cursor).toBeNull();
    },
  );

  it("binds continuation to its human, parent, collection and effective limit", async () => {
    const f = await fixture({ extraProject: true }),
      root = await first(f, "comments"),
      query = `limit=2&cursor=${root.next_cursor}`;
    await reject(f, f.path("comments", query), "owner");
    await reject(f, f.path("comments", query, f.otherTask.id));
    await reject(f, f.path("links", query));
    await reject(f, f.path("comments", `limit=1&cursor=${root.next_cursor}`));
    await reject(f, f.path("comments", `limit=2&cursor=${randomBytes(32).toString("base64url")}`));
  });

  it("parent denial takes precedence over malformed, raw, unknown and previously valid positions", async () => {
    const f = await fixture(),
      root = await first(f, "comments");
    await f.revoke();
    for (const taskId of [f.task.id, randomUlid()])
      for (const cursor of ["bad", f.task.id, root.next_cursor!]) {
        const response = await unchanged(f.db, () =>
          f.request(f.path("comments", `limit=2&cursor=${cursor}`, taskId)),
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found" });
        expect(response.headers.get("cache-control")).toContain("no-store");
      }
  });

  it("rejects a typed expired historical position against the database clock without changing it", async () => {
    const f = await fixture(),
      root = await first(f, "comments"),
      expired = randomBytes(32).toString("base64url");
    // An independently inserted historical position is immutable; no trigger or issued row is rewritten.
    await f.db
      .prepare(
        `INSERT INTO task_collection_positions
         (position_hash,workspace_id,human_id,authorization_epoch,projection_version,page_limit,audience_json,after_hash,
          task_id,project_id,collection,capture_ceiling,expires_at,anchor_id,anchor_rowid,created_at)
         SELECT ?,workspace_id,human_id,authorization_epoch,projection_version,page_limit,audience_json,after_hash,
          task_id,project_id,collection,capture_ceiling,strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'),anchor_id,anchor_rowid,
          strftime('%Y-%m-%dT%H:%M:%fZ','now','-11 minutes')
         FROM task_collection_positions WHERE workspace_id=? AND position_hash=?`,
      )
      .run(positionHash(expired), FIX.workspace, positionHash(root.next_cursor!));
    expect(
      await f.db
        .prepare(
          "SELECT expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now') AS expired FROM task_collection_positions WHERE position_hash=?",
        )
        .get(positionHash(expired)),
    ).toEqual({ expired: 1 });
    await reject(f, f.path("comments", `limit=2&cursor=${expired}`));
    expect(
      await unchanged(f.db, () => f.page("comments", `limit=2&cursor=${root.next_cursor}`)),
    ).toMatchObject({
      has_more: false,
      next_cursor: null,
    });
  });

  it.each(["expansion", "contraction"] as const)(
    "exact project audience %s invalidates a position while its parent stays readable",
    async (change) => {
      const f = await fixture({ extraProject: change === "contraction" }),
        root = await first(f, "comments");
      if (change === "expansion")
        await f.db
          .prepare("INSERT INTO project_access(workspace_id,project_id,human_id) VALUES (?,?,?)")
          .run(FIX.workspace, FIX.projectB, FIX.reviewer);
      else
        await f.db
          .prepare(
            "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
          )
          .run(FIX.workspace, FIX.projectB, FIX.reviewer);
      await reject(f, f.path("comments", `limit=2&cursor=${root.next_cursor}`));
      expect(await unchanged(f.db, () => f.page("comments", "limit=50"))).toMatchObject({
        has_more: false,
        next_cursor: null,
      });
    },
  );

  it("hidden dependency targets do not create lookahead or a position", async () => {
    const f = await fixture(),
      ordered = [...f.targets].sort((a, b) => a.id.localeCompare(b.id));
    await f.db
      .prepare(
        "INSERT INTO task_privacy(workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, ordered[0]!.id, FIX.member, f.now);
    const visible = await unchanged(f.db, () => f.page("dependencies"));
    expect(visible).toMatchObject({ has_more: false, next_cursor: null, limit: 2 });
    expect(visible.dependencies.map((row) => identity("dependencies", row))).toEqual(
      ordered.slice(1).map((target) => target.id),
    );
    expect(f.calls).toEqual([]);
  });

  it("a dependency position is invalid when its retained anchor becomes private", async () => {
    const f = await fixture(),
      root = await first(f, "dependencies"),
      anchor = identity("dependencies", root.dependencies[1]!);
    await f.db
      .prepare(
        "INSERT INTO task_privacy(workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, anchor, FIX.member, f.now);
    await reject(f, f.path("dependencies", `limit=2&cursor=${root.next_cursor}`));
  });

  it("descendants retain the root ceiling and expiry and exclude a newly inserted backdated identity", async () => {
    const f = await fixture(),
      root = await first(f, "comments", "limit=1"),
      original = await unchanged(f.db, () => f.page("comments", "limit=50")),
      alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const digits = identity("comments", original.comments[1]!).split("");
    for (let index = digits.length - 1; index >= 0; index--) {
      const next = alphabet.indexOf(digits[index]!) + 1;
      if (next < alphabet.length) {
        digits[index] = alphabet[next]!;
        break;
      }
      digits[index] = alphabet[0]!;
    }
    const backdatedId = digits.join("");
    expect(backdatedId > identity("comments", original.comments[1]!)).toBe(true);
    expect(backdatedId < identity("comments", original.comments[2]!)).toBe(true);
    await f.db
      .prepare(
        `INSERT INTO comments(workspace_id,id,task_id,author_human_id,body,kind,created_at)
         VALUES (?,?,?,?,?,'discussion','2025-01-01T00:00:00.000Z')`,
      )
      .run(FIX.workspace, backdatedId, f.task.id, FIX.member, `${MARKER}-NEW-BACKDATED`);
    const before = await snapshot(f.db),
      second = await f.page("comments", `limit=1&cursor=${root.next_cursor}`);
    assertHandle(second.next_cursor);
    assertIssuance(before, await snapshot(f.db), 1, [root.next_cursor!, second.next_cursor]);
    const terminal = await unchanged(f.db, () =>
      f.page("comments", `limit=1&cursor=${second.next_cursor}`),
    );
    expect([root, second, terminal].flatMap((body) => body.comments)).toEqual(original.comments);
    expect(terminal).toMatchObject({ has_more: false, next_cursor: null });
    const positions = (await snapshot(f.db)).task_collection_positions!;
    expect(positions).toHaveLength(2);
    expect(positions[1]).toMatchObject({
      capture_ceiling: positions[0]!.capture_ceiling,
      expires_at: positions[0]!.expires_at,
      after_hash: positions[0]!.position_hash,
      anchor_id: identity("comments", second.comments[0]!),
    });
    expect(JSON.stringify(terminal)).not.toContain(backdatedId);
  });

  it("parent contribution history is untouched when read authority is revoked immediately before issuance batch", async () => {
    const f = await fixture();
    let observed = false,
      baseline: Snapshot | undefined;
    f.useHub(
      resultStagedD1(f.db, async () => {
        observed = true;
        await f.revoke();
        baseline = await snapshot(f.db);
      }).db,
    );
    const response = await f.request(f.path("comments", "limit=2"));
    expect(observed, "the actual staged batch must be reached").toBe(true);
    expect(baseline).toBeDefined();
    expect(await snapshot(f.db)).toEqual(baseline);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    await foreignKeys(f.db);
  });

  it("loss of a nonanchor dependency lookahead rolls back the complete issuance", async () => {
    const f = await fixture(),
      ordered = [...f.targets].sort((a, b) => a.id.localeCompare(b.id));
    let observed = false,
      baseline: Snapshot | undefined;
    f.useHub(
      resultStagedD1(f.db, async () => {
        observed = true;
        await f.db
          .prepare(
            "INSERT INTO task_privacy(workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
          )
          .run(FIX.workspace, ordered[2]!.id, FIX.member, f.now);
        baseline = await snapshot(f.db);
      }).db,
    );
    const response = await f.request(f.path("dependencies", "limit=2")),
      body = (await response.json()) as Row;
    expect(observed, "the third target must disappear at the actual atomic batch").toBe(true);
    expect(baseline).toBeDefined();
    expect(await snapshot(f.db)).toEqual(baseline);
    expect(response.status).toBe(409);
    expect(body).toEqual({ error: "command_failed", message: "command failed" });
    expect(JSON.stringify(body)).not.toContain(MARKER);
    await foreignKeys(f.db);
  });

  it("post-Hub revocation withholds a page but retains its committed safe issuance history", async () => {
    const f = await fixture(),
      before = await snapshot(f.db);
    let observed = false,
      committed: Snapshot | undefined,
      baseline: Snapshot | undefined;
    f.afterIssue(async () => {
      observed = true;
      committed = await snapshot(f.db);
      assertIssuance(before, committed, 1, []);
      await f.revoke();
      baseline = await snapshot(f.db);
    });
    const response = await f.request(f.path("comments", "limit=2"));
    expect(observed, "a successful real Hub response must precede the mutation").toBe(true);
    expect(committed?.task_collection_positions).toHaveLength(1);
    expect(await snapshot(f.db)).toEqual(baseline);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(response.headers.get("cache-control")).toContain("no-store");
    await foreignKeys(f.db);
  });

  it("new project access cannot widen the original request ceiling after the actual Hub reply", async () => {
    const f = await fixture({ movable: true });
    let observed = false,
      baseline: Snapshot | undefined;
    f.afterIssue(async () => {
      observed = true;
      await f.db
        .prepare("UPDATE tasks SET project_id=? WHERE workspace_id=? AND id=?")
        .run(FIX.projectB, FIX.workspace, f.task.id);
      await f.db
        .prepare("INSERT INTO project_access(workspace_id,project_id,human_id) VALUES (?,?,?)")
        .run(FIX.workspace, FIX.projectB, FIX.reviewer);
      baseline = await snapshot(f.db);
    });
    const response = await f.request(f.path("comments", "limit=2"));
    expect(observed).toBe(true);
    expect(await snapshot(f.db)).toEqual(baseline);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    await foreignKeys(f.db);
    // A new authenticated request sees B; its terminal page proves the retained task/grant remains readable.
    expect(await unchanged(f.db, () => f.page("comments", "limit=50"))).toMatchObject({
      has_more: false,
      next_cursor: null,
    });
  });
});
