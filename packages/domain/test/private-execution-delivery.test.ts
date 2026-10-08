// ABOUTME: Verifies shared-only retained participant and runner delivery without stranding checkout reservations.
// ABOUTME: Synthetic privacy cuts preserve canonical history and never claim private provider execution.

import type { SqlDatabase } from "@bfb/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeCheckoutLeaseCommand } from "../src/checkout-leases.js";
import { readParticipantDiscussion } from "../src/discussion-views.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { readLaunch, reauthorizeLaunch } from "../src/launch-state.js";
import {
  authorizeLaunchCommand,
  claimLaunchCommand,
  reconcileLaunchCommand,
} from "../src/launches.js";
import { pullRunnerCommands } from "../src/runner-channel.js";
import {
  claimRunControlCommand,
  createRunControlCommand,
  readRunnerControl,
} from "../src/run-controls.js";
import { discussionFixture, SYNTHETIC_OUTPUT } from "./discussion-fixture.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";
import { createTaskCommand } from "../src/work-commands.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());

async function privatize(db: SqlDatabase, taskId: string, mode = "direct") {
  if (mode === "inherited") {
    const root = success(
      await new WorkspaceHub(db).execute(createTaskCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        now: LAUNCH_NOW,
        input: { projectId: FIX.projectA, title: "Synthetic private root", priority: "P2" },
      }),
    );
    await privatize(db, root.id);
    await db
      .prepare("UPDATE tasks SET parent_task_id=? WHERE workspace_id=? AND id=?")
      .run(root.id, FIX.workspace, taskId);
    await db
      .prepare(
        `INSERT INTO task_privacy_inheritance
      (workspace_id,project_id,task_id,root_task_id,created_at) VALUES (?,?,?,?,?)`,
      )
      .run(FIX.workspace, FIX.projectA, taskId, root.id, LAUNCH_NOW);
    return;
  }
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, taskId, FIX.owner, LAUNCH_NOW);
}

function atRead(db: SqlDatabase, needle: string, effect: () => Promise<void>) {
  let fired = false;
  return {
    fired: () => fired,
    db: {
      ...db,
      prepare(sql: string) {
        const statement = db.prepare(sql);
        async function cut() {
          if (!fired && sql.includes(needle)) {
            fired = true;
            await effect();
          }
        }
        return {
          ...statement,
          async get(...params: unknown[]) {
            const result = await statement.get(...params);
            await cut();
            return result;
          },
          async all(...params: unknown[]) {
            const result = await statement.all(...params);
            await cut();
            return result;
          },
        };
      },
    } satisfies SqlDatabase,
  };
}

async function history(db: SqlDatabase) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "discussions",
    "discussion_messages",
    "discussion_deliveries",
    "launch_commands",
    "run_controls",
    "runner_command_references",
    "checkout_leases",
    "runs",
    "run_executions",
  ])
    result[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return result;
}

