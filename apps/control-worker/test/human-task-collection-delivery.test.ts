// ABOUTME: Exercises browser task child collections through genuine synthetic sessions and production work setup.
// ABOUTME: Final-parent races distinguish denial from empty pages while paged reads permit only opaque-position bookkeeping.

import type { SqlDatabase } from "@bfb/db";
import {
  FIX,
  bumpMemberEpoch,
  randomUlid,
  seedSyntheticWorkspace,
  type TaskRecord,
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

const NOW = "2026-10-06T12:00:00.000Z";
const BASE = `/api/v1/workspaces/${FIX.workspace}`;
const MARKER = "SYNTHETIC-C11-HUMAN-TASK-COLLECTION";
const contexts: AuthTestContext[] = [];
type Actor = "owner" | "member" | "reviewer";
const collections = [
  {
    name: "comments",
    suffix: "/comments",
    key: "comments",
    paged: true,
    source: /\bFROM comments\b/,
  },
  {
    name: "all context",
    suffix: "/context",
    key: "context",
    paged: false,
    source: /\bFROM task_context_items\b/,
  },
  {
    name: "agent context",
    suffix: "/context?audience=agent",
    key: "context",
    paged: false,
    source: /\bFROM task_context_items\b/,
  },
  {
    name: "dependencies",
    suffix: "/dependencies",
    key: "dependencies",
    paged: true,
    source: /\bFROM task_dependencies\b/,
  },
  { name: "links", suffix: "/links", key: "links", paged: true, source: /\bFROM task_links\b/ },
  { name: "work runs", suffix: "/runs", key: "runs", paged: true, source: /\bFROM runs\b/ },
] as const;
type Collection = (typeof collections)[number];
type Row = Record<string, unknown>;
interface CollectionBody {
  comments?: Row[];
  context?: Row[];
  dependencies?: Row[];
  links?: Row[];
  runs?: Row[];
  limit?: number;
  has_more?: boolean;
  next_cursor?: string | null;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const context of contexts.splice(0)) context.raw.close();
  vi.useRealTimers();
});

async function snapshot(db: SqlDatabase) {
  const result: Record<string, unknown[]> = {};
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
    result[name] = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return result;
}
async function foreignKeys(db: SqlDatabase) {
  expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}
async function unchanged<T>(db: SqlDatabase, read: () => Promise<T>) {
  await foreignKeys(db);
  const before = await snapshot(db),
    result = await read();
  expect(await snapshot(db)).toEqual(before);
  await foreignKeys(db);
  return result;
}

async function positionRead<T>(db: SqlDatabase, read: () => Promise<T>) {
  const before = await snapshot(db),
    result = await read(),
    after = await snapshot(db);
  const bookkeeping = new Set([
    "task_collection_positions",
    "semantic_events",
    "audit_events",
    "outbox_records",
    "idempotency_records",
    "workspace_cursors",
  ]);
  for (const name of Object.keys(after)) {
    if (!bookkeeping.has(name)) expect(after[name], name).toEqual(before[name]);
  }
  const positions = after.task_collection_positions ?? [],
    previous = before.task_collection_positions ?? [],
    issued = positions.length - previous.length;
  expect(positions.slice(0, previous.length)).toEqual(previous);
  for (const [table, actionKey] of [
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
      expect((row as Row)[actionKey], table).toBe("task.collection_position.issue");
    }
  }
  expect(after.workspace_cursors).toEqual(
    (before.workspace_cursors as Array<Row>).map((row) =>
      row.workspace_id === FIX.workspace ? { ...row, cursor: Number(row.cursor) + issued } : row,
    ),
  );
  await foreignKeys(db);
  return result;
}

function collectionPath(collection: Collection, taskId: string, query = "") {
  return `${BASE}/tasks/${taskId}${collection.suffix}${query ? `${collection.suffix.includes("?") ? "&" : "?"}${query}` : ""}`;
}
function emptyBody(collection: Collection, limit = 50) {
  return {
    [collection.key]: [],
    ...(collection.paged ? { limit, has_more: false, next_cursor: null } : {}),
  };
}
function rowId(collection: Collection, row: Row): string {
  const id = row[collection.key === "dependencies" ? "depends_on_task_id" : "id"];
  expect(typeof id).toBe("string");
  return id as string;
}

