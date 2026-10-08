// ABOUTME: Verifies runner nudges use canonical shared parents and do not reveal private-reference changes.
// ABOUTME: Socket doubles observe frames while current runner authority and reference selection use migrated SQL.

import type { D1Like } from "@bfb/db";
import { FIX, randomUlid } from "@bfb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAUNCH_NOW,
  launchFixture,
  success,
} from "../../../packages/domain/test/launch-fixture.js";
import { createTaskCommand } from "../../../packages/domain/src/work-commands.js";
import { startLaunchCommand } from "../../../packages/domain/src/launches.js";
import { RunnerChannels } from "../src/runner-channels.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());

async function fixture() {
  const f = await launchFixture();
  success(await f.human(startLaunchCommand, f.start));
  let attachment = {
    schema_version: 1,
    principal: f.principal,
    connectionId: randomUlid(),
    lastHeartbeatAt: LAUNCH_NOW,
    nudgeSequence: 0,
  };
  const socket = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    deserializeAttachment: () => attachment,
    serializeAttachment: (value: typeof attachment) => {
      attachment = value;
    },
  };
  const binding: D1Like = {
    prepare(sql) {
      const query = f.db.prepare(sql);
      const prepared = (parameters: unknown[] = []) => ({
        bind: (...values: unknown[]) => prepared(values),
        first: async () => (await query.get(...parameters)) ?? null,
        all: async () => ({ results: await query.all(...parameters) }),
        run: async () => {
          throw new Error("Nudges cannot mutate canonical work");
        },
      });
      return prepared();
    },
    batch: async () => {
      throw new Error("Nudges cannot mutate canonical work");
    },
  };
  const state = {
    getWebSockets: () => [socket],
    storage: { setAlarm: vi.fn(), deleteAlarm: vi.fn() },
  };
  const channels = new RunnerChannels(
    state as unknown as DurableObjectState,
    binding as D1Database,
    () => f.hub,
    () => LAUNCH_NOW,
  );
  const privatize = () =>
    f.db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, f.task.id, FIX.owner, LAUNCH_NOW);
  return { ...f, socket, channels, privatize, attachment: () => attachment };
}

describe("private runner channel hold", () => {
  it("sends no hint for a private-only pending reference and leaves canonical records alone", async () => {
    const f = await fixture();
    await f.privatize();
    const before = await f.db.prepare("SELECT * FROM runner_command_references").all();
    await f.channels.afterCommand();
    await f.channels.alarm();
    expect(f.socket.send).not.toHaveBeenCalled();
    expect(f.socket.close).not.toHaveBeenCalled();
    expect(f.attachment().nudgeSequence).toBe(0);
    expect(await f.db.prepare("SELECT * FROM runner_command_references").all()).toEqual(before);
  });

  it("does not nudge on unresolved references or privacy cuts, but still nudges the next genuine shared launch", async () => {
    const f = await fixture();
    await f.channels.afterCommand();
    expect(f.socket.send).toHaveBeenCalledOnce();
    const watermark = f.attachment().nudgeSequence;
    for (const kind of ["launch", "discussion_turn"])
      await f.db
        .prepare(
          `INSERT INTO runner_command_references
        (workspace_id,runner_id,command_id,command_kind,project_id,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          FIX.workspace,
          f.runner,
          randomUlid(),
          kind,
          FIX.projectA,
          LAUNCH_NOW,
          f.principal.authExpiresAt,
        );
    await f.channels.afterCommand();
    await f.privatize();
    await f.channels.afterCommand();
    expect(f.socket.send).toHaveBeenCalledOnce();
    expect(f.attachment().nudgeSequence).toBe(watermark);
    const task = success(
      await f.human(createTaskCommand, {
        projectId: FIX.projectA,
        title: "Synthetic next shared launch",
        priority: "P2",
        nextOwnerType: "human",
        nextOwnerId: FIX.owner,
      }),
    );
    success(
      await f.human(startLaunchCommand, {
        ...f.start,
        idempotency_key: randomUlid(),
        task_id: task.id,
      }),
    );
    await f.channels.afterCommand();
    expect(f.socket.send).toHaveBeenCalledTimes(2);
    expect(f.attachment().nudgeSequence).toBeGreaterThan(watermark);
    expect(f.socket.send.mock.calls.map(([wire]) => JSON.parse(wire as string).kind)).toEqual([
      "runner.commands.available",
      "runner.commands.available",
    ]);
  });
});
