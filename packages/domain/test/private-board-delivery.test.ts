// ABOUTME: Verifies current-authority canonical board and independent attention-deck delivery.
// ABOUTME: Synthetic history and interleaved revocation expose stale hydration without enabling private creation.

import type { SqlDatabase } from "@bfb/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { buildNeedsNowDeck, buildProjectLanes, readWorkBoard } from "../src/projections.js";
import type { TaskAccessContext } from "../src/task-access.js";
import { createTaskCommand } from "../src/work-commands.js";
import { openDomainDb } from "./helpers.js";

const NOW = "2026-10-06T12:00:00.000Z";
const access = (humanId = FIX.owner, authorizationEpoch = 1) => ({
  workspaceId: FIX.workspace,
  humanId,
  authorizationEpoch,
});
let db: SqlDatabase;
let taskId: string;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  db = await openDomainDb();
  taskId = await task("Current board task");
});
afterEach(() => vi.useRealTimers());

async function task(title: string, projectId = FIX.projectA) {
  const created = await new WorkspaceHub(db).execute(createTaskCommand, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.member,
    authorizationEpoch: 1,
    idempotencyKey: randomUlid(),
    input: {
      projectId,
      title,
      priority: "P0",
      nextOwnerType: "human",
      nextOwnerId: FIX.owner,
      nextActionReason: "Recorded decision",
      dueAt: "2026-10-06T11:00:00Z",
    },
  });
  if (!created.ok) throw new Error(created.error.code);
  return created.result.id;
}
async function privatize() {
  await db
    .prepare(
      `INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at)
    VALUES (?,?,?,?)`,
    )
    .run(FIX.workspace, taskId, FIX.member, NOW);
}
async function grant() {
  const id = randomUlid();
  await db
    .prepare(
      `INSERT INTO task_human_grants
    (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
    VALUES (?,?,?,?,1,'read',?)`,
    )
    .run(FIX.workspace, id, taskId, FIX.owner, NOW);
  return id;
}
async function run(
  createdAt: string,
  options: { id?: string; projectId?: string; purpose?: string; result?: string } = {},
) {
  await db
    .prepare(
      `INSERT INTO runs (workspace_id,id,project_id,task_id,requested_by_human_id,
    agent_profile_id,result_state,activity,resource_version,created_at,purpose)
    VALUES (?,?,?,?,?,? ,?,'unknown',1,?,?)`,
    )
    .run(
      FIX.workspace,
      options.id ?? randomUlid(),
      options.projectId ?? FIX.projectA,
      taskId,
      FIX.member,
      FIX.profileCodex,
      options.result ?? "open",
      createdAt,
      options.purpose ?? "work",
    );
}
function beforeSelection(change: () => Promise<void>, late = true) {
  let fired = false;
  const wrapped: SqlDatabase = {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      const matches =
        sql.includes("board_scope AS MATERIALIZED") ||
        (late
          ? sql.includes("SELECT task_id, result_state, activity")
          : sql.includes("SELECT p.id, p.name, p.slug, p.tint"));
      if (!matches) return statement;
      const mutate = async () => {
        if (!fired) {
          fired = true;
          await change();
        }
      };
      return {
        ...statement,
        async all(...params) {
          await mutate();
          return statement.all(...params);
        },
        async get(...params) {
          await mutate();
          return statement.get(...params);
        },
      };
    },
  };
  return { wrapped, fired: () => fired };
}
const lanes = (database = db) =>
  buildProjectLanes(database, FIX.workspace, [FIX.projectA], access());
const cards = async (database = db) => (await lanes(database)).flatMap((lane) => lane.tasks);
const deck = (now = NOW) =>
  buildNeedsNowDeck(db, FIX.workspace, FIX.owner, [FIX.projectA], now, access());