async function fixture(options: { resources?: boolean; movable?: boolean } = {}) {
  const context = openAuthTestContext(NOW);
  contexts.push(context);
  const db = context.db;
  await seedSyntheticWorkspace(db, NOW);
  const fake = <T extends object>(label: string) => ({ __synthetic: label }) as unknown as T;
  const bindings: ControlBindings = {
    DB: fake<D1Database>("db"),
    ARTIFACTS: fake<R2Bucket>("r2"),
    ASSETS: fake<Fetcher>("assets"),
    JOBS: fake<Queue>("jobs"),
    JOBS_DLQ: fake<Queue>("dlq"),
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(db),
    APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
  const app = createControlApp(validateControlEnv(bindings), {
    db,
    now: NOW,
    abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
  const actors = {} as Record<Actor, { cookie: string; csrf: string; humanId: string }>;
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
    ["reviewer", FIX.reviewer],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `task-collection-${actor}-user`,
      sessionId: `task-collection-${actor}-session`,
      token: `task-collection-${actor}-token`,
      email: `${actor}@task-collection.synthetic.test`,
      name: `Synthetic ${actor}`,
      humanId,
      now: NOW,
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
      humanId,
    };
  }
  async function request(path: string, actor: Actor = "reviewer", value?: Record<string, unknown>) {
    const identity = actors[actor];
    return app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, {
        method: value ? "POST" : "GET",
        headers: {
          cookie: identity.cookie,
          ...(value
            ? {
                "content-type": "application/json",
                origin: AUTH_TEST_ENV.APP_ORIGIN,
                "sec-fetch-site": "same-origin",
                "x-bfb-csrf": identity.csrf,
              }
            : {}),
        },
        ...(value ? { body: JSON.stringify(value) } : {}),
      }),
      undefined,
      bindings,
    );
  }
  async function write<T>(path: string, value: Record<string, unknown>): Promise<T> {
    const response = await request(path, "member", { ...value, request_id: randomUlid() });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { ok: boolean; result: T };
    expect(body.ok).toBe(true);
    return body.result;
  }
  const task = await write<TaskRecord>(`${BASE}/tasks`, {
    project_id: FIX.projectA,
    title: `${MARKER}-PARENT`,
    priority: "P2",
  });
  const comments: Array<{ id: string; body: string; kind: string }> = [];
  const contextItems: Array<{
    id: string;
    version: number;
    contentHash: string;
    audience: string;
    body: string;
    kind: string;
  }> = [];
  const links: Array<{ id: string; url: string; label: string }> = [];
  const dependencyTargets: TaskRecord[] = [];
  let runId: string | undefined;
  if (options.resources !== false) {
    for (const kind of ["discussion", "progress"] as const) {
      const body = `${MARKER}-${kind.toUpperCase()}`;
      comments.push({
        ...(await write<{ id: string }>(`${BASE}/tasks/${task.id}/comments`, { body, kind })),
        body,
        kind,
      });
    }
    for (const [audience, kind] of [
      ["human", "note"],
      ["agent", "constraint"],
      ["both", "acceptance"],
    ] as const) {
      const body = `${MARKER}-${audience.toUpperCase()}-CONTEXT`;
      contextItems.push({
        ...(await write<{ id: string; version: number; contentHash: string }>(
          `${BASE}/tasks/${task.id}/context`,
          { audience, kind, body },
        )),
        audience,
        kind,
        body,
      });
    }
    for (let index = 0; index < 2; index++) {
      const url = `https://synthetic.invalid/task-collection-${index}`,
        label = `${MARKER}-LINK-${index}`;
      links.push({
        ...(await write<{ id: string }>(`${BASE}/tasks/${task.id}/links`, {
          kind: "external",
          url,
          label,
        })),
        url,
        label,
      });
    }
    if (!options.movable) {
      for (let index = 0; index < 2; index++) {
        const target = await write<TaskRecord>(`${BASE}/tasks`, {
          project_id: FIX.projectA,
          title: `${MARKER}-DEPENDENCY-${index}`,
          priority: index === 0 ? "P1" : "P3",
        });
        dependencyTargets.push(target);
        await write(`${BASE}/tasks/${task.id}/dependencies`, { depends_on_task_id: target.id });
      }
      const result = await write<{ run: { id: string } }>(`${BASE}/tasks/${task.id}/runs`, {
        expected_task_version: task.resource_version,
        agent_profile_id: FIX.profileCodex,
        workspace_policy_version: 1,
        project_policy_version: 1,
        repository_config_version: 1,
        agent_profile_version: 1,
      });
      runId = result.run.id;
    }
  }
  // Explicit dormant policy/grant fixtures do not activate private creation or sharing.
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, task.id, FIX.member, NOW);
  const grants = {} as Record<"owner" | "reviewer", string>;
  for (const actor of ["owner", "reviewer"] as const) {
    const id = randomUlid();
    await db
      .prepare(
        "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)",
      )
      .run(FIX.workspace, id, task.id, actors[actor].humanId, NOW);
    grants[actor] = id;
  }
  async function revoke() {
    await db
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(NOW, FIX.workspace, grants.reviewer);
    expect(
      await db
        .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, grants.reviewer),
    ).toEqual({ revoked_at: NOW });
  }
  await foreignKeys(db);
  return {
    context,
    db,
    request,
    task,
    comments,
    contextItems,
    links,
    dependencyTargets,
    runId,
    revoke,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function beforeFinalSelection(f: Fixture, collection: Collection, change: () => Promise<void>) {
  const prepare = f.db.prepare.bind(f.db);
  let fired = false,
    baseline: Awaited<ReturnType<typeof snapshot>> | undefined;
  vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!collection.source.test(sql) || !sql.includes("SELECT")) return statement;
    const beforeRead = async () => {
      if (fired) return;
      fired = true;
      await change();
      await foreignKeys(f.db);
      baseline = await snapshot(f.db);
    };
    return {
      ...statement,
      all: async (...args: unknown[]) => {
        await beforeRead();
        return statement.all(...args);
      },
      get: async (...args: unknown[]) => {
        await beforeRead();
        return statement.get(...args);
      },
    };
  });
  return { fired: () => fired, baseline: () => baseline };
}
async function deniedAfterCut(
  f: Fixture,
  cut: ReturnType<typeof beforeFinalSelection>,
  response: Response,
  ambiguity = true,
) {
  const body: unknown = await response.json();
  expect(cut.fired(), "the actual final collection selection must execute the armed cut").toBe(
    true,
  );
  expect(cut.baseline()).toBeDefined();
  expect(await snapshot(f.db)).toEqual(cut.baseline());
  await foreignKeys(f.db);
  expect(JSON.stringify(body)).not.toContain(MARKER);
  expect(
    response.status,
    ambiguity
      ? "OLD late denial is a 200-empty ambiguity, not demonstrated body leakage"
      : "original captured project authority must not widen",
  ).toBe(404);
  expect(body).toEqual({ error: "not_found" });
}
async function read(f: Fixture, collection: Collection, query = "", actor: Actor = "reviewer") {
  const response = await f.request(collectionPath(collection, f.task.id, query), actor);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as CollectionBody;
}

