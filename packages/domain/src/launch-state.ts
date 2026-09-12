// ABOUTME: Loads launch bindings and validates current human, runner, policy and checkout authority.
// ABOUTME: Shared launch helpers prepare all reads before the WorkspaceHub stages an atomic D1 batch.

import type { SqlDatabase } from "@bfb/db";
import {
  decodeWireDocument,
  type CheckoutSummary,
  type LaunchSnapshot,
  type LaunchStartRequest,
  type RunnerInventory,
  type WireDocumentName,
} from "@bfb/protocol";

import { assertEpoch, assertRole, loadPrincipal, type AuthzPrincipal } from "./authorization.js";
import { DomainError, type HubContext } from "./hub.js";
import { randomUlid } from "./ids.js";
import { assertPolicyTightens, type PolicySettings } from "./projects.js";
import { resolveRunnerCommandReference } from "./runner-channel.js";
import { rejectRunnerRequest, runnerHash } from "./runner-crypto.js";
import {
  assertCurrentRunnerPrincipal,
  assertRunnerLaunchAuthority,
  type RunnerPrincipal,
} from "./runners.js";
import type { CreateRunInput } from "./work-records.js";

export const LAUNCH_TTL_MS = 120_000;
export const LEASE_TTL_MS = 45_000;
export const LAUNCH_BODY_LIMIT = 16_384;

export type LaunchState = "pending" | "claimed" | "started" | "rejected" | "expired";
export type LaunchEndReason = "launch_blocked" | "launch_expired" | "terminated";

export interface AssignmentRow {
  workspace_id: string;
  execution_id: string;
  assignment_generation: number;
  run_id: string;
  task_id: string;
  project_id: string;
  runner_id: string;
  checkout_id: string;
  physical_worktree_hash: string;
  requesting_human_id: string;
  requesting_human_epoch: number;
  runner_authorization_epoch: number;
  runner_grant_epoch: number;
  runner_key_thumbprint: string;
  created_at: string;
}

export interface LaunchRow extends AssignmentRow {
  id: string;
  idempotency_key_hash: string;
  request_hash: string;
  state: LaunchState;
  snapshot_id: string;
  expires_at: string;
  claim_key_hash: string | null;
  final_authorized_at: string | null;
  final_identity_json: string | null;
  cancelled_at: string | null;
  end_reason: LaunchEndReason | null;
  snapshot_hash: string;
  canonical_json: string;
  execution_state: string;
  result_state: string;
  resume_session_id: string | null;
  resume_observed_session_id: string | null;
}

export interface LeaseRow {
  workspace_id: string;
  runner_id: string;
  physical_worktree_hash: string;
  execution_id: string;
  assignment_generation: number;
  fencing_generation: number;
  state: "reserved" | "live" | "containment_unknown" | "released";
  expires_at: string;
  observation_sequence: number;
  observed_at: string | null;
  identity_json: string | null;
  containment_reason:
    "escaped_descendant" | "identity_ambiguous" | "evidence_missing" | "recovery_incomplete" | null;
  released_at: string | null;
}

export function canonicalLaunchJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalLaunchJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalLaunchJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function launchHash(value: unknown): string {
  return runnerHash(canonicalLaunchJson(value));
}
export function launchDeadline(now: string, ms = LAUNCH_TTL_MS): string {
  return new Date(Date.parse(now) + ms).toISOString();
}

export function launchWire<T>(name: WireDocumentName, value: unknown): T {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > LAUNCH_BODY_LIMIT) rejectRunnerRequest();
  const decoded = decodeWireDocument(name, Buffer.from(bytes));
  if (!decoded.ok) rejectRunnerRequest();
  return decoded.value as T;
}

export async function launchHuman(ctx: HubContext): Promise<AuthzPrincipal> {
  if (!ctx.actorHumanId || ctx.actorDelegationId || ctx.actorRunnerId || ctx.actorSystemId)
    rejectRunnerRequest();
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertEpoch(principal, ctx.authorizationEpoch);
  assertRole(principal, ["owner", "member"]);
  return principal;
}

