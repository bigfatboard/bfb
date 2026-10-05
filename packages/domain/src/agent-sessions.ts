// ABOUTME: Confirms trusted execution-session associations and current bound agent-work authority.
// ABOUTME: Stages canonical business rows and immutable provenance together without impersonating a human.

import { createHash } from "node:crypto";
import {
  decodeWireDocument,
  type AgentWorkRequest,
  type AgentSessionBindRequest,
  type AgentSessionBindResult,
  type AgentSessionReference,
  type AgentBoundRequest,
  type AgentCommentRequest,
  type AgentCommentResult,
  type AgentAuthorityResult,
  type AgentUpdateRequest,
  type AgentUpdateResult,
  type AgentProgressRequest,
  type AgentProposalRequest,
  type AgentProposalResult,
  type AgentCaptureConfirmationRequest,
  type AgentCaptureConfirmationResult,
  type AgentWorkCapture,
  type WireDocumentName,
} from "@bfb/protocol";
import { agentWorkKey, agentTaskView, liveRun, type BoundRun } from "./agent-work.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { randomUlid } from "./ids.js";
import { canonicalLaunchJson, readLaunch, snapshotOf } from "./launch-state.js";
import type { RunnerPrincipal } from "./runners.js";
import { runnerObject } from "./runner-crypto.js";
import {
  AGENT_CAPTURE_CONFIRMATION_COMMAND,
  AGENT_CONFIRMATION_REQUEST_BYTES,
  checkedCaptureDocument,
  deriveAgentCaptureConfirmation,
  agentCaptureConfirmationFingerprint,
  authorizeAgentReplay,
  type AgentWriteRequest,
  type AgentWriteCommandName,
} from "./agent-capture.js";
import {
  checkedCommentBody,
  getTask,
  persistComment,
  assertAgentRootProposalAllowed,
  assertAgentChildLimit,
  prepareTaskCreation,
  persistTaskCreation,
  prepareTaskUpdate,
  persistTaskUpdate,
} from "./work-commands.js";

export const AGENT_WRITE_REQUEST_BYTES = 16_384;
export interface AgentSessionInput {
  principal: RunnerPrincipal;
  request: AgentSessionBindRequest;
}
export interface AgentBoundInput {
  principal: RunnerPrincipal;
  request: AgentBoundRequest;
}
interface ReplayInput {
  /** Internal Hub metadata; never accepted by an ordinary public work request document. */
  replayCapture?: AgentWorkCapture;
}
export interface AgentCommentInput extends ReplayInput {
  principal: RunnerPrincipal;
  request: AgentCommentRequest;
}
export interface AgentUpdateInput extends ReplayInput {
  principal: RunnerPrincipal;
  request: AgentUpdateRequest;
}
export interface AgentProgressInput extends ReplayInput {
  principal: RunnerPrincipal;
  request: AgentProgressRequest;
}
export interface AgentProposalInput extends ReplayInput {
  principal: RunnerPrincipal;
  request: AgentProposalRequest;
}
export interface AgentCaptureConfirmationInput {
  principal: RunnerPrincipal;
  request: AgentCaptureConfirmationRequest;
}
interface BindingRow {
  provider_session_id: string;
  provider: AgentSessionReference["provider"];
  observed_session_id: string;
  observed_at: string;
  confirmed_at: string;
  session_state: string;
}
interface SessionRow {
  id: string;
  provider: string;
  observed_session_id: string | null;
  state: string;
}

function checked<T>(document: WireDocumentName, request: T): T {
  const bytes = Buffer.from(JSON.stringify(request));
  if (bytes.length > AGENT_WRITE_REQUEST_BYTES || !decodeWireDocument(document, bytes).ok)
    throw new DomainError("request_rejected", "invalid agent operation");
  return request;
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalLaunchJson(value)).digest("hex");
const fingerprint = (input: AgentBoundInput | AgentCommentInput) => hash(input.request);
function bindingReference(reference: AgentWorkRequest): AgentWorkRequest {
  return { ...reference, request_id: "session-bind-v1" };
}
export const agentSessionBindKey = (reference: AgentWorkRequest) =>
  agentWorkKey("session-bind", bindingReference(reference));
