// ABOUTME: Exercises shared-parent human coordination history through mounted authenticated browser reads.
// ABOUTME: Current viewer races and exact recorded launch tuples cannot become private coordination delivery.

import type { SqlDatabase } from "@bfb/db";
import {
  changeDiscussionCommand,
  createTaskCommand,
  FIX,
  randomUlid,
  rejectLaunchCommand,
  startLaunchCommand,
} from "@bfb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discussionFixture } from "../../../packages/domain/test/discussion-fixture.js";
import {
  LAUNCH_NOW,
  launchFixture,
  success,
} from "../../../packages/domain/test/launch-fixture.js";
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
const BASE = `/api/v1/workspaces/${FIX.workspace}`;
const CANARY = "SYNTHETIC-PRIVATE-COORDINATION-HISTORY";
const contexts: AuthTestContext[] = [];
type Actor = "owner" | "member" | "reviewer";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(LAUNCH_NOW);
});
afterEach(() => {
  contexts.splice(0).forEach((context) => context.raw.close());
  vi.useRealTimers();
});

async function mounted(context: AuthTestContext) {
  const cookies = {} as Record<Actor, string>;
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
    ["reviewer", FIX.reviewer],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `coordination-${actor}-user`,
      sessionId: `coordination-${actor}-session`,
      token: `coordination-${actor}-token`,
      email: `${actor}@synthetic.test`,
      humanId,
      now: LAUNCH_NOW,
    });
    cookies[actor] = session.cookie;
  }
  const bindings = {
    DB: {},
    ARTIFACTS: {},
    ASSETS: {},
    JOBS: {},
    JOBS_DLQ: {},
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(context.db),
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
    DISCUSSIONS_ENABLED: "true",
  } as unknown as ControlBindings;
  const get = (path: string, actor: Actor = "owner", database = context.db) =>
    createControlApp(validateControlEnv(bindings), {
      db: database,
      now: LAUNCH_NOW,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      humanAuth: () => ({
        auth: context.auth,
        keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
        abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      }),
    }).request(
      new Request(ORIGIN + BASE + path, { headers: { cookie: cookies[actor] } }),
      undefined,
      bindings,
    );
  return { get };
}

async function launchSetup(create = true) {
  const context = openAuthTestContext(LAUNCH_NOW);
  contexts.push(context);
  const f = await launchFixture(context.db);
  const launch = create ? success(await f.human(startLaunchCommand, f.start)) : undefined;
  return { ...f, context, launch, ...(await mounted(context)) };
}

async function discussionSetup(history = false) {
  const context = openAuthTestContext(LAUNCH_NOW);
  contexts.push(context);
  const f = await discussionFixture(context.db);
  const created = await f.create();
  if (history) {
    await f.complete(created.discussion_id, 1);
    const recommendations = (await f.db
      .prepare("SELECT id FROM discussion_messages WHERE discussion_id=? AND kind='recommendation'")
      .all(created.discussion_id)) as { id: string }[];
    success(
      await f.human(changeDiscussionCommand, {
        schema_version: 1,
        idempotency_key: randomUlid(),
        discussion_id: created.discussion_id,
        expected_version: (await f.row(created.discussion_id)).resource_version,
        action: "cancel",
      }),
    );
    success(
      await f.human(changeDiscussionCommand, {
        schema_version: 1,
        idempotency_key: randomUlid(),
        discussion_id: created.discussion_id,
        expected_version: (await f.row(created.discussion_id)).resource_version,
        action: "decide",
        decision: {
          kind: "record_recommendation",
          recommendation_ids: [recommendations[0]!.id],
          summary: CANARY,
        },
      }),
    );
  }
  return { ...f, context, created, ...(await mounted(context)) };
}

async function privacy(db: SqlDatabase, taskId: string, grants = false) {
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, taskId, FIX.owner, LAUNCH_NOW);
  if (grants)
    await db
      .prepare(
        `INSERT INTO task_human_grants
    (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)`,
      )
      .run(FIX.workspace, randomUlid(), taskId, FIX.member, LAUNCH_NOW);
}

async function epoch(db: SqlDatabase, humanId = FIX.owner) {
  await db
    .prepare(
      "UPDATE workspace_members SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
    )
    .run(FIX.workspace, humanId);
  await db
    .prepare(
      "UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
    )
    .run(FIX.workspace, humanId);
}

async function projectLoss(db: SqlDatabase) {
  await db
    .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
    .run(FIX.workspace, FIX.projectA);
  await db
    .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
    .run(FIX.workspace, FIX.projectA, FIX.owner);
}