export async function launchRunner(
  ctx: HubContext,
  principal: RunnerPrincipal,
): Promise<RunnerPrincipal> {
  if (
    ctx.actorRunnerId !== principal.runnerId ||
    ctx.workspaceId !== principal.workspaceId ||
    ctx.authorizationEpoch !== principal.authorizationEpoch ||
    ctx.actorHumanId ||
    ctx.actorDelegationId ||
    ctx.actorSystemId
  )
    rejectRunnerRequest();
  return assertCurrentRunnerPrincipal(ctx.db, principal, ctx.now);
}

export async function readLaunch(
  db: SqlDatabase,
  workspace: string,
  id: string,
): Promise<LaunchRow> {
  const row = (await db
    .prepare(
      `SELECT assignment.*, launch.id, launch.idempotency_key_hash,
    launch.request_hash, launch.state, launch.snapshot_id, launch.expires_at, launch.claim_key_hash,
    launch.final_authorized_at, launch.final_identity_json, launch.cancelled_at, launch.end_reason,
    launch.resume_session_id, launch.resume_observed_session_id,
    snapshot.canonical_json, snapshot.content_hash AS snapshot_hash, execution.state AS execution_state,
    run.result_state
    FROM launch_commands AS launch
    JOIN execution_assignments AS assignment ON assignment.workspace_id = launch.workspace_id AND assignment.execution_id = launch.execution_id
    JOIN run_configuration_snapshots AS snapshot ON snapshot.workspace_id = launch.workspace_id AND snapshot.id = launch.snapshot_id
    JOIN run_executions AS execution ON execution.workspace_id = launch.workspace_id AND execution.id = launch.execution_id
    JOIN runs AS run ON run.workspace_id = launch.workspace_id AND run.id = launch.run_id
    WHERE launch.workspace_id = ? AND launch.id = ?`,
    )
    .get(workspace, id)) as LaunchRow | undefined;
  if (!row) rejectRunnerRequest();
  return row;
}

export async function readLease(
  db: SqlDatabase,
  binding: Pick<AssignmentRow, "runner_id" | "physical_worktree_hash">,
): Promise<LeaseRow | undefined> {
  return (await db
    .prepare(`SELECT * FROM checkout_leases WHERE runner_id = ? AND physical_worktree_hash = ?`)
    .get(binding.runner_id, binding.physical_worktree_hash)) as LeaseRow | undefined;
}

export function assertLeaseBinding(
  lease: LeaseRow | undefined,
  assignment: AssignmentRow,
  fencing?: number,
): asserts lease is LeaseRow {
  if (
    !lease ||
    lease.workspace_id !== assignment.workspace_id ||
    lease.execution_id !== assignment.execution_id ||
    lease.assignment_generation !== assignment.assignment_generation ||
    lease.runner_id !== assignment.runner_id ||
    (fencing !== undefined && lease.fencing_generation !== fencing)
  )
    rejectRunnerRequest();
}

export function launchSummary(
  row: Pick<
    LaunchRow,
    | "id"
    | "run_id"
    | "execution_id"
    | "assignment_generation"
    | "runner_id"
    | "checkout_id"
    | "state"
    | "expires_at"
  >,
) {
  return {
    launch_id: row.id,
    run_id: row.run_id,
    run_execution_id: row.execution_id,
    assignment_generation: row.assignment_generation,
    runner_id: row.runner_id,
    checkout_id: row.checkout_id,
    state: row.state,
    expires_at: row.expires_at,
  };
}

export function snapshotOf(row: LaunchRow): LaunchSnapshot {
  const snapshot = launchWire<LaunchSnapshot>("launch-snapshot", JSON.parse(row.canonical_json));
  if (
    `sha256:${launchHash(snapshot)}` !== row.snapshot_hash ||
    snapshot.workspace_id !== row.workspace_id ||
    snapshot.project_id !== row.project_id ||
    snapshot.task_id !== row.task_id ||
    snapshot.physical_worktree_hash !== row.physical_worktree_hash
  )
    rejectRunnerRequest();
  return snapshot;
}

