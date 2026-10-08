// ABOUTME: Tests verifier-only wake issuance, one-use redemption and immutable launch binding.
// ABOUTME: Synthetic capability scans ensure raw wake identifiers never reach hub history or D1.

import { describe, expect, it } from "vitest";

import { FIX } from "../src/fixtures.js";
import { launchDeadline } from "../src/launch-state.js";
import {
  cloudWakeVerifier,
  createCloudWakeIdentifier,
  issueLaunchWakeCommand,
  redeemLaunchWakeCommand,
} from "../src/launch-wake.js";
import { claimLaunchCommand, startLaunchCommand } from "../src/launches.js";
import { randomUlid } from "../src/ids.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

describe("single-use cloud wake hints", () => {
  it("uses the native grammar with all 128 random bits and retains no raw identifiers", async () => {
    const f = await launchFixture(),
      launch = success(await f.human(startLaunchCommand, f.start));
    const ids = Array.from({ length: 64 }, createCloudWakeIdentifier);
    expect(new Set(ids).size).toBe(64);
    expect(new Set(ids.map((id) => id.slice(0, 8))).size).toBe(64);
    for (const id of ids) expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const raw = ids[0]!,
      verifier = cloudWakeVerifier(raw);
    const issued = success(
      await f.human(issueLaunchWakeCommand, { launchId: launch.launch_id, verifier }),
    );
    expect(issued.expires_at).toBe(launch.expires_at);
    const stored = JSON.stringify(await f.db.prepare(`SELECT * FROM launch_wake_intents`).all());
    expect(stored).toContain(verifier);
    expect(stored).not.toContain(raw);
    for (const table of [
      "audit_events",
      "semantic_events",
      "outbox_records",
      "idempotency_records",
    ])
      expect(JSON.stringify(await f.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(raw);
  });

  it("consumes once across concurrent redemption and cannot create a second assignment", async () => {
    const f = await launchFixture(),
      launch = success(await f.human(startLaunchCommand, f.start));
    const verifier = cloudWakeVerifier(createCloudWakeIdentifier());
    success(await f.human(issueLaunchWakeCommand, { launchId: launch.launch_id, verifier }));
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        f.native(redeemLaunchWakeCommand, { principal: f.principal, verifier }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await f.db.prepare(`SELECT state FROM launch_commands`).get()).toEqual({
      state: "pending",
    });
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM execution_assignments`).get()).toEqual(
      { count: 1 },
    );
    const claim = success(
      await f.native(claimLaunchCommand, {
        principal: f.principal,
        claim: {
          schema_version: 1,
          launch_id: launch.launch_id,
          runner_id: f.runner,
          idempotency_key: randomUlid(),
          claimed_at: LAUNCH_NOW,
        },
      }),
    );
    expect(claim.state).toBe("claimed");
  });

  it.each(["human", "runner", "device", "workspace", "expired", "revoked"])(
    "rejects %s mismatch without consuming or claiming",
    async (fault) => {
      const f = await launchFixture(),
        launch = success(await f.human(startLaunchCommand, f.start)),
        verifier = cloudWakeVerifier(createCloudWakeIdentifier());
      success(await f.human(issueLaunchWakeCommand, { launchId: launch.launch_id, verifier }));
      if (fault === "human")
        await f.db
          .prepare(`UPDATE launch_wake_intents SET requesting_human_id = ?`)
          .run(FIX.member);
      if (fault === "revoked")
        await f.db
          .prepare(`UPDATE runner_launch_grants SET revoked_at = ? WHERE runner_id = ?`)
          .run(LAUNCH_NOW, f.runner);
      const principal = { ...f.principal };
      if (fault === "runner") principal.runnerId = randomUlid();
      if (fault === "workspace") principal.workspaceId = randomUlid();
      if (fault === "device") principal.keyThumbprint = "synthetic-wrong-device";
      expect(
        (
          await f.native(
            redeemLaunchWakeCommand,
            { principal, verifier },
            fault === "expired" ? launchDeadline(LAUNCH_NOW) : LAUNCH_NOW,
          )
        ).ok,
      ).toBe(false);
      expect(await f.db.prepare(`SELECT consumed_at FROM launch_wake_intents`).get()).toEqual({
        consumed_at: null,
      });
      expect(await f.db.prepare(`SELECT state FROM launch_commands`).get()).toEqual({
        state: "pending",
      });
    },
  );
});
