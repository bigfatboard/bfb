// ABOUTME: Proves current creator and named-human task authority at authenticated browser HTTP boundaries.
// ABOUTME: Keeps private creation dormant while exercising pagination, revoked receipts and bounded work audit payloads.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPrivateTaskCommand,
  FIX,
  randomUlid,
  resolveCommand,
  seedSyntheticWorkspace,
  WorkspaceHub,
} from "@bfb/domain";

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
const MISSING_TASK = "00000000000000000000000000";
const CANARY = "SYNTHETIC-C11-PRIVATE-WORK";
const contexts: AuthTestContext[] = [];
type Actor = "owner" | "member" | "reviewer";
type Permission = "read" | "contribute" | "edit";
type WorkApp = ReturnType<typeof createControlApp>;

interface TaskFixture {
  id: string;
  title: string;
}

interface PrivateWorkFixture {
  context: AuthTestContext;
  app: WorkApp;
  bindings: ControlBindings;
  actors: Record<Actor, { humanId: string; cookie: string; csrf: string }>;
  privateTask: TaskFixture;
  sharedTasks: TaskFixture[];
  runId?: string;
  taskVersion: number;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  for (const context of contexts.splice(0)) context.raw.close();
  vi.useRealTimers();
});

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

function bindings(context: AuthTestContext): ControlBindings {
  return {
    DB: fakeBinding<D1Database>("db"),
    ARTIFACTS: fakeBinding<R2Bucket>("r2"),
    ASSETS: fakeBinding<Fetcher>("assets"),
    JOBS: fakeBinding<Queue>("jobs"),
    JOBS_DLQ: fakeBinding<Queue>("dlq"),
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(context.db),
    APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
}

function appFor(context: AuthTestContext, currentBindings: ControlBindings): WorkApp {
  return createControlApp(validateControlEnv(currentBindings), {
    db: context.db,
    now: NOW,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
}

async function get(fixture: PrivateWorkFixture, actor: Actor, path: string): Promise<Response> {
  return fixture.app.request(
    new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, {
      headers: { cookie: fixture.actors[actor].cookie },
    }),
    undefined,
    fixture.bindings,
  );
}

async function write(
  fixture: PrivateWorkFixture,
  actor: Actor,
  path: string,
  method: "POST" | "PATCH",
  value: Record<string, unknown>,
): Promise<Response> {
  const principal = fixture.actors[actor];
  return fixture.app.request(
    new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, {
      method,
      headers: {
        cookie: principal.cookie,
        "content-type": "application/json",
        origin: AUTH_TEST_ENV.APP_ORIGIN,
        "sec-fetch-site": "same-origin",
        "x-bfb-csrf": principal.csrf,
      },
      body: JSON.stringify(value),
    }),
    undefined,
    fixture.bindings,
  );
}

async function successfulResult<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { result: T }).result;
}

