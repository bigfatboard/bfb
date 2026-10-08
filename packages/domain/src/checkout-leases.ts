// ABOUTME: Renews or releases fenced checkout reservations from authenticated local containment observations.
// ABOUTME: Unknown containment persists across expiry and can clear only through explicit verified local recovery.

import type { CheckoutLeaseObservation } from "@bfb/protocol";

import type { HubCommand } from "./hub.js";
import {
  assertLeaseBinding,
  canonicalLaunchJson,
  guardLaunchMutation,
  launchDeadline,
  launchRunner,
  launchWire,
  LEASE_TTL_MS,
  readLaunch,
  readLease,
} from "./launch-state.js";
import { resolveRunnerCommandReference } from "./runner-channel.js";
import { rejectRunnerRequest, runnerObject } from "./runner-crypto.js";
import type { RunnerPrincipal } from "./runners.js";

interface LeaseIdentity {
  supervisor?: CheckoutLeaseObservation["supervisor"];
  local_lock_id: string;
  owned_group_id: number;
  owned_group_start_identity: string;
}

function identityOf(observation: CheckoutLeaseObservation): LeaseIdentity {
  return {
    ...(observation.supervisor ? { supervisor: observation.supervisor } : {}),
    local_lock_id: observation.local_lock_id,
    owned_group_id: observation.owned_group_id,
    owned_group_start_identity: observation.owned_group_start_identity,
  };
}

function verifiedLive(observation: CheckoutLeaseObservation): boolean {
  return (
    observation.supervisor !== undefined &&
    observation.supervisor_state === "verified" &&
    observation.group_state === "live" &&
    observation.owned_group_id > 0 &&
    observation.owned_group_start_identity !== "" &&
    observation.lock_state === "held" &&
    observation.descendants_state === "contained"
  );
}

function verifiedGone(observation: CheckoutLeaseObservation, everStarted: boolean): boolean {
  if (everStarted)
    return (
      observation.supervisor !== undefined &&
      observation.supervisor_state === "gone" &&
      observation.group_state === "gone" &&
      observation.lock_state === "gone" &&
      observation.descendants_state === "gone" &&
      observation.owned_group_id > 0 &&
      observation.owned_group_start_identity !== ""
    );
  return (
    (observation.supervisor_state === "gone" ||
      (observation.supervisor_state === "never_started" && !observation.supervisor)) &&
    (observation.group_state === "never_started" || observation.group_state === "gone") &&
    observation.owned_group_id === 0 &&
    observation.owned_group_start_identity === "" &&
    (observation.lock_state === "never_acquired" || observation.lock_state === "gone") &&
    observation.descendants_state === "none"
  );
}

export const observeCheckoutLeaseCommand: HubCommand<
  {
    principal: RunnerPrincipal;
    observation: CheckoutLeaseObservation;
  },
  {
    state: "live" | "containment_unknown" | "released";
    fencing_generation: number;
    observation_sequence: number;
    expires_at: string;
  }