const bindingFingerprint = (input: AgentSessionInput) =>
  hash({
    reference: bindingReference(input.request.reference),
    observation: input.request.observation,
  });
const safeReference = (reference: AgentWorkRequest) => ({
  executionId: reference.run_execution_id,
  generation: reference.assignment_generation,
  requestId: reference.request_id,
});
async function bindingRow(ctx: HubContext, row: BoundRun): Promise<BindingRow | undefined> {
  return (await ctx.db
    .prepare(
      `SELECT binding.provider_session_id, binding.provider,
    binding.observed_session_id, binding.observed_at, binding.confirmed_at,
    session.state AS session_state
    FROM execution_session_bindings binding
    LEFT JOIN provider_sessions session ON session.workspace_id = binding.workspace_id
      AND session.run_id = binding.run_id AND session.id = binding.provider_session_id
      AND session.provider = binding.provider AND session.observed_session_id = binding.observed_session_id
    WHERE binding.workspace_id = ? AND binding.execution_id = ? AND binding.assignment_generation = ?
      AND binding.run_id = ? AND binding.runner_id = ?`,
    )
    .get(
      ctx.workspaceId,
      row.execution_id,
      row.assignment_generation,
      row.run_id,
      row.runner_id,
    )) as BindingRow | undefined;
}
function origin(row: BoundRun, sessionId: string) {
  return {
    run_id: row.run_id,
    run_execution_id: row.execution_id,
    assignment_generation: row.assignment_generation,
    provider_session_id: sessionId,
  };
}
function bindingResult(binding: BindingRow, row: BoundRun): AgentSessionBindResult {
  return {
    binding: {
      provider_session_id: binding.provider_session_id,
      provider: binding.provider,
      observed_session_id: binding.observed_session_id,
    },
    observed_at: binding.observed_at,
    confirmed_at: binding.confirmed_at,
    origin: origin(row, binding.provider_session_id),
  };
}
function matches(binding: BindingRow, reference: AgentSessionReference): boolean {
  return (
    binding.provider_session_id === reference.provider_session_id &&
    binding.provider === reference.provider &&
    binding.observed_session_id === reference.observed_session_id
  );
}

async function prepareBinding(input: AgentSessionInput, ctx: HubContext) {
  const request = checked("agent-session-bind-request", input.request);
  const row = await liveRun({ principal: input.principal, request: request.reference }, ctx);
  const launch = await readLaunch(ctx.db, ctx.workspaceId, row.launch_id);
  const provider = snapshotOf(launch).execution_config.provider;
  if (provider !== request.observation.provider)
    throw new DomainError("session_conflict", "provider observation does not match launch");
  const existing = await bindingRow(ctx, row);
  if (existing) {
    if (
      existing.provider !== provider ||
      existing.observed_session_id !== request.observation.observed_session_id ||
      existing.observed_at !== request.observation.observed_at
    )
      throw new DomainError("session_conflict", "execution already has a different observation");
    if (existing.session_state !== "active")
      throw new DomainError("capability_closed", "provider session ended");
    if (
      launch.resume_session_id &&
      (existing.provider_session_id !== launch.resume_session_id ||
        existing.observed_session_id !== launch.resume_observed_session_id)
    )
      throw new DomainError("session_conflict", "resumed session does not match launch");
    return { row, existing, session: undefined };
  }
  if (!["attached", "detached"].includes(row.execution_state))
    throw new DomainError("session_not_bound", "execution is not attached");
  const sessions = (await ctx.db
    .prepare(
      `SELECT id, provider, observed_session_id, state FROM provider_sessions
    WHERE workspace_id = ? AND run_id = ? AND ${launch.resume_session_id ? "id = ?" : "execution_id = ?"}
    LIMIT 2`,
    )
    .all(
      ctx.workspaceId,
      row.run_id,
      launch.resume_session_id ?? row.execution_id,
    )) as SessionRow[];
  if (sessions.length > 1) throw new DomainError("session_conflict", "ambiguous provider sessions");
  const session = sessions[0];
  if (
    session &&
    (session.provider !== provider ||
      session.state !== "active" ||
      (session.observed_session_id !== null &&
        session.observed_session_id !== request.observation.observed_session_id))
  )
    throw new DomainError("session_conflict", "provider session does not match observation");
  if (
    launch.resume_session_id &&
    (!session ||
      session.observed_session_id !== launch.resume_observed_session_id ||
      request.observation.observed_session_id !== launch.resume_observed_session_id)
  )
    throw new DomainError("session_conflict", "resumed session does not match launch");
  return { row, existing: undefined, session };
}