function intercepted(
  db: SqlDatabase,
  matches: (sql: string) => boolean,
  mutate: () => Promise<void>,
  after = false,
) {
  let observed = false;
  const database: SqlDatabase = {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!matches(sql)) return statement;
      async function invoke() {
        if (!observed) {
          observed = true;
          await mutate();
        }
      }
      return {
        ...statement,
        async get(...params) {
          if (!after) await invoke();
          const result = await statement.get(...params);
          if (after) await invoke();
          return result;
        },
        async all(...params) {
          if (!after) await invoke();
          const result = await statement.all(...params);
          if (after) await invoke();
          return result;
        },
      };
    },
  };
  return { database, observed: () => expect(observed).toBe(true) };
}

function launchBoundary(sql: string) {
  return sql.includes("launch_commands AS launch");
}
function discussionListBoundary(sql: string) {
  return (
    sql.includes("readable_parent AS MATERIALIZED") ||
    sql.includes("FROM discussions WHERE workspace_id = ? AND task_id = ?")
  );
}
function launchPath(taskId: string, launchId: string, boundary: "list" | "detail") {
  return boundary === "list" ? `/launches?task_id=${taskId}` : `/launches/${launchId}`;
}
async function missing(response: Response, launch = false) {
  expect(response.status, await response.clone().text()).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(
    launch ? { error: "not_found", message: "launch is not available" } : { error: "not_found" },
  );
}

