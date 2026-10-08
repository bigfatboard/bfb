// ABOUTME: Tests durable controls, principal and assignment binding, and exact-session resume fencing.
// ABOUTME: Synthetic process facts never grant a second local action or alter a run result.

import type { CheckoutLeaseObservation, RunControlClaim, RunControlRequest } from "@bfb/protocol";
import { describe, expect, it } from "vitest";

import { observeCheckoutLeaseCommand } from "../src/checkout-leases.js";
import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import { launchDeadline } from "../src/launch-state.js";
import { authorizeLaunchCommand, claimLaunchCommand, startLaunchCommand } from "../src/launches.js";
import {
  acknowledgeRunControlCommand,
  claimRunControlCommand,
  createRunControlCommand,
  readRunnerControl,
} from "../src/run-controls.js";
import { pullRunnerCommands } from "../src/runner-channel.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

async function fixture() {
  const f = await launchFixture(),
    c = await f.claim();
  success(
    await f.native(authorizeLaunchCommand, { principal: f.principal, authorization: c.final }),
  );
  const observation: CheckoutLeaseObservation = {
    schema_version: 1,
    run_execution_id: c.final.run_execution_id,
    assignment_generation: c.final.assignment_generation,
    fencing_generation: c.final.fencing_generation,
    sequence: 1,
    observed_at: LAUNCH_NOW,
    operation: "renew",
    supervisor: c.final.supervisor,
    local_lock_id: c.final.local_lock_id,
    owned_group_id: 1235,
    owned_group_start_identity: "123456:2000",
    supervisor_state: "verified",
    group_state: "live",
    lock_state: "held",
    descendants_state: "contained",
    recovery_local: false,
  };
  success(await f.native(observeCheckoutLeaseCommand, { principal: f.principal, observation }));
  const input = (action: RunControlRequest["action"]): RunControlRequest => ({
    schema_version: 1,
    idempotency_key: randomUlid(),
    runner_id: f.runner,
    run_execution_id: c.final.run_execution_id,
    assignment_generation: c.final.assignment_generation,
    action,
  });
  async function makeControl(action: RunControlRequest["action"]) {
    const request = input(action),
      control = success(await f.human(createRunControlCommand, request));
    const claim: RunControlClaim = {
      schema_version: 1,
      idempotency_key: randomUlid(),
      control_id: control.control_id,
      run_execution_id: request.run_execution_id,
      assignment_generation: request.assignment_generation,
      action,
    };
    return { control, request, claim };
  }
  async function end() {
    success(
      await f.native(observeCheckoutLeaseCommand, {
        principal: f.principal,
        observation: {
          ...observation,
          sequence: 2,
          operation: "release",
          supervisor_state: "gone",
          group_state: "gone",
          lock_state: "gone",
          descendants_state: "gone",
        },
      }),
    );
    const session = randomUlid();
    await f.db
      .prepare(
        `INSERT INTO provider_sessions (workspace_id, id, run_id, execution_id, provider, observed_session_id, state, resource_version, started_at)
      VALUES (?, ?, ?, ?, 'fake', 'synthetic-owned-session', 'active', 1, ?)`,
      )
      .run(FIX.workspace, session, c.launch.run_id, c.final.run_execution_id, LAUNCH_NOW);
    return session;
  }
  return { ...f, ...c, input, makeControl, end };
}