> = {
  name: "checkout.lease.observe",
  replay: "reject",
  auditInput: (input) => ({
    runnerId: input.principal.runnerId,
    executionId: input.observation.run_execution_id,
    assignmentGeneration: input.observation.assignment_generation,
    fencingGeneration: input.observation.fencing_generation,
    sequence: input.observation.sequence,
    operation: input.observation.operation,
  }),
  async run(input, ctx) {
    runnerObject(input, ["principal", "observation"]);
    const observation = launchWire<CheckoutLeaseObservation>(
      "checkout-lease-observation",
      input.observation,
    );
    const principal = await launchRunner(ctx, input.principal);
    const launch = (await ctx.db
      .prepare(
        `SELECT id FROM launch_commands WHERE workspace_id = ? AND execution_id = ? AND assignment_generation = ?`,
      )
      .get(ctx.workspaceId, observation.run_execution_id, observation.assignment_generation)) as
      { id: string } | undefined;
    if (!launch) rejectRunnerRequest();
    const row = await readLaunch(ctx.db, ctx.workspaceId, launch.id);
    if (
      row.runner_id !== principal.runnerId ||
      row.runner_key_thumbprint !== principal.keyThumbprint
    )
      rejectRunnerRequest();
    const lease = await readLease(ctx.db, row);
    assertLeaseBinding(lease, row, observation.fencing_generation);
    // Observations are short-lived request-bound facts, never offline heartbeat authority.
    const age = Date.parse(ctx.now) - Date.parse(observation.observed_at);
    if (
      age < -5_000 ||
      age > 30_000 ||
      observation.sequence <= lease.observation_sequence ||
      (lease.observed_at && Date.parse(observation.observed_at) < Date.parse(lease.observed_at))
    )
      rejectRunnerRequest();
    if (lease.state === "released") rejectRunnerRequest();
    const prior = lease.identity_json
      ? (JSON.parse(lease.identity_json) as LeaseIdentity)
      : undefined;
    const identity = identityOf(observation);
    const encodedIdentity = canonicalLaunchJson(identity);
    const finalIdentity = canonicalLaunchJson({
      ...(observation.supervisor ? { supervisor: observation.supervisor } : {}),
      local_lock_id: observation.local_lock_id,
    });
    const matchingFinal = row.final_identity_json === finalIdentity;
    const matchingPrior = !prior || encodedIdentity === canonicalLaunchJson(prior);
    const everStarted = Boolean(
      prior?.owned_group_id || observation.owned_group_id || row.state === "started",
    );
    const release = observation.operation === "release" || observation.operation === "recover";
    const explicitRecovery = observation.operation === "recover" && observation.recovery_local;
    let unknown:
      | "escaped_descendant"
      | "identity_ambiguous"
      | "evidence_missing"
      | "recovery_incomplete"
      | undefined;
    if (observation.descendants_state === "escaped") unknown = "escaped_descendant";
    else if (
      observation.supervisor_state === "ambiguous" ||
      !matchingPrior ||
      (row.final_identity_json && !matchingFinal)
    )
      unknown = "identity_ambiguous";
    else if (release) {
      if (
        !verifiedGone(observation, everStarted) ||
        (lease.state === "containment_unknown" && !explicitRecovery) ||
        (observation.operation === "recover" && !observation.recovery_local) ||
        (everStarted && !matchingFinal)
      )
        unknown = "recovery_incomplete";
    } else if (
      observation.operation !== "renew" ||
      !matchingFinal ||
      !verifiedLive(observation) ||
      observation.recovery_local
    )
      unknown = "evidence_missing";

    // A good heartbeat cannot erase an earlier escape/ambiguity marker.
    if (lease.state === "containment_unknown" && !explicitRecovery)
      unknown ??= lease.containment_reason ?? "evidence_missing";
    const state = unknown ? "containment_unknown" : release ? "released" : "live";
    const expires = state === "live" ? launchDeadline(ctx.now, LEASE_TTL_MS) : lease.expires_at;
    await guardLaunchMutation(
      ctx,
      `EXISTS (SELECT 1 FROM checkout_leases WHERE runner_id = ? AND physical_worktree_hash = ? AND execution_id = ? AND fencing_generation = ? AND observation_sequence = ? AND state != 'released')`,
      [
        row.runner_id,
        row.physical_worktree_hash,
        row.execution_id,
        observation.fencing_generation,
        lease.observation_sequence,
      ],
    );
    await ctx.db
      .prepare(
        `UPDATE checkout_leases SET state = ?, expires_at = ?, observation_sequence = ?, observed_at = ?,
      identity_json = ?, containment_reason = ?, released_at = ? WHERE runner_id = ? AND physical_worktree_hash = ?`,
      )
      .run(
        state,
        expires,
        observation.sequence,
        observation.observed_at,
        // Preserve the established process identity when a new claim is ambiguous.
        lease.identity_json ?? (matchingFinal ? encodedIdentity : null),
        unknown ?? null,
        state === "released" ? ctx.now : null,
        row.runner_id,
        row.physical_worktree_hash,
      );
    if (state === "live" && row.state === "claimed") {
      await ctx.db
        .prepare(`UPDATE launch_commands SET state = 'started' WHERE workspace_id = ? AND id = ?`)
        .run(ctx.workspaceId, row.id);
      await ctx.db
        .prepare(
          `UPDATE run_executions SET state = 'attached', resource_version = resource_version + 1 WHERE workspace_id = ? AND id = ? AND state = 'launching'`,
        )
        .run(ctx.workspaceId, row.execution_id);
      await resolveRunnerCommandReference(ctx, row.runner_id, row.id);
    }
    if (state === "released") {
      // Completion is not inferred: this changes only the execution's process fact.
      await ctx.db
        .prepare(
          `UPDATE run_executions SET state = 'ended', end_reason = ?, ended_at = ?, resource_version = resource_version + 1
        WHERE workspace_id = ? AND id = ? AND state != 'ended'`,
        )
        .run(
          row.cancelled_at ? "terminated" : everStarted ? "process_exit" : "launch_blocked",
          ctx.now,
          ctx.workspaceId,
          row.execution_id,
        );
      if (row.state === "claimed" || row.state === "pending") {
        await ctx.db
          .prepare(
            `UPDATE launch_commands SET state = 'rejected', end_reason = 'launch_blocked' WHERE workspace_id = ? AND id = ?`,
          )
          .run(ctx.workspaceId, row.id);
        await ctx.db
          .prepare(
            `UPDATE tasks SET state = 'ready', resource_version = resource_version + 1 WHERE workspace_id = ? AND id = ? AND state = 'active'
          AND NOT EXISTS (SELECT 1 FROM run_executions AS execution JOIN runs AS run ON run.workspace_id = execution.workspace_id AND run.id = execution.run_id
          WHERE run.workspace_id = tasks.workspace_id AND run.task_id = tasks.id AND run.purpose = 'work' AND execution.state != 'ended')`,
          )
          .run(ctx.workspaceId, row.task_id);
      }
      await resolveRunnerCommandReference(ctx, row.runner_id, row.id);
    }
    return {
      state,
      fencing_generation: lease.fencing_generation,
      observation_sequence: observation.sequence,
      expires_at: expires,
    };
  },
};
