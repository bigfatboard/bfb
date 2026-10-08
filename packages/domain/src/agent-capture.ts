// ABOUTME: Derives exact launch-scoped capture confirmations and verifies signed replay admission.
// ABOUTME: Keeps historical capture proof separate from current authority and business idempotency.

import {
  decodeWireDocument,
  canonicalAgentWriteRequest,
  type AgentCaptureConfirmationRequest,
  type AgentCaptureConfirmationResult,
  type AgentWorkCapture,
  type AgentCommentRequest,
  type AgentUpdateRequest,
  type AgentProgressRequest,
  type AgentProposalRequest,
  type WireDocumentName,
} from "@bfb/protocol";
import { agentWorkKey, type BoundRun } from "./agent-work.js";
import { DomainError, type HubContext } from "./hub.js";
import {
  canonicalLaunchJson,
  readLaunch,
  readLease,
  assertLeaseBinding,
  reauthorizeActiveRun,
} from "./launch-state.js";
import {
  normalizeOfflineAgentWork,
  assertOfflineAgentWorkTightens,
  type OfflineAgentWorkPolicy,
} from "./offline-agent-policy.js";
import { canonicalRunnerKey, runnerHash, runnerKeyThumbprint } from "./runner-crypto.js";
import type { RunnerPrincipal } from "./runners.js";

export const AGENT_CONFIRMATION_REQUEST_BYTES = 2_048;
export const AGENT_CONFIRMATION_RESULT_BYTES = 4_096;
export const AGENT_CAPTURE_BYTES = 8_192;
export const AGENT_REPLAY_REQUEST_BYTES = 32_768;
export const AGENT_CAPTURE_CONFIRMATION_COMMAND = "agent_run.capture_confirmation";
export type AgentWriteRequest =
  AgentCommentRequest | AgentUpdateRequest | AgentProgressRequest | AgentProposalRequest;
export const agentCaptureConfirmationKey = (request: AgentCaptureConfirmationRequest) =>
  agentWorkKey("capture-confirmation", request);
export const agentCaptureConfirmationFingerprint = (request: AgentCaptureConfirmationRequest) =>
  runnerHash(canonicalLaunchJson(request));

export function checkedCaptureDocument<T>(name: WireDocumentName, value: T, limit: number): T {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    /* Invalid internal evidence is not an outage. */
  }
  if (typeof encoded !== "string")
    throw new DomainError("capture_invalid", "invalid capture evidence");
  const bytes = Buffer.from(encoded);
  if (bytes.length > limit || !decodeWireDocument(name, bytes).ok)
    throw new DomainError("capture_invalid", "invalid capture evidence");
  return value;
}
interface PermissionRow {
  offline_agent_tools_json: string;
  offline_agent_max_pending_age_seconds: number;
  content_hash?: string;
  canonical_json?: string;
}
async function exactPermission(
  ctx: HubContext,
  table: "workspace_policy_versions" | "project_policy_versions" | "repository_config_versions",
  version: number,
  projectId: string,
): Promise<{ permission: OfflineAgentWorkPolicy; row: PermissionRow }> {
  const row = (await ctx.db
    .prepare(
      `SELECT * FROM ${table} WHERE workspace_id = ? ${table === "workspace_policy_versions" ? "" : "AND project_id = ?"} AND version = ?`,
    )
    .get(
      ...(table === "workspace_policy_versions"
        ? [ctx.workspaceId, version]
        : [ctx.workspaceId, projectId, version]),
    )) as PermissionRow | undefined;
  if (!row) throw new DomainError("policy_rejected", "capture policy version unavailable");
  try {
    return {
      row,
      permission: normalizeOfflineAgentWork({
        allowed_tools: JSON.parse(row.offline_agent_tools_json),
        max_pending_age_seconds: row.offline_agent_max_pending_age_seconds,
      }),
    };
  } catch {
    throw new DomainError("policy_rejected", "capture policy version invalid");
  }
}
export async function capturePublicKey(ctx: HubContext, row: BoundRun) {
  const stored = (await ctx.db
    .prepare("SELECT public_key_json FROM runners WHERE workspace_id = ? AND id = ?")
    .get(ctx.workspaceId, row.runner_id)) as { public_key_json: string } | undefined;
  if (!stored) invalidCapture();
  try {
    const key = await canonicalRunnerKey(JSON.parse(stored.public_key_json));
    if (runnerKeyThumbprint(key) !== row.runner_key_thumbprint) invalidCapture();
    return key;
  } catch {
    invalidCapture();
  }
}