export function createRunInput(input: LaunchStartRequest): CreateRunInput {
  return {
    taskId: input.task_id,
    expectedTaskVersion: input.expected_task_version,
    agentProfileId: input.agent_profile_id,
    agentProfileVersion: input.agent_profile_version,
    workspacePolicyVersion: input.workspace_policy_version,
    projectPolicyVersion: input.project_policy_version,
    repositoryConfigVersion: input.repository_config_version,
  };
}

type PolicyRow = {
  allowed_providers_json: string;
  allow_agent_root_propose: number;
  allow_pass_to_agent: number;
  allow_run_overrides: number;
  resource_version: number;
};
type Policy = LaunchSnapshot["workspace_policy"];

function policy(row: PolicyRow): Policy {
  return {
    allowed_providers: JSON.parse(row.allowed_providers_json),
    allow_agent_root_propose: row.allow_agent_root_propose === 1,
    allow_pass_to_agent: row.allow_pass_to_agent === 1,
    allow_run_overrides: row.allow_run_overrides === 1,
  };
}

export function policySettings(value: Policy): PolicySettings {
  return {
    allowedProviders: value.allowed_providers,
    allowAgentRootPropose: value.allow_agent_root_propose,
    allowPassToAgent: value.allow_pass_to_agent,
    allowRunOverrides: value.allow_run_overrides,
  };
}

