// ABOUTME: Checks exact result-run authority and protected result capture before canonical outcomes.
// ABOUTME: Keeps result permission, signing and confirmation separate from the four agent-work tools.

import {
  canonicalAgentWriteRequest,
  type AgentResultRequest,
  type AgentResultResult,
  type AgentResultCapture,
  type AgentResultConfirmationRequest,
  type AgentResultConfirmationResult,
} from "@bfb/protocol";
import {
  capturePublicKey,
  checkedCaptureDocument,
  deriveAgentCaptureScope,
} from "./agent-capture.js";
import { currentAgentSession } from "./agent-sessions.js";
import { agentTaskAccess, agentWorkKey, liveRun, type BoundRun } from "./agent-work.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { canonicalLaunchJson, readLaunch, reauthorizeActiveRun } from "./launch-state.js";
import {
  assertOfflineAgentResultsTightens,
  normalizeOfflineAgentResults,
  type OfflineAgentResultsPolicy,
} from "./offline-result-policy.js";
import { runnerHash, runnerKeyThumbprint } from "./runner-crypto.js";
import type { RunnerPrincipal } from "./runners.js";
import type { SubmitResultResult } from "./results.js";
import { getTask } from "./work-commands.js";

export const AGENT_RESULT_REQUEST_BYTES = 32_768;
export const AGENT_RESULT_REPLAY_BYTES = 49_152;
export const RESULT_CONFIRMATION_COMMAND = "result.capture_confirmation";
export interface AgentResultInput {
  principal: RunnerPrincipal;
  request: AgentResultRequest;
  replayCapture?: AgentResultCapture;
}
export interface AgentResultConfirmationInput {
  principal: RunnerPrincipal;
  request: AgentResultConfirmationRequest;
}
export const resultConfirmationKey = (request: AgentResultConfirmationRequest) =>
  agentWorkKey("result-confirmation", request);
export const resultConfirmationFingerprint = (request: AgentResultConfirmationRequest) =>
  runnerHash(canonicalLaunchJson(request));

function internalInput(value: unknown, fields: readonly string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new DomainError("request_rejected", "invalid result authority input");
}

async function resultRun(
  ctx: HubContext,
  principal: RunnerPrincipal,
  request: AgentResultRequest["reference"],
  binding: AgentResultRequest["binding"],
): Promise<BoundRun> {
  const row = await liveRun(
    {
      principal,
      request: {
        schema_version: request.schema_version,
        request_id: request.request_id,
        run_execution_id: request.run_execution_id,
        assignment_generation: request.assignment_generation,
      },
    },
    ctx,
    "contribute",
  );
  const latest = (await ctx.db
    .prepare(
      "SELECT execution_id, assignment_generation FROM execution_assignments WHERE workspace_id = ? AND run_id = ? ORDER BY assignment_generation DESC LIMIT 1",
    )
    .get(ctx.workspaceId, row.run_id)) as
    { execution_id: string; assignment_generation: number } | undefined;
  if (
    !latest ||
    latest.execution_id !== row.execution_id ||
    latest.assignment_generation !== row.assignment_generation
  )
    throw new DomainError("assignment_ended", "result assignment superseded");
  await currentAgentSession(ctx, row, binding);
  try {
    await reauthorizeActiveRun(ctx, await readLaunch(ctx.db, ctx.workspaceId, row.launch_id));
  } catch (error) {
    if (
      error instanceof DomainError &&
      ["request_rejected", "policy_widening", "invalid_policy"].includes(error.code)
    )
      throw new DomainError("policy_rejected", "current result policy unavailable");
    throw error;
  }
  return row;
}

