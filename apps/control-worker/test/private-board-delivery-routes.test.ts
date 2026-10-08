// ABOUTME: Exercises canonical board and attention-deck delivery through authenticated browser requests.
// ABOUTME: Current retained human authority and one final selection fence private and stale hydrated cards.

import type { SqlDatabase } from "@bfb/db";
import { FIX, randomUlid, seedSyntheticWorkspace } from "@bfb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createControlApp } from "../src/routes.js";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
  type AuthTestContext,
} from "./auth-helpers.js";

const NOW = "2026-10-07T12:00:00.000Z";
const BASE = `/api/v1/workspaces/${FIX.workspace}/board`;
const TASK_A = "00000000000000000000000100";
const TASK_B = "00000000000000000000000101";
const PRIVATE_TASK = "00000000000000000000000001";
const CANARY = "SYNTHETIC-C11-BOARD-PRIVATE";
const SCOPE_DENIED = { error: "not_found", message: "board scope not found" };
type Actor = "owner" | "member" | "reviewer";
type Card = {
  taskId: string;
  title: string;
  projectId: string;
  punchline: string;
  state: string;
  whyHuman?: string;
  humanOwnerName?: string;
  passToAgentProfileId?: string;
  latestEvent?: unknown;
  runSummary?: { resultState: string; activity: string };
};
type Board = {
  human: { id: string; display_name: string };
  role: string;
  authorization_epoch: number;
  lanes: Array<{ projectId: string; slug: string; tasks: Card[] }>;
  needs_now: Array<{ taskId: string; title: string; reason: string }>;
  agent_work_available: boolean;
  recent_events_available: boolean;
};
const contexts: AuthTestContext[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  contexts.splice(0).forEach((context) => context.raw.close());
  vi.useRealTimers();
});

async function fixture(withTasks = true, observedNow = NOW) {
  const context = openAuthTestContext(NOW);
  contexts.push(context);
  const db = context.db;
  await seedSyntheticWorkspace(db, NOW);
  const bindings = {
    DB: {},
    ARTIFACTS: {},
    ASSETS: {},
    JOBS: {},
    JOBS_DLQ: {},
    WORKSPACE_HUB: {},
    APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  } as unknown as ControlBindings;
  const cookies = {} as Record<Actor, string>;
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
    ["reviewer", FIX.reviewer],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `board-${actor}-user`,
      sessionId: `board-${actor}-session`,
      token: `board-${actor}-token`,
      email: `${actor}@synthetic.test`,
      humanId,
      now: NOW,
    });
    cookies[actor] = session.cookie;
  }
  const task = async (
    id: string,
    options: {
      project?: string;
      title?: string;
      priority?: string;
      due?: string | null;
      state?: string;
      owner?: string;
      ownerType?: string;
    } = {},
  ) => {
    await db
      .prepare(
        `INSERT INTO tasks
         (workspace_id,id,project_id,title,state,priority,due_at,next_owner_type,next_owner_id,
          next_action_reason,punchline,resource_version,created_by_human_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      )
      .run(
        FIX.workspace,
        id,
        options.project ?? FIX.projectA,
        options.title ?? `Synthetic board task ${id}`,
        options.state ?? "blocked",
        options.priority ?? "P1",
        options.due === undefined ? "2026-10-06T12:00:00.000Z" : options.due,
        options.ownerType ?? "human",
        options.owner ?? FIX.owner,
        "Synthetic current decision",
        `Synthetic board summary ${id}`,
        FIX.member,
        NOW,
      );
  };
  if (withTasks) {
    await task(TASK_A);
    await task(TASK_B, { project: FIX.projectB, priority: "P2", state: "ready", due: null });
  }
  const privatize = async (id = PRIVATE_TASK) => {
    await db
      .prepare(
        `INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,access_version,created_at)
         VALUES (?,?,?,1,?)`,
      )
      .run(FIX.workspace, id, FIX.member, NOW);
  };
  const grant = async (humanId = FIX.owner) => {
    const id = randomUlid();
    await db
      .prepare(
        `INSERT INTO task_human_grants
         (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
         VALUES (?,?,?,?,1,'read',?)`,
      )
      .run(FIX.workspace, id, PRIVATE_TASK, humanId, NOW);
    return id;
  };
  const read = (actor: Actor = "owner", database = db, cookie = cookies[actor]) => {
    const app = createControlApp(validateControlEnv(bindings), {
      db: database,
      now: observedNow,
      humanAuth: () => ({
        auth: context.auth,
        keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
        abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      }),
    });
    return app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${BASE}`, { headers: { cookie } }),
      undefined,
      bindings,
    );
  };
  const removeMember = async () => {
    await db
      .prepare(`DELETE FROM project_access WHERE workspace_id=? AND human_id=?`)
      .run(FIX.workspace, FIX.member);
    await db
      .prepare(`DELETE FROM workspace_members WHERE workspace_id=? AND human_id=?`)
      .run(FIX.workspace, FIX.member);
  };
  return { context, db, read, task, privatize, grant, removeMember };
}

