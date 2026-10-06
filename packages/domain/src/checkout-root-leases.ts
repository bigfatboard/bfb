// ABOUTME: Renews root-supervised checkout occupancy without claiming complete descendant coverage.
// ABOUTME: Pins root scope and immutable provider identity while preserving uncertainty until explicit recovery exists.

import type { CheckoutRootLeaseObservation, LaunchSnapshot } from "@bfb/protocol";

import { DomainError, type HubCommand } from "./hub.js";
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
  reauthorizeActiveRun,
  snapshotOf,
} from "./launch-state.js";
import { resolveRunnerCommandReference } from "./runner-channel.js";
import { rejectRunnerRequest, runnerObject } from "./runner-crypto.js";
import type { RunnerPrincipal } from "./runners.js";

interface RootLeaseIdentity {
  supervisor?: CheckoutRootLeaseObservation["supervisor"];
  local_lock_id: string;
  owned_group_id: number;
  owned_group_start_identity: string;
  supervision_mode: "root";
  family_coverage: "unproven";
  provider_manifest_id: LaunchSnapshot["provider_manifest_id"];
  provider_version: LaunchSnapshot["provider_version"];
}

function identityOf(
  observation: CheckoutRootLeaseObservation,
  snapshot: LaunchSnapshot,
): RootLeaseIdentity {
  return {
    ...(observation.supervisor ? { supervisor: observation.supervisor } : {}),
    local_lock_id: observation.local_lock_id,
    owned_group_id: observation.owned_group_id,
    owned_group_start_identity: observation.owned_group_start_identity,
    supervision_mode: "root",
    family_coverage: "unproven",
    provider_manifest_id: snapshot.provider_manifest_id,
    provider_version: snapshot.provider_version,
  };
}

function verifiedLiveRoot(observation: CheckoutRootLeaseObservation): boolean {
  return (
    observation.supervisor !== undefined &&
    observation.supervisor_state === "verified" &&
    observation.group_state === "live" &&
    observation.owned_group_id > 0 &&
    observation.owned_group_start_identity !== "" &&
    observation.lock_state === "held"
  );
}

export const observeCheckoutRootLeaseCommand: HubCommand<
  { principal: RunnerPrincipal; observation: CheckoutRootLeaseObservation },
  {
    state: "live" | "containment_unknown";
    fencing_generation: number;
    observation_sequence: number;
    expires_at: string;
    supervision_mode: "root";
    family_coverage: "unproven";
  }
> = {
  name: "checkout.root-lease.observe",
  replay: "reject",
  auditInput: (input) => ({
    runnerId: input.principal.runnerId,
    executionId: input.observation.run_execution_id,
    assignmentGeneration: input.observation.assignment_generation,
    fencingGeneration: input.observation.fencing_generation,
    sequence: input.observation.sequence,
    operation: input.observation.operation,
    supervisionMode: "root",
    familyCoverage: "unproven",
  }),
  async run(input, ctx) {
    runnerObject(input, ["principal", "observation"]);
    const observation = launchWire<CheckoutRootLeaseObservation>(
      "checkout-root-lease-observation",
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
    const snapshot = snapshotOf(row);
    if (
      snapshot.execution_config.provider !== "claude" ||
      snapshot.execution_config.mode !== "interactive"
    )
      rejectRunnerRequest();
    const lease = await readLease(ctx.db, row);
    assertLeaseBinding(lease, row, observation.fencing_generation);
    const age = Date.parse(ctx.now) - Date.parse(observation.observed_at);
    if (
      age < -5_000 ||
      age > 30_000 ||
      observation.sequence <= lease.observation_sequence ||
      (lease.observed_at && Date.parse(observation.observed_at) < Date.parse(lease.observed_at)) ||
      lease.state === "released"
    )
      rejectRunnerRequest();

    // Only a new reservation may choose root scope; strict and earlier unknown leases cannot upgrade.
    const prior = lease.identity_json
      ? (JSON.parse(lease.identity_json) as Partial<RootLeaseIdentity>)
      : undefined;
    if (
      prior
        ? prior.supervision_mode !== "root" || prior.family_coverage !== "unproven"
        : lease.state !== "reserved" || lease.observation_sequence !== 0
    )
      rejectRunnerRequest();
    const encodedIdentity = canonicalLaunchJson(identityOf(observation, snapshot));
    const matchingPrior = !prior || encodedIdentity === canonicalLaunchJson(prior);
    const matchingFinal =
      row.final_identity_json ===
      canonicalLaunchJson({
        ...(observation.supervisor ? { supervisor: observation.supervisor } : {}),
        local_lock_id: observation.local_lock_id,
      });
    let unknown: "identity_ambiguous" | "evidence_missing" | undefined;
    if (
      observation.supervisor_state === "ambiguous" ||
      !matchingPrior ||
      (row.final_identity_json && !matchingFinal)
    )
      unknown = "identity_ambiguous";
    else if (
      observation.operation !== "renew" ||
      !matchingFinal ||
      !row.final_authorized_at ||
      !verifiedLiveRoot(observation) ||
      row.cancelled_at ||
      row.execution_state === "ended" ||
      (row.state !== "claimed" && row.state !== "started")
    )
      unknown = "evidence_missing";
    else {
      // Occupancy evidence may survive revoked policy; live authority may not.
      try {
        await reauthorizeActiveRun(ctx, row);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        unknown = "evidence_missing";
      }
    }
    if (lease.state === "containment_unknown")
      unknown ??=
        lease.containment_reason === "identity_ambiguous"
          ? "identity_ambiguous"
          : "evidence_missing";
    const state = unknown ? "containment_unknown" : "live";
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
      identity_json = ?, containment_reason = ?, released_at = NULL WHERE runner_id = ? AND physical_worktree_hash = ?`,
      )
      .run(
        state,
        expires,
        observation.sequence,
        observation.observed_at,
        lease.identity_json ?? encodedIdentity,
        unknown ?? null,
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
    // Root loss is uncertainty, not a process-exit fact or permission to release the checkout.
    return {
      state,
      fencing_generation: lease.fencing_generation,
      observation_sequence: observation.sequence,
      expires_at: expires,
      supervision_mode: "root",
      family_coverage: "unproven",
    };
  },
};
