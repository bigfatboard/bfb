// ABOUTME: Exercises immutable root-lease scope and current authority without complete family claims.
// ABOUTME: Root loss, revoked policy and version-one recovery cannot release or rehabilitate uncertain occupancy.

import type { CheckoutLeaseObservation, CheckoutRootLeaseObservation } from "@bfb/protocol";
import { describe, expect, it } from "vitest";

import { observeCheckoutLeaseCommand } from "../src/checkout-leases.js";
import { observeCheckoutRootLeaseCommand } from "../src/checkout-root-leases.js";
import { launchDeadline } from "../src/launch-state.js";
import { authorizeLaunchCommand } from "../src/launches.js";
import { configureRootLaunchFixture, rootLeaseObservation } from "./checkout-root-lease-fixture.js";
import { LAUNCH_NOW, launchFixture, success, SYNTHETIC_DIGEST } from "./launch-fixture.js";

async function fixture(authorize = true) {
  const f = await launchFixture();
  await configureRootLaunchFixture(f);
  const c = await f.claim();
  if (authorize)
    success(
      await f.native(authorizeLaunchCommand, { principal: f.principal, authorization: c.final }),
    );
  const live = rootLeaseObservation(c.final);
  const observe = (observation: CheckoutRootLeaseObservation, now = observation.observed_at) =>
    f.native(observeCheckoutRootLeaseCommand, { principal: f.principal, observation }, now);
  const strict = (observation: CheckoutRootLeaseObservation): CheckoutLeaseObservation => {
    const { supervision_mode: _mode, family_coverage: _coverage, ...fields } = observation;
    return { ...fields, schema_version: 1, descendants_state: "contained" };
  };
  return { ...f, ...c, live, observe, strict };
}