describe("private execution delivery hold", () => {
  it.each(
    ["direct", "inherited"].flatMap((mode) =>
      ["before", "after_hydration"].map((phase) => [mode, phase]),
    ),
  )(
    "withholds %s participant brief/history %s without turning denial into an advisory",
    async (mode, phase) => {
      const f = await discussionFixture(),
        created = await f.create({ rounds: 1 });
      await f.complete(created.discussion_id, 1);
      await f.complete(created.discussion_id, 2);
      const participant = (await f.participants(created.discussion_id))[0]!;
      const ctx = {
        db: f.db,
        workspaceId: FIX.workspace,
        actorSystemId: participant.run_id,
        authorizationEpoch: 1,
        now: LAUNCH_NOW,
        cursorBase: 0,
      };
      const healthy = await readParticipantDiscussion(ctx, created.discussion_id);
      expect(healthy.messages.map((row) => row.output)).toEqual([
        SYNTHETIC_OUTPUT,
        SYNTHETIC_OUTPUT,
      ]);
      const before = await history(f.db);
      if (phase === "before") await privatize(f.db, f.task.id, mode);
      const staged = atRead(f.db, "FROM discussion_conclusions", () =>
        privatize(f.db, f.task.id, mode),
      );
      await expect(
        readParticipantDiscussion(
          { ...ctx, db: phase === "before" ? f.db : staged.db },
          created.discussion_id,
        ),
      ).rejects.toMatchObject({ code: "not_found", message: "discussion not found" });
      if (phase !== "before") expect(staged.fired()).toBe(true);
      expect(await history(f.db)).toEqual(before);
    },
  );

  it.each(
    ["direct", "inherited"].flatMap((mode) =>
      ["before", "after_environment"].map((phase) => [mode, phase]),
    ),
  )(
    "denies %s retained launch authority %s without changing its reservation",
    async (mode, phase) => {
      const f = await launchFixture(),
        c = await f.claim();
      const row = await readLaunch(f.db, FIX.workspace, c.launch.launch_id);
      const ctx = {
        db: f.db,
        workspaceId: FIX.workspace,
        now: LAUNCH_NOW,
        authorizationEpoch: 1,
        cursorBase: 0,
      };
      expect((await reauthorizeLaunch(ctx, row)).snapshot.task_id).toBe(f.task.id);
      const before = await history(f.db);
      if (phase === "before") await privatize(f.db, f.task.id, mode);
      const staged = atRead(f.db, "FROM repository_configs", () =>
        privatize(f.db, f.task.id, mode),
      );
      await expect(
        reauthorizeLaunch({ ...ctx, db: phase === "before" ? f.db : staged.db }, row),
      ).rejects.toMatchObject({ code: "request_rejected" });
      if (phase !== "before") expect(staged.fired()).toBe(true);
      expect(await history(f.db)).toEqual(before);
    },
  );

  it("rejects private final authorization and same-key claim while permitting reservation reconciliation and verified release", async () => {
    const f = await launchFixture(),
      c = await f.claim();
    await privatize(f.db, f.task.id);
    const before = await f.db.prepare("SELECT * FROM checkout_leases").get();
    const reconciled = success(
      await f.native(reconcileLaunchCommand, { principal: f.principal, claim: c.request }),
    );
    expect(reconciled.reservation_state).toBe("reserved");
    expect(await f.db.prepare("SELECT * FROM checkout_leases").get()).toEqual(before);
    const final = success(
      await f.native(authorizeLaunchCommand, { principal: f.principal, authorization: c.final }),
    );
    expect(final.decision).toBe("rejected");
    expect(
      success(await f.native(claimLaunchCommand, { principal: f.principal, claim: c.request })),
    ).toEqual({ state: "rejected", reason: "launch_blocked" });
    expect(await f.db.prepare("SELECT * FROM checkout_leases").get()).toEqual(before);
    const released = success(
      await f.native(observeCheckoutLeaseCommand, {
        principal: f.principal,
        observation: {
          schema_version: 1,
          run_execution_id: c.final.run_execution_id,
          assignment_generation: c.final.assignment_generation,
          fencing_generation: c.final.fencing_generation,
          sequence: 1,
          observed_at: LAUNCH_NOW,
          operation: "release",
          local_lock_id: c.final.local_lock_id,
          owned_group_id: 0,
          owned_group_start_identity: "",
          supervisor_state: "never_started",
          group_state: "never_started",
          lock_state: "never_acquired",
          descendants_state: "none",
          recovery_local: false,
        },
      }),
    );
    expect(released.state).toBe("released");
    expect(
      success(await f.native(reconcileLaunchCommand, { principal: f.principal, claim: c.request }))
        .reservation_state,
    ).toBe("released");
  });

  it("omits private launch/control references and direct control reads without resolving retained commands", async () => {
    const f = await launchFixture(),
      c = await f.claim();
    const request = {
      schema_version: 1 as const,
      idempotency_key: randomUlid(),
      runner_id: f.runner,
      run_execution_id: c.final.run_execution_id,
      assignment_generation: c.final.assignment_generation,
      action: "cancel" as const,
    };
    const control = success(await f.human(createRunControlCommand, request));
    const input = { schema_version: 1 as const, control_id: control.control_id };
    expect(
      (await pullRunnerCommands(f.db, f.principal, LAUNCH_NOW)).commands.map(
        (row) => row.command_id,
      ),
    ).toContain(control.control_id);
    expect(await readRunnerControl(f.db, f.principal, input, LAUNCH_NOW)).toEqual(control);
    await privatize(f.db, f.task.id);
    const before = await history(f.db);
    expect(await pullRunnerCommands(f.db, f.principal, LAUNCH_NOW)).toMatchObject({
      commands: [],
      more: false,
    });
    await expect(readRunnerControl(f.db, f.principal, input, LAUNCH_NOW)).rejects.toMatchObject({
      code: "request_rejected",
    });
    expect(
      (
        await f.native(claimRunControlCommand, {
          principal: f.principal,
          claim: {
            ...input,
            idempotency_key: randomUlid(),
            run_execution_id: request.run_execution_id,
            assignment_generation: request.assignment_generation,
            action: request.action,
          },
        })
      ).ok,
    ).toBe(false);
    expect(await history(f.db)).toEqual(before);
  });
});