async function privateWorkFixture(withResources = false): Promise<PrivateWorkFixture> {
  const context = openAuthTestContext(NOW);
  contexts.push(context);
  await seedSyntheticWorkspace(context.db, NOW);
  const currentBindings = bindings(context);
  const app = appFor(context, currentBindings);
  const actors = {} as PrivateWorkFixture["actors"];
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
    ["reviewer", FIX.reviewer],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `private-work-${actor}-user`,
      sessionId: `private-work-${actor}-session`,
      token: `private-work-${actor}-token`,
      email: `${actor}@synthetic.test`,
      name: `Synthetic ${actor}`,
      humanId,
      now: NOW,
    });
    const response = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/session`, {
        headers: { cookie: session.cookie },
      }),
      undefined,
      currentBindings,
    );
    expect(response.status).toBe(200);
    const csrf = ((await response.json()) as { csrf_token: string }).csrf_token;
    actors[actor] = { humanId, cookie: session.cookie, csrf };
  }
  const fixture: PrivateWorkFixture = {
    context,
    app,
    bindings: currentBindings,
    actors,
    privateTask: { id: "", title: "" },
    sharedTasks: [],
    taskVersion: 1,
  };
  const tasks: TaskFixture[] = [];
  for (let index = 0; index < 3; index++) {
    tasks.push(
      await successfulResult<TaskFixture>(
        await write(fixture, "member", `${BASE}/tasks`, "POST", {
          project_id: FIX.projectA,
          title: `${CANARY}-TITLE-${index}`,
          punchline: `${CANARY}-PUNCHLINE-${index}`,
          priority: "P0",
          due_at: "2026-10-05T12:00:00.000Z",
          next_owner_type: "human",
          next_owner_id: FIX.owner,
          next_action_reason: `${CANARY}-REASON-${index}`,
          request_id: `private-work-seed-task-${index}`,
        }),
      ),
    );
  }
  // The hidden record precedes both visible rows regardless of random ULID allocation.
  tasks.sort((left, right) => left.id.localeCompare(right.id));
  fixture.privateTask = tasks[0]!;
  fixture.sharedTasks = tasks.slice(1);

  if (withResources) {
    for (const [suffix, value] of [
      ["comments", { body: `${CANARY}-COMMENT`, kind: "discussion" }],
      ["context", { body: `${CANARY}-CONTEXT`, kind: "constraint", audience: "both" }],
      [
        "links",
        {
          kind: "external",
          url: `https://synthetic.invalid/${CANARY}-URL`,
          label: `${CANARY}-LINK`,
        },
      ],
      ["dependencies", { depends_on_task_id: fixture.sharedTasks[0]!.id }],
    ] as const) {
      await successfulResult(
        await write(
          fixture,
          "member",
          `${BASE}/tasks/${fixture.privateTask.id}/${suffix}`,
          "POST",
          {
            ...value,
            request_id: `private-work-seed-${suffix}`,
          },
        ),
      );
    }
    const result = await successfulResult<{ run: { id: string } }>(
      await write(fixture, "member", `${BASE}/tasks/${fixture.privateTask.id}/runs`, "POST", {
        expected_task_version: 1,
        agent_profile_id: FIX.profileCodex,
        workspace_policy_version: 1,
        project_policy_version: 1,
        repository_config_version: 1,
        agent_profile_version: 1,
        request_id: "private-work-seed-run",
      }),
    );
    fixture.runId = result.run.id;
    fixture.taskVersion = 2;
  }
  // Synthetic policy insertion is not a private-create command or product activation.
  await context.db
    .prepare(
      `INSERT INTO task_privacy
       (workspace_id, task_id, owner_human_id, access_version, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    )
    .run(FIX.workspace, fixture.privateTask.id, FIX.member, NOW);
  return fixture;
}

async function grant(
  fixture: PrivateWorkFixture,
  actor: Actor,
  permission: Permission,
): Promise<string> {
  const id = randomUlid();
  await fixture.context.db
    .prepare(
      `INSERT INTO task_human_grants
       (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(FIX.workspace, id, fixture.privateTask.id, fixture.actors[actor].humanId, permission, NOW);
  return id;
}

async function revoke(fixture: PrivateWorkFixture, grantId: string): Promise<void> {
  await fixture.context.db
    .prepare(`UPDATE task_human_grants SET revoked_at = ? WHERE workspace_id = ? AND id = ?`)
    .run(NOW, FIX.workspace, grantId);
}

async function inheritedWorkFixture(withResources = false) {
  const fixture = await privateWorkFixture();
  const setupGrantId = await grant(fixture, "owner", "edit");
  // Synthetic preparation calls the unregistered domain command directly, never an HTTP create route.
  expect(resolveCommand("task.private.create")).toBeUndefined();
  const prepared = await new WorkspaceHub(fixture.context.db).execute(createPrivateTaskCommand, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    idempotencyKey: "private-work-inherited-preparation",
    input: {
      projectId: FIX.projectA,
      parentTaskId: fixture.privateTask.id,
      title: `${CANARY}-INHERITED-TITLE`,
      punchline: `${CANARY}-INHERITED-PUNCHLINE`,
      priority: "P0",
      // An earlier due date deterministically ranks the child ahead of the three root-fixture tasks.
      dueAt: "2026-10-04T12:00:00.000Z",
      nextOwnerType: "human",
      nextOwnerId: FIX.owner,
      nextActionReason: `${CANARY}-INHERITED-REASON`,
    },
  });
  expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
  if (!prepared.ok) throw new Error(prepared.error.code);
  const inheritedTask = { id: prepared.result.task_id, title: `${CANARY}-INHERITED-TITLE` };
  expect(prepared.result).toEqual({
    task_id: inheritedTask.id,
    project_id: FIX.projectA,
    parent_task_id: fixture.privateTask.id,
    privacy_root_task_id: fixture.privateTask.id,
  });
  expect(
    await fixture.context.db
      .prepare(
        `SELECT task.created_by_human_id,task.created_by_delegation_id,inheritance.root_task_id
         FROM tasks AS task JOIN task_privacy_inheritance AS inheritance
           ON inheritance.workspace_id=task.workspace_id AND inheritance.task_id=task.id
         WHERE task.workspace_id=? AND task.id=?`,
      )
      .get(FIX.workspace, inheritedTask.id),
  ).toEqual({
    created_by_human_id: FIX.owner,
    created_by_delegation_id: null,
    root_task_id: fixture.privateTask.id,
  });
  await revoke(fixture, setupGrantId);
  expect(
    await fixture.context.db
      .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, setupGrantId),
  ).toEqual({ revoked_at: NOW });
  if (withResources) {
    for (const [suffix, value] of [
      ["comments", { body: `${CANARY}-INHERITED-COMMENT`, kind: "discussion" }],
      ["context", { body: `${CANARY}-INHERITED-CONTEXT`, kind: "constraint", audience: "both" }],
      [
        "links",
        {
          kind: "external",
          url: `https://synthetic.invalid/${CANARY}-INHERITED-URL`,
          label: `${CANARY}-INHERITED-LINK`,
        },
      ],
    ] as const) {
      await successfulResult(
        await write(fixture, "member", `${BASE}/tasks/${inheritedTask.id}/${suffix}`, "POST", {
          ...value,
          request_id: `private-work-inherited-seed-${suffix}`,
        }),
      );
    }
  }
  return { ...fixture, inheritedTask };
}