describe("canonical board current delivery", () => {
  it("removes a task privatized before the old final run hydration", async () => {
    const race = beforeSelection(privatize);
    expect(await cards(race.wrapped)).toEqual([]);
    expect(race.fired()).toBe(true);
  });
  it("removes a private task after its current read grant is revoked", async () => {
    await privatize();
    const id = await grant();
    const race = beforeSelection(async () => {
      await db.prepare("UPDATE task_human_grants SET revoked_at=? WHERE id=?").run(NOW, id);
    });
    expect(await cards(race.wrapped)).toEqual([]);
    expect(race.fired()).toBe(true);
  });
  it("removes captured projects whose current project grant was lost", async () => {
    const race = beforeSelection(async () => {
      await db.prepare("UPDATE projects SET access_mode='restricted' WHERE id=?").run(FIX.projectA);
      await db
        .prepare("DELETE FROM project_access WHERE project_id=? AND human_id=?")
        .run(FIX.projectA, FIX.owner);
    });
    expect(await lanes(race.wrapped)).toEqual([]);
    expect(race.fired()).toBe(true);
  });
  it("denies retained-epoch loss at final selection rather than returning hydrated cards", async () => {
    const race = beforeSelection(async () => {
      await db
        .prepare("UPDATE workspace_authorization_epochs SET revoked_at=? WHERE human_id=?")
        .run(NOW, FIX.owner);
    });
    await expect(lanes(race.wrapped)).rejects.toMatchObject({
      code: "not_found",
      message: "board scope not found",
    });
    expect(race.fired()).toBe(true);
  });
  it("uses current task body and policy values in the final selection", async () => {
    await db
      .prepare("UPDATE tasks SET next_owner_type='agent_profile',next_owner_id=? WHERE id=?")
      .run(FIX.profileCodex, taskId);
    const race = beforeSelection(async () => {
      await db.prepare("UPDATE tasks SET title='Current changed title' WHERE id=?").run(taskId);
      await db
        .prepare("UPDATE workspace_policies SET allow_pass_to_agent=0 WHERE workspace_id=?")
        .run(FIX.workspace);
    });
    const selected = await cards(race.wrapped);
    expect(selected).toMatchObject([{ title: "Current changed title" }]);
    expect(selected[0]?.passToAgentProfileId).toBeUndefined();
    expect(race.fired()).toBe(true);
  });
  it("does not retain an owner name after that owner's membership is revoked", async () => {
    await db.prepare("UPDATE tasks SET next_owner_id=? WHERE id=?").run(FIX.member, taskId);
    const race = beforeSelection(async () => {
      await db
        .prepare("UPDATE workspace_authorization_epochs SET revoked_at=? WHERE human_id=?")
        .run(NOW, FIX.member);
    });
    expect((await cards(race.wrapped))[0]?.humanOwnerName).toBeUndefined();
    expect(race.fired()).toBe(true);
  });
  it("keeps internal wrappers shared-only but permits current creator and named grantee", async () => {
    await privatize();
    expect((await buildProjectLanes(db, FIX.workspace, [FIX.projectA]))[0]?.tasks).toEqual([]);
    expect(await cards()).toEqual([]);
    expect(
      (await buildProjectLanes(db, FIX.workspace, [FIX.projectA], access(FIX.member)))[0]?.tasks,
    ).toHaveLength(1);
    await grant();
    expect(await cards()).toHaveLength(1);
  });
  it("checks scope even with empty projects and an invalid deck clock", async () => {
    await db
      .prepare("UPDATE workspace_authorization_epochs SET revoked_at=? WHERE human_id=?")
      .run(NOW, FIX.owner);
    await expect(
      buildNeedsNowDeck(db, FIX.workspace, FIX.owner, [], "invalid", access()),
    ).rejects.toMatchObject({ code: "not_found", message: "board scope not found" });
  });
  it("does not read another human's deck through a valid principal", async () => {
    await expect(
      buildNeedsNowDeck(db, FIX.workspace, FIX.member, [FIX.projectA], NOW, access()),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
  it("holds recent-event metadata independently of semantic snapshots", async () => {
    expect((await cards())[0]).not.toHaveProperty("latestEvent");
    await db.prepare("UPDATE semantic_events SET payload_json=? WHERE kind='task.create'").run(
      JSON.stringify({
        input: { taskId },
        result: { task_id: taskId },
        decoy: "SYNTHETIC_EVENT_CANARY",
      }),
    );
    expect((await cards())[0]).not.toHaveProperty("latestEvent");
  });
});

describe("recorded board chronology and exact work lineage", () => {
  it("does not treat a future microsecond as due at the whole second", async () => {
    await db
      .prepare("UPDATE tasks SET due_at=? WHERE id=?")
      .run("2026-10-06T12:00:00.000001Z", taskId);
    expect(await deck("2026-10-06T12:00:00Z")).toEqual([]);
  });
  it("includes the whole-second due instant just after that instant", async () => {
    await db.prepare("UPDATE tasks SET due_at=? WHERE id=?").run("2026-10-06T12:00:00Z", taskId);
    expect(await deck("2026-10-06T12:00:00.000001Z")).toHaveLength(1);
  });
  it("ranks whole seconds before later fractional due instants", async () => {
    const later = await task("Later fraction");
    await db.prepare("UPDATE tasks SET due_at=? WHERE id=?").run("2026-10-06T11:00:00.1Z", later);
    expect((await deck()).map((item) => item.taskId)).toEqual([taskId, later]);
  });
  it("selects the chronologically latest recorded work run without a liveness condition", async () => {
    await run("2026-10-06T11:00:00Z");
    await run("2026-10-06T11:00:00.1Z", { result: "accepted" });
    expect((await cards())[0]?.runSummary).toEqual({
      resultState: "accepted",
      activity: "unknown",
    });
  });
  it("omits a newer work run with a different project parent", async () => {
    await run("2026-10-06T10:00:00Z");
    // Deliberately corrupt historical lineage, not a valid product mutation.
    await db.prepare("PRAGMA foreign_keys=OFF").run();
    try {
      await run("2026-10-06T11:00:00Z", { projectId: FIX.projectB, result: "failed" });
    } finally {
      await db.prepare("PRAGMA foreign_keys=ON").run();
    }
    expect((await cards())[0]?.runSummary).toEqual({ resultState: "open", activity: "unknown" });
  });
  it("omits a genuine malformed NUL-suffixed run identity", async () => {
    await run("2026-10-06T11:00:00Z", { id: randomUlid() + "\u0000SYNTHETIC_RUN_CANARY" });
    expect((await cards())[0]?.runSummary).toBeUndefined();
  });
  it("does not project discussion runs as work", async () => {
    await run("2026-10-06T11:00:00Z", { purpose: "discussion" });
    expect((await cards())[0]?.runSummary).toBeUndefined();
  });
  it("uses run-ID ordering for chronologically equivalent retained creation times", async () => {
    await run("2026-10-06T11:00:00.1Z", { id: "00000000000000000000000002" });
    await run("2026-10-06T11:00:00.100000Z", {
      id: "00000000000000000000000001",
      result: "accepted",
    });
    expect((await cards())[0]?.runSummary).toEqual({
      resultState: "accepted",
      activity: "unknown",
    });
  });
  it("omits malformed creation timestamps without hiding a legitimate older work run", async () => {
    await run("2026-10-06T10:00:00Z", { result: "cancelled" });
    await run("2026-10-06T11:00:00Z\u0000SYNTHETIC_TIME_CANARY");
    await run("2026-02-30T12:00:00Z");
    expect((await cards())[0]?.runSummary).toEqual({
      resultState: "cancelled",
      activity: "unknown",
    });
  });
});

describe("required combined work-board selection", () => {
  it("requires explicit human authority rather than inferring owner", async () => {
    await expect(
      readWorkBoard(
        db,
        FIX.workspace,
        [FIX.projectA],
        NOW,
        undefined as unknown as TaskAccessContext,
      ),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
  it("returns current role/retained epoch with one final statement and no semantic hydration", async () => {
    let selections = 0;
    const wrapped: SqlDatabase = {
      ...db,
      prepare(sql) {
        selections++;
        expect(sql).toContain("board_scope AS MATERIALIZED");
        expect(sql).not.toContain("semantic_events");
        return db.prepare(sql);
      },
    };
    // Retain another Owner so this valid role change respects final-owner invariants.
    await db.prepare("UPDATE workspace_members SET role='owner' WHERE human_id=?").run(FIX.member);
    await db
      .prepare("UPDATE workspace_members SET role='reviewer' WHERE human_id=?")
      .run(FIX.owner);
    const board = await readWorkBoard(
      wrapped,
      FIX.workspace,
      [FIX.projectB, FIX.projectA],
      NOW,
      access(),
    );
    expect(selections).toBe(1);
    expect(board).toMatchObject({
      role: "reviewer",
      authorizationEpoch: 1,
      recentEventsAvailable: false,
    });
    expect(board.lanes.map((lane) => lane.slug)).toEqual(["alpha", "beta"]);
    expect(board.needsNow.map((item) => item.taskId)).toEqual([taskId]);
    expect(board.lanes[0]?.tasks[0]).toMatchObject({
      taskId,
      topEdgePx: 3,
      sideStripe: false,
      nowLabel: "NOW",
      humanOwnerName: "Synthetic Owner",
    });
    expect(board.lanes[1]?.tasks).toEqual([]);
  });
  it("checks an empty combined board's current scope after independent epoch loss", async () => {
    const race = beforeSelection(async () => {
      await db
        .prepare("UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE human_id=?")
        .run(FIX.owner);
      await db
        .prepare("UPDATE workspace_members SET authorization_epoch=2 WHERE human_id=?")
        .run(FIX.owner);
    });
    await expect(
      readWorkBoard(race.wrapped, FIX.workspace, [], "invalid", access()),
    ).rejects.toMatchObject({ code: "not_found", message: "board scope not found" });
    expect(race.fired()).toBe(true);
  });
  it("does not widen the captured project boundary and handles large narrowed sets with fixed binds", async () => {
    const projects = [FIX.projectB, ...Array.from({ length: 150 }, () => randomUlid())];
    const board = await readWorkBoard(db, FIX.workspace, projects, NOW, access());
    expect(board.lanes.map((lane) => lane.projectId)).toEqual([FIX.projectB]);
    expect(board.needsNow).toEqual([]);
  });
  it("keeps the lane's global50 limit independent from the three-item deck", async () => {
    const insert = db.prepare(`INSERT INTO tasks (workspace_id,id,project_id,title,state,priority,
      next_owner_type,punchline,resource_version,created_by_human_id,created_at)
      VALUES (?,?,?,'Synthetic bounded filler','ready','P3','unassigned','Later',1,?,?)`);
    for (let index = 0; index < 50; index++)
      await insert.run(
        FIX.workspace,
        `0000000000000000000000${String(index).padStart(4, "0")}`,
        FIX.projectA,
        FIX.member,
        NOW,
      );
    await task("Independent urgent two");
    await task("Independent urgent three");
    await task("Fourth urgent");
    const board = await readWorkBoard(db, FIX.workspace, [FIX.projectA], NOW, access());
    expect(board.lanes[0]?.tasks).toHaveLength(50);
    expect(board.lanes[0]?.tasks.every((card) => card.priority === "P3")).toBe(true);
    expect(board.needsNow).toHaveLength(3);
    expect(board.needsNow.every((item) => item.priority === "P0")).toBe(true);
  });
  it("preserves missing-policy candidate budget while independently delivering its urgent deck", async () => {
    await db.prepare("DELETE FROM repository_configs WHERE project_id=?").run(FIX.projectB);
    const insert = db.prepare(`INSERT INTO tasks (workspace_id,id,project_id,title,state,priority,
      next_owner_type,punchline,resource_version,created_by_human_id,created_at)
      VALUES (?,?,?,'Synthetic policyless filler','ready','P3','unassigned','Later',1,?,?)`);
    for (let index = 0; index < 50; index++)
      await insert.run(
        FIX.workspace,
        `0000000000000000000000${String(index).padStart(4, "0")}`,
        FIX.projectB,
        FIX.member,
        NOW,
      );
    const urgent = await task("Urgent without lane policy", FIX.projectB);
    const board = await readWorkBoard(
      db,
      FIX.workspace,
      [FIX.projectA, FIX.projectB],
      NOW,
      access(),
    );
    expect(board.lanes.map((lane) => lane.projectId)).toEqual([FIX.projectA]);
    expect(board.lanes[0]?.tasks).toEqual([]);
    expect(board.needsNow.map((item) => item.taskId)).toEqual([taskId, urgent].sort());
  });
  it("returns no deck for invalid clock without inventing a terminal-task exclusion", async () => {
    await db.prepare("UPDATE tasks SET state='done' WHERE id=?").run(taskId);
    expect(
      (await readWorkBoard(db, FIX.workspace, [FIX.projectA], NOW, access())).needsNow,
    ).toHaveLength(1);
    const invalid = await readWorkBoard(db, FIX.workspace, [FIX.projectA], "invalid", access());
    expect(invalid.needsNow).toEqual([]);
    expect(invalid.lanes[0]?.tasks).toHaveLength(1);
  });
});