describe("mounted current human coordination history", () => {
  it.each(["list", "detail"] as const)(
    "holds private launch %s equally for creator, grantee and unrelated reader",
    async (boundary) => {
      const f = await launchSetup();
      await privacy(f.db, f.task.id, true);
      for (const actor of ["owner", "member", "reviewer"] as const) {
        await missing(
          await f.get(launchPath(f.task.id, f.launch!.launch_id, boundary), actor),
          true,
        );
        await missing(await f.get(launchPath(randomUlid(), randomUlid(), boundary), actor), true);
      }
    },
  );

  for (const boundary of ["list", "detail"] as const) {
    it.each(["privacy", "project", "epoch", "membership"] as const)(
      `rechecks %s at the final launch ${boundary} selection`,
      async (loss) => {
        const f = await launchSetup();
        const race = intercepted(f.db, launchBoundary, async () => {
          if (loss === "privacy") await privacy(f.db, f.task.id);
          if (loss === "project") await projectLoss(f.db);
          if (loss === "epoch") await epoch(f.db);
          if (loss === "membership") {
            await f.db
              .prepare(
                "UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND human_id=?",
              )
              .run(FIX.workspace, FIX.member);
            await f.db
              .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
              .run(FIX.workspace, FIX.owner);
            await f.db
              .prepare("DELETE FROM runner_launch_grants WHERE workspace_id=? AND human_id=?")
              .run(FIX.workspace, FIX.owner);
            await f.db
              .prepare("DELETE FROM workspace_members WHERE workspace_id=? AND human_id=?")
              .run(FIX.workspace, FIX.owner);
            expect(
              await f.db
                .prepare(
                  "SELECT human_id FROM workspace_members WHERE workspace_id=? AND human_id=?",
                )
                .get(FIX.workspace, FIX.owner),
            ).toBeUndefined();
          }
        });
        await missing(
          await f.get(launchPath(f.task.id, f.launch!.launch_id, boundary), "owner", race.database),
          true,
        );
        race.observed();
      },
    );
    it(`retains the first workspace epoch across later project hydration for launch ${boundary}`, async () => {
      const f = await launchSetup();
      const race = intercepted(
        f.db,
        (sql) => sql.includes("SELECT projects.id"),
        () => epoch(f.db),
        true,
      );
      await missing(
        await f.get(launchPath(f.task.id, f.launch!.launch_id, boundary), "owner", race.database),
        true,
      );
      race.observed();
    });
  }

  it("requires the current parent and retained epoch even for an empty launch list", async () => {
    const f = await launchSetup(false);
    const race = intercepted(f.db, launchBoundary, () => epoch(f.db));
    await missing(await f.get(`/launches?task_id=${f.task.id}`, "owner", race.database), true);
    race.observed();
  });

  it.each(["generation", "execution-run", "snapshot-run", "task-project"] as const)(
    "omits synthetic %s tuple corruption from both launch reads",
    async (kind) => {
      const f = await launchSetup();
      // Corruption fixtures bypass immutable/FK storage guards deliberately; they assert no producer provenance.
      f.context.raw.pragma("foreign_keys = OFF");
      if (kind === "generation") {
        f.context.raw.exec("DROP TRIGGER launch_commands_binding_immutable");
        await f.db
          .prepare(
            "UPDATE launch_commands SET assignment_generation=assignment_generation+1 WHERE id=?",
          )
          .run(f.launch!.launch_id);
      }
      if (kind === "execution-run")
        await f.db
          .prepare("UPDATE run_executions SET run_id=? WHERE id=?")
          .run(randomUlid(), f.launch!.run_execution_id);
      if (kind === "snapshot-run") {
        f.context.raw.exec("DROP TRIGGER run_configuration_snapshots_immutable_update");
        await f.db
          .prepare("UPDATE run_configuration_snapshots SET run_id=? WHERE run_id=?")
          .run(randomUlid(), f.launch!.run_id);
      }
      if (kind === "task-project")
        await f.db.prepare("UPDATE tasks SET project_id=? WHERE id=?").run(FIX.projectB, f.task.id);
      expect(await (await f.get(`/launches?task_id=${f.task.id}`)).json()).toEqual({
        launches: [],
      });
      await missing(await f.get(`/launches/${f.launch!.launch_id}`), true);
    },
  );

  it("omits a genuinely malformed NUL-suffixed run identity before launch delivery", async () => {
    const f = await launchSetup();
    const malformed = f.launch!.run_id + "\u0000" + CANARY;
    f.context.raw.pragma("foreign_keys = OFF");
    f.context.raw.exec(
      "DROP TRIGGER execution_assignments_immutable_update; DROP TRIGGER launch_commands_binding_immutable; DROP TRIGGER run_configuration_snapshots_immutable_update",
    );
    // All relation columns agree synthetically; typed identity validation must still reject the source.
    for (const [table, column] of [
      ["runs", "id"],
      ["run_executions", "run_id"],
      ["execution_assignments", "run_id"],
      ["launch_commands", "run_id"],
      ["run_configuration_snapshots", "run_id"],
    ]) {
      await f.db
        .prepare(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`)
        .run(malformed, f.launch!.run_id);
    }
    expect(await (await f.get(`/launches?task_id=${f.task.id}`)).json()).toEqual({ launches: [] });
    await missing(await f.get(`/launches/${f.launch!.launch_id}`), true);
  });

  it("does not attribute a replacement checkout occupant's lease to recorded launch history", async () => {
    const f = await launchSetup();
    const task = success(
      await f.human(createTaskCommand, {
        projectId: FIX.projectA,
        title: "Synthetic replacement",
        priority: "P2",
      }),
    );
    const replacement = success(
      await f.human(startLaunchCommand, {
        ...f.start,
        task_id: task.id,
        idempotency_key: randomUlid(),
      }),
    );
    const claimed = await f.claim();
    // A different genuine assignment occupies the same physical key; no provider execution is performed.
    await f.db
      .prepare(
        "UPDATE checkout_leases SET execution_id=?,assignment_generation=? WHERE workspace_id=? AND runner_id=?",
      )
      .run(
        replacement.run_execution_id,
        replacement.assignment_generation,
        FIX.workspace,
        f.runner,
      );
    const response = await f.get(`/launches/${claimed.launch.launch_id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      launch: { launch_id: claimed.launch.launch_id, lease_state: null, containment_reason: null },
    });
  });

  it("preserves shared terminal history and an exact historical lease", async () => {
    const f = await launchSetup();
    const claimed = await f.claim();
    success(
      await f.native(rejectLaunchCommand, {
        principal: f.principal,
        launchId: claimed.launch.launch_id,
        executionId: claimed.final.run_execution_id,
        assignmentGeneration: claimed.final.assignment_generation,
      }),
    );
    const response = await f.get(`/launches/${claimed.launch.launch_id}`, "member");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      launch: {
        state: "rejected",
        execution_state: "ended",
        result_state: "open",
        provider: "fake",
        lease_state: "reserved",
      },
    });
    expect(
      await (await f.get(`/launches?task_id=${f.task.id}&limit=1`, "member")).json(),
    ).toMatchObject({ launches: [{ launch_id: claimed.launch.launch_id }] });
  });

  it("filters a misbound newer source before the launch list limit", async () => {
    const f = await launchSetup();
    success(
      await f.native(rejectLaunchCommand, {
        principal: f.principal,
        launchId: f.launch!.launch_id,
        executionId: f.launch!.run_execution_id,
        assignmentGeneration: f.launch!.assignment_generation,
      }),
    );
    const task = (await f.db
      .prepare("SELECT resource_version FROM tasks WHERE id=?")
      .get(f.task.id)) as { resource_version: number };
    const newer = success(
      await f.human(startLaunchCommand, {
        ...f.start,
        idempotency_key: randomUlid(),
        expected_task_version: task.resource_version,
      }),
    );
    // Historical corruption is synthetic, not a claim that a command can forge this immutable binding.
    f.context.raw.pragma("foreign_keys = OFF");
    f.context.raw.exec("DROP TRIGGER launch_commands_binding_immutable");
    await f.db
      .prepare(
        "UPDATE launch_commands SET assignment_generation=assignment_generation+1,created_at=? WHERE id=?",
      )
      .run("2026-09-12T12:00:01Z", newer.launch_id);
    const response = await f.get(`/launches?task_id=${f.task.id}&limit=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      launches: [{ launch_id: f.launch!.launch_id, state: "rejected" }],
    });
  });

  it("holds genuine discussion recommendations and decisions after privatization for every human", async () => {
    const f = await discussionSetup(true);
    const path = `/discussions/${f.created.discussion_id}`;
    const shared = await f.get(path);
    expect(shared.status).toBe(200);
    const content = await shared.text();
    expect(content).toContain(CANARY);
    expect(content).toContain("recommendation");
    await privacy(f.db, f.task.id, true);
    for (const actor of ["owner", "member", "reviewer"] as const) {
      await missing(await f.get(path, actor));
      await missing(await f.get(`/discussions/${randomUlid()}`, actor));
      await missing(await f.get(`/tasks/${f.task.id}/discussions`, actor));
    }
  });

  for (const boundary of ["list", "detail"] as const) {
    it(`retains the first workspace epoch across discussion ${boundary} lookup`, async () => {
      const f = await discussionSetup();
      const race = intercepted(
        f.db,
        (sql) => sql.includes("SELECT projects.id"),
        () => epoch(f.db),
        true,
      );
      const path =
        boundary === "list"
          ? `/tasks/${f.task.id}/discussions`
          : `/discussions/${f.created.discussion_id}`;
      await missing(await f.get(path, "owner", race.database));
      race.observed();
    });
    it.each(["privacy", "project", "epoch"] as const)(
      `rechecks %s after discussion ${boundary} hydration`,
      async (loss) => {
        const f = await discussionSetup();
        const match =
          boundary === "list"
            ? discussionListBoundary
            : (sql: string) => sql.includes("FROM discussion_decisions");
        const race = intercepted(f.db, match, async () => {
          if (loss === "privacy") await privacy(f.db, f.task.id);
          if (loss === "project") await projectLoss(f.db);
          if (loss === "epoch") await epoch(f.db);
        });
        const path =
          boundary === "list"
            ? `/tasks/${f.task.id}/discussions`
            : `/discussions/${f.created.discussion_id}`;
        await missing(await f.get(path, "owner", race.database));
        race.observed();
      },
    );
  }

  it("denies an empty discussion page after current viewer epoch loss", async () => {
    const f = await discussionSetup();
    const race = intercepted(f.db, discussionListBoundary, () => epoch(f.db));
    await missing(
      await f.get(
        `/tasks/${f.task.id}/discussions?cursor=7ZZZZZZZZZZZZZZZZZZZZZZZZZ`,
        "owner",
        race.database,
      ),
    );
    race.observed();
  });

  it("retains a readable sponsor-revoked advisory for another authorized shared viewer", async () => {
    const f = await discussionSetup();
    await epoch(f.db);
    const response = await f.get(`/discussions/${f.created.discussion_id}`, "member");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      discussion: { dispatch_block_reason: "sponsor_revoked", participants: [{}, {}] },
    });
  });

  it("preserves discussion pagination admission and independent shared empty pages", async () => {
    const f = await discussionSetup();
    const path = `/tasks/${f.task.id}/discussions`;
    expect((await f.get(path + "?limit=0")).status).toBe(400);
    expect((await f.get(path + "?cursor=invalid")).status).toBe(400);
    expect((await f.get(`/discussions/${f.created.discussion_id}?scope=participant`)).status).toBe(
      400,
    );
    expect(await (await f.get(path + "?cursor=7ZZZZZZZZZZZZZZZZZZZZZZZZZ")).json()).toEqual({
      schema_version: 1,
      discussions: [],
      has_more: false,
    });
  });
});