async function canonicalSnapshot(fixture: PrivateWorkFixture) {
  const rows = (await fixture.context.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  const canonical: Record<string, unknown[]> = {};
  for (const { name } of rows) {
    if (["sqlite_sequence", "d1_migrations", "_cf_METADATA", "rate_limit_buckets"].includes(name))
      continue;
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    expect(name.startsWith("sqlite_") || name.startsWith("_cf_")).toBe(false);
    canonical[name] = await fixture.context.db
      .prepare(`SELECT * FROM "${name}" ORDER BY rowid`)
      .all();
  }
  // Abuse buckets are independently mutable request bookkeeping, not canonical work effects.
  const budgets = await fixture.context.db
    .prepare("SELECT * FROM rate_limit_buckets ORDER BY rowid")
    .all();
  expect(await fixture.context.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  return { canonical, budgets };
}

function resourcePaths(fixture: PrivateWorkFixture, taskId = fixture.privateTask.id): string[] {
  return [
    "",
    "/comments",
    "/context",
    "/context?audience=agent",
    "/links",
    "/dependencies",
    "/runs",
  ].map((suffix) => `${BASE}/tasks/${taskId}${suffix}`);
}

const editCases = [
  {
    name: "task",
    method: "PATCH" as const,
    suffix: "",
    value: { title: `${CANARY}-EDITED-TITLE` },
  },
  {
    name: "context",
    method: "POST" as const,
    suffix: "/context",
    value: { kind: "note", audience: "human", body: `${CANARY}-EDITED-CONTEXT` },
  },
  {
    name: "link",
    method: "POST" as const,
    suffix: "/links",
    value: {
      kind: "external",
      url: `https://synthetic.invalid/${CANARY}-EDITED-URL`,
      label: `${CANARY}-EDITED-LINK`,
    },
  },
] as const;

describe("C11 private browser task delivery", () => {
  for (const actor of ["owner", "reviewer"] as const) {
    it(`hides private board, deck and list metadata from the unshared ${actor}`, async () => {
      const fixture = await privateWorkFixture();
      for (const path of [`${BASE}/board`, `${BASE}/tasks`]) {
        const response = await get(fixture, actor, path);
        expect(response.status).toBe(200);
        const rendered = await response.text();
        expect(rendered).not.toContain(fixture.privateTask.id);
        expect(rendered).not.toContain(fixture.privateTask.title);
        for (const task of fixture.sharedTasks) expect(rendered).toContain(task.id);
      }
    });

    it(`filters the hidden first task before LIMIT 1 for the ${actor}`, async () => {
      const fixture = await privateWorkFixture();
      const first = await get(fixture, actor, `${BASE}/tasks?limit=1`);
      expect(first.status).toBe(200);
      const page = (await first.json()) as { tasks: TaskFixture[]; next_cursor: string };
      expect(page).toMatchObject({ tasks: [{ id: fixture.sharedTasks[0]!.id }], has_more: true });
      const last = await get(fixture, actor, `${BASE}/tasks?limit=1&cursor=${page.next_cursor}`);
      expect(last.status).toBe(200);
      expect(await last.json()).toMatchObject({
        tasks: [{ id: fixture.sharedTasks[1]!.id }],
        has_more: false,
      });
    });

    it(`uniformly hides the task and child routes from the unshared ${actor}`, async () => {
      const fixture = await privateWorkFixture(true);
      for (const [index, path] of resourcePaths(fixture).entries()) {
        const denied = await get(fixture, actor, path);
        const missing = await get(fixture, actor, resourcePaths(fixture, MISSING_TASK)[index]!);
        expect(denied.status, path).toBe(404);
        expect(missing.status, path).toBe(404);
        expect(await denied.json(), path).toEqual(await missing.json());
      }
      const run = await get(fixture, actor, `${BASE}/runs/${fixture.runId}`);
      expect(run.status).toBe(404);
      expect(await run.json()).toEqual({ error: "not_found" });
    });

    it(`filters an inaccessible dependency endpoint before LIMIT for the ${actor}`, async () => {
      const fixture = await privateWorkFixture();
      const source = fixture.sharedTasks[1]!.id;
      // This represents retained legacy data, not a permitted shared-to-private mutation.
      for (const endpoint of [fixture.privateTask.id, fixture.sharedTasks[0]!.id]) {
        await fixture.context.db
          .prepare(
            `INSERT INTO task_dependencies
             (workspace_id, project_id, task_id, depends_on_task_id, kind, created_at)
             VALUES (?, ?, ?, ?, 'blocks', ?)`,
          )
          .run(FIX.workspace, FIX.projectA, source, endpoint, NOW);
      }
      const response = await get(fixture, actor, `${BASE}/tasks/${source}/dependencies?limit=1`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        dependencies: [{ depends_on_task_id: fixture.sharedTasks[0]!.id }],
        has_more: false,
      });
      expect(JSON.stringify(body)).not.toContain(fixture.privateTask.id);
      expect(JSON.stringify(body)).not.toContain(fixture.privateTask.title);
    });
  }

  for (const actor of ["member", "owner", "reviewer"] as const) {
    it(`includes private work for the ${actor === "member" ? "creator" : `named ${actor} reader`}`, async () => {
      const fixture = await privateWorkFixture();
      if (actor !== "member") await grant(fixture, actor, "read");
      for (const path of [
        `${BASE}/board`,
        `${BASE}/tasks`,
        `${BASE}/tasks/${fixture.privateTask.id}`,
      ]) {
        const response = await get(fixture, actor, path);
        expect(response.status).toBe(200);
        const rendered = await response.text();
        expect(rendered).toContain(fixture.privateTask.id);
        expect(rendered).toContain(fixture.privateTask.title);
      }
    });
  }

  it("rechecks the named reader on every child read after revocation", async () => {
    const fixture = await privateWorkFixture(true);
    const id = await grant(fixture, "owner", "read");
    const paths = [...resourcePaths(fixture), `${BASE}/runs/${fixture.runId}`];
    for (const path of paths) expect((await get(fixture, "owner", path)).status, path).toBe(200);
    await revoke(fixture, id);
    for (const path of paths) {
      const denied = await get(fixture, "owner", path);
      expect(denied.status, path).toBe(404);
      expect(await denied.json(), path).toEqual({ error: "not_found" });
    }
  });
});

describe("C11 private browser command authority", () => {
  for (const actor of ["owner", "reviewer"] as const) {
    for (const permission of [null, "read", "contribute", "edit"] as const) {
      it(`${actor} ${permission ?? "unshared"} comment authority`, async () => {
        const fixture = await privateWorkFixture();
        if (permission) await grant(fixture, actor, permission);
        const response = await write(
          fixture,
          actor,
          `${BASE}/tasks/${fixture.privateTask.id}/comments`,
          "POST",
          {
            body: `${CANARY}-GRANT-COMMENT`,
            request_id: "private-work-comment-grant",
          },
        );
        const allowed = permission === "contribute" || permission === "edit";
        expect(response.status).toBe(allowed ? 200 : 404);
        const count = await fixture.context.db
          .prepare(`SELECT COUNT(*) AS count FROM comments WHERE workspace_id = ? AND task_id = ?`)
          .get(FIX.workspace, fixture.privateTask.id);
        expect(count).toEqual({ count: allowed ? 1 : 0 });
      });
    }
  }

  for (const edit of editCases) {
    for (const [actor, permission] of [
      ["owner", "read"],
      ["owner", "contribute"],
      ["owner", "edit"],
      ["reviewer", "edit"],
    ] as const) {
      it(`${edit.name} edit intersects ${actor} role and ${permission} grant`, async () => {
        const fixture = await privateWorkFixture();
        await grant(fixture, actor, permission);
        const response = await write(
          fixture,
          actor,
          `${BASE}/tasks/${fixture.privateTask.id}${edit.suffix}`,
          edit.method,
          {
            ...edit.value,
            ...(edit.name === "task" ? { expected_version: fixture.taskVersion } : {}),
            request_id: `private-work-${edit.name}-grant`,
          },
        );
        if (actor === "reviewer") expect([403, 404]).toContain(response.status);
        else expect(response.status).toBe(permission === "edit" ? 200 : 404);
      });
    }
  }

  for (const command of [
    {
      name: "comment",
      suffix: "/comments",
      method: "POST" as const,
      value: { body: `${CANARY}-CACHED-COMMENT` },
    },
    ...editCases,
  ]) {
    it(`rechecks task access before a cached ${command.name} outcome`, async () => {
      const fixture = await privateWorkFixture();
      const id = await grant(fixture, "owner", "edit");
      const value = {
        ...command.value,
        ...(command.name === "task" ? { expected_version: fixture.taskVersion } : {}),
        request_id: `private-work-${command.name}-cached`,
      };
      const path = `${BASE}/tasks/${fixture.privateTask.id}${command.suffix}`;
      await successfulResult(await write(fixture, "owner", path, command.method, value));
      const replay = await write(fixture, "owner", path, command.method, value);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ ok: true, replayed: true });
      await revoke(fixture, id);
      const revoked = await write(fixture, "owner", path, command.method, value);
      const missing = await write(
        fixture,
        "owner",
        `${BASE}/tasks/${MISSING_TASK}${command.suffix}`,
        command.method,
        {
          ...value,
          request_id: `private-work-${command.name}-missing`,
        },
      );
      expect(revoked.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await revoked.json()).toEqual(await missing.json());
    });
  }

  for (const [field, value] of [
    ["visibility", "private"],
    ["private", true],
    ["owner_human_id", FIX.owner],
    ["private_owner_human_id", FIX.owner],
  ] as const) {
    it(`rejects private creation field ${field} on the shared API`, async () => {
      const fixture = await privateWorkFixture();
      const response = await write(fixture, "member", `${BASE}/tasks`, "POST", {
        project_id: FIX.projectA,
        title: `${CANARY}-UNAVAILABLE-CREATE`,
        [field]: value,
        request_id: `private-work-create-${field}`,
      });
      expect(response.status).toBe(400);
      expect(
        await fixture.context.db
          .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE workspace_id = ?`)
          .get(FIX.workspace),
      ).toEqual({ count: 3 });
    });
  }

  it("rejects even creator child creation while private inheritance is unavailable", async () => {
    const fixture = await privateWorkFixture();
    const response = await write(fixture, "member", `${BASE}/tasks`, "POST", {
      project_id: FIX.projectA,
      parent_task_id: fixture.privateTask.id,
      title: `${CANARY}-UNAVAILABLE-CHILD`,
      request_id: "private-work-create-child",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(
      await fixture.context.db
        .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE workspace_id = ?`)
        .get(FIX.workspace),
    ).toEqual({ count: 3 });
  });

  it("stores covered work receipts without synthetic titles or prose", async () => {
    const fixture = await privateWorkFixture(true);
    await successfulResult(
      await write(fixture, "member", `${BASE}/tasks/${fixture.privateTask.id}`, "PATCH", {
        expected_version: fixture.taskVersion,
        title: `${CANARY}-AUDIT-TITLE`,
        punchline: `${CANARY}-AUDIT-PUNCHLINE`,
        next_action_reason: `${CANARY}-AUDIT-REASON`,
        request_id: "private-work-audit-update",
      }),
    );
    const commandNames = [
      "task.create",
      "task.update",
      "comment.add",
      "context.add",
      "task.link.add",
      "task.dependency.add",
    ];
    const placeholders = commandNames.map(() => "?").join(", ");
    for (const [table, discriminator] of [
      ["audit_events", "action"],
      ["semantic_events", "kind"],
      ["outbox_records", "kind"],
    ] as const) {
      const rows = (await fixture.context.db
        .prepare(
          `SELECT ${discriminator} AS command, payload_json FROM ${table} WHERE workspace_id = ? AND ${discriminator} IN (${placeholders})`,
        )
        .all(FIX.workspace, ...commandNames)) as Array<{ command: string; payload_json: string }>;
      expect(new Set(rows.map((row) => row.command)), table).toEqual(new Set(commandNames));
      expect(JSON.stringify(rows), table).not.toContain(CANARY);
    }
  });
});