/** Caller has already established live execution, canonical binding and authenticated Hub actor. */
export async function deriveAgentCaptureScope(
  ctx: HubContext,
  row: BoundRun,
  principal: RunnerPrincipal,
  request: AgentCaptureConfirmationRequest,
  authority: "launch" | "active",
): Promise<Omit<AgentCaptureConfirmationResult, "configured_permission">> {
  checkedCaptureDocument(
    "agent-capture-confirmation-request",
    request,
    AGENT_CONFIRMATION_REQUEST_BYTES,
  );
  const launch = await readLaunch(ctx.db, ctx.workspaceId, row.launch_id);
  await capturePublicKey(ctx, row);
  let snapshot;
  try {
    // Capture belongs to an already bound execution, not a new launch delivery.
    if (authority === "launch" && !["open", "changes_requested"].includes(launch.result_state))
      throw new DomainError("request_rejected", "request rejected");
    ({ snapshot } = await reauthorizeActiveRun(ctx, launch));
  } catch (error) {
    if (
      error instanceof DomainError &&
      ["request_rejected", "policy_widening", "invalid_policy"].includes(error.code)
    )
      throw new DomainError("policy_rejected", "current launch policy unavailable");
    throw error;
  }
  const lease = await readLease(ctx.db, row);
  assertLeaseBinding(lease, row);
  if (!lease || !["reserved", "live"].includes(lease.state) || lease.expires_at <= ctx.now)
    throw new DomainError("capability_closed", "checkout lease ended");
  const repository = (await ctx.db
    .prepare(
      "SELECT canonical_json, content_hash FROM repository_config_versions WHERE workspace_id = ? AND project_id = ? AND version = ?",
    )
    .get(ctx.workspaceId, row.project_id, snapshot.repository_config_version)) as
    { canonical_json: string; content_hash: string } | undefined;
  if (
    !repository ||
    typeof repository.canonical_json !== "string" ||
    repository.content_hash !== `sha256:${runnerHash(repository.canonical_json)}`
  )
    throw new DomainError("policy_rejected", "repository version hash invalid");
  return {
    schema_version: 1,
    confirmation_id: request.request_id,
    workspace_id: ctx.workspaceId,
    project_id: row.project_id,
    source_task_id: row.task_id,
    run_id: row.run_id,
    run_execution_id: row.execution_id,
    runner_id: row.runner_id,
    checkout_id: row.checkout_id,
    requesting_human_id: row.requesting_human_id,
    runner_owner_human_id: principal.ownerHumanId,
    assignment_generation: row.assignment_generation,
    fencing_generation: lease.fencing_generation,
    requesting_human_authorization_epoch: row.requesting_human_epoch,
    runner_owner_authorization_epoch: principal.ownerAuthorizationEpoch,
    runner_authorization_epoch: row.runner_authorization_epoch,
    runner_grant_epoch: row.runner_grant_epoch,
    runner_token_epoch: principal.tokenEpoch,
    runner_key_thumbprint: row.runner_key_thumbprint,
    physical_worktree_hash: row.physical_worktree_hash,
    snapshot_hash: launch.snapshot_hash,
    snapshot_generation: snapshot.snapshot_generation,
    workspace_policy_version: snapshot.workspace_policy_version,
    project_policy_version: snapshot.project_policy_version,
    repository_config_version: snapshot.repository_config_version,
    snapshot_repository_config_hash: snapshot.repository_config_hash,
    approved_repository_config_hash: repository.content_hash,
    binding: request.binding,
    confirmed_at: ctx.now,
    lease_expires_at: lease.expires_at,
    credential_expires_at: principal.authExpiresAt,
  };
}

