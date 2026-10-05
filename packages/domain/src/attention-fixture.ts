// ABOUTME: Prepares synthetic attention fixtures through final launch, lease and session commands.
// ABOUTME: Shares real domain transitions without claiming native ownership or possession proof.

import {
  decodeWireDocument,
  type AgentBoundRequest,
  type AgentSessionBindResult,
  type LaunchClaimResult,
  type LaunchFinalRequest,
} from "@bfb/protocol";

import { randomUlid } from "./ids.js";
import type { RunnerPrincipal } from "./runners.js";

/** Synthetic fixtures only; execute must throw for every non-successful command outcome. */
export async function prepareSyntheticAttentionClaim(
  execute: (name: string, input: unknown) => Promise<unknown>,
  principal: RunnerPrincipal,
  claim: LaunchClaimResult,
  now: string,
): Promise<AgentBoundRequest> {
  const spec = claim.specification;
  const final: LaunchFinalRequest = {
    schema_version: 1,
    launch_id: spec.launch_id,
    run_execution_id: spec.run_execution_id,
    assignment_generation: spec.assignment_generation,
    fencing_generation: claim.fencing_generation,
    config_snapshot_id: spec.config_snapshot_id,
    config_snapshot_hash: spec.config_snapshot_hash,
    repository_config_hash: claim.snapshot.repository_config_hash,
    physical_worktree_hash: claim.snapshot.physical_worktree_hash,
    supervisor: {
      pid: 1234,
      start_identity: "123456:1000",
      executable_hash: `sha256:${"a".repeat(64)}`,
    },
    local_lock_id: randomUlid(),
  };
  const authorized = (await execute("launch.authorize", {
    principal,
    authorization: final,
  })) as { decision?: string };
  if (authorized.decision !== "authorized") {
    throw new Error("synthetic attention launch was not authorized");
  }
  await execute("checkout.lease.observe", {
    principal,
    observation: {
      schema_version: 1,
      run_execution_id: spec.run_execution_id,
      assignment_generation: spec.assignment_generation,
      fencing_generation: claim.fencing_generation,
      sequence: 1,
      observed_at: now,
      operation: "renew",
      supervisor: final.supervisor,
      local_lock_id: final.local_lock_id,
      owned_group_id: 1235,
      owned_group_start_identity: "123456:2000",
      supervisor_state: "verified",
      group_state: "live",
      lock_state: "held",
      descendants_state: "contained",
      recovery_local: false,
    },
  });
  const reference = {
    schema_version: 1 as const,
    run_execution_id: spec.run_execution_id,
    assignment_generation: spec.assignment_generation,
    request_id: randomUlid(),
  };
  const result = await execute("agent_run.session_bind", {
    principal,
    request: {
      reference,
      observation: {
        provider: spec.execution_config.provider,
        observed_session_id: `synthetic-attention-${spec.run_execution_id}`,
        observed_at: now,
      },
    },
  });
  if (!decodeWireDocument("agent-session-bind-result", Buffer.from(JSON.stringify(result))).ok) {
    throw new Error("synthetic attention session was not confirmed");
  }
  return { reference, binding: (result as AgentSessionBindResult).binding };
}