describe("C11 prepared inherited private browser delivery", () => {
  it("does not give the actual Owner author root authority after the setup edit grant is revoked", async () => {
    const fixture = await inheritedWorkFixture(true);
    const before = await canonicalSnapshot(fixture);
    for (const path of resourcePaths(fixture, fixture.inheritedTask.id)) {
      const denied = await get(fixture, "owner", path);
      expect(denied.status, path).toBe(404);
      expect(await denied.json(), path).toEqual({ error: "not_found" });
    }
    for (const path of [`${BASE}/board`, `${BASE}/tasks`]) {
      const response = await get(fixture, "owner", path);
      expect(response.status).toBe(200);
      const rendered = await response.text();
      expect(rendered).not.toContain(fixture.privateTask.id);
      expect(rendered).not.toContain(fixture.inheritedTask.id);
      expect(rendered).not.toContain(fixture.inheritedTask.title);
      for (const shared of fixture.sharedTasks) expect(rendered).toContain(shared.id);
    }
    const denied = await write(
      fixture,
      "owner",
      `${BASE}/tasks/${fixture.inheritedTask.id}/comments`,
      "POST",
      {
        body: `${CANARY}-INHERITED-AUTHOR-DENIED`,
        request_id: "private-work-inherited-author-denied",
      },
    );
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect((await canonicalSnapshot(fixture)).canonical).toEqual(before.canonical);
  });

  it("delivers inherited board, list, detail and child resources through named root read grants", async () => {
    const fixture = await inheritedWorkFixture(true);
    for (const actor of ["owner", "reviewer"] as const) await grant(fixture, actor, "read");
    const before = await canonicalSnapshot(fixture);
    for (const actor of ["owner", "reviewer"] as const) {
      for (const path of [`${BASE}/board`, `${BASE}/tasks`]) {
        const response = await get(fixture, actor, path);
        expect(response.status, path).toBe(200);
        const body = await response.json();
        const rendered = JSON.stringify(body);
        expect(rendered, path).toContain(fixture.inheritedTask.id);
        expect(rendered, path).toContain(fixture.inheritedTask.title);
        if (actor === "owner" && path === `${BASE}/board`) {
          expect(body.needs_now[0]).toEqual({
            taskId: fixture.inheritedTask.id,
            title: fixture.inheritedTask.title,
            projectId: FIX.projectA,
            priority: "P0",
            punchline: `${CANARY}-INHERITED-PUNCHLINE`,
            reason: `${CANARY}-INHERITED-REASON`,
          });
        }
      }
      const detail = await get(fixture, actor, `${BASE}/tasks/${fixture.inheritedTask.id}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        task: { id: fixture.inheritedTask.id, parent_task_id: fixture.privateTask.id },
      });
      for (const [suffix, key, value] of [
        ["/comments", "comments", { body: `${CANARY}-INHERITED-COMMENT` }],
        ["/context", "context", { body: `${CANARY}-INHERITED-CONTEXT`, audience: "both" }],
        [
          "/context?audience=agent",
          "context",
          { body: `${CANARY}-INHERITED-CONTEXT`, audience: "both" },
        ],
        ["/links", "links", { label: `${CANARY}-INHERITED-LINK` }],
      ] as const) {
        const response = await get(
          fixture,
          actor,
          `${BASE}/tasks/${fixture.inheritedTask.id}${suffix}`,
        );
        expect(response.status, suffix).toBe(200);
        expect(await response.json(), suffix).toMatchObject({ [key]: [value] });
      }
      for (const family of ["dependencies", "runs"] as const) {
        const response = await get(
          fixture,
          actor,
          `${BASE}/tasks/${fixture.inheritedTask.id}/${family}`,
        );
        expect(response.status, family).toBe(200);
        expect(await response.json(), family).toEqual({
          [family]: [],
          limit: 50,
          has_more: false,
          next_cursor: null,
        });
      }
    }
    expect((await canonicalSnapshot(fixture)).canonical).toEqual(before.canonical);
  });

  it("rechecks the inherited parent through every browser child read after root grant revocation", async () => {
    const fixture = await inheritedWorkFixture(true);
    const grantId = await grant(fixture, "owner", "read");
    const paths = resourcePaths(fixture, fixture.inheritedTask.id);
    for (const path of paths) expect((await get(fixture, "owner", path)).status, path).toBe(200);
    await successfulResult(
      await write(
        fixture,
        "member",
        `${BASE}/tasks/${fixture.privateTask.id}/sharing/grants/${grantId}/revoke`,
        "POST",
        {
          expected_access_version: 1,
          request_id: "private-work-inherited-read-revoke",
        },
      ),
    );
    const before = await canonicalSnapshot(fixture);
    for (const [index, path] of paths.entries()) {
      const denied = await get(fixture, "owner", path);
      const missing = await get(fixture, "owner", resourcePaths(fixture, MISSING_TASK)[index]!);
      expect(denied.status, path).toBe(404);
      expect(missing.status, path).toBe(404);
      expect(await denied.json(), path).toEqual(await missing.json());
    }
    expect((await canonicalSnapshot(fixture)).canonical).toEqual(before.canonical);
  });

  it("denies identical cached inherited work writes after root revocation while preserving their history", async () => {
    const fixture = await inheritedWorkFixture();
    const grantId = await grant(fixture, "owner", "edit");
    const commands = [
      {
        name: "comment",
        suffix: "/comments",
        method: "POST" as const,
        value: { body: `${CANARY}-INHERITED-CACHED-COMMENT` },
      },
      ...editCases,
    ].map((command) => ({
      ...command,
      path: `${BASE}/tasks/${fixture.inheritedTask.id}${command.suffix}`,
      input: {
        ...command.value,
        ...(command.name === "task" ? { expected_version: 1 } : {}),
        request_id: `private-work-inherited-${command.name}-cached`,
      },
    }));
    for (const command of commands) {
      const result = await successfulResult(
        await write(fixture, "owner", command.path, command.method, command.input),
      );
      const before = await canonicalSnapshot(fixture);
      const response = await write(fixture, "owner", command.path, command.method, command.input);
      expect(response.status, command.name).toBe(200);
      expect(await response.json(), command.name).toMatchObject({
        ok: true,
        replayed: true,
        result,
      });
      expect((await canonicalSnapshot(fixture)).canonical, command.name).toEqual(before.canonical);
    }
    await successfulResult(
      await write(
        fixture,
        "member",
        `${BASE}/tasks/${fixture.privateTask.id}/sharing/grants/${grantId}/revoke`,
        "POST",
        {
          expected_access_version: 1,
          request_id: "private-work-inherited-cached-revoke",
        },
      ),
    );
    const before = await canonicalSnapshot(fixture);
    expect(before.canonical.idempotency_records).toHaveLength(9);
    for (const command of commands) {
      const response = await write(fixture, "owner", command.path, command.method, command.input);
      expect(response.status, command.name).toBe(404);
      expect(await response.json(), command.name).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
    }
    expect((await canonicalSnapshot(fixture)).canonical).toEqual(before.canonical);
  });

  it("keeps browser sharing on the exact root instead of reinterpreting descendant IDs", async () => {
    const fixture = await inheritedWorkFixture();
    const grantId = await grant(fixture, "owner", "read");
    const root = await get(fixture, "member", `${BASE}/tasks/${fixture.privateTask.id}/sharing`);
    expect(root.status).toBe(200);
    expect(await root.json()).toMatchObject({
      sharing: {
        task_id: fixture.privateTask.id,
        access_version: 1,
        grants: [{ id: grantId, human_id: FIX.owner }],
      },
    });
    const before = await canonicalSnapshot(fixture);
    const denied = await get(
      fixture,
      "member",
      `${BASE}/tasks/${fixture.inheritedTask.id}/sharing`,
    );
    const missing = await get(fixture, "member", `${BASE}/tasks/${MISSING_TASK}/sharing`);
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await denied.json()).toEqual(await missing.json());
    for (const [suffix, input] of [
      [
        "/sharing/grants",
        { human_id: FIX.reviewer, permission: "read", expected_access_version: 1 },
      ],
      [`/sharing/grants/${grantId}/revoke`, { expected_access_version: 1 }],
    ] as const) {
      const response = await write(
        fixture,
        "member",
        `${BASE}/tasks/${fixture.inheritedTask.id}${suffix}`,
        "POST",
        {
          ...input,
          request_id: `private-work-inherited-sharing-${suffix.endsWith("revoke") ? "revoke" : "grant"}`,
        },
      );
      expect(response.status, suffix).toBe(404);
      expect(await response.json(), suffix).toEqual({
        error: "not_found",
        message: "task sharing not found",
      });
    }
    expect((await canonicalSnapshot(fixture)).canonical).toEqual(before.canonical);
  });
});