async function resultPermission(
  ctx: HubContext,
  row: BoundRun,
  scope: AgentResultConfirmationResult | Awaited<ReturnType<typeof deriveAgentCaptureScope>>,
): Promise<OfflineAgentResultsPolicy> {
  const permissions: OfflineAgentResultsPolicy[] = [];
  for (const [table, version] of [
    ["workspace_policy_versions", scope.workspace_policy_version],
    ["project_policy_versions", scope.project_policy_version],
    ["repository_config_versions", scope.repository_config_version],
  ] as const) {
    const policy = (await ctx.db
      .prepare(
        `SELECT offline_result_allow_submit, offline_result_max_pending_age_seconds FROM ${table} WHERE workspace_id = ? ${table === "workspace_policy_versions" ? "" : "AND project_id = ?"} AND version = ?`,
      )
      .get(
        ...(table === "workspace_policy_versions"
          ? [ctx.workspaceId, version]
          : [ctx.workspaceId, row.project_id, version]),
      )) as
      | { offline_result_allow_submit: number; offline_result_max_pending_age_seconds: number }
      | undefined;
    if (!policy || ![0, 1].includes(policy.offline_result_allow_submit))
      throw new DomainError("policy_rejected", "result policy version unavailable");
    try {
      permissions.push(
        normalizeOfflineAgentResults({
          allow_submit_result: policy.offline_result_allow_submit === 1,
          max_pending_age_seconds: policy.offline_result_max_pending_age_seconds,
        }),
      );
    } catch {
      throw new DomainError("policy_rejected", "result policy version invalid");
    }
  }
  try {
    assertOfflineAgentResultsTightens(permissions[0]!, permissions[1]!);
    assertOfflineAgentResultsTightens(permissions[1]!, permissions[2]!);
  } catch {
    throw new DomainError("policy_rejected", "result policy widens its ceiling");
  }
  return permissions[2]!;
}

export async function deriveResultConfirmation(
  ctx: HubContext,
  row: BoundRun,
  principal: RunnerPrincipal,
  request: AgentResultConfirmationRequest,
): Promise<AgentResultConfirmationResult> {
  checkedCaptureDocument("agent-result-confirmation-request", request, 2_048);
  const scope = await deriveAgentCaptureScope(ctx, row, principal, request, "active");
  const permission = await resultPermission(ctx, row, scope);
  const task = await getTask(ctx.db, ctx.workspaceId, row.task_id, agentTaskAccess(row));
  return checkedCaptureDocument(
    "agent-result-confirmation-result",
    {
      ...scope,
      configured_permission: permission,
      can_submit:
        ["open", "changes_requested"].includes(row.result_state) && task?.state === "active",
    },
    4_096,
  );
}

async function confirmation(input: AgentResultConfirmationInput, ctx: HubContext) {
  internalInput(input, ["principal", "request"]);
  const request = checkedCaptureDocument("agent-result-confirmation-request", input.request, 2_048);
  const row = await resultRun(ctx, input.principal, request, request.binding);
  return deriveResultConfirmation(ctx, row, input.principal, request);
}
export const resultCaptureConfirmationCommand: HubCommand<
  AgentResultConfirmationInput,
  AgentResultConfirmationResult
> = {
  name: RESULT_CONFIRMATION_COMMAND,
  authorize: async (input, ctx) => {
    await confirmation(input, ctx);
  },
  inputFingerprint: (input) => resultConfirmationFingerprint(input.request),
  auditInput: (input) => ({
    confirmationId: input.request.request_id,
    executionId: input.request.run_execution_id,
    generation: input.request.assignment_generation,
    bindingHash: runnerHash(canonicalLaunchJson(input.request.binding)),
  }),
  auditResult: (result) => ({
    confirmationId: result.confirmation_id,
    runId: result.run_id,
    executionId: result.run_execution_id,
    snapshotHash: result.snapshot_hash,
    permissionHash: runnerHash(canonicalLaunchJson(result.configured_permission)),
    canSubmit: result.can_submit,
  }),
  run: confirmation,
};