/** Interleaves real SQL reads; never replaces returned rows or the production selection. */
function boundary(
  db: SqlDatabase,
  point: "after_principal" | "before_delivery",
  change: () => Promise<unknown>,
) {
  let fired = false;
  const queries: string[] = [];
  const wrapped: SqlDatabase = {
    ...db,
    prepare(sql) {
      queries.push(sql);
      const statement = db.prepare(sql);
      const selected =
        point === "after_principal"
          ? sql.includes("LEFT JOIN project_access AS access")
          : sql.includes("FROM runs") || sql.includes("board_scope");
      const mutate = async () => {
        if (selected && !fired) {
          fired = true;
          await change();
        }
      };
      return {
        ...statement,
        async get(...params) {
          if (point === "before_delivery") await mutate();
          const row = await statement.get(...params);
          if (point === "after_principal") await mutate();
          return row;
        },
        async all(...params) {
          if (point === "before_delivery") await mutate();
          const rows = await statement.all(...params);
          if (point === "after_principal") await mutate();
          return rows;
        },
      };
    },
  };
  return { db: wrapped, fired: () => fired, queries };
}

async function board(response: Response): Promise<Board> {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Board;
}
const cards = (value: Board) => value.lanes.flatMap((lane) => lane.tasks);

describe("canonical authenticated board delivery", () => {
  it("does not retain a task privatized between lane selection and final delivery", async () => {
    const f = await fixture();
    const race = boundary(f.db, "before_delivery", () => f.privatize(TASK_A));
    const value = await board(await f.read("owner", race.db));
    expect(race.fired()).toBe(true);
    expect(cards(value).map((card) => card.taskId)).not.toContain(TASK_A);
    expect(value.needs_now.map((item) => item.taskId)).not.toContain(TASK_A);
  });

  it.each([false, true])("rechecks retained epoch with empty=%s", async (empty) => {
    const f = await fixture(!empty);
    const race = boundary(f.db, "after_principal", async () => {
      await f.db
        .prepare(
          `UPDATE workspace_members SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?`,
        )
        .run(FIX.workspace, FIX.member);
      await f.db
        .prepare(
          `UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?`,
        )
        .run(FIX.workspace, FIX.member);
    });
    const response = await f.read("member", race.db);
    expect(race.fired()).toBe(true);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(SCOPE_DENIED);
  });

  it.each([false, true])("rechecks membership with empty=%s", async (empty) => {
    const f = await fixture(!empty);
    const race = boundary(f.db, "after_principal", f.removeMember);
    const response = await f.read("member", race.db);
    expect(race.fired()).toBe(true);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(SCOPE_DENIED);
  });

  it("rejects epoch revocation even with no tasks or current project grants", async () => {
    const f = await fixture(false);
    await f.db
      .prepare(`DELETE FROM project_access WHERE workspace_id=? AND human_id=?`)
      .run(FIX.workspace, FIX.member);
    const race = boundary(f.db, "after_principal", () =>
      f.db
        .prepare(
          `UPDATE workspace_authorization_epochs SET revoked_at=? WHERE workspace_id=? AND human_id=?`,
        )
        .run(NOW, FIX.workspace, FIX.member),
    );
    const response = await f.read("member", race.db);
    expect(race.fired()).toBe(true);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(SCOPE_DENIED);
  });

  it("does not restore a lost project grant from captured project IDs", async () => {
    const f = await fixture();
    const race = boundary(f.db, "before_delivery", () =>
      f.db
        .prepare(`DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?`)
        .run(FIX.workspace, FIX.projectA, FIX.owner),
    );
    const value = await board(await f.read("owner", race.db));
    expect(race.fired()).toBe(true);
    expect(value.lanes.map((lane) => lane.projectId)).toEqual([FIX.projectB]);
    expect(value.needs_now).toEqual([]);
  });

  it("uses current role and retained epoch rather than hydrated role metadata", async () => {
    const f = await fixture();
    const race = boundary(f.db, "after_principal", () =>
      f.db
        .prepare(`UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?`)
        .run(FIX.workspace, FIX.member),
    );
    const value = await board(await f.read("member", race.db));
    expect(race.fired()).toBe(true);
    expect(value.role).toBe("reviewer");
    expect(value.authorization_epoch).toBe(1);
  });

  it("does not adopt project access granted after the captured ceiling", async () => {
    const f = await fixture();
    const race = boundary(f.db, "after_principal", () =>
      f.db
        .prepare(`INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)`)
        .run(FIX.workspace, FIX.projectB, FIX.reviewer),
    );
    const value = await board(await f.read("reviewer", race.db));
    expect(race.fired()).toBe(true);
    expect(value.lanes.map((lane) => lane.projectId)).toEqual([FIX.projectA]);
    expect(cards(value).map((card) => card.taskId)).toEqual([TASK_A]);
  });

  it.each(["owner", "member", "reviewer"] as const)(
    "respects private creator/grant access for %s",
    async (actor) => {
      const f = await fixture();
      await f.task(PRIVATE_TASK, { title: CANARY, owner: FIX[actor], priority: "P0" });
      await f.privatize();
      if (actor === "reviewer") await f.grant(FIX.reviewer);
      const value = await board(await f.read(actor));
      const authorized = actor !== "owner";
      expect(cards(value).some((card) => card.taskId === PRIVATE_TASK)).toBe(authorized);
      expect(value.needs_now.some((item) => item.taskId === PRIVATE_TASK)).toBe(authorized);
      expect(JSON.stringify(value).includes(CANARY)).toBe(authorized);
    },
  );

  it("rechecks a named task grant before returning cards and deck slots", async () => {
    const f = await fixture();
    await f.task(PRIVATE_TASK, { title: CANARY, priority: "P0" });
    await f.privatize();
    const grantId = await f.grant();
    const race = boundary(f.db, "before_delivery", () =>
      f.db
        .prepare(`UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?`)
        .run(NOW, FIX.workspace, grantId),
    );
    const value = await board(await f.read("owner", race.db));
    expect(race.fired()).toBe(true);
    expect(JSON.stringify(value)).not.toContain(CANARY);
    expect(cards(value).map((card) => card.taskId)).not.toContain(PRIVATE_TASK);
    expect(value.needs_now.map((item) => item.taskId)).toEqual([TASK_A]);
  });

  it("uses current bodies, routing and policy from the final selection", async () => {
    const f = await fixture();
    const race = boundary(f.db, "before_delivery", async () => {
      await f.db
        .prepare(
          `UPDATE tasks SET title='Synthetic fresh title',punchline='Synthetic fresh summary',next_owner_type='agent_profile',next_owner_id=?,next_action_reason='Synthetic fresh routing' WHERE workspace_id=? AND id=?`,
        )
        .run(FIX.profileCodex, FIX.workspace, TASK_A);
      await f.db
        .prepare(`UPDATE workspace_policies SET allow_pass_to_agent=0 WHERE workspace_id=?`)
        .run(FIX.workspace);
    });
    const value = await board(await f.read("owner", race.db));
    expect(race.fired()).toBe(true);
    expect(cards(value).find((card) => card.taskId === TASK_A)).toMatchObject({
      title: "Synthetic fresh title",
      punchline: "Synthetic fresh summary",
      whyDelegable: "Synthetic fresh routing",
    });
    expect(
      cards(value).find((card) => card.taskId === TASK_A)?.passToAgentProfileId,
    ).toBeUndefined();
    expect(value.needs_now).toEqual([]);
  });

  it("holds event metadata uniformly and never reads heuristic semantic snapshots", async () => {
    const f = await fixture();
    const before = await board(await f.read());
    await f.db
      .prepare(
        `INSERT INTO semantic_events (workspace_id,event_id,workspace_cursor,kind,payload_json,created_at) VALUES (?,?,987654,'synthetic.private.decoy',?,?)`,
      )
      .run(
        FIX.workspace,
        randomUlid(),
        JSON.stringify({ input: { taskId: TASK_A }, body: CANARY }),
        NOW,
      );
    const trace = boundary(f.db, "after_principal", async () => {});
    const after = await board(await f.read("owner", trace.db));
    expect(after).toEqual(before);
    expect(after.recent_events_available).toBe(false);
    expect(cards(after).every((card) => card.latestEvent === undefined)).toBe(true);
    expect(trace.queries.some((query) => /semantic_events|workspace_cursor/.test(query))).toBe(
      false,
    );
    expect(JSON.stringify(after)).not.toMatch(
      /987654|workspace_cursor|latestEvent|SYNTHETIC-C11-BOARD-PRIVATE/,
    );
  });

  it("delivers lane and deck data in one final statement without later hydration", async () => {
    const f = await fixture();
    const trace = boundary(f.db, "after_principal", async () => {});
    await board(await f.read("owner", trace.db));
    const finalSelections = trace.queries.filter((query) =>
      query.includes("board_scope AS MATERIALIZED"),
    );
    expect(finalSelections).toHaveLength(1);
    expect(trace.queries.at(-1)).toBe(finalSelections[0]);
  });

  it("ranks equivalent UTC spellings by actual due instant rather than raw text", async () => {
    const f = await fixture(false);
    await f.task(TASK_A, { priority: "P0", due: "2026-10-07T11:00:00Z" });
    await f.task(TASK_B, { priority: "P0", due: "2026-10-07T11:00:00.100Z" });
    const value = await board(await f.read());
    expect(value.needs_now.map((item) => item.taskId)).toEqual([TASK_A, TASK_B]);
  });

  it("retains terminal work-run history but ignores discussion and malformed run identities", async () => {
    const f = await fixture();
    for (const [id, purpose, state, activity, created] of [
      [String(301).padStart(26, "0"), "work", "open", "unknown", "2026-10-07T10:00:00Z"],
      [String(302).padStart(26, "0"), "work", "accepted", "idle", "2026-10-07T10:00:00.100Z"],
      [String(303).padStart(26, "0"), "discussion", "open", "working", "2026-10-07T11:00:00Z"],
      [
        `${String(304).padStart(26, "0")}\0${CANARY}`,
        "work",
        "failed",
        "offline",
        "2026-10-07T11:30:00Z",
      ],
    ] as const) {
      await f.db
        .prepare(
          `INSERT INTO runs (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,purpose,result_state,activity,resource_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,?)`,
        )
        .run(
          FIX.workspace,
          id,
          FIX.projectA,
          TASK_A,
          FIX.owner,
          FIX.profileCodex,
          purpose,
          state,
          activity,
          created,
        );
    }
    const value = await board(await f.read());
    expect(cards(value).find((card) => card.taskId === TASK_A)?.runSummary).toEqual({
      resultState: "accepted",
      activity: "idle",
    });
    expect(JSON.stringify(value)).not.toContain(CANARY);
  });

  it("has the same unshared-owner response with and without hidden private work", async () => {
    const f = await fixture();
    const before = await board(await f.read());
    await f.task(PRIVATE_TASK, { title: CANARY, priority: "P0" });
    await f.privatize();
    expect(await board(await f.read())).toEqual(before);
  });

  it("does not select a removed human owner's display name", async () => {
    const f = await fixture();
    await f.db
      .prepare(`UPDATE tasks SET next_owner_id=? WHERE workspace_id=? AND id=?`)
      .run(FIX.member, FIX.workspace, TASK_A);
    const race = boundary(f.db, "after_principal", f.removeMember);
    const value = await board(await f.read("owner", race.db));
    expect(race.fired()).toBe(true);
    expect(cards(value).find((card) => card.taskId === TASK_A)?.humanOwnerName).toBeUndefined();
  });

  it("keeps urgent tasks independent of required lane-policy joins", async () => {
    const f = await fixture();
    await f.db
      .prepare(`DELETE FROM repository_configs WHERE workspace_id=? AND project_id=?`)
      .run(FIX.workspace, FIX.projectA);
    const value = await board(await f.read());
    expect(value.lanes.map((lane) => lane.projectId)).toEqual([FIX.projectB]);
    expect(value.needs_now.map((item) => item.taskId)).toEqual([TASK_A]);
  });

  it("keeps the 50-card bound separate from the three-item deck and ignores hidden rows", async () => {
    const f = await fixture(false);
    for (let index = 2; index < 53; index++) {
      await f.task(String(index).padStart(26, "0"), { priority: "P2", state: "ready", due: null });
    }
    const urgent = String(99).padStart(26, "0");
    await f.task(urgent, { title: "Synthetic urgent outside cards", priority: "P0" });
    await f.task(PRIVATE_TASK, { title: CANARY, priority: "P0" });
    await f.privatize();
    const value = await board(await f.read());
    expect(cards(value)).toHaveLength(50);
    expect(cards(value).map((card) => card.taskId)).toEqual(
      Array.from({ length: 50 }, (_, index) => String(index + 2).padStart(26, "0")),
    );
    expect(value.needs_now.map((item) => item.taskId)).toEqual([urgent]);
    expect(JSON.stringify(value)).not.toContain(CANARY);
  });

  it("retains authentication rather than accepting a synthetic caller-selected human", async () => {
    const f = await fixture();
    const response = await f.read("owner", f.db, "");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });
});
