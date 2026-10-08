// ABOUTME: Checks current canonical run/session authority for agent artifact publication and upload consumption.
// ABOUTME: Repeats the exact read-only authority witness in the direct-D1 committing batch.

import type { SqlDatabase } from "@bfb/db";
import type { AgentSessionReference, AgentWorkRequest } from "@bfb/protocol";
import { agentTaskAccess, liveRun } from "./agent-work.js";
import { currentAgentSession } from "./agent-sessions.js";
import { DomainError, type HubContext } from "./hub.js";
import { readLaunch, reauthorizeActiveRun } from "./launch-state.js";
import type { RunnerPrincipal } from "./runners.js";
import { taskAccessPredicate } from "./task-access.js";

export async function requireAgentArtifactRun(
  ctx: HubContext,
  principal: RunnerPrincipal,
  reference: AgentWorkRequest,
  binding: AgentSessionReference,
) {
  const row = await liveRun({ principal, request: reference }, ctx, "contribute");
  const latest = (await ctx.db
    .prepare(
      `SELECT execution_id,assignment_generation FROM execution_assignments
    WHERE workspace_id=? AND run_id=? ORDER BY assignment_generation DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, row.run_id)) as
    { execution_id: string; assignment_generation: number } | undefined;
  if (
    !latest ||
    latest.execution_id !== row.execution_id ||
    latest.assignment_generation !== row.assignment_generation
  )
    throw new DomainError("assignment_ended", "artifact assignment superseded");
  await currentAgentSession(ctx, row, binding);
  try {
    await reauthorizeActiveRun(ctx, await readLaunch(ctx.db, ctx.workspaceId, row.launch_id));
  } catch (error) {
    if (
      error instanceof DomainError &&
      ["request_rejected", "policy_widening", "invalid_policy"].includes(error.code)
    )
      throw new DomainError("policy_rejected", "current artifact policy rejected");
    throw error;
  }
  return row;
}

// This fixed, server-owned projection covers every mutable source read by the
// shared current-run checker. It is never persisted or accepted from a caller.
// Reads on either side of authorization must agree, then the same projection
// must still agree inside the consumption batch (including direct token changes).
const authoritySql = `SELECT json_array(
  json_array(a.run_id,a.task_id,a.project_id,a.runner_id,a.requesting_human_id,a.requesting_human_epoch,
    a.runner_authorization_epoch,a.runner_grant_epoch,a.runner_key_thumbprint,a.checkout_id,a.physical_worktree_hash,
    (SELECT MAX(assignment_generation) FROM execution_assignments WHERE workspace_id=a.workspace_id AND run_id=a.run_id)),
  json_array(execution.state,run.result_state,run.purpose,run.project_id,run.task_id),
  json_array(launch.state,launch.final_authorized_at,launch.resume_session_id,launch.resume_observed_session_id,snapshot.canonical_json,snapshot.content_hash),
  json_array(runner.owner_human_id,runner.key_thumbprint,runner.authorization_epoch,runner.grant_epoch,runner.token_epoch,runner.revoked_at),
  json_array(token.claims_json,token.expires_at,token.revoked_at),
  json_array(owner.role,owner.authorization_epoch,owner_epoch.authorization_epoch,owner_epoch.revoked_at),
  json_array(requester.role,requester.authorization_epoch,requester_epoch.authorization_epoch,requester_epoch.revoked_at),
  json_array(project.access_mode,project.repository_host,project.repository_subpath,
    EXISTS(SELECT 1 FROM project_access WHERE workspace_id=a.workspace_id AND project_id=a.project_id AND human_id=runner.owner_human_id),
    EXISTS(SELECT 1 FROM project_access WHERE workspace_id=a.workspace_id AND project_id=a.project_id AND human_id=a.requesting_human_id),
    EXISTS(SELECT 1 FROM runner_project_grants WHERE workspace_id=a.workspace_id AND project_id=a.project_id AND runner_id=a.runner_id),
    EXISTS(SELECT 1 FROM runner_launch_grants WHERE workspace_id=a.workspace_id AND runner_id=a.runner_id AND human_id=a.requesting_human_id AND revoked_at IS NULL)),
  json_array(workspace_policy.allowed_providers_json,workspace_policy.allow_agent_root_propose,workspace_policy.allow_pass_to_agent,workspace_policy.allow_run_overrides,workspace_policy.resource_version),
  json_array(project_policy.allowed_providers_json,project_policy.allow_agent_root_propose,project_policy.allow_pass_to_agent,project_policy.allow_run_overrides,project_policy.resource_version),
  json_array(repository.allowed_providers_json,repository.allow_agent_root_propose,repository.allow_pass_to_agent,repository.allow_run_overrides,repository.resource_version,repository.content_hash),
  json_array(profile.provider,profile.model,profile.execution_mode,profile.harness_mode,profile.permission_mode,profile.resource_version),
  json_array(inventory.inventory_json,inventory.received_at),
  json_array(binding.run_id,binding.runner_id,binding.project_id,binding.source_task_id,binding.provider_session_id,binding.provider,binding.observed_session_id,
    session.run_id,session.provider,session.observed_session_id,session.state),
  json_array(lease.workspace_id,lease.execution_id,lease.assignment_generation,lease.runner_id,lease.state,lease.expires_at,lease.fencing_generation)
) AS witness
FROM execution_assignments a
JOIN run_executions execution ON execution.workspace_id=a.workspace_id AND execution.id=a.execution_id
JOIN runs run ON run.workspace_id=a.workspace_id AND run.id=a.run_id
JOIN tasks artifact_task ON artifact_task.workspace_id=run.workspace_id AND artifact_task.id=run.task_id
  AND artifact_task.project_id=run.project_id AND run.task_id=a.task_id AND run.project_id=a.project_id
JOIN launch_commands launch ON launch.workspace_id=a.workspace_id AND launch.execution_id=a.execution_id
JOIN run_configuration_snapshots snapshot ON snapshot.workspace_id=launch.workspace_id AND snapshot.id=launch.snapshot_id
JOIN runners runner ON runner.workspace_id=a.workspace_id AND runner.id=a.runner_id
JOIN runner_tokens token ON token.workspace_id=a.workspace_id AND token.runner_id=a.runner_id AND token.id=?
JOIN workspace_members owner ON owner.workspace_id=a.workspace_id AND owner.human_id=runner.owner_human_id
JOIN workspace_authorization_epochs owner_epoch ON owner_epoch.workspace_id=owner.workspace_id AND owner_epoch.human_id=owner.human_id
JOIN workspace_members requester ON requester.workspace_id=a.workspace_id AND requester.human_id=a.requesting_human_id
JOIN workspace_authorization_epochs requester_epoch ON requester_epoch.workspace_id=requester.workspace_id AND requester_epoch.human_id=requester.human_id
JOIN projects project ON project.workspace_id=a.workspace_id AND project.id=a.project_id
JOIN workspace_policies workspace_policy ON workspace_policy.workspace_id=a.workspace_id
JOIN project_policies project_policy ON project_policy.workspace_id=a.workspace_id AND project_policy.project_id=a.project_id
JOIN repository_configs repository ON repository.workspace_id=a.workspace_id AND repository.project_id=a.project_id
JOIN agent_profiles profile ON profile.workspace_id=a.workspace_id AND profile.id=json_extract(snapshot.canonical_json,'$.agent_profile_id')
JOIN runner_inventories inventory ON inventory.workspace_id=a.workspace_id AND inventory.runner_id=a.runner_id
JOIN execution_session_bindings binding ON binding.workspace_id=a.workspace_id AND binding.execution_id=a.execution_id AND binding.assignment_generation=a.assignment_generation
JOIN provider_sessions session ON session.workspace_id=binding.workspace_id AND session.id=binding.provider_session_id
JOIN checkout_leases lease ON lease.runner_id=a.runner_id AND lease.physical_worktree_hash=a.physical_worktree_hash
WHERE a.workspace_id=? AND a.execution_id=? AND a.assignment_generation=?`;

export interface ArtifactAuthorityWitness {
  predicate: string;
  params: unknown[];
}
export async function prepareAgentArtifactAuthority(
  ctx: HubContext,
  principal: RunnerPrincipal,
  reference: AgentWorkRequest,
  binding: AgentSessionReference,
) {
  const authenticated = await liveRun({ principal, request: reference }, ctx, "contribute");
  const parent = taskAccessPredicate(agentTaskAccess(authenticated), "contribute", "artifact_task");
  const currentAuthoritySql = `${authoritySql} AND ${parent.sql}
    AND lease.expires_at > ? AND token.expires_at > ?`;
  const params = [
    principal.tokenId,
    ctx.workspaceId,
    reference.run_execution_id,
    reference.assignment_generation,
    ...parent.parameters,
    ctx.now,
    ctx.now,
  ];
  const read = async () =>
    ((await ctx.db.prepare(currentAuthoritySql).get(...params)) as { witness: string } | undefined)
      ?.witness;
  const before = await read();
  const row = await requireAgentArtifactRun(ctx, principal, reference, binding);
  const after = await read();
  if (!before || before !== after)
    throw new DomainError("revoked", "artifact authority changed during validation");
  return {
    row,
    witness: {
      predicate: `(${currentAuthoritySql}) = ?`,
      params: [...params, before],
    } satisfies ArtifactAuthorityWitness,
  };
}

/** Upload grants derive the original association, not public upload metadata. */
export async function prepareAgentArtifactGrantAuthority(
  db: SqlDatabase,
  workspaceId: string,
  operation: {
    execution_id: string;
    assignment_generation: number;
    run_id: string;
    provider_session_id: string;
    runner_id: string;
  },
  principal: RunnerPrincipal,
  now: string,
) {
  const binding = (await db
    .prepare(
      `SELECT provider_session_id,provider,observed_session_id FROM execution_session_bindings
    WHERE workspace_id=? AND execution_id=? AND assignment_generation=? AND run_id=? AND runner_id=? AND provider_session_id=?`,
    )
    .get(
      workspaceId,
      operation.execution_id,
      operation.assignment_generation,
      operation.run_id,
      operation.runner_id,
      operation.provider_session_id,
    )) as AgentSessionReference | undefined;
  if (!binding)
    throw new DomainError("session_not_bound", "artifact grant association unavailable");
  return prepareAgentArtifactAuthority(
    {
      db,
      workspaceId,
      now,
      actorRunnerId: principal.runnerId,
      authorizationEpoch: principal.authorizationEpoch,
      cursorBase: 0,
    },
    principal,
    {
      schema_version: 1,
      request_id: "artifact-upload-v1",
      run_execution_id: operation.execution_id,
      assignment_generation: operation.assignment_generation,
    },
    binding,
  );
}