export async function readLaunchEnvironment(
  ctx: HubContext,
  input: {
    runnerId: string;
    checkoutId: string;
    projectId: string;
    profileId: string;
    taskId: string;
  },
  fresh: boolean,
) {
  const runner = (await ctx.db
    .prepare(
      `SELECT authorization_epoch, grant_epoch, key_thumbprint, revoked_at FROM runners WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, input.runnerId)) as
    | {
        authorization_epoch: number;
        grant_epoch: number;
        key_thumbprint: string;
        revoked_at: string | null;
      }
    | undefined;
  const inventoryRow = (await ctx.db
    .prepare(
      `SELECT inventory_json, received_at FROM runner_inventories WHERE workspace_id = ? AND runner_id = ?`,
    )
    .get(ctx.workspaceId, input.runnerId)) as
    { inventory_json: string; received_at: string } | undefined;
  if (
    !runner ||
    runner.revoked_at ||
    !inventoryRow ||
    (fresh && Date.parse(ctx.now) - Date.parse(inventoryRow.received_at) > 30_000)
  )
    rejectRunnerRequest();
  const decoded = decodeWireDocument("runner-inventory", Buffer.from(inventoryRow.inventory_json));
  if (!decoded.ok) rejectRunnerRequest();
  const inventory = decoded.value as RunnerInventory;
  const checkout = inventory.checkouts.find((item) => item.checkout_id === input.checkoutId);
  const project = (await ctx.db
    .prepare(
      `SELECT repository_host, repository_subpath FROM projects WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, input.projectId)) as
    { repository_host: string; repository_subpath: string } | undefined;
  if (
    !project ||
    !checkout ||
    checkout.workspace_id !== ctx.workspaceId ||
    checkout.runner_id !== input.runnerId ||
    checkout.project_id !== input.projectId ||
    checkout.status !== "validated" ||
    checkout.block_reason ||
    checkout.workspace_subpath !== project.repository_subpath ||
    checkout.repository_identity.split("/")[0] !== project.repository_host
  )
    rejectRunnerRequest();
  const workspacePolicy = (await ctx.db
    .prepare(`SELECT * FROM workspace_policies WHERE workspace_id = ?`)
    .get(ctx.workspaceId)) as PolicyRow;
  const projectPolicy = (await ctx.db
    .prepare(`SELECT * FROM project_policies WHERE workspace_id = ? AND project_id = ?`)
    .get(ctx.workspaceId, input.projectId)) as PolicyRow;
  const repository = (await ctx.db
    .prepare(`SELECT * FROM repository_configs WHERE workspace_id = ? AND project_id = ?`)
    .get(ctx.workspaceId, input.projectId)) as PolicyRow & { content_hash: string };
  const profile = (await ctx.db
    .prepare(
      `SELECT provider, model, execution_mode, harness_mode, resource_version FROM agent_profiles WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, input.profileId)) as
    | {
        provider: LaunchSnapshot["execution_config"]["provider"];
        model: string | null;
        execution_mode: "interactive" | "headless";
        harness_mode: "restricted" | "standard";
        resource_version: number;
      }
    | undefined;
  if (!workspacePolicy || !projectPolicy || !repository || !profile || !profile.model)
    rejectRunnerRequest();
  const provider = inventory.providers.find((item) => item.provider === profile.provider);
  if (
    !provider ||
    provider.status !== "healthy" ||
    (fresh && Date.parse(provider.expires_at) <= Date.parse(ctx.now))
  )
    rejectRunnerRequest();
  const workspace = policy(workspacePolicy),
    projectCeiling = policy(projectPolicy),
    repositoryCeiling = policy(repository);
  assertPolicyTightens(policySettings(workspace), policySettings(projectCeiling));
  assertPolicyTightens(policySettings(projectCeiling), policySettings(repositoryCeiling));
  if (
    !repositoryCeiling.allow_pass_to_agent ||
    !repositoryCeiling.allowed_providers.includes(profile.provider)
  )
    rejectRunnerRequest();
  const config: LaunchSnapshot["execution_config"] = {
    provider: profile.provider,
    model: profile.model,
    mode: profile.execution_mode,
    effort: "high",
    approval_policy: profile.harness_mode === "restricted" ? "never" : "on_request",
    filesystem_policy: profile.harness_mode === "restricted" ? "read_only" : "workspace_write",
    context_injection: "session_start_additional_context",
    initial_turn_transport: "provider_prompt",
    required_capabilities: [],
  };
  config.required_capabilities = [
    `launch.${config.mode}`,
    `filesystem.${config.filesystem_policy}`,
    `approval.${config.approval_policy}`,
    "context.session_start",
    "prompt.initial_constant",
    "hooks.session_start",
    "mcp.stdio",
  ].sort();
  if (
    config.required_capabilities.some(
      (capability) =>
        !provider.capabilities.includes(capability as (typeof provider.capabilities)[number]),
    )
  )
    rejectRunnerRequest();
  const snapshot = launchWire<LaunchSnapshot>("launch-snapshot", {
    schema_version: 1,
    workspace_id: ctx.workspaceId,
    project_id: input.projectId,
    task_id: input.taskId,
    agent_profile_id: input.profileId,
    workspace_policy_version: workspacePolicy.resource_version,
    project_policy_version: projectPolicy.resource_version,
    repository_config_version: repository.resource_version,
    agent_profile_version: profile.resource_version,
    snapshot_generation: 1,
    physical_worktree_hash: checkout.physical_worktree_hash,
    repository_config_hash: repository.content_hash,
    repository_identity_hash: `sha256:${runnerHash(checkout.repository_identity)}`,
    provider_manifest_id: provider.manifest_id,
    provider_version: provider.version,
    workspace_policy: workspace,
    project_policy: projectCeiling,
    repository_policy: repositoryCeiling,
    execution_config: config,
  });
  return { runner, checkout, snapshot, capabilities: provider.capabilities };
}

export async function reauthorizeLaunch(
  ctx: HubContext,
  row: LaunchRow,
  fresh = true,
  replacementRepositoryHash?: string,
): Promise<{ checkout: CheckoutSummary; snapshot: LaunchSnapshot }> {
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, row.requesting_human_id);
  assertEpoch(principal, row.requesting_human_epoch);
  await assertRunnerLaunchAuthority(ctx.db, principal, row.runner_id, row.project_id);
  const snapshot = snapshotOf(row);
  const environment = await readLaunchEnvironment(
    ctx,
    {
      runnerId: row.runner_id,
      checkoutId: row.checkout_id,
      projectId: row.project_id,
      profileId: snapshot.agent_profile_id,
      taskId: row.task_id,
    },
    fresh,
  );
  if (
    environment.runner.authorization_epoch !== row.runner_authorization_epoch ||
    environment.runner.grant_epoch !== row.runner_grant_epoch ||
    environment.runner.key_thumbprint !== row.runner_key_thumbprint ||
    environment.checkout.physical_worktree_hash !== row.physical_worktree_hash ||
    environment.checkout.repository_config_hash !==
      (replacementRepositoryHash ?? snapshot.repository_config_hash) ||
    environment.snapshot.workspace_policy_version !== snapshot.workspace_policy_version ||
    environment.snapshot.project_policy_version !== snapshot.project_policy_version ||
    environment.snapshot.repository_config_version !== snapshot.repository_config_version ||
    environment.snapshot.agent_profile_version !== snapshot.agent_profile_version ||
    environment.snapshot.repository_identity_hash !== snapshot.repository_identity_hash ||
    environment.snapshot.provider_manifest_id !== snapshot.provider_manifest_id ||
    environment.snapshot.provider_version !== snapshot.provider_version ||
    (row.result_state !== "open" && row.result_state !== "changes_requested")
  )
    rejectRunnerRequest();
  assertPolicyTightens(
    policySettings(environment.snapshot.repository_policy),
    policySettings(snapshot.repository_policy),
  );
  if (
    !snapshot.repository_policy.allow_pass_to_agent ||
    !snapshot.repository_policy.allowed_providers.includes(snapshot.execution_config.provider)
  )
    rejectRunnerRequest();
  if (row.resume_session_id) {
    if (!environment.capabilities.includes("session.resume")) rejectRunnerRequest();
    const session = (await ctx.db
      .prepare(
        `SELECT observed_session_id, provider FROM provider_sessions
      WHERE workspace_id = ? AND run_id = ? AND id = ? AND state = 'active'`,
      )
      .get(ctx.workspaceId, row.run_id, row.resume_session_id)) as
      { observed_session_id: string | null; provider: string } | undefined;
    if (
      !session ||
      session.provider !== snapshot.execution_config.provider ||
      session.observed_session_id !== row.resume_observed_session_id
    )
      rejectRunnerRequest();
  }
  return { checkout: environment.checkout, snapshot };
}

/** Conditional assertions run inside the committing batch, not only in its preceding reads. */
export async function guardLaunchMutation(
  ctx: HubContext,
  predicate: string,
  params: unknown[],
): Promise<void> {
  const id = randomUlid();
  await ctx.db
    .prepare(
      `INSERT INTO runner_mutation_guards (id, valid) SELECT ?, CASE WHEN (${predicate}) THEN 1 ELSE 0 END`,
    )
    .run(id, ...params);
  await ctx.db.prepare(`DELETE FROM runner_mutation_guards WHERE id = ?`).run(id);
}

export async function endUnstartedLaunch(
  ctx: HubContext,
  row: LaunchRow,
  reason: LaunchEndReason,
): Promise<void> {
  if (row.state === "started")
    throw new DomainError("invalid_transition", "started execution requires verified local ending");
  await ctx.db
    .prepare(
      `UPDATE launch_commands SET state = ?, end_reason = ? WHERE workspace_id = ? AND id = ? AND state IN ('pending', 'claimed')`,
    )
    .run(reason === "launch_expired" ? "expired" : "rejected", reason, ctx.workspaceId, row.id);
  await ctx.db
    .prepare(
      `UPDATE run_executions SET state = 'ended', end_reason = ?, ended_at = ?, resource_version = resource_version + 1 WHERE workspace_id = ? AND id = ? AND state IN ('queued', 'launching')`,
    )
    .run(reason, ctx.now, ctx.workspaceId, row.execution_id);
  await ctx.db
    .prepare(
      `UPDATE tasks SET state = 'ready', resource_version = resource_version + 1
    WHERE workspace_id = ? AND id = ? AND state = 'active' AND NOT EXISTS (
      SELECT 1 FROM run_executions AS execution JOIN runs AS run ON run.workspace_id = execution.workspace_id AND run.id = execution.run_id
      WHERE run.workspace_id = tasks.workspace_id AND run.task_id = tasks.id AND execution.state != 'ended')`,
    )
    .run(ctx.workspaceId, row.task_id);
  await resolveRunnerCommandReference(ctx, row.runner_id, row.id);
  // No lease mutation here: even a pre-exec rejection can leave a supervisor or local lock alive.
}
