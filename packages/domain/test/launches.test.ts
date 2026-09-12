// ABOUTME: Verifies durable launch contention, immutable history, revocation and final authorization.
// ABOUTME: Negative tests preserve independent task results and physical checkout occupancy.

import { describe, expect, it } from "vitest";
import type { LaunchStartRequest } from "@bfb/protocol";

import { FIX } from "../src/fixtures.js";
import { observeCheckoutLeaseCommand } from "../src/checkout-leases.js";
import { randomUlid } from "../src/ids.js";
import { launchDeadline } from "../src/launch-state.js";
import {
  authorizeLaunchCommand,
  claimLaunchCommand,
  reconcileLaunchCommand,
  rejectLaunchCommand,
  startLaunchCommand,
  tightenLaunchCommand,
} from "../src/launches.js";
import { pullRunnerCommands } from "../src/runner-channel.js";
import { runnerHash } from "../src/runner-crypto.js";
import { removeMemberCommand } from "../src/workspace-authorization.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

describe("durable launch orchestration", () => {
  it("deduplicates identical Start and rejects changed input or a different human", async () => {
    const f = await launchFixture();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => f.human(startLaunchCommand, f.start)),
    );
    const ids = new Set(results.map((result) => success(result).launch_id));
    expect(ids.size).toBe(1);
    expect((await f.human(startLaunchCommand, { ...f.start, checkout_id: randomUlid() })).ok).toBe(
      false,
    );
    expect((await f.human(startLaunchCommand, f.start, LAUNCH_NOW, FIX.member)).ok).toBe(false);
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM execution_assignments`).get()).toEqual(
      { count: 1 },
    );
  });

  it("has one claim winner across keys and replays the same claim without another fence", async () => {
    const f = await launchFixture();
    const launch = success(await f.human(startLaunchCommand, f.start));
    const requests = Array.from({ length: 12 }, () => ({
      schema_version: 1 as const,
      launch_id: launch.launch_id,
      runner_id: f.runner,
      idempotency_key: randomUlid(),
      claimed_at: LAUNCH_NOW,
    }));
    const claims = await Promise.all(
      requests.map((claim) => f.native(claimLaunchCommand, { principal: f.principal, claim })),
    );
    expect(claims.filter((result) => result.ok)).toHaveLength(1);
    const replay = success(
      await f.native(claimLaunchCommand, { principal: f.principal, claim: requests[0]! }),
    );
    expect(replay.state).toBe("claimed");
    expect(await f.db.prepare(`SELECT fencing_generation FROM checkout_leases`).get()).toEqual({
      fencing_generation: 1,
    });
  });

  it("recovers a lost nudge by pulling only the existing durable command", async () => {
    const f = await launchFixture();
    const launch = success(await f.human(startLaunchCommand, f.start));
    const pulled = await pullRunnerCommands(f.db, f.principal, LAUNCH_NOW);
    expect(pulled.commands).toEqual([
      { command_id: launch.launch_id, command_kind: "launch", expires_at: launch.expires_at },
    ]);
  });

  it.each([46_000, 120_001])(
    "recovers a lost claim after %s ms without extending authority",
    async (delay) => {
      const f = await launchFixture(),
        c = await f.claim(),
        later = launchDeadline(LAUNCH_NOW, delay);
      await f.refresh(later);
      const retry = await f.native(
        claimLaunchCommand,
        { principal: f.principal, claim: c.request },
        later,
      );
      if (delay < 120_000) expect(retry.ok).toBe(false);
      else expect(success(retry)).toEqual({ state: "expired", reason: "launch_expired" });
      const before = await f.db.prepare(`SELECT * FROM checkout_leases`).get();
      const binding = success(
        await f.native(
          reconcileLaunchCommand,
          {
            principal: f.principal,
            claim: c.request,
          },
          later,
        ),
      );
      expect(binding).toEqual({
        schema_version: 1,
        workspace_id: FIX.workspace,
        runner_id: f.runner,
        launch_id: c.request.launch_id,
        run_execution_id: c.final.run_execution_id,
        assignment_generation: 1,
        physical_worktree_hash: c.final.physical_worktree_hash,
        launch_state: delay < 120_000 ? "claimed" : "expired",
        reservation_state: "reserved",
        fencing_generation: 1,
        observation_sequence: 0,
        lease_expires_at: launchDeadline(LAUNCH_NOW, 45_000),
      });
      expect(await f.db.prepare(`SELECT * FROM checkout_leases`).get()).toEqual(before);
      expect(
        success(
          await f.native(
            authorizeLaunchCommand,
            {
              principal: f.principal,
              authorization: c.final,
            },
            later,
          ),
        ).decision,
      ).toBe("rejected");
      expect(
        success(
          await f.native(
            observeCheckoutLeaseCommand,
            {
              principal: f.principal,
              observation: {
                schema_version: 1,
                run_execution_id: binding.run_execution_id,
                assignment_generation: binding.assignment_generation,
                fencing_generation: binding.fencing_generation!,
                sequence: binding.observation_sequence! + 1,
                observed_at: later,
                operation: "release",
                local_lock_id: randomUlid(),
                owned_group_id: 0,
                owned_group_start_identity: "",
                supervisor_state: "never_started",
                group_state: "never_started",
                lock_state: "never_acquired",
                descendants_state: "none",
                recovery_local: false,
              },
            },
            later,
          ),
        ).state,
      ).toBe("released");
      expect(
        success(
          await f.native(
            reconcileLaunchCommand,
            {
              principal: f.principal,
              claim: c.request,
            },
            later,
          ),
        ),
      ).toMatchObject({ reservation_state: "released", observation_sequence: 1 });
      const next = success(
        await f.human(
          startLaunchCommand,
          {
            ...f.start,
            expected_task_version: 3,
            idempotency_key: randomUlid(),
          },
          later,
        ),
      );
      const nextClaim = success(
        await f.native(
          claimLaunchCommand,
          {
            principal: f.principal,
            claim: {
              ...c.request,
              launch_id: next.launch_id,
              idempotency_key: randomUlid(),
              claimed_at: later,
            },
          },
          later,
        ),
      );
      expect(nextClaim.state).toBe("claimed");
      if (nextClaim.state === "claimed") expect(nextClaim.claim.fencing_generation).toBe(2);
      const old = success(
        await f.native(
          reconcileLaunchCommand,
          {
            principal: f.principal,
            claim: c.request,
          },
          later,
        ),
      );
      expect(old.reservation_state).toBe("superseded");
      expect(old).not.toHaveProperty("fencing_generation");
      expect(old).not.toHaveProperty("observation_sequence");
      expect(old).not.toHaveProperty("lease_expires_at");
    },
  );

  it("keeps cleanup readable after launch-grant revocation without restoring that grant", async () => {
    const f = await launchFixture(),
      c = await f.claim();
    await f.db.prepare(`UPDATE runner_launch_grants SET revoked_at = ?`).run(LAUNCH_NOW);
    expect(
      success(await f.native(claimLaunchCommand, { principal: f.principal, claim: c.request }))
        .state,
    ).toBe("rejected");
    expect(
      success(await f.native(reconcileLaunchCommand, { principal: f.principal, claim: c.request })),
    ).toMatchObject({
      reservation_state: "reserved",
      launch_state: "rejected",
    });
    expect(
      success(
        await f.native(authorizeLaunchCommand, { principal: f.principal, authorization: c.final }),
      ).decision,
    ).toBe("rejected");
  });

  it.each(["expiry", "revoked_grant"])(
    "reconciles a lost %s response before any lease was acquired",
    async (fault) => {
      const f = await launchFixture();
      const launch = success(await f.human(startLaunchCommand, f.start));
      const claim = {
        schema_version: 1 as const,
        launch_id: launch.launch_id,
        runner_id: f.runner,
        idempotency_key: randomUlid(),
        claimed_at: LAUNCH_NOW,
      };
      expect((await f.native(reconcileLaunchCommand, { principal: f.principal, claim })).ok).toBe(
        false,
      );
      const later = fault === "expiry" ? launchDeadline(LAUNCH_NOW, 120_001) : LAUNCH_NOW;
      await f.refresh(later);
      if (fault === "revoked_grant")
        await f.db.prepare(`UPDATE runner_launch_grants SET revoked_at = ?`).run(later);
      const rejected = success(
        await f.native(claimLaunchCommand, { principal: f.principal, claim }, later),
      );
      expect(rejected.state).toBe(fault === "expiry" ? "expired" : "rejected");
      expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM checkout_leases`).get()).toEqual({
        count: 0,
      });
      const binding = success(
        await f.native(reconcileLaunchCommand, { principal: f.principal, claim }, later),
      );
      expect(binding).toEqual({
        schema_version: 1,
        workspace_id: FIX.workspace,
        runner_id: f.runner,
        launch_id: launch.launch_id,
        run_execution_id: launch.run_execution_id,
        assignment_generation: launch.assignment_generation,
        physical_worktree_hash: f.inventory().checkouts[0]!.physical_worktree_hash,
        launch_state: rejected.state,
        reservation_state: "never_acquired",
      });
      for (const principal of [
        { ...f.principal, runnerId: randomUlid() },
        { ...f.principal, keyThumbprint: "synthetic-other-key" },
        { ...f.principal, workspaceId: randomUlid() },
      ])
        expect((await f.native(reconcileLaunchCommand, { principal, claim }, later)).ok).toBe(
          false,
        );
      expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM checkout_leases`).get()).toEqual({
        count: 0,
      });
    },
  );

  it("does not disclose cleanup bindings to an unclaimed key, another runner, workspace or proof type", async () => {
    const f = await launchFixture(),
      c = await f.claim();
    for (const claim of [
      { ...c.request, idempotency_key: randomUlid() },
      { ...c.request, runner_id: randomUlid() },
      { ...c.request, launch_id: randomUlid() },
      { ...c.request, device_proof_nonce: "synthetic-invalid-nonce" },
      { ...c.request, argv: ["synthetic"] },
    ])
      expect((await f.native(reconcileLaunchCommand, { principal: f.principal, claim })).ok).toBe(
        false,
      );
    for (const principal of [
      { ...f.principal, workspaceId: randomUlid() },
      { ...f.principal, runnerId: randomUlid() },
      { ...f.principal, keyThumbprint: "synthetic-other-key" },
    ])
      expect((await f.native(reconcileLaunchCommand, { principal, claim: c.request })).ok).toBe(
        false,
      );
    await f.db.prepare(`UPDATE runners SET revoked_at = ?`).run(LAUNCH_NOW);
    expect(
      (await f.native(reconcileLaunchCommand, { principal: f.principal, claim: c.request })).ok,
    ).toBe(false);
  });

  it("does not turn an expired reconnect into a claim and leaves the run result open", async () => {
    const f = await launchFixture();
    const launch = success(await f.human(startLaunchCommand, f.start));
    const expired = success(
      await f.native(
        claimLaunchCommand,
        {
          principal: f.principal,
          claim: {
            schema_version: 1,
            launch_id: launch.launch_id,
            runner_id: f.runner,
            idempotency_key: randomUlid(),
            claimed_at: LAUNCH_NOW,
          },
        },
        launchDeadline(LAUNCH_NOW),
      ),
    );
    expect(expired).toEqual({ state: "expired", reason: "launch_expired" });
    expect(
      await f.db.prepare(`SELECT result_state FROM runs WHERE id = ?`).get(launch.run_id),
    ).toEqual({ result_state: "open" });
    expect(await f.db.prepare(`SELECT state FROM tasks WHERE id = ?`).get(f.task.id)).toEqual({
      state: "ready",
    });
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM checkout_leases`).get()).toEqual({
      count: 0,
    });
  });

  it.each(["human", "grant", "checkout", "manifest", "policy", "snapshot"])(
    "rejects final authorization after %s changes",
    async (fault) => {
      const f = await launchFixture(),
        c = await f.claim();
      if (fault === "human")
        await f.db
          .prepare(`UPDATE runner_launch_grants SET revoked_at = ? WHERE human_id = ?`)
          .run(LAUNCH_NOW, FIX.owner);
      if (fault === "grant")
        await f.db.prepare(`DELETE FROM runner_project_grants WHERE runner_id = ?`).run(f.runner);
      if (fault === "checkout") await f.refresh(LAUNCH_NOW, { checkouts: [] });
      if (fault === "manifest")
        await f.refresh(LAUNCH_NOW, {
          providers: f
            .inventory()
            .providers.map((p) => ({ ...p, manifest_id: `sha256:${"b".repeat(64)}` })),
        });
      if (fault === "policy")
        await f.db
          .prepare(`UPDATE workspace_policies SET resource_version = resource_version + 1`)
          .run();
      if (fault === "snapshot") c.final.config_snapshot_hash = `sha256:${"c".repeat(64)}`;
      const result = success(
        await f.native(authorizeLaunchCommand, { principal: f.principal, authorization: c.final }),
      );
      expect(result.decision).toBe("rejected");
      expect(await f.db.prepare(`SELECT state FROM checkout_leases`).get()).toEqual({
        state: "reserved",
      });
      expect(
        await f.db.prepare(`SELECT result_state FROM runs WHERE id = ?`).get(c.launch.run_id),
      ).toEqual({ result_state: "open" });
    },
  );

  it("checks every final retry and binds the supervisor instead of replaying prior authorization", async () => {
    const f = await launchFixture(),
      c = await f.claim();
    expect(
      success(
        await f.native(authorizeLaunchCommand, { principal: f.principal, authorization: c.final }),
      ).decision,
    ).toBe("authorized");
    expect(
      success(
        await f.native(authorizeLaunchCommand, { principal: f.principal, authorization: c.final }),
      ).decision,
    ).toBe("authorized");
    expect(
      success(
        await f.native(authorizeLaunchCommand, {
          principal: f.principal,
          authorization: { ...c.final, supervisor: { ...c.final.supervisor, pid: 9999 } },
        }),
      ).decision,
    ).toBe("rejected");
  });

  it("appends a tighter snapshot and refuses the original final-check binding", async () => {
    const f = await launchFixture(),
      c = await f.claim();
    const document = { allow_run_overrides: false },
      hash = `sha256:${runnerHash(JSON.stringify(document))}`;
    await f.refresh(LAUNCH_NOW, {
      checkouts: f
        .inventory()
        .checkouts.map((checkout) => ({ ...checkout, repository_config_hash: hash })),
    });
    const replacement = success(
      await f.native(tightenLaunchCommand, {
        principal: f.principal,
        launchId: c.launch.launch_id,
        executionId: c.final.run_execution_id,
        assignmentGeneration: c.final.assignment_generation,
        fencingGeneration: c.final.fencing_generation,
        snapshotHash: c.final.config_snapshot_hash,
        repositoryConfigHash: hash,
        document,
      }),
    );
    expect(replacement.snapshot.repository_policy.allow_run_overrides).toBe(false);
    expect(replacement.specification.config_snapshot_id).not.toBe(c.final.config_snapshot_id);
    expect(
      await f.db
        .prepare(`SELECT COUNT(*) AS count FROM run_configuration_snapshots WHERE run_id = ?`)
        .get(c.launch.run_id),
    ).toEqual({ count: 2 });
    expect(
      success(
        await f.native(authorizeLaunchCommand, {
          principal: f.principal,
          authorization: {
            ...c.final,
            config_snapshot_id: replacement.specification.config_snapshot_id,
            config_snapshot_hash: replacement.specification.config_snapshot_hash,
            repository_config_hash: hash,
          },
        }),
      ).decision,
    ).toBe("authorized");
    expect(
      success(
        await f.native(authorizeLaunchCommand, { principal: f.principal, authorization: c.final }),
      ).decision,
    ).toBe("rejected");
  });

  it("retains a rejected claimed checkout beyond cloud TTL", async () => {
    const f = await launchFixture(),
      c = await f.claim();
    success(
      await f.native(rejectLaunchCommand, {
        principal: f.principal,
        launchId: c.launch.launch_id,
        executionId: c.final.run_execution_id,
        assignmentGeneration: c.final.assignment_generation,
      }),
    );
    const now = launchDeadline(LAUNCH_NOW, 60_000);
    await f.refresh(now);
    const retry = {
      ...f.start,
      expected_task_version: 3,
      idempotency_key: randomUlid(),
      retry_run_id: c.launch.run_id,
    };
    expect((await f.human(startLaunchCommand, retry, now)).ok).toBe(false);
    expect(await f.db.prepare(`SELECT state FROM checkout_leases`).get()).toEqual({
      state: "reserved",
    });
  });

  it.each(["claim", "final"])(
    "rechecks the requesting human epoch before %s independently of the runner owner",
    async (boundary) => {
      const f = await launchFixture();
      await f.db
        .prepare(
          `INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)`,
        )
        .run(FIX.workspace, f.runner, FIX.member, LAUNCH_NOW);
      const c = boundary === "final" ? await f.claim(FIX.member) : undefined;
      const launch =
        c?.launch ?? success(await f.human(startLaunchCommand, f.start, LAUNCH_NOW, FIX.member));
      success(await f.human(removeMemberCommand, { humanId: FIX.member }));
      if (c)
        expect(
          success(
            await f.native(authorizeLaunchCommand, {
              principal: f.principal,
              authorization: c.final,
            }),
          ).decision,
        ).toBe("rejected");
      else
        expect(
          success(
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
          ).state,
        ).toBe("rejected");
      expect(
        await f.db.prepare(`SELECT result_state FROM runs WHERE id = ?`).get(launch.run_id),
      ).toEqual({ result_state: "open" });
      expect(await f.db.prepare(`SELECT state FROM tasks WHERE id = ?`).get(f.task.id)).toEqual({
        state: "ready",
      });
    },
  );

  it("rejects widening and permits claim recovery of a lost tightening response without another snapshot", async () => {
    const f = await launchFixture(),
      c = await f.claim();
    const input = {
      principal: f.principal,
      launchId: c.launch.launch_id,
      executionId: c.final.run_execution_id,
      assignmentGeneration: c.final.assignment_generation,
      fencingGeneration: c.final.fencing_generation,
      snapshotHash: c.final.config_snapshot_hash,
    };
    const document = { allow_agent_root_propose: true },
      widened = `sha256:${runnerHash(JSON.stringify(document))}`;
    await f.refresh(LAUNCH_NOW, {
      checkouts: f
        .inventory()
        .checkouts.map((checkout) => ({ ...checkout, repository_config_hash: widened })),
    });
    expect(
      (await f.native(tightenLaunchCommand, { ...input, repositoryConfigHash: widened, document }))
        .ok,
    ).toBe(false);
    expect(
      await f.db.prepare(`SELECT COUNT(*) AS count FROM run_configuration_snapshots`).get(),
    ).toEqual({ count: 1 });
    const narrower = { allow_run_overrides: false },
      hash = `sha256:${runnerHash(JSON.stringify(narrower))}`;
    await f.refresh(LAUNCH_NOW, {
      checkouts: f
        .inventory()
        .checkouts.map((checkout) => ({ ...checkout, repository_config_hash: hash })),
    });
    const replacement = success(
      await f.native(tightenLaunchCommand, {
        ...input,
        repositoryConfigHash: hash,
        document: narrower,
      }),
    );
    const repeated = success(
      await f.native(claimLaunchCommand, { principal: f.principal, claim: c.request }),
    );
    expect(repeated.state).toBe("claimed");
    if (repeated.state === "claimed") expect(repeated.claim).toEqual(replacement);
    expect(
      await f.db.prepare(`SELECT COUNT(*) AS count FROM run_configuration_snapshots`).get(),
    ).toEqual({ count: 2 });
    await expect(
      f.db.prepare(`UPDATE run_configuration_snapshots SET canonical_json = '{}'`).run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      f.db.prepare(`UPDATE execution_assignments SET checkout_id = ?`).run(randomUlid()),
    ).rejects.toThrow(/immutable/);
  });

  it.each([false, true])(
    "retries a fully released unstarted run only without provider history (session: %s)",
    async (withSession) => {
      const f = await launchFixture(),
        c = await f.claim();
      if (withSession)
        await f.db
          .prepare(
            `INSERT INTO provider_sessions (workspace_id, id, run_id, execution_id, provider, observed_session_id, state, started_at)
      VALUES (?, ?, ?, ?, 'fake', 'synthetic-session', 'active', ?)`,
          )
          .run(FIX.workspace, randomUlid(), c.launch.run_id, c.final.run_execution_id, LAUNCH_NOW);
      success(
        await f.native(rejectLaunchCommand, {
          principal: f.principal,
          launchId: c.launch.launch_id,
          executionId: c.final.run_execution_id,
          assignmentGeneration: 1,
        }),
      );
      success(
        await f.native(observeCheckoutLeaseCommand, {
          principal: f.principal,
          observation: {
            schema_version: 1,
            run_execution_id: c.final.run_execution_id,
            assignment_generation: 1,
            fencing_generation: 1,
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
      const retry = await f.human(startLaunchCommand, {
        ...f.start,
        idempotency_key: randomUlid(),
        expected_task_version: 3,
        retry_run_id: c.launch.run_id,
      });
      expect(retry.ok).toBe(!withSession);
      if (retry.ok) {
        expect(retry.result.run_id).toBe(c.launch.run_id);
        expect(retry.result.assignment_generation).toBe(2);
        expect(retry.result.run_execution_id).not.toBe(c.final.run_execution_id);
        expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM runs`).get()).toEqual({
          count: 1,
        });
        expect(
          await f.db
            .prepare(
              `SELECT snapshot_generation FROM run_configuration_snapshots ORDER BY snapshot_generation`,
            )
            .all(),
        ).toEqual([{ snapshot_generation: 1 }, { snapshot_generation: 2 }]);
      }
    },
  );

  it.each([
    "command",
    "argv",
    "cwd",
    "task_text",
    "repository_url",
    "branch",
    "token",
    "local_path",
  ])("rejects malicious Start field %s before state", async (field) => {
    const f = await launchFixture();
    expect(
      (
        await f.human(startLaunchCommand, {
          ...f.start,
          [field]: "synthetic-canary",
        } as LaunchStartRequest)
      ).ok,
    ).toBe(false);
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM launch_commands`).get()).toEqual({
      count: 0,
    });
  });
});
