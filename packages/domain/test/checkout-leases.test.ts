// ABOUTME: Exercises process-group and lock proof matrices against persisted cloud checkout fences.
// ABOUTME: TTL, provider exit and ambiguous recovery never stand in for complete local containment proof.

import type { CheckoutLeaseObservation } from "@bfb/protocol";
import { describe, expect, it } from "vitest";

import { observeCheckoutLeaseCommand } from "../src/checkout-leases.js";
import { launchDeadline } from "../src/launch-state.js";
import { authorizeLaunchCommand } from "../src/launches.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

async function fixture() {
  const f = await launchFixture(),
    c = await f.claim();
  const observe = (observation: CheckoutLeaseObservation, now = observation.observed_at) =>
    f.native(observeCheckoutLeaseCommand, { principal: f.principal, observation }, now);
  const live: CheckoutLeaseObservation = {
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
  const ended: CheckoutLeaseObservation = {
    ...live,
    sequence: 2,
    operation: "release",
    supervisor_state: "gone",
    group_state: "gone",
    lock_state: "gone",
    descendants_state: "gone",
  };
  success(
    await f.native(authorizeLaunchCommand, { principal: f.principal, authorization: c.final }),
  );
  return { ...f, ...c, live, ended, observe };
}

describe("fenced checkout containment", () => {
  it("renews only verified live identity and releases only the whole group plus lock", async () => {
    const f = await fixture();
    expect(success(await f.observe(f.live)).state).toBe("live");
    expect(success(await f.observe(f.ended)).state).toBe("released");
    expect(
      await f.db.prepare(`SELECT result_state FROM runs WHERE id = ?`).get(f.launch.run_id),
    ).toEqual({ result_state: "open" });
    expect(
      await f.db
        .prepare(`SELECT state, end_reason FROM run_executions WHERE id = ?`)
        .get(f.final.run_execution_id),
    ).toEqual({ state: "ended", end_reason: "process_exit" });
  });

  it.each([
    { name: "child still alive", change: { group_state: "live" } },
    { name: "local lock still held", change: { lock_state: "held" } },
    { name: "escaped descendant", change: { descendants_state: "escaped" } },
    { name: "unknown descendant", change: { descendants_state: "unknown" } },
    { name: "ambiguous supervisor", change: { supervisor_state: "ambiguous" } },
    { name: "unknown group", change: { group_state: "unknown" } },
    { name: "unknown lock", change: { lock_state: "unknown" } },
  ] as const)("retains a durable unknown fence for $name", async ({ change }) => {
    const f = await fixture();
    success(await f.observe(f.live));
    expect(success(await f.observe({ ...f.ended, ...change })).state).toBe("containment_unknown");
    const afterTtl = launchDeadline(LAUNCH_NOW, 90_000);
    expect(success(await f.observe({ ...f.live, sequence: 3, observed_at: afterTtl })).state).toBe(
      "containment_unknown",
    );
    expect(success(await f.observe({ ...f.ended, sequence: 4, observed_at: afterTtl })).state).toBe(
      "containment_unknown",
    );
    expect(
      success(
        await f.observe({
          ...f.ended,
          sequence: 5,
          observed_at: afterTtl,
          operation: "recover",
          recovery_local: true,
        }),
      ).state,
    ).toBe("released");
  });

  it("rejects stale sequences and another fence without poisoning the current owner", async () => {
    const f = await fixture();
    success(await f.observe(f.live));
    expect((await f.observe(f.live)).ok).toBe(false);
    expect((await f.observe({ ...f.ended, fencing_generation: 2 })).ok).toBe(false);
    expect((await f.observe({ ...f.ended, assignment_generation: 2 })).ok).toBe(false);
    expect(
      (
        await f.observe(
          { ...f.ended, observed_at: launchDeadline(LAUNCH_NOW, -60_000) },
          LAUNCH_NOW,
        )
      ).ok,
    ).toBe(false);
    expect(
      await f.db.prepare(`SELECT state, observation_sequence FROM checkout_leases`).get(),
    ).toEqual({ state: "live", observation_sequence: 1 });
  });

  it("detects PID reuse and retains the original supervisor/group identity for recovery", async () => {
    const f = await fixture();
    success(await f.observe(f.live));
    expect(
      success(
        await f.observe({
          ...f.live,
          sequence: 2,
          supervisor: { ...f.live.supervisor!, start_identity: "999999:1" },
        }),
      ).state,
    ).toBe("containment_unknown");
    expect(
      success(
        await f.observe({ ...f.ended, sequence: 3, operation: "recover", recovery_local: true }),
      ).state,
    ).toBe("released");
  });

  it("cannot renew without final authorization, or clear unknown by asserting ordinary release", async () => {
    const f = await launchFixture(),
      c = await f.claim();
    const proof: CheckoutLeaseObservation = {
      schema_version: 1,
      run_execution_id: c.final.run_execution_id,
      assignment_generation: 1,
      fencing_generation: 1,
      sequence: 1,
      observed_at: LAUNCH_NOW,
      operation: "renew",
      local_lock_id: c.final.local_lock_id,
      owned_group_id: 0,
      owned_group_start_identity: "",
      supervisor_state: "never_started",
      group_state: "never_started",
      lock_state: "never_acquired",
      descendants_state: "none",
      recovery_local: false,
    };
    const observe = (observation: CheckoutLeaseObservation) =>
      f.native(observeCheckoutLeaseCommand, { principal: f.principal, observation });
    expect(success(await observe(proof)).state).toBe("containment_unknown");
    expect(success(await observe({ ...proof, sequence: 2, operation: "release" })).state).toBe(
      "containment_unknown",
    );
    expect(
      success(await observe({ ...proof, sequence: 3, operation: "recover", recovery_local: true }))
        .state,
    ).toBe("released");
  });
});
