// ABOUTME: Reproduces measurement cache identity and current-authority boundaries through the real Hub.
// ABOUTME: Checks all five commands without substituting injected authorization or business effects.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FIX } from "../src/fixtures.js";
import { type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import {
  recordBrowserActivityCommand,
  normalizeTokenFields,
  reportIntervalCommand,
  reportTokensCommand,
  startReviewTimerCommand,
  stopReviewTimerCommand,
} from "../src/measurements.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

const commands = [
  reportTokensCommand,
  reportIntervalCommand,
  startReviewTimerCommand,
  stopReviewTimerCommand,
  recordBrowserActivityCommand,
] as const;

async function fixture(command: (typeof commands)[number]) {
  const f = await launchFixture();
  const { claimed } = await f.claim();
  const spec = claimed.specification;
  let input: Record<string, unknown>;
  if (command === reportTokensCommand || command === reportIntervalCommand) {
    input = {
      principal: f.principal,
      observationId: randomUlid(),
      runId: spec.run_id,
      executionId: spec.run_execution_id,
      assignmentGeneration: spec.assignment_generation,
      ...(command === reportTokensCommand
        ? { provider: "fake", tokens: { input: 7 }, quality: "provider_reported" }
        : { intervalKind: "active", startedAt: LAUNCH_NOW, endedAt: "2026-09-12T12:00:01.000Z" }),
    };
  } else if (command === stopReviewTimerCommand) {
    const timer = success(await f.human(startReviewTimerCommand, { taskId: f.task.id }));
    input = { timerId: timer.id, expectedVersion: 1 };
  } else {
    input = {
      taskId: f.task.id,
      ...(command === recordBrowserActivityCommand
        ? {
            observationId: randomUlid(),
            startedAt: LAUNCH_NOW,
            endedAt: "2026-09-12T12:00:01.000Z",
          }
        : {}),
    };
  }
  const key = randomUlid();
  const actor =
    command === reportTokensCommand || command === reportIntervalCommand
      ? { actorRunnerId: f.runner }
      : { actorHumanId: FIX.owner };
  const execute = (value = input) =>
    f.hub.execute(command as HubCommand<unknown, unknown>, {
      workspaceId: FIX.workspace,
      authorizationEpoch: 1,
      now: LAUNCH_NOW,
      idempotencyKey: key,
      ...actor,
      input: value,
    });
  return { ...f, input, execute };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());

describe("measurement current-authority before cached outcomes", () => {
  for (const command of commands) {
    it(`${command.name} rejects changed input under an accepted Hub key`, async () => {
      const f = await fixture(command);
      const first = success(await f.execute());
      expect(await f.execute()).toMatchObject({ ok: true, replayed: true, result: first });
      const changed =
        command === reportTokensCommand
          ? { ...f.input, tokens: { input: 8 } }
          : command === reportIntervalCommand
            ? { ...f.input, intervalKind: "idle" }
            : command === stopReviewTimerCommand
              ? { ...f.input, expectedVersion: 2 }
              : command === recordBrowserActivityCommand
                ? { ...f.input, endedAt: "2026-09-12T12:00:02.000Z" }
                : { ...f.input, runId: randomUlid() };
      expect(await f.execute(changed)).toMatchObject({ ok: false });
    });

    it(`${command.name} rejects cached outcomes after current epoch revocation`, async () => {
      const f = await fixture(command);
      success(await f.execute());
      await f.db
        .prepare(
          "UPDATE workspace_members SET authorization_epoch = 2 WHERE workspace_id = ? AND human_id = ?",
        )
        .run(FIX.workspace, FIX.owner);
      await f.db
        .prepare(
          "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE workspace_id = ? AND human_id = ?",
        )
        .run(FIX.workspace, FIX.owner);
      expect(await f.execute()).toMatchObject({ ok: false });
    });

    it(`${command.name} rechecks current project access before a cached reply`, async () => {
      const f = await fixture(command);
      success(await f.execute());
      await f.db
        .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
        .run(FIX.workspace, FIX.projectA);
      await f.db
        .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
        .run(FIX.workspace, FIX.owner);
      expect(await f.execute()).toMatchObject({ ok: false });
    });

    it(`${command.name} observes a preceding FIFO revocation instead of its cached authority`, async () => {
      const f = await fixture(command);
      success(await f.execute());
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
          enter = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
      const revocation = f.hub.execute(
        {
          name: "synthetic.measurement-revoke",
          async run(_, ctx) {
            enter();
            await gate;
            await ctx.db
              .prepare(
                "UPDATE workspace_members SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
              )
              .run(FIX.workspace, FIX.owner);
            await ctx.db
              .prepare(
                "UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
              )
              .run(FIX.workspace, FIX.owner);
            return { revoked: true };
          },
        },
        {
          workspaceId: FIX.workspace,
          actorHumanId: FIX.owner,
          authorizationEpoch: 1,
          idempotencyKey: randomUlid(),
          now: LAUNCH_NOW,
          input: {},
        },
      );
      await entered;
      const replay = f.execute();
      release();
      success(await revocation);
      expect(await replay).toMatchObject({ ok: false });
    });
  }

  it("rejects every invalid or contradictory token alias, including a secondary alias", () => {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "7", false]) {
      expect(() => normalizeTokenFields({ input: 7, input_tokens: value })).toThrow();
    }
    expect(() => normalizeTokenFields({ input: null, input_tokens: 7 })).toThrow();
    expect(() => normalizeTokenFields({ input: 7, input_tokens: 8 })).toThrow();
    expect(() => normalizeTokenFields({ input: 7, typo: 8 })).toThrow();
    expect(
      normalizeTokenFields({ input: 7, input_tokens: 7, cache_read: 0, cached_input_tokens: 0 }),
    ).toEqual({ input: 7, output: null, cache_read: 0, cache_write: null, reasoning: null });
  });

  it("cannot relabel an immutable fake execution as a different provider", async () => {
    const f = await fixture(reportTokensCommand);
    expect(await f.execute({ ...f.input, provider: "codex" })).toMatchObject({ ok: false });
    success(await f.execute());
  });
});