describe("durable run controls", () => {
  it("reads a pulled target without claiming, applying or exposing it to another principal", async () => {
    const f = await fixture(),
      c = await f.makeControl("interrupt"),
      input = { schema_version: 1 as const, control_id: c.control.control_id };
    const events = await f.db.prepare(`SELECT COUNT(*) AS count FROM semantic_events`).get();
    expect(await readRunnerControl(f.db, f.principal, input, LAUNCH_NOW)).toEqual(c.control);
    expect(await f.db.prepare(`SELECT state, claim_key_hash FROM run_controls`).get()).toEqual({
      state: "pending",
      claim_key_hash: null,
    });
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM semantic_events`).get()).toEqual(
      events,
    );
    await expect(
      readRunnerControl(f.db, { ...f.principal, runnerId: randomUlid() }, input, LAUNCH_NOW),
    ).rejects.toThrow();
    await expect(
      readRunnerControl(f.db, { ...f.principal, workspaceId: randomUlid() }, input, LAUNCH_NOW),
    ).rejects.toThrow();
    await f.db
      .prepare(`UPDATE runner_launch_grants SET revoked_at = ? WHERE runner_id = ?`)
      .run(LAUNCH_NOW, f.runner);
    await expect(readRunnerControl(f.db, f.principal, input, LAUNCH_NOW)).rejects.toThrow();
  });
  it.each(["focus_existing", "interrupt", "terminate", "cancel"] as const)(
    "deduplicates %s with one claimed disposition and durable pull",
    async (action) => {
      const f = await fixture(),
        c = await f.makeControl(action);
      expect(success(await f.human(createRunControlCommand, c.request)).control_id).toBe(
        c.control.control_id,
      );
      expect(
        (await pullRunnerCommands(f.db, f.principal, LAUNCH_NOW)).commands.map((x) => x.command_id),
      ).toContain(c.control.control_id);
      const claimed = success(
        await f.native(claimRunControlCommand, { principal: f.principal, claim: c.claim }),
      );
      expect(claimed.state).toBe("claimed");
      expect(
        success(await f.native(claimRunControlCommand, { principal: f.principal, claim: c.claim })),
      ).toEqual(claimed);
      const acknowledgement = {
        schema_version: 1 as const,
        control_id: c.control.control_id,
        run_execution_id: c.claim.run_execution_id,
        assignment_generation: c.claim.assignment_generation,
        idempotency_key: c.claim.idempotency_key,
        disposition: "applied" as const,
      };
      expect(
        success(
          await f.native(acknowledgeRunControlCommand, { principal: f.principal, acknowledgement }),
        ).state,
      ).toBe("applied");
      expect(
        success(
          await f.native(acknowledgeRunControlCommand, { principal: f.principal, acknowledgement }),
        ).state,
      ).toBe("applied");
      expect((await pullRunnerCommands(f.db, f.principal, LAUNCH_NOW)).commands).toEqual([]);
      expect(await f.db.prepare(`SELECT state FROM checkout_leases`).get()).toEqual({
        state: "live",
      });
    },
  );

  it.each(["key", "generation", "execution", "action", "principal", "grant", "expiry"])(
    "refuses %s mismatch before a control effect",
    async (fault) => {
      const f = await fixture(),
        c = await f.makeControl("interrupt");
      const claim = { ...c.claim };
      let principal = f.principal,
        now = LAUNCH_NOW;
      if (fault === "key") {
        success(await f.native(claimRunControlCommand, { principal, claim }));
        claim.idempotency_key = randomUlid();
      }
      if (fault === "generation") claim.assignment_generation++;
      if (fault === "execution") claim.run_execution_id = randomUlid();
      if (fault === "action") claim.action = "terminate";
      if (fault === "principal") principal = { ...principal, runnerId: randomUlid() };
      if (fault === "grant")
        await f.db
          .prepare(`UPDATE runner_launch_grants SET revoked_at = ? WHERE runner_id = ?`)
          .run(LAUNCH_NOW, f.runner);
      if (fault === "expiry") now = launchDeadline(LAUNCH_NOW);
      const result = await f.native(claimRunControlCommand, { principal, claim }, now);
      expect(result.ok && result.result.state === "claimed").toBe(false);
      expect(await f.db.prepare(`SELECT state FROM checkout_leases`).get()).toEqual({
        state: "live",
      });
    },
  );

  it("cancels pending authority immediately without manufacturing a process or result", async () => {
    const f = await launchFixture(),
      launch = success(await f.human(startLaunchCommand, f.start));
    const control = success(
      await f.human(createRunControlCommand, {
        schema_version: 1,
        idempotency_key: randomUlid(),
        runner_id: f.runner,
        run_execution_id: launch.run_execution_id,
        assignment_generation: launch.assignment_generation,
        action: "cancel",
      }),
    );
    expect(control.state).toBe("applied");
    expect(
      await f.db.prepare(`SELECT result_state FROM runs WHERE id = ?`).get(launch.run_id),
    ).toEqual({ result_state: "open" });
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM checkout_leases`).get()).toEqual({
      count: 0,
    });
  });

  it("resumes one exact session through one new assignment and an independently claimed fence", async () => {
    const f = await fixture(),
      session = await f.end(),
      c = await f.makeControl("resume");
    const claimed = success(
      await f.native(claimRunControlCommand, { principal: f.principal, claim: c.claim }),
    );
    expect(claimed.resume_launch_id).toBeTruthy();
    expect(
      success(await f.native(claimRunControlCommand, { principal: f.principal, claim: c.claim }))
        .resume_launch_id,
    ).toBe(claimed.resume_launch_id);
    const resumed = success(
      await f.native(claimLaunchCommand, {
        principal: f.principal,
        claim: {
          schema_version: 1,
          launch_id: claimed.resume_launch_id!,
          runner_id: f.runner,
          idempotency_key: randomUlid(),
          claimed_at: LAUNCH_NOW,
        },
      }),
    );
    expect(resumed.state).toBe("claimed");
    if (resumed.state !== "claimed") return;
    expect(resumed.claim.specification.run_id).toBe(f.launch.run_id);
    expect(resumed.claim.specification.run_execution_id).not.toBe(f.final.run_execution_id);
    expect(resumed.claim.specification.assignment_generation).toBe(2);
    expect(resumed.claim.fencing_generation).toBe(2);
    expect(resumed.claim.specification.resume_session).toEqual({
      provider_session_id: session,
      observed_session_id: "synthetic-owned-session",
    });
    expect(resumed.claim.specification.expires_at).toBe(c.control.expires_at);
  });

  it("does not resume a live process or guess between ambiguous observed sessions", async () => {
    const f = await fixture();
    expect((await f.human(createRunControlCommand, f.input("resume"))).ok).toBe(false);
    await f.end();
    const c = await f.makeControl("resume");
    await f.db
      .prepare(
        `INSERT INTO provider_sessions (workspace_id, id, run_id, execution_id, provider, observed_session_id, state, resource_version, started_at)
      VALUES (?, ?, ?, ?, 'fake', 'synthetic-other-session', 'active', 1, ?)`,
      )
      .run(FIX.workspace, randomUlid(), f.launch.run_id, f.final.run_execution_id, LAUNCH_NOW);
    expect(
      (await f.native(claimRunControlCommand, { principal: f.principal, claim: c.claim })).ok,
    ).toBe(false);
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM execution_assignments`).get()).toEqual(
      { count: 1 },
    );
  });
});