/** A01 retains launch eligibility; result reconciliation uses the separately named active scope. */
export async function deriveAgentCaptureConfirmation(
  ctx: HubContext,
  row: BoundRun,
  principal: RunnerPrincipal,
  request: AgentCaptureConfirmationRequest,
): Promise<AgentCaptureConfirmationResult> {
  const scope = await deriveAgentCaptureScope(ctx, row, principal, request, "launch");
  const workspace = await exactPermission(
    ctx,
    "workspace_policy_versions",
    scope.workspace_policy_version,
    row.project_id,
  );
  const project = await exactPermission(
    ctx,
    "project_policy_versions",
    scope.project_policy_version,
    row.project_id,
  );
  const repository = await exactPermission(
    ctx,
    "repository_config_versions",
    scope.repository_config_version,
    row.project_id,
  );
  try {
    assertOfflineAgentWorkTightens(workspace.permission, project.permission);
    assertOfflineAgentWorkTightens(project.permission, repository.permission);
  } catch {
    throw new DomainError("policy_rejected", "capture policy widens its ceiling");
  }
  return checkedCaptureDocument(
    "agent-capture-confirmation-result",
    {
      ...scope,
      configured_permission: repository.permission,
    },
    AGENT_CONFIRMATION_RESULT_BYTES,
  );
}

const writeCommands = {
  "agent_run.comment": { action: "comment", tool: "bfb_add_comment" },
  "agent_run.update": { action: "update", tool: "bfb_update_task" },
  "agent_run.progress": { action: "progress", tool: "bfb_report_progress" },
  "agent_run.proposal": { action: "proposal", tool: "bfb_propose_task" },
} as const;
export type AgentWriteCommandName = keyof typeof writeCommands;
export function agentWriteAction(command: AgentWriteCommandName): string {
  return writeCommands[command].action;
}
function invalidCapture(): never {
  throw new DomainError("capture_invalid", "capture evidence does not match operation");
}

async function assertOriginalConfirmation(
  ctx: HubContext,
  confirmation: AgentCaptureConfirmationResult,
) {
  const request: AgentCaptureConfirmationRequest = {
    schema_version: 1,
    request_id: confirmation.confirmation_id,
    run_execution_id: confirmation.run_execution_id,
    assignment_generation: confirmation.assignment_generation,
    binding: confirmation.binding,
  };
  const stored = (await ctx.db
    .prepare(
      "SELECT command_name, result_json FROM idempotency_records WHERE workspace_id = ? AND idempotency_key = ?",
    )
    .get(ctx.workspaceId, agentCaptureConfirmationKey(request))) as
    { command_name: string; result_json: string } | undefined;
  if (!stored || stored.command_name !== AGENT_CAPTURE_CONFIRMATION_COMMAND) invalidCapture();
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(stored.result_json) as Record<string, unknown>;
  } catch {
    invalidCapture();
  }
  if (
    !record ||
    Array.isArray(record) ||
    record.actorRunnerId !== ctx.actorRunnerId ||
    record.authorizationEpoch !== ctx.authorizationEpoch ||
    record.actorHumanId !== undefined ||
    record.actorDelegationId !== undefined ||
    record.actorSystemId !== undefined ||
    record.inputFingerprint !== agentCaptureConfirmationFingerprint(request) ||
    canonicalLaunchJson(record.result) !== canonicalLaunchJson(confirmation)
  )
    invalidCapture();
}