describe("browser task collection final-parent delivery", () => {
  it.each(collections)(
    "$name populated late grant loss is denied rather than reported as empty",
    async (collection) => {
      const f = await fixture();
      const healthy = await unchanged(f.db, () => read(f, collection));
      expect(healthy[collection.key]?.length).toBeGreaterThan(0);
      const cut = beforeFinalSelection(f, collection, f.revoke);
      await deniedAfterCut(f, cut, await f.request(collectionPath(collection, f.task.id)));
    },
  );

  it.each(collections)(
    "$name authorized empty collection remains readable without effects",
    async (collection) => {
      const f = await fixture({ resources: false });
      expect(await unchanged(f.db, () => read(f, collection))).toEqual(emptyBody(collection));
    },
  );

  it.each(collections.filter((collection) => collection.paged))(
    "$name authorized opaque traversal reaches a terminal page",
    async (collection) => {
      const f = await fixture();
      let body = await positionRead(f.db, () => read(f, collection, "limit=1"));
      expect(body[collection.key]!.length).toBeGreaterThan(0);
      if (body.has_more) {
        expect(body.next_cursor).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        body = await unchanged(f.db, () =>
          read(f, collection, `limit=1&cursor=${body.next_cursor}`),
        );
      }
      expect(body).toMatchObject({ limit: 1, has_more: false, next_cursor: null });
    },
  );

  it("late denial of an actually empty context is not an authorized empty collection", async () => {
    const f = await fixture({ resources: false }),
      collection = collections[1];
    expect(await unchanged(f.db, () => read(f, collection))).toEqual({ context: [] });
    const cut = beforeFinalSelection(f, collection, f.revoke);
    await deniedAfterCut(f, cut, await f.request(collectionPath(collection, f.task.id)));
  });

  it("late denial at a real terminal comment cursor returns the uniform missing envelope", async () => {
    const f = await fixture(),
      collection = collections[0],
      first = await positionRead(f.db, () => read(f, collection, "limit=1"));
    expect(first.next_cursor).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const query = `limit=1&cursor=${first.next_cursor}`;
    expect(await unchanged(f.db, () => read(f, collection, query))).toMatchObject({
      limit: 1,
      has_more: false,
      next_cursor: null,
    });
    const cut = beforeFinalSelection(f, collection, f.revoke);
    await deniedAfterCut(f, cut, await f.request(collectionPath(collection, f.task.id, query)));
  });

  it.each(["epoch", "project", "membership"] as const)(
    "late %s loss is parent denial rather than a successful empty collection",
    async (loss) => {
      const f = await fixture(),
        collection =
          loss === "epoch" ? collections[1] : loss === "project" ? collections[0] : collections[4];
      if (loss === "membership") {
        // Project policy remains readable after its unused referencing grant is removed.
        await f.db
          .prepare("UPDATE projects SET access_mode='workspace' WHERE workspace_id=? AND id=?")
          .run(FIX.workspace, FIX.projectA);
      }
      expect(
        (await unchanged(f.db, () => read(f, collection)))[collection.key]?.length,
      ).toBeGreaterThan(0);
      const cut = beforeFinalSelection(f, collection, async () => {
        if (loss === "epoch") {
          expect(await bumpMemberEpoch(f.db, FIX.workspace, FIX.reviewer)).toBe(2);
          expect(
            await f.db
              .prepare(
                "SELECT authorization_epoch FROM workspace_members WHERE workspace_id=? AND human_id=?",
              )
              .get(FIX.workspace, FIX.reviewer),
          ).toEqual({ authorization_epoch: 2 });
        } else if (loss === "project") {
          await f.db
            .prepare(
              "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.projectA, FIX.reviewer);
          expect(
            await f.db
              .prepare(
                "SELECT 1 FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
              )
              .get(FIX.workspace, FIX.projectA, FIX.reviewer),
          ).toBeUndefined();
        } else {
          await f.db
            .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
            .run(FIX.workspace, FIX.reviewer);
          await f.db
            .prepare("DELETE FROM workspace_members WHERE workspace_id=? AND human_id=?")
            .run(FIX.workspace, FIX.reviewer);
          expect(
            await f.db
              .prepare("SELECT 1 FROM workspace_members WHERE workspace_id=? AND human_id=?")
              .get(FIX.workspace, FIX.reviewer),
          ).toBeUndefined();
          expect(
            await f.db
              .prepare("SELECT access_mode FROM projects WHERE workspace_id=? AND id=?")
              .get(FIX.workspace, FIX.projectA),
          ).toEqual({ access_mode: "workspace" });
        }
      });
      await deniedAfterCut(f, cut, await f.request(collectionPath(collection, f.task.id)));
    },
  );

  it("preserves useful fields, human attribution, context audience/version order and paged lookahead for a Reviewer", async () => {
    const f = await fixture();
    await positionRead(f.db, async () => {
      const comments = await read(f, collections[0]);
      expect(comments.comments).toEqual(
        [...f.comments]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((row) => ({
            ...row,
            author_human_id: FIX.member,
            author_delegation_id: null,
            created_at: NOW,
            author_kind: "human",
            author_run_id: null,
            author_execution_id: null,
            author_provider_session_id: null,
            percent: null,
            confidence: null,
          })),
      );
      const all = await read(f, collections[1]),
        agent = await read(f, collections[2]);
      const expectedContext = f.contextItems.map(({ contentHash, ...item }) => ({
        ...item,
        content_hash: contentHash,
        created_at: NOW,
      }));
      expect(all.context).toEqual(expectedContext);
      expect(agent.context).toEqual(expectedContext.filter((row) => row.audience !== "human"));
      const dependencies = await read(f, collections[3]);
      expect(dependencies.dependencies).toEqual(
        [...f.dependencyTargets]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((target) => ({
            depends_on_task_id: target.id,
            kind: "blocks",
            created_at: NOW,
            title: target.title,
            state: target.state,
            priority: target.priority,
          })),
      );
      const links = await read(f, collections[4]);
      expect(links.links).toEqual(
        [...f.links]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((row) => ({ ...row, kind: "external", created_at: NOW })),
      );
      const runs = await read(f, collections[5]);
      expect(runs.runs).toEqual([
        {
          id: f.runId,
          project_id: FIX.projectA,
          task_id: f.task.id,
          requested_by_human_id: FIX.member,
          agent_profile_id: FIX.profileCodex,
          result_state: "open",
          activity: "unknown",
          resource_version: 1,
          created_at: NOW,
        },
      ]);
      for (const collection of [collections[0], collections[3], collections[4]]) {
        const first = await read(f, collection, "limit=1"),
          rows = first[collection.key]!;
        expect(first).toMatchObject({
          limit: 1,
          has_more: true,
        });
        expect(first.next_cursor).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(first.next_cursor).not.toBe(rowId(collection, rows[0]!));
        expect(rows).toHaveLength(1);
        const second = await read(f, collection, `limit=1&cursor=${first.next_cursor}`);
        expect(second).toMatchObject({ limit: 1, has_more: false });
        expect(second.next_cursor).toBeNull();
        expect(
          rowId(collection, second[collection.key]![0]!).localeCompare(rowId(collection, rows[0]!)),
        ).toBeGreaterThan(0);
      }
      for (const actor of ["owner", "member"] as const) {
        const body = await read(f, collections[1], "", actor);
        expect(body.context).toEqual(expectedContext);
      }
    });
  });

  it("filters an inaccessible dependency endpoint before limit without denying its readable parent", async () => {
    const f = await fixture(),
      ordered = [...f.dependencyTargets].sort((a, b) => a.id.localeCompare(b.id));
    await f.db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, ordered[0]!.id, FIX.member, NOW);
    const response = await unchanged(f.db, () => read(f, collections[3], "limit=1"));
    expect(response).toEqual({
      dependencies: [
        {
          depends_on_task_id: ordered[1]!.id,
          kind: "blocks",
          created_at: NOW,
          title: ordered[1]!.title,
          state: ordered[1]!.state,
          priority: ordered[1]!.priority,
        },
      ],
      limit: 1,
      has_more: false,
      next_cursor: null,
    });
    expect(JSON.stringify(response)).not.toContain(ordered[0]!.id);
  });

  it("a fixture-only FK-clean task move plus newly gained project access cannot widen the captured project ceiling", async () => {
    const f = await fixture({ movable: true }),
      collection = collections[0];
    expect((await unchanged(f.db, () => read(f, collection))).comments).toHaveLength(2);
    expect(
      await f.db
        .prepare(
          "SELECT 1 FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
        )
        .get(FIX.workspace, FIX.projectB, FIX.reviewer),
    ).toBeUndefined();
    const cut = beforeFinalSelection(f, collection, async () => {
      // Only this mutable disposable task moves; no run/dependency or immutable context row is rewritten.
      await f.db
        .prepare("UPDATE tasks SET project_id=? WHERE workspace_id=? AND id=?")
        .run(FIX.projectB, FIX.workspace, f.task.id);
      await f.db
        .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
        .run(FIX.workspace, FIX.projectB, FIX.reviewer);
      expect(
        await f.db
          .prepare("SELECT project_id FROM tasks WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.task.id),
      ).toEqual({ project_id: FIX.projectB });
      expect(
        await f.db
          .prepare(
            "SELECT human_id FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
          )
          .get(FIX.workspace, FIX.projectB, FIX.reviewer),
      ).toEqual({ human_id: FIX.reviewer });
    });
    await deniedAfterCut(f, cut, await f.request(collectionPath(collection, f.task.id)), false);
  });

  it("initially denied and absent parents keep the same exact envelope across all six paths without effects", async () => {
    const f = await fixture();
    await f.revoke();
    await unchanged(f.db, async () => {
      for (const collection of collections) {
        const denied = await f.request(collectionPath(collection, f.task.id)),
          missing = await f.request(collectionPath(collection, randomUlid()));
        expect(denied.status).toBe(404);
        expect(missing.status).toBe(404);
        expect(await denied.json()).toEqual({ error: "not_found" });
        expect(await missing.json()).toEqual({ error: "not_found" });
      }
    });
  });
});