export const bindAgentSessionCommand: HubCommand<AgentSessionInput, AgentSessionBindResult> = {
  name: "agent_run.session_bind",
  inputFingerprint: bindingFingerprint,
  auditInput: (input) => ({
    ...safeReference(input.request.reference),
    provider: input.request.observation.provider,
    observationHash: hash(input.request.observation),
  }),
  auditResult: (result) => ({
    providerSessionId: result.binding.provider_session_id,
    provider: result.binding.provider,
    observedIdentityHash: hash(result.binding.observed_session_id),
    confirmedAt: result.confirmed_at,
    origin: result.origin,
  }),
  authorize: async (input, ctx) => {
    await prepareBinding(input, ctx);
  },
  async run(input, ctx) {
    const prepared = await prepareBinding(input, ctx);
    if (prepared.existing) return bindingResult(prepared.existing, prepared.row);
    const { row, session } = prepared,
      observation = input.request.observation;
    const id = session?.id ?? randomUlid();
    if (!session) {
      await ctx.db
        .prepare(
          `INSERT INTO provider_sessions
        (workspace_id, id, run_id, execution_id, provider, requested_session_id, observed_session_id,
         state, resource_version, started_at, ended_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 'active', 1, ?, NULL)`,
        )
        .run(
          ctx.workspaceId,
          id,
          row.run_id,
          row.execution_id,
          observation.provider,
          observation.observed_session_id,
          ctx.now,
        );
    } else if (session.observed_session_id === null) {
      await ctx.db
        .prepare(
          `UPDATE provider_sessions SET observed_session_id = ?, resource_version = resource_version + 1
        WHERE workspace_id = ? AND id = ? AND observed_session_id IS NULL`,
        )
        .run(observation.observed_session_id, ctx.workspaceId, id);
    }
    await ctx.db
      .prepare(
        `INSERT INTO execution_session_bindings
      (workspace_id, execution_id, assignment_generation, run_id, source_task_id, project_id, runner_id,
       provider_session_id, provider, observed_session_id, observed_at, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        row.execution_id,
        row.assignment_generation,
        row.run_id,
        row.task_id,
        row.project_id,
        row.runner_id,
        id,
        observation.provider,
        observation.observed_session_id,
        observation.observed_at,
        ctx.now,
      );
    return {
      binding: {
        provider_session_id: id,
        provider: observation.provider,
        observed_session_id: observation.observed_session_id,
      },
      observed_at: observation.observed_at,
      confirmed_at: ctx.now,
      origin: origin(row, id),
    };
  },
};

async function boundAuthority(input: AgentBoundInput, ctx: HubContext) {
  const request = checked("agent-bound-request", input.request);
  const row = await liveRun({ principal: input.principal, request: request.reference }, ctx);
  const binding = await bindingRow(ctx, row);
  if (!binding) throw new DomainError("session_not_bound", "execution session is not confirmed");
  if (!matches(binding, request.binding))
    throw new DomainError("session_conflict", "session reference does not match");
  if (binding.session_state !== "active")
    throw new DomainError("capability_closed", "provider session ended");
  const launch = await readLaunch(ctx.db, ctx.workspaceId, row.launch_id);
  if (
    snapshotOf(launch).execution_config.provider !== binding.provider ||
    (launch.resume_session_id &&
      (launch.resume_session_id !== binding.provider_session_id ||
        launch.resume_observed_session_id !== binding.observed_session_id))
  )
    throw new DomainError("session_conflict", "session does not match pinned launch");
  return row;
}
export const agentBoundAuthorityCommand: HubCommand<AgentBoundInput, AgentAuthorityResult> = {
  name: "agent_run.bound_authority",
  inputFingerprint: fingerprint,
  auditInput: (input) => ({
    ...safeReference(input.request.reference),
    providerSessionId: input.request.binding.provider_session_id,
  }),
  authorize: async (input, ctx) => {
    await boundAuthority(input, ctx);
  },
  async run() {
    return { revoked: false, execution_ended: false, result_terminal: false };
  },
};
async function captureConfirmation(input: AgentCaptureConfirmationInput, ctx: HubContext) {
  runnerObject(input, ["principal", "request"]);
  const request = checkedCaptureDocument(
    "agent-capture-confirmation-request",
    input.request,
    AGENT_CONFIRMATION_REQUEST_BYTES,
  );
  const row = await boundAuthority(
    {
      principal: input.principal,
      request: {
        reference: {
          schema_version: 1,
          request_id: request.request_id,
          run_execution_id: request.run_execution_id,
          assignment_generation: request.assignment_generation,
        },
        binding: request.binding,
      },
    },
    ctx,
  );
  return deriveAgentCaptureConfirmation(ctx, row, input.principal, request);
}
export const agentCaptureConfirmationCommand: HubCommand<
  AgentCaptureConfirmationInput,
  AgentCaptureConfirmationResult
> = {
  name: AGENT_CAPTURE_CONFIRMATION_COMMAND,
  inputFingerprint: (input) => agentCaptureConfirmationFingerprint(input.request),
  auditInput: (input) => ({
    confirmationId: input.request.request_id,
    executionId: input.request.run_execution_id,
    generation: input.request.assignment_generation,
    bindingHash: hash(input.request.binding),
  }),
  auditResult: (result) => ({
    confirmationId: result.confirmation_id,
    runId: result.run_id,
    executionId: result.run_execution_id,
    snapshotHash: result.snapshot_hash,
    permissionHash: hash(result.configured_permission),
  }),
  authorize: async (input, ctx) => {
    await captureConfirmation(input, ctx);
  },
  run: captureConfirmation,
};
const writeDocumentCommands: Partial<Record<WireDocumentName, AgentWriteCommandName>> = {
  "agent-comment-request": "agent_run.comment",
  "agent-update-request": "agent_run.update",
  "agent-progress-request": "agent_run.progress",
  "agent-proposal-request": "agent_run.proposal",
};
async function writeAuthority(
  input: AgentBoundInput & ReplayInput,
  document: WireDocumentName,
  ctx: HubContext,
) {
  runnerObject(input, ["principal", "request", "replayCapture"]);
  checked(document, input.request);
  const row = await boundAuthority(
    {
      principal: input.principal,
      request: {
        reference: input.request.reference,
        binding: input.request.binding,
      },
    },
    ctx,
  );
  if (Object.hasOwn(input, "replayCapture")) {
    await authorizeAgentReplay(
      ctx,
      row,
      input.principal,
      input.request as AgentWriteRequest,
      writeDocumentCommands[document]!,
      input.replayCapture!,
    );
  }
  return row;
}
async function boundTask(ctx: HubContext, row: BoundRun) {
  const task = await getTask(ctx.db, ctx.workspaceId, row.task_id);
  if (!task || task.project_id !== row.project_id)
    throw new DomainError("boundary_escape", "bound task unavailable");
  return task;
}
type EffectTarget =
  | {
      tool: "comment" | "progress";
      kind: "comment.add" | "progress.report";
      taskId: string;
      commentId: string;
      percent?: number;
      confidence?: number;
    }
  | {
      tool: "update" | "proposal";
      kind: "task.update" | "task.propose";
      taskId: string;
      version: number;
    };
async function persistAgentEffect(
  ctx: HubContext,
  input: AgentBoundInput,
  row: BoundRun,
  effect: EffectTarget,
) {
  await ctx.db
    .prepare(
      `INSERT INTO agent_work_effects
    (workspace_id, operation_key, kind, run_id, execution_id, assignment_generation, provider_session_id,
     project_id, source_task_id, target_task_id, comment_id, resulting_task_version, percent, confidence, input_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.workspaceId,
      agentWorkKey(effect.tool, input.request.reference),
      effect.kind,
      row.run_id,
      row.execution_id,
      row.assignment_generation,
      input.request.binding.provider_session_id,
      row.project_id,
      row.task_id,
      effect.taskId,
      "commentId" in effect ? effect.commentId : null,
      "version" in effect ? effect.version : null,
      "percent" in effect ? (effect.percent ?? null) : null,
      "confidence" in effect ? (effect.confidence ?? null) : null,
      fingerprint(input),
      ctx.now,
    );
}
export const agentRunCommentCommand: HubCommand<AgentCommentInput, AgentCommentResult> = {
  name: "agent_run.comment",
  inputFingerprint: fingerprint,
  auditInput: (input) => ({
    ...safeReference(input.request.reference),
    providerSessionId: input.request.binding.provider_session_id,
    bodyHash: hash(input.request.body),
  }),
  auditResult: (result) => ({ id: result.id, kind: "comment.add", origin: result.origin }),
  authorize: async (input, ctx) => {
    await writeAuthority(input, "agent-comment-request", ctx);
  },
  async run(input, ctx) {
    const row = await writeAuthority(input, "agent-comment-request", ctx);
    await boundTask(ctx, row);
    const body = checkedCommentBody(input.request.body);
    const id = await persistComment(ctx, row.task_id, body, "discussion", {
      humanId: null,
      delegationId: null,
    });
    await persistAgentEffect(ctx, input, row, {
      tool: "comment",
      kind: "comment.add",
      taskId: row.task_id,
      commentId: id,
    });
    return { id, origin: origin(row, input.request.binding.provider_session_id) };
  },
};

export const agentRunUpdateCommand: HubCommand<AgentUpdateInput, AgentUpdateResult> = {
  name: "agent_run.update",
  inputFingerprint: fingerprint,
  auditInput: (input) => ({
    ...safeReference(input.request.reference),
    providerSessionId: input.request.binding.provider_session_id,
    expectedVersion: input.request.expected_version,
    payloadHash: hash({
      title: input.request.title ?? null,
      punchline: input.request.punchline ?? null,
    }),
  }),
  auditResult: (result) => ({
    id: result.task.id,
    version: result.task.resource_version,
    kind: "task.update",
    origin: result.origin,
  }),
  authorize: async (input, ctx) => {
    await writeAuthority(input, "agent-update-request", ctx);
  },
  async run(input, ctx) {
    const row = await writeAuthority(input, "agent-update-request", ctx);
    const task = await boundTask(ctx, row);
    const updated = await prepareTaskUpdate(
      {
        taskId: task.id,
        expectedVersion: input.request.expected_version,
        ...(input.request.title !== undefined ? { title: input.request.title } : {}),
        ...(input.request.punchline !== undefined ? { punchline: input.request.punchline } : {}),
      },
      ctx,
      task,
    );
    await persistTaskUpdate(ctx, updated, input.request.expected_version);
    await persistAgentEffect(ctx, input, row, {
      tool: "update",
      kind: "task.update",
      taskId: task.id,
      version: updated.resource_version,
    });
    return {
      task: agentTaskView(updated),
      origin: origin(row, input.request.binding.provider_session_id),
    };
  },
};

export const agentRunProgressCommand: HubCommand<AgentProgressInput, AgentCommentResult> = {
  name: "agent_run.progress",
  inputFingerprint: fingerprint,
  auditInput: (input) => ({
    ...safeReference(input.request.reference),
    providerSessionId: input.request.binding.provider_session_id,
    summaryHash: hash(input.request.summary),
    percent: input.request.percent ?? null,
    confidence: input.request.confidence ?? null,
  }),
  auditResult: (result) => ({ id: result.id, kind: "progress.report", origin: result.origin }),
  authorize: async (input, ctx) => {
    await writeAuthority(input, "agent-progress-request", ctx);
  },
  async run(input, ctx) {
    const row = await writeAuthority(input, "agent-progress-request", ctx);
    await boundTask(ctx, row);
    const summary = checkedCommentBody(input.request.summary);
    const id = await persistComment(ctx, row.task_id, summary, "progress", {
      humanId: null,
      delegationId: null,
    });
    await persistAgentEffect(ctx, input, row, {
      tool: "progress",
      kind: "progress.report",
      taskId: row.task_id,
      commentId: id,
      ...(input.request.percent !== undefined ? { percent: input.request.percent } : {}),
      ...(input.request.confidence !== undefined ? { confidence: input.request.confidence } : {}),
    });
    return { id, origin: origin(row, input.request.binding.provider_session_id) };
  },
};

async function proposalAuthority(input: AgentProposalInput, ctx: HubContext) {
  const row = await writeAuthority(input, "agent-proposal-request", ctx);
  if (input.request.parent_task_id !== undefined && input.request.parent_task_id !== row.task_id)
    throw new DomainError("boundary_escape", "proposal parent is outside the bound task");
  if (input.request.parent_task_id === undefined)
    await assertAgentRootProposalAllowed(ctx.db, ctx.workspaceId, row.project_id);
  return row;
}
export const agentRunProposalCommand: HubCommand<AgentProposalInput, AgentProposalResult> = {
  name: "agent_run.proposal",
  inputFingerprint: fingerprint,
  auditInput: (input) => ({
    ...safeReference(input.request.reference),
    providerSessionId: input.request.binding.provider_session_id,
    parentTaskId: input.request.parent_task_id ?? null,
    priority: input.request.priority ?? "P2",
    titleHash: hash(input.request.title),
  }),
  auditResult: (result) => ({
    id: result.id,
    state: result.state,
    kind: "task.propose",
    origin: result.origin,
  }),
  authorize: async (input, ctx) => {
    await proposalAuthority(input, ctx);
  },
  async run(input, ctx) {
    const row = await proposalAuthority(input, ctx);
    const source = await boundTask(ctx, row);
    const parent = input.request.parent_task_id !== undefined ? source : undefined;
    if (parent) {
      try {
        await assertAgentChildLimit(ctx.db, ctx.workspaceId, parent.id);
      } catch (error) {
        if (error instanceof DomainError && error.code === "child_limit_reached")
          throw new DomainError("child_limit", "agent child task limit reached");
        throw error;
      }
    }
    const task = await prepareTaskCreation(
      {
        projectId: row.project_id,
        title: input.request.title,
        priority: input.request.priority ?? "P2",
      },
      ctx,
      true,
      parent,
    );
    await persistTaskCreation(ctx, task, { humanId: null, delegationId: null });
    await persistAgentEffect(ctx, input, row, {
      tool: "proposal",
      kind: "task.propose",
      taskId: task.id,
      version: task.resource_version,
    });
    return {
      id: task.id,
      state: task.state as AgentProposalResult["state"],
      origin: origin(row, input.request.binding.provider_session_id),
    };
  },
};