/** Runs within original command authorization, before its idempotent outcome is examined. */
export async function authorizeAgentReplay(
  ctx: HubContext,
  row: BoundRun,
  principal: RunnerPrincipal,
  request: AgentWriteRequest,
  commandName: AgentWriteCommandName,
  capture: AgentWorkCapture,
): Promise<void> {
  checkedCaptureDocument("agent-work-capture", capture, AGENT_CAPTURE_BYTES);
  if (capture.admission_mode !== "offline_admitted") invalidCapture();
  const original = capture.confirmation;
  const current = await deriveAgentCaptureConfirmation(ctx, row, principal, {
    schema_version: 1,
    request_id: original.confirmation_id,
    run_execution_id: request.reference.run_execution_id,
    assignment_generation: request.reference.assignment_generation,
    binding: request.binding,
  });
  // Fresh lease/token expiry and token epoch may change on an ordinary renewal.
  const {
    confirmed_at: _now,
    lease_expires_at: _lease,
    credential_expires_at: _credential,
    runner_token_epoch: _token,
    ...currentIdentity
  } = current;
  const {
    confirmed_at: _originalNow,
    lease_expires_at: _originalLease,
    credential_expires_at: _originalCredential,
    runner_token_epoch: _originalToken,
    ...originalIdentity
  } = original;
  if (canonicalLaunchJson(currentIdentity) !== canonicalLaunchJson(originalIdentity))
    invalidCapture();
  await assertOriginalConfirmation(ctx, original);
  const descriptor = writeCommands[commandName];
  const operation = capture.operation;
  if (
    operation.command_name !== commandName ||
    operation.tool !== descriptor.tool ||
    operation.operation_schema_version !== request.reference.schema_version ||
    operation.operation_key !== agentWorkKey(descriptor.action, request.reference) ||
    operation.request_id !== request.reference.request_id ||
    operation.payload_hash !==
      `sha256:${runnerHash(canonicalAgentWriteRequest(commandName, Buffer.from(JSON.stringify(request))))}` ||
    operation.expected_version !==
      ("expected_version" in request ? request.expected_version : null) ||
    operation.target_task_id !== (commandName === "agent_run.proposal" ? null : row.task_id) ||
    operation.parent_task_id !==
      ("parent_task_id" in request ? (request.parent_task_id ?? null) : null)
  )
    invalidCapture();
  const permission = normalizeOfflineAgentWork(capture.admitted_permission);
  if (
    canonicalLaunchJson(permission) !== canonicalLaunchJson(original.configured_permission) ||
    !permission.allowed_tools.includes(descriptor.tool) ||
    original.snapshot_repository_config_hash !== original.approved_repository_config_hash
  )
    throw new DomainError("policy_rejected", "offline replay not permitted");
  const confirmedAt = Date.parse(original.confirmed_at),
    capturedAt = Date.parse(capture.captured_at);
  if (
    capturedAt < confirmedAt ||
    capturedAt > Date.parse(ctx.now) ||
    capturedAt >=
      Math.min(
        confirmedAt + 45_000,
        Date.parse(original.lease_expires_at),
        Date.parse(original.credential_expires_at),
      ) ||
    capture.intent_expires_at !==
      new Date(capturedAt + permission.max_pending_age_seconds * 1000).toISOString()
  )
    invalidCapture();
  if (Date.parse(ctx.now) >= Date.parse(capture.intent_expires_at!))
    throw new DomainError("intent_expired", "offline replay intent expired");
  const key = await capturePublicKey(ctx, row);
  try {
    if (runnerKeyThumbprint(key) !== original.runner_key_thumbprint) invalidCapture();
    const signature = Buffer.from(capture.signature, "base64url");
    if (signature.length !== 64 || signature.toString("base64url") !== capture.signature)
      invalidCapture();
    const { signature: _signature, ...unsigned } = capture;
    const transcript = new TextEncoder().encode(
      `BFB-AGENT-WORK-CAPTURE-V1\n${canonicalLaunchJson(unsigned)}\n`,
    );
    if (transcript.length > AGENT_CAPTURE_BYTES) invalidCapture();
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature,
        transcript,
      ))
    )
      invalidCapture();
  } catch {
    invalidCapture();
  }
}