describe("root checkout occupancy", () => {
  it("renews an authorized live root and durably declares unproven family coverage", async () => {
    const f = await fixture();
    const renewal = success(await f.observe(f.live));
    expect(renewal).toMatchObject({
      state: "live",
      supervision_mode: "root",
      family_coverage: "unproven",
    });
    expect(renewal.expires_at).toBe(launchDeadline(LAUNCH_NOW, 45_000));
    const lease = (await f.db.prepare(`SELECT identity_json FROM checkout_leases`).get()) as {
      identity_json: string;
    };
    expect(JSON.parse(lease.identity_json)).toMatchObject({
      supervision_mode: "root",
      family_coverage: "unproven",
      provider_manifest_id: SYNTHETIC_DIGEST,
      provider_version: "2.1.291",
      owned_group_id: 1235,
      local_lock_id: f.final.local_lock_id,
    });
    expect(await f.db.prepare(`SELECT state FROM run_executions`).get()).toEqual({
      state: "attached",
    });
  });

  it("root loss stays unknown across expiry and never asserts process exit or completion", async () => {
    const f = await fixture();
    success(await f.observe(f.live));
    const loss = success(
      await f.observe({ ...f.live, sequence: 2, operation: "unknown", group_state: "gone" }),
    );
    expect(loss.state).toBe("containment_unknown");
    const later = launchDeadline(LAUNCH_NOW, 90_000);
    await f.refresh(later);
    expect(success(await f.observe({ ...f.live, sequence: 3, observed_at: later })).state).toBe(
      "containment_unknown",
    );
    expect(await f.db.prepare(`SELECT state, end_reason FROM run_executions`).get()).toEqual({
      state: "attached",
      end_reason: null,
    });
    expect(await f.db.prepare(`SELECT result_state FROM runs`).get()).toEqual({
      result_state: "open",
    });
    expect(await f.db.prepare(`SELECT expires_at, released_at FROM checkout_leases`).get()).toEqual(
      { expires_at: loss.expires_at, released_at: null },
    );
  });

  it.each(["renew", "release", "recover"] as const)(
    "version-one %s cannot downgrade a root pin",
    async (operation) => {
      const f = await fixture();
      success(await f.observe(f.live));
      const observation = {
        ...f.strict(f.live),
        sequence: 2,
        operation,
        ...(operation === "renew"
          ? {}
          : {
              supervisor_state: "gone" as const,
              group_state: "gone" as const,
              lock_state: "gone" as const,
              descendants_state: "gone" as const,
            }),
        recovery_local: operation === "recover",
      };
      expect(
        success(
          await f.native(observeCheckoutLeaseCommand, { principal: f.principal, observation }),
        ).state,
      ).toBe("containment_unknown");
      expect(await f.db.prepare(`SELECT released_at FROM checkout_leases`).get()).toEqual({
        released_at: null,
      });
      expect(success(await f.observe({ ...f.live, sequence: 3 })).state).toBe(
        "containment_unknown",
      );
    },
  );

  it.each([false, true])(
    "never upgrades a strict lease, including strict unknown (%s)",
    async (unknown) => {
      const f = await fixture();
      const observation = {
        ...f.strict(f.live),
        ...(unknown ? { operation: "unknown" as const } : {}),
      };
      success(await f.native(observeCheckoutLeaseCommand, { principal: f.principal, observation }));
      expect((await f.observe({ ...f.live, sequence: 2 })).ok).toBe(false);
      const lease = (await f.db
        .prepare(`SELECT identity_json, observation_sequence FROM checkout_leases`)
        .get()) as { identity_json: string; observation_sequence: number };
      expect(JSON.parse(lease.identity_json)).not.toHaveProperty("supervision_mode");
      expect(lease.observation_sequence).toBe(1);
    },
  );

  it("does not upgrade identity-free historical unknown occupancy", async () => {
    const f = await fixture();
    await f.db
      .prepare(
        `UPDATE checkout_leases SET state = 'containment_unknown', containment_reason = 'evidence_missing'`,
      )
      .run();
    expect((await f.observe(f.live)).ok).toBe(false);
    expect(
      await f.db.prepare(`SELECT identity_json, observation_sequence FROM checkout_leases`).get(),
    ).toEqual({ identity_json: null, observation_sequence: 0 });
  });

  it("pins a first unknown observation and blocks final authorization or later renewal", async () => {
    const f = await fixture(false);
    expect(success(await f.observe({ ...f.live, operation: "unknown" })).state).toBe(
      "containment_unknown",
    );
    expect(
      success(
        await f.native(authorizeLaunchCommand, { principal: f.principal, authorization: f.final }),
      ).decision,
    ).toBe("rejected");
    expect(success(await f.observe({ ...f.live, sequence: 2 })).state).toBe("containment_unknown");
    const lease = (await f.db.prepare(`SELECT identity_json FROM checkout_leases`).get()) as {
      identity_json: string;
    };
    expect(JSON.parse(lease.identity_json)).toMatchObject({
      supervision_mode: "root",
      family_coverage: "unproven",
    });
  });

  it("rejects root scope for another provider before changing the reservation", async () => {
    const f = await launchFixture(),
      c = await f.claim();
    expect(
      (
        await f.native(observeCheckoutRootLeaseCommand, {
          principal: f.principal,
          observation: rootLeaseObservation(c.final),
        })
      ).ok,
    ).toBe(false);
    expect(await f.db.prepare(`SELECT state, identity_json FROM checkout_leases`).get()).toEqual({
      state: "reserved",
      identity_json: null,
    });
  });

  it.each([
    { supervisor: { pid: 1234, start_identity: "999999:1", executable_hash: SYNTHETIC_DIGEST } },
    { owned_group_id: 9999 },
    { owned_group_start_identity: "999999:2" },
  ])("retains the first identity when identity changes: %j", async (change) => {
    const f = await fixture();
    success(await f.observe(f.live));
    const before = await f.db.prepare(`SELECT identity_json FROM checkout_leases`).get();
    expect(success(await f.observe({ ...f.live, sequence: 2, ...change })).state).toBe(
      "containment_unknown",
    );
    expect(await f.db.prepare(`SELECT identity_json FROM checkout_leases`).get()).toEqual(before);
  });

  it("rejects stale or mismatched fences without changing current occupancy", async () => {
    const f = await fixture();
    success(await f.observe(f.live));
    for (const observation of [
      f.live,
      { ...f.live, sequence: 2, fencing_generation: 99 },
      { ...f.live, sequence: 2, assignment_generation: 99 },
      { ...f.live, sequence: 2, observed_at: launchDeadline(LAUNCH_NOW, -60_000) },
    ])
      expect((await f.observe(observation, LAUNCH_NOW)).ok).toBe(false);
    expect(
      await f.db.prepare(`SELECT state, observation_sequence FROM checkout_leases`).get(),
    ).toEqual({ state: "live", observation_sequence: 1 });
  });

  it.each(["grant", "policy", "cancelled", "terminal-result", "manifest"] as const)(
    "denies renewal after %s changes but accepts unknown occupancy",
    async (change) => {
      const f = await fixture();
      success(await f.observe(f.live));
      switch (change) {
        case "grant":
          await f.db.prepare(`DELETE FROM runner_launch_grants WHERE runner_id = ?`).run(f.runner);
          break;
        case "policy":
          await f.db
            .prepare(
              `UPDATE project_policies SET allow_pass_to_agent = 0, resource_version = resource_version + 1`,
            )
            .run();
          break;
        case "cancelled":
          await f.db.prepare(`UPDATE launch_commands SET cancelled_at = ?`).run(LAUNCH_NOW);
          break;
        case "terminal-result":
          await f.db.prepare(`UPDATE runs SET result_state = 'accepted'`).run();
          break;
        case "manifest":
          await f.refresh(LAUNCH_NOW, {
            providers: f.inventory().providers.map((provider) => ({
              ...provider,
              manifest_id: `sha256:${"b".repeat(64)}`,
            })),
          });
          break;
      }
      expect(success(await f.observe({ ...f.live, sequence: 2 })).state).toBe(
        "containment_unknown",
      );
      expect(
        success(
          await f.observe({ ...f.live, sequence: 3, operation: "unknown", group_state: "gone" }),
        ).state,
      ).toBe("containment_unknown");
      expect(await f.db.prepare(`SELECT released_at FROM checkout_leases`).get()).toEqual({
        released_at: null,
      });
    },
  );
});