function invalidCapture(): never {
  throw new DomainError("capture_invalid", "result capture does not match operation");
}
async function originalConfirmation(ctx: HubContext, confirmation: AgentResultConfirmationResult) {
  const request: AgentResultConfirmationRequest = {
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
    .get(ctx.workspaceId, resultConfirmationKey(request))) as
    { command_name: string; result_json: string } | undefined;
  if (!stored || stored.command_name !== RESULT_CONFIRMATION_COMMAND) invalidCapture();
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(stored.result_json);
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
    record.inputFingerprint !== resultConfirmationFingerprint(request) ||
    canonicalLaunchJson(record.result) !== canonicalLaunchJson(confirmation)
  )
    invalidCapture();
}
async function replayAuthority(ctx: HubContext, row: BoundRun, input: AgentResultInput) {
  const capture = checkedCaptureDocument("agent-result-capture", input.replayCapture!, 8_192);
  if (capture.admission_mode !== "offline_admitted") invalidCapture();
  const original = capture.confirmation;
  const current = await deriveResultConfirmation(ctx, row, input.principal, {
    schema_version: 1,
    request_id: original.confirmation_id,
    run_execution_id: input.request.reference.run_execution_id,
    assignment_generation: input.request.reference.assignment_generation,
    binding: input.request.binding,
  });
  const {
    confirmed_at: _now,
    lease_expires_at: _lease,
    credential_expires_at: _credential,
    runner_token_epoch: _token,
    can_submit: _eligible,
    ...currentIdentity
  } = current;
  const {
    confirmed_at: _originalNow,
    lease_expires_at: _originalLease,
    credential_expires_at: _originalCredential,
    runner_token_epoch: _originalToken,
    can_submit: _originalEligible,
    ...originalIdentity
  } = original;
  if (canonicalLaunchJson(currentIdentity) !== canonicalLaunchJson(originalIdentity))
    invalidCapture();
  await originalConfirmation(ctx, original);
  const operation = capture.operation;
  if (
    operation.command_name !== "result.submit" ||
    operation.tool !== "bfb_submit_result" ||
    operation.operation_schema_version !== input.request.reference.schema_version ||
    operation.operation_key !== agentWorkKey("submit_result", input.request.reference) ||
    operation.request_id !== input.request.reference.request_id ||
    operation.payload_hash !==
      `sha256:${runnerHash(canonicalAgentWriteRequest("result.submit", Buffer.from(JSON.stringify(input.request))))}` ||
    operation.expected_version !== null ||
    operation.parent_task_id !== null ||
    operation.target_task_id !== row.task_id
  )
    invalidCapture();
  const permission = normalizeOfflineAgentResults(capture.admitted_permission);
  if (
    !original.can_submit ||
    !permission.allow_submit_result ||
    canonicalLaunchJson(permission) !== canonicalLaunchJson(original.configured_permission) ||
    original.snapshot_repository_config_hash !== original.approved_repository_config_hash
  )
    throw new DomainError("policy_rejected", "offline result replay not permitted");
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
    throw new DomainError("intent_expired", "result replay intent expired");
  const key = await capturePublicKey(ctx, row);
  try {
    if (runnerKeyThumbprint(key) !== original.runner_key_thumbprint) invalidCapture();
    const signature = Buffer.from(capture.signature, "base64url");
    if (signature.length !== 64 || signature.toString("base64url") !== capture.signature)
      invalidCapture();
    const { signature: _signature, ...unsigned } = capture;
    const transcript = new TextEncoder().encode(
      `BFB-AGENT-RESULT-CAPTURE-V1\n${canonicalLaunchJson(unsigned)}\n`,
    );
    if (transcript.length > 8_192) invalidCapture();
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

/** Original catalog command invokes this before cache lookup, never a replay-only wrapper. */
export async function authorizeAgentResult(
  input: AgentResultInput,
  ctx: HubContext,
): Promise<BoundRun> {
  internalInput(input, ["principal", "request", "replayCapture"]);
  checkedCaptureDocument("agent-result-request", input.request, AGENT_RESULT_REQUEST_BYTES);
  const row = await resultRun(ctx, input.principal, input.request.reference, input.request.binding);
  if (Object.hasOwn(input, "replayCapture")) await replayAuthority(ctx, row, input);
  return row;
}
export function agentResultProjection(result: SubmitResultResult): AgentResultResult {
  if (!result.agentOrigin) throw new DomainError("request_rejected", "result has no agent origin");
  return checkedCaptureDocument(
    "agent-result-result",
    {
      submission_id: result.submission.id,
      version: result.submission.version,
      result_state: result.runResultState,
      task_state: result.taskState,
      run_version: result.runVersion,
      task_version: result.taskVersion,
      origin: result.agentOrigin,
    },
    2_048,
  );
}
