// ABOUTME: Confirms trusted execution-session associations and derives bound agent comment authority.
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
  type WireDocumentName,
} from "@bfb/protocol";
import { agentWorkKey, liveRun, type BoundRun } from "./agent-work.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { randomUlid } from "./ids.js";
import { canonicalLaunchJson, readLaunch, snapshotOf } from "./launch-state.js";
import type { RunnerPrincipal } from "./runners.js";
import { checkedCommentBody, getTask, persistComment } from "./work-commands.js";

export const AGENT_WRITE_REQUEST_BYTES = 16_384;
export interface AgentSessionInput {
  principal: RunnerPrincipal;
  request: AgentSessionBindRequest;
}
export interface AgentBoundInput {
  principal: RunnerPrincipal;
  request: AgentBoundRequest;
}
export interface AgentCommentInput {
  principal: RunnerPrincipal;
  request: AgentCommentRequest;
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
async function commentAuthority(input: AgentCommentInput, ctx: HubContext) {
  checked("agent-comment-request", input.request);
  return boundAuthority(
    {
      principal: input.principal,
      request: {
        reference: input.request.reference,
        binding: input.request.binding,
      },
    },
    ctx,
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
    await commentAuthority(input, ctx);
  },
  async run(input, ctx) {
    const row = await commentAuthority(input, ctx);
    const task = await getTask(ctx.db, ctx.workspaceId, row.task_id);
    if (!task || task.project_id !== row.project_id)
      throw new DomainError("boundary_escape", "bound task unavailable");
    const body = checkedCommentBody(input.request.body),
      inputHash = fingerprint(input);
    const id = await persistComment(ctx, row.task_id, body, "discussion", {
      humanId: null,
      delegationId: null,
    });
    await ctx.db
      .prepare(
        `INSERT INTO agent_work_effects
      (workspace_id, operation_key, kind, run_id, execution_id, assignment_generation, provider_session_id,
       project_id, source_task_id, target_task_id, comment_id, resulting_task_version, percent, confidence, input_hash, created_at)
      VALUES (?, ?, 'comment.add', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        agentWorkKey("comment", input.request.reference),
        row.run_id,
        row.execution_id,
        row.assignment_generation,
        input.request.binding.provider_session_id,
        row.project_id,
        row.task_id,
        row.task_id,
        id,
        inputHash,
        ctx.now,
      );
    return { id, origin: origin(row, input.request.binding.provider_session_id) };
  },
};
