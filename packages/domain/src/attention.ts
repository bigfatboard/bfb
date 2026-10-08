// ABOUTME: Implements typed human attention requests, answers, and ranked cross-project reads.
// ABOUTME: Runner-bound agents request; workspace humans answer under rechecked role, epoch, and project scope.

import type { SqlDatabase } from "@bfb/db";
import { createHash } from "node:crypto";
import {
  decodeWireDocument,
  type AgentAttentionRequest,
  type AgentSessionReference,
} from "@bfb/protocol";

import {
  assertEpoch,
  assertProjectAccess,
  assertRole,
  loadPrincipal,
  type AuthzPrincipal,
  type WorkspaceRole,
} from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";
import { canonicalLaunchJson, readLaunch, reauthorizeActiveRun } from "./launch-state.js";
import { runnerObject } from "./runner-crypto.js";
import type { RunnerPrincipal } from "./runners.js";
import { liveRun, type AgentWorkInput } from "./agent-work.js";
import { currentAgentSession } from "./agent-sessions.js";
import {
  delegatedReadTaskPredicate,
  readTaskPredicate,
  type DelegatedTaskReadAccess,
  type TaskReadAccess,
} from "./work-commands.js";
import { taskAccessPredicate, type TaskAccessAction } from "./task-access.js";
import {
  publicBusinessCommand,
  publicTaskRowAuthorityPredicate,
  type PublicBusinessAuthority,
  type PublicBusinessSelection,
} from "./public-business.js";

export const ATTENTION_KINDS = [
  "clarification",
  "review",
  "credential",
  "capability",
  "destructive_action",
  "blocker",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const ATTENTION_STATES = ["open", "answered", "resolved"] as const;
export type AttentionState = (typeof ATTENTION_STATES)[number];

export const ATTENTION_OBSERVATION_KINDS = ["requested", "answered", "resolved"] as const;

/** Bounded agent wait for a committed answer. The wait polls committed records; it never holds a Worker open. */
export const ATTENTION_WAIT_TIMEOUT_MS = 30_000;

/**
 * Minimum workspace role that may answer, per kind. Reviewers may answer
 * clarification and review requests; credential, capability, and
 * destructive-action requests require an owner; blockers require a member.
 * An answer never grants authority beyond recording the human decision.
 */
export const ATTENTION_KIND_ROLES: Record<AttentionKind, WorkspaceRole> = {
  clarification: "reviewer",
  review: "reviewer",
  blocker: "member",
  credential: "owner",
  capability: "owner",
  destructive_action: "owner",
};

/** Deterministic display rank: lower is more urgent. Ties break by request time, then ID. */
export const ATTENTION_KIND_RANK: Record<AttentionKind, number> = {
  blocker: 0,
  destructive_action: 1,
  credential: 2,
  capability: 3,
  review: 4,
  clarification: 5,
};

const ROLE_RANK: Record<WorkspaceRole, number> = { owner: 0, member: 1, reviewer: 2 };

export function attentionRoleSatisfies(role: WorkspaceRole, required: WorkspaceRole): boolean {
  return ROLE_RANK[role] <= ROLE_RANK[required];
}

export interface AttentionRecord {
  id: string;
  project_id: string;
  task_id: string;
  run_id: string;
  run_execution_id: string;
  assignment_generation: number;
  kind: AttentionKind;
  required_role: WorkspaceRole;
  reference_kind: string | null;
  reference_id: string | null;
  question: string;
  blocking: boolean;
  state: AttentionState;
  answer: string | null;
  answered_by_human_id: string | null;
  requested_at: string;
  first_response_at: string | null;
  answered_at: string | null;
  resolved_at: string | null;
  resource_version: number;
}

export interface RankedAttention extends AttentionRecord {
  task_title: string;
  project_name: string;
  run_result_state: string;
  run_activity: string;
  rank_reason: string;
}

export interface AttentionObservation {
  observation_id: string;
  attention_id: string;
  observed_kind: (typeof ATTENTION_OBSERVATION_KINDS)[number];
  actor_type: "runner" | "agent_run" | "human";
  actor_id: string;
  occurred_at: string;
}

function attentionKind(value: unknown): AttentionKind {
  if (typeof value !== "string" || !ATTENTION_KINDS.includes(value as AttentionKind)) {
    throw new DomainError("invalid_argument", "attention kind is invalid");
  }
  return value as AttentionKind;
}

function attentionState(value: unknown): AttentionState {
  if (typeof value !== "string" || !ATTENTION_STATES.includes(value as AttentionState)) {
    throw new DomainError("invalid_argument", "attention state is invalid");
  }
  return value as AttentionState;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new DomainError("invalid_argument", `${field} must be a string`);
  }
  const normalized = value.trim();
  if (
    !normalized ||
    [...normalized].length > maximum ||
    [...normalized].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new DomainError("invalid_argument", `${field} is invalid`);
  }
  return normalized;
}

function optionalBoundedText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return boundedText(value, field, maximum);
}

function version(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new DomainError("invalid_argument", `${field} is invalid`);
  }
  return Number(value);
}

export function rowToRecord(row: Record<string, unknown>): AttentionRecord {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    task_id: String(row.task_id),
    run_id: String(row.run_id),
    run_execution_id: String(row.run_execution_id),
    assignment_generation: Number(row.assignment_generation),
    kind: attentionKind(row.kind),
    required_role: row.required_role as WorkspaceRole,
    reference_kind: (row.reference_kind as string | null) ?? null,
    reference_id: (row.reference_id as string | null) ?? null,
    question: String(row.question),
    blocking: Number(row.blocking) === 1,
    state: attentionState(row.state),
    answer: (row.answer as string | null) ?? null,
    answered_by_human_id: (row.answered_by_human_id as string | null) ?? null,
    requested_at: String(row.requested_at),
    first_response_at: (row.first_response_at as string | null) ?? null,
    answered_at: (row.answered_at as string | null) ?? null,
    resolved_at: (row.resolved_at as string | null) ?? null,
    resource_version: Number(row.resource_version),
  };
}

export function rankReason(record: AttentionRecord): string {
  const blocking = record.blocking ? "blocking" : "non-blocking";
  return `${blocking} ${record.kind} requested ${record.requested_at}`;
}

async function requireAttentionHuman(ctx: HubContext): Promise<AuthzPrincipal> {
  if (!ctx.actorHumanId || ctx.actorDelegationId) {
    throw new DomainError("forbidden", "direct authorized human required");
  }
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertEpoch(principal, ctx.authorizationEpoch);
  assertRole(principal, ["owner", "member", "reviewer"]);
  return principal;
}

async function loadRequestForHuman(
  ctx: HubContext,
  principal: AuthzPrincipal,
  attentionId: string,
): Promise<AttentionRecord> {
  if (!isUlid(attentionId)) {
    throw new DomainError("not_found", "attention request not found");
  }
  const predicate = taskAccessPredicate(principal, "contribute", "task");
  const row = (await ctx.db
    .prepare(
      `SELECT attention.* FROM attention_requests AS attention
      JOIN tasks AS task ON task.workspace_id = attention.workspace_id
        AND task.id = attention.task_id AND task.project_id = attention.project_id
      JOIN runs AS run ON run.workspace_id = attention.workspace_id
        AND run.id = attention.run_id AND run.task_id = task.id
        AND run.project_id = task.project_id
      WHERE attention.workspace_id = ? AND attention.id = ? AND ${predicate.sql}`,
    )
    .get(ctx.workspaceId, attentionId, ...predicate.parameters)) as
    Record<string, unknown> | undefined;
  if (!row) {
    throw new DomainError("not_found", "attention request not found");
  }
  const record = rowToRecord(row);
  assertProjectAccess(principal, record.project_id);
  return record;
}

async function insertObservation(
  db: SqlDatabase,
  workspaceId: string,
  attentionId: string,
  observedKind: (typeof ATTENTION_OBSERVATION_KINDS)[number],
  actorType: AttentionObservation["actor_type"],
  actorId: string,
  now: string,
): Promise<string> {
  const observationId = randomUlid();
  await db
    .prepare(
      `INSERT INTO attention_observations
       (workspace_id, observation_id, attention_id, observed_kind, actor_type, actor_id, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(workspaceId, observationId, attentionId, observedKind, actorType, actorId, now);
  return observationId;
}

export interface RequestAttentionInput {
  principal: RunnerPrincipal;
  request: AgentAttentionRequest;
}

const fingerprint = (input: unknown) =>
  createHash("sha256").update(canonicalLaunchJson(input)).digest("hex");

/** Reauthorizes the complete calling execution without borrowing historical capture permission. */
export async function requireAttentionRun(
  input: AgentWorkInput,
  ctx: HubContext,
  supplied?: AgentSessionReference,
  action: TaskAccessAction = "read",
) {
  const row = await liveRun(input, ctx, action);
  const launch = await readLaunch(ctx.db, ctx.workspaceId, row.launch_id);
  try {
    await reauthorizeActiveRun(ctx, launch);
  } catch (error) {
    if (
      error instanceof DomainError &&
      ["request_rejected", "policy_widening", "invalid_policy"].includes(error.code)
    )
      throw new DomainError("policy_rejected", "current attention policy rejected");
    throw error;
  }
  const binding = await currentAgentSession(ctx, row, supplied);
  return { row, binding };
}

async function prepareAttentionRequest(input: RequestAttentionInput, ctx: HubContext) {
  runnerObject(input, ["principal", "request"]);
  const bytes = Buffer.from(JSON.stringify(input.request));
  const decoded = decodeWireDocument("agent-attention-request", bytes);
  if (bytes.length > 16_384 || !decoded.ok)
    throw new DomainError("request_rejected", "invalid attention request");
  const request = decoded.value as AgentAttentionRequest;
  const current = await requireAttentionRun(
    { principal: input.principal, request: request.reference },
    ctx,
    request.binding,
    "contribute",
  );
  if (!current.binding)
    throw new DomainError("session_not_bound", "attention requires a confirmed session");
  const question = boundedText(request.question, "attention question", 2048);
  const referenceKind = optionalBoundedText(request.reference_kind, "attention reference kind", 64);
  const referenceId = optionalBoundedText(request.reference_id, "attention reference", 128);
  if ((referenceKind === null) !== (referenceId === null))
    throw new DomainError("invalid_argument", "attention reference fields must be paired");
  return { ...current, request, question, referenceKind, referenceId };
}

function attentionReceipt(record: AttentionRecord) {
  return {
    id: record.id,
    kind: record.kind,
    state: record.state,
    resource_version: record.resource_version,
    project_id: record.project_id,
    task_id: record.task_id,
    run_id: record.run_id,
    run_execution_id: record.run_execution_id,
    assignment_generation: record.assignment_generation,
  };
}

export const requestAttentionCommand: HubCommand<RequestAttentionInput, AttentionRecord> = {
  name: "attention.request",
  authorize: async (input, ctx) => {
    await prepareAttentionRequest(input, ctx);
  },
  inputFingerprint: (input) => fingerprint(input.request),
  auditInput: (input) => ({
    executionId: input.request.reference.run_execution_id,
    generation: input.request.reference.assignment_generation,
    providerSessionId: input.request.binding.provider_session_id,
    kind: input.request.kind,
    blocking: input.request.blocking,
    questionChars: [...input.request.question].length,
  }),
  auditResult: attentionReceipt,
  async run(input, ctx) {
    const { row, request, question, referenceKind, referenceId } = await prepareAttentionRequest(
      input,
      ctx,
    );
    const requiredRole = ATTENTION_KIND_ROLES[request.kind];
    const id = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO attention_requests
         (workspace_id, id, project_id, task_id, run_id, run_execution_id,
          assignment_generation, kind, required_role, reference_kind, reference_id,
          question, blocking, state, answer, answered_by_human_id,
          requested_at, first_response_at, answered_at, resolved_at, resource_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, NULL, NULL, NULL, 1)`,
      )
      .run(
        ctx.workspaceId,
        id,
        row.project_id,
        row.task_id,
        row.run_id,
        row.execution_id,
        row.assignment_generation,
        request.kind,
        requiredRole,
        referenceKind,
        referenceId,
        question,
        request.blocking ? 1 : 0,
        ctx.now,
      );
    await insertObservation(
      ctx.db,
      ctx.workspaceId,
      id,
      "requested",
      "agent_run",
      row.run_id,
      ctx.now,
    );
    // D1 batch transactions forbid reads after a queued write, so the
    // committed record is constructed here instead of re-selected.
    return {
      id,
      project_id: row.project_id,
      task_id: row.task_id,
      run_id: row.run_id,
      run_execution_id: row.execution_id,
      assignment_generation: row.assignment_generation,
      kind: request.kind,
      required_role: requiredRole,
      reference_kind: referenceKind,
      reference_id: referenceId,
      question,
      blocking: request.blocking,
      state: "open" as AttentionState,
      answer: null,
      answered_by_human_id: null,
      requested_at: ctx.now,
      first_response_at: null,
      answered_at: null,
      resolved_at: null,
      resource_version: 1,
    };
  },
};

export interface AnswerAttentionInput {
  attentionId: string;
  expectedVersion: number;
  answer: string;
}

async function authorizeHumanAttention(
  input: ResolveAttentionInput | AnswerAttentionInput,
  ctx: HubContext,
  answering: boolean,
) {
  runnerObject(
    input,
    answering ? ["attentionId", "expectedVersion", "answer"] : ["attentionId", "expectedVersion"],
  );
  version(input.expectedVersion, "expected attention version");
  if (answering) boundedText((input as AnswerAttentionInput).answer, "attention answer", 2048);
  const principal = await requireAttentionHuman(ctx);
  const record = await loadRequestForHuman(ctx, principal, input.attentionId);
  if (!attentionRoleSatisfies(principal.role, record.required_role))
    throw new DomainError("forbidden", "attention requires an authorized human role");
  // Version and transition checks belong only to a new effect. A replay of
  // this actor's identical outcome still rechecks current authority above.
  return { principal, record };
}

const humanAttentionReplayAuthorities = new WeakMap<
  HubContext,
  Awaited<ReturnType<typeof authorizeHumanAttention>>
>();

async function replayHumanAttentionResult(
  result: AttentionRecord,
  ctx: HubContext,
): Promise<AttentionRecord> {
  const retained = humanAttentionReplayAuthorities.get(ctx);
  if (!retained) throw new DomainError("not_found", "attention request not found");
  const { principal, record } = retained;
  if (
    result.id !== record.id ||
    result.project_id !== record.project_id ||
    result.task_id !== record.task_id ||
    result.run_id !== record.run_id ||
    result.run_execution_id !== record.run_execution_id ||
    result.assignment_generation !== record.assignment_generation
  )
    throw new DomainError("not_found", "attention request not found");
  const predicate = taskAccessPredicate(principal, "contribute");
  const row = await ctx.db
    .prepare(
      `SELECT 1 AS authorized FROM attention_requests AS attention
       JOIN tasks AS task ON task.workspace_id = attention.workspace_id
         AND task.id = attention.task_id AND task.project_id = attention.project_id
       JOIN runs AS run ON run.workspace_id = attention.workspace_id
         AND run.id = attention.run_id AND run.task_id = task.id AND run.project_id = task.project_id
       JOIN workspace_members AS sponsor
         ON sponsor.workspace_id = task.workspace_id AND sponsor.human_id = ?
       WHERE attention.workspace_id = ? AND attention.id = ? AND attention.project_id = ?
         AND attention.task_id = ? AND attention.run_id = ? AND attention.run_execution_id = ?
         AND attention.assignment_generation = ?
         AND attention.project_id IN (SELECT value FROM json_each(?)) AND ${predicate.sql}
         AND CASE attention.required_role
           WHEN 'owner' THEN sponsor.role = 'owner'
           WHEN 'member' THEN sponsor.role IN ('owner', 'member')
           WHEN 'reviewer' THEN sponsor.role IN ('owner', 'member', 'reviewer')
           ELSE 0 END`,
    )
    .get(
      principal.humanId,
      ctx.workspaceId,
      record.id,
      record.project_id,
      record.task_id,
      record.run_id,
      record.run_execution_id,
      record.assignment_generation,
      JSON.stringify(principal.projectIds),
      ...predicate.parameters,
    );
  if (!row) throw new DomainError("not_found", "attention request not found");
  return result;
}

const answerAttentionBase: HubCommand<AnswerAttentionInput, AttentionRecord> = {
  name: "attention.answer",
  authorize: async (input, ctx) => {
    humanAttentionReplayAuthorities.set(ctx, await authorizeHumanAttention(input, ctx, true));
  },
  replayResult: replayHumanAttentionResult,
  inputFingerprint: fingerprint,
  auditInput: (input) => ({
    attentionId: (input as AnswerAttentionInput)?.attentionId,
    expectedVersion: (input as AnswerAttentionInput)?.expectedVersion,
    answerChars: [...(((input as AnswerAttentionInput)?.answer as string) ?? "")].length,
  }),
  auditResult: attentionReceipt,
  async run(input, ctx) {
    const { principal, record } = await authorizeHumanAttention(input, ctx, true);
    const expected = version(input.expectedVersion, "expected attention version");
    if (record.resource_version !== expected) {
      throw new DomainError("stale_version", "attention version conflict");
    }
    if (record.state !== "open") {
      throw new DomainError("already_answered", "attention request already has a committed answer");
    }
    const answer = boundedText(input.answer, "attention answer", 2048);
    const next = expected + 1;
    // The hub FIFO serializes workspace commands, so the version pre-check
    // above is the conflict guard; the conditional UPDATE is the backstop.
    // Queued D1 writes report no change counts, so the result is constructed.
    await ctx.db
      .prepare(
        `UPDATE attention_requests
         SET state = 'answered', answer = ?, answered_by_human_id = ?,
             answered_at = ?, first_response_at = ?, resource_version = ?
         WHERE workspace_id = ? AND id = ? AND resource_version = ?`,
      )
      .run(answer, principal.humanId, ctx.now, ctx.now, next, ctx.workspaceId, record.id, expected);
    await insertObservation(
      ctx.db,
      ctx.workspaceId,
      record.id,
      "answered",
      "human",
      principal.humanId,
      ctx.now,
    );
    return {
      ...record,
      state: "answered" as AttentionState,
      answer,
      answered_by_human_id: principal.humanId,
      first_response_at: ctx.now,
      answered_at: ctx.now,
      resource_version: next,
    };
  },
};

export interface ResolveAttentionInput {
  attentionId: string;
  expectedVersion: number;
}

const resolveAttentionBase: HubCommand<ResolveAttentionInput, AttentionRecord> = {
  name: "attention.resolve",
  authorize: async (input, ctx) => {
    humanAttentionReplayAuthorities.set(ctx, await authorizeHumanAttention(input, ctx, false));
  },
  replayResult: replayHumanAttentionResult,
  inputFingerprint: fingerprint,
  auditInput: (input) => ({
    attentionId: input.attentionId,
    expectedVersion: input.expectedVersion,
  }),
  auditResult: attentionReceipt,
  async run(input, ctx) {
    const { principal, record } = await authorizeHumanAttention(input, ctx, false);
    const expected = version(input.expectedVersion, "expected attention version");
    if (record.resource_version !== expected) {
      throw new DomainError("stale_version", "attention version conflict");
    }
    if (record.state !== "answered") {
      throw new DomainError(
        "invalid_transition",
        `attention in state ${record.state} cannot resolve`,
      );
    }
    const next = expected + 1;
    await ctx.db
      .prepare(
        `UPDATE attention_requests
         SET state = 'resolved', resolved_at = ?, resource_version = ?
         WHERE workspace_id = ? AND id = ? AND resource_version = ?`,
      )
      .run(ctx.now, next, ctx.workspaceId, record.id, expected);
    await insertObservation(
      ctx.db,
      ctx.workspaceId,
      record.id,
      "resolved",
      "human",
      principal.humanId,
      ctx.now,
    );
    return {
      ...record,
      state: "resolved" as AttentionState,
      resolved_at: ctx.now,
      resource_version: next,
    };
  },
};

/** Bound to the joined attention/task/run aliases; historical reads do not require liveness. */
export const ATTENTION_HISTORY_LINEAGE_SQL = `EXISTS (
  SELECT 1 FROM run_executions AS attention_execution
  JOIN execution_assignments AS attention_assignment
    ON attention_assignment.workspace_id = attention_execution.workspace_id
    AND attention_assignment.execution_id = attention_execution.id
    AND attention_assignment.assignment_generation = attention.assignment_generation
    AND attention_assignment.run_id = run.id
    AND attention_assignment.task_id = task.id
    AND attention_assignment.project_id = task.project_id
  WHERE attention_execution.workspace_id = attention.workspace_id
    AND attention_execution.id = attention.run_execution_id
    AND attention_execution.run_id = run.id)`;

/** Reads one request within the reader's project scope. Cross-project IDs stay hidden as null. */
export async function getAttention(
  db: SqlDatabase,
  workspaceId: string,
  projectIds: string[],
  attentionId: string,
  access?: TaskReadAccess,
): Promise<AttentionRecord | null> {
  if (!isUlid(attentionId) || projectIds.length === 0) {
    return null;
  }
  const placeholders = projectIds.map(() => "?").join(", ");
  const predicate = readTaskPredicate(access, "task");
  const row = (await db
    .prepare(
      `SELECT attention.* FROM attention_requests AS attention
       JOIN tasks AS task ON task.workspace_id = attention.workspace_id
         AND task.id = attention.task_id AND task.project_id = attention.project_id
       JOIN runs AS run ON run.workspace_id = attention.workspace_id
         AND run.id = attention.run_id AND run.task_id = task.id
         AND run.project_id = task.project_id
       WHERE attention.workspace_id = ? AND attention.id = ?
         AND attention.project_id IN (${placeholders}) AND ${predicate.sql}
         AND ${ATTENTION_HISTORY_LINEAGE_SQL}`,
    )
    .get(workspaceId, attentionId, ...projectIds, ...predicate.parameters)) as
    Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

/** Select body and observations together; an authorized empty history is not a denied parent. */
export async function getHumanAttentionDetail(
  db: SqlDatabase,
  workspaceId: string,
  projectIds: string[],
  attentionId: string,
  access: TaskReadAccess,
): Promise<{ attention: AttentionRecord; observations: AttentionObservation[] } | null> {
  if (!isUlid(attentionId) || projectIds.length === 0) return null;
  const predicate = readTaskPredicate(access);
  const rows = (await db
    .prepare(
      `SELECT attention.*, observation.observation_id,
              observation.attention_id AS observation_attention_id, observation.observed_kind,
              observation.actor_type, observation.actor_id, observation.occurred_at
       FROM attention_requests AS attention
       JOIN tasks AS task ON task.workspace_id = attention.workspace_id
         AND task.id = attention.task_id AND task.project_id = attention.project_id
       JOIN runs AS run ON run.workspace_id = attention.workspace_id
         AND run.id = attention.run_id AND run.task_id = task.id
         AND run.project_id = task.project_id
       LEFT JOIN attention_observations AS observation
         ON observation.workspace_id = attention.workspace_id
        AND observation.attention_id = attention.id
       WHERE attention.workspace_id = ? AND attention.id = ?
         AND attention.project_id IN (SELECT value FROM json_each(?)) AND ${predicate.sql}
         AND ${ATTENTION_HISTORY_LINEAGE_SQL}
       ORDER BY observation.occurred_at ASC, observation.rowid ASC`,
    )
    .all(workspaceId, attentionId, JSON.stringify(projectIds), ...predicate.parameters)) as Array<
    Record<string, unknown>
  >;
  const first = rows[0];
  if (!first) return null;
  return {
    attention: rowToRecord(first),
    observations: rows.flatMap((row) =>
      row.observation_id === null
        ? []
        : [
            {
              observation_id: String(row.observation_id),
              attention_id: String(row.observation_attention_id),
              observed_kind: row.observed_kind as AttentionObservation["observed_kind"],
              actor_type: row.actor_type as AttentionObservation["actor_type"],
              actor_id: String(row.actor_id),
              occurred_at: String(row.occurred_at),
            },
          ],
    ),
  };
}

/** Final canonical read bound to the preliminary lineage and original OAuth ceilings. */
export async function getDelegatedAttention(
  db: SqlDatabase,
  workspaceId: string,
  retained: AttentionRecord,
  access: DelegatedTaskReadAccess,
): Promise<AttentionRecord | null> {
  if (
    [
      retained.id,
      retained.task_id,
      retained.project_id,
      retained.run_id,
      retained.run_execution_id,
    ].some((id) => typeof id !== "string" || id.length !== 26 || !isUlid(id)) ||
    !Number.isSafeInteger(retained.assignment_generation) ||
    retained.assignment_generation < 1
  )
    return null;
  const predicate = delegatedReadTaskPredicate(access);
  const row = (await db
    .prepare(
      `SELECT attention.* FROM attention_requests AS attention
     JOIN tasks AS task ON task.workspace_id = attention.workspace_id
       AND task.id = attention.task_id AND task.project_id = attention.project_id
     JOIN runs AS run ON run.workspace_id = attention.workspace_id
       AND run.id = attention.run_id AND run.task_id = task.id
       AND run.project_id = task.project_id
     JOIN run_executions AS execution ON execution.workspace_id = attention.workspace_id
       AND execution.id = attention.run_execution_id AND execution.run_id = run.id
     JOIN execution_assignments AS assignment ON assignment.workspace_id = attention.workspace_id
       AND assignment.execution_id = execution.id
       AND assignment.assignment_generation = attention.assignment_generation
       AND assignment.run_id = run.id AND assignment.task_id = task.id
       AND assignment.project_id = task.project_id
     WHERE attention.workspace_id = ? AND attention.id = ?
       AND attention.task_id = ? AND attention.project_id = ? AND attention.run_id = ?
       AND attention.run_execution_id = ? AND attention.assignment_generation = ?
       AND ${predicate.sql}`,
    )
    .get(
      workspaceId,
      retained.id,
      retained.task_id,
      retained.project_id,
      retained.run_id,
      retained.run_execution_id,
      retained.assignment_generation,
      ...predicate.parameters,
    )) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

export interface ListAttentionOptions {
  state?: AttentionState;
  limit?: number;
}

/**
 * Lists open attention across the reader's projects in deterministic rank
 * order: blocking first, then kind severity, then oldest request, then ID.
 * The rank reason is returned with every item so the ordering stays explainable.
 */
export async function listAttention(
  db: SqlDatabase,
  workspaceId: string,
  projectIds: string[],
  options: ListAttentionOptions = {},
  access?: TaskReadAccess,
): Promise<RankedAttention[]> {
  if (projectIds.length === 0) {
    return [];
  }
  const state = options.state === undefined ? undefined : attentionState(options.state);
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new DomainError("invalid_argument", "attention list limit is invalid");
  }
  const placeholders = projectIds.map(() => "?").join(", ");
  const predicate = readTaskPredicate(access, "task");
  const rows = (await db
    .prepare(
      `SELECT attention.*,
              task.title AS task_title, project.name AS project_name,
              run.result_state AS run_result_state, run.activity AS run_activity
       FROM attention_requests AS attention
       JOIN tasks AS task ON task.workspace_id = attention.workspace_id AND task.id = attention.task_id
         AND task.project_id = attention.project_id
       JOIN projects AS project ON project.workspace_id = attention.workspace_id AND project.id = attention.project_id
       JOIN runs AS run ON run.workspace_id = attention.workspace_id AND run.id = attention.run_id
         AND run.task_id = task.id AND run.project_id = task.project_id
       WHERE attention.workspace_id = ? AND attention.project_id IN (${placeholders}) AND ${predicate.sql}
         AND ${ATTENTION_HISTORY_LINEAGE_SQL}
         ${state === undefined ? "" : "AND attention.state = ?"}
       ORDER BY attention.blocking DESC,
                CASE attention.kind
                  WHEN 'blocker' THEN 0
                  WHEN 'destructive_action' THEN 1
                  WHEN 'credential' THEN 2
                  WHEN 'capability' THEN 3
                  WHEN 'review' THEN 4
                  ELSE 5
                END ASC,
                attention.requested_at ASC, attention.id ASC
       LIMIT ?`,
    )
    .all(
      workspaceId,
      ...projectIds,
      ...predicate.parameters,
      ...(state === undefined ? [] : [state]),
      limit,
    )) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const record = rowToRecord(row);
    return {
      ...record,
      task_title: String(row.task_title),
      project_name: String(row.project_name),
      run_result_state: String(row.run_result_state),
      run_activity: String(row.run_activity),
      rank_reason: rankReason(record),
    };
  });
}

/** Lists the immutable raw observations for one in-scope request, oldest first. */
export async function listAttentionObservations(
  db: SqlDatabase,
  workspaceId: string,
  projectIds: string[],
  attentionId: string,
  access?: TaskReadAccess,
): Promise<AttentionObservation[]> {
  if (!isUlid(attentionId) || projectIds.length === 0) {
    return [];
  }
  const predicate = readTaskPredicate(access, "task");
  const placeholders = projectIds.map(() => "?").join(", ");
  const rows = (await db
    .prepare(
      `SELECT observation.observation_id, observation.attention_id, observation.observed_kind,
              observation.actor_type, observation.actor_id, observation.occurred_at
       FROM attention_observations AS observation
       JOIN attention_requests AS attention ON attention.workspace_id = observation.workspace_id
         AND attention.id = observation.attention_id
       JOIN tasks AS task ON task.workspace_id = attention.workspace_id
         AND task.id = attention.task_id AND task.project_id = attention.project_id
       JOIN runs AS run ON run.workspace_id = attention.workspace_id
         AND run.id = attention.run_id AND run.task_id = task.id
         AND run.project_id = task.project_id
       WHERE observation.workspace_id = ? AND observation.attention_id = ?
         AND attention.project_id IN (${placeholders}) AND ${predicate.sql}
         AND ${ATTENTION_HISTORY_LINEAGE_SQL}
       ORDER BY observation.occurred_at ASC, observation.rowid ASC`,
    )
    .all(workspaceId, attentionId, ...projectIds, ...predicate.parameters)) as Array<{
    observation_id: string;
    attention_id: string;
    observed_kind: (typeof ATTENTION_OBSERVATION_KINDS)[number];
    actor_type: AttentionObservation["actor_type"];
    actor_id: string;
    occurred_at: string;
  }>;
  return rows;
}

/** Current contribution and exact historical waiter lineage, without replaying a transition. */
export function publicAttentionBusinessSelection(
  authority: PublicBusinessAuthority,
  attentionId: string,
  record?: AttentionRecord,
  delegated = false,
): PublicBusinessSelection<AttentionRecord> {
  const task = publicTaskRowAuthorityPredicate(authority, "contribute", "public_attention_task");
  return {
    sql: `SELECT 1 AS permitted FROM attention_requests AS public_attention
      JOIN runs AS public_attention_run ON public_attention_run.workspace_id = public_attention.workspace_id
        AND public_attention_run.id = public_attention.run_id AND public_attention_run.task_id = public_attention.task_id
        AND public_attention_run.project_id = public_attention.project_id AND public_attention_run.purpose = 'work'
      JOIN tasks AS public_attention_task ON public_attention_task.workspace_id = public_attention_run.workspace_id
        AND public_attention_task.id = public_attention_run.task_id AND public_attention_task.project_id = public_attention_run.project_id
      JOIN run_executions AS public_attention_execution ON public_attention_execution.workspace_id = public_attention.workspace_id
        AND public_attention_execution.id = public_attention.run_execution_id AND public_attention_execution.run_id = public_attention_run.id
      JOIN execution_assignments AS public_attention_assignment ON public_attention_assignment.workspace_id = public_attention.workspace_id
        AND public_attention_assignment.execution_id = public_attention_execution.id
        AND public_attention_assignment.assignment_generation = public_attention.assignment_generation
        AND public_attention_assignment.run_id = public_attention_run.id
        AND public_attention_assignment.task_id = public_attention_task.id
        AND public_attention_assignment.project_id = public_attention_task.project_id
      JOIN workspace_members AS public_attention_member ON public_attention_member.workspace_id = public_attention.workspace_id
        AND public_attention_member.human_id = ?
      WHERE public_attention.workspace_id = ? AND public_attention.id = ? AND ${task.sql}
      ${
        record
          ? `AND public_attention.id = ? AND public_attention.project_id = ? AND public_attention.task_id = ? AND public_attention.run_id = ?
        AND public_attention.run_execution_id = ? AND public_attention.assignment_generation = ?`
          : ""
      }
      ${
        delegated
          ? "AND public_attention_run.result_state IN ('open','changes_requested','submitted')"
          : `AND CASE public_attention.required_role
        WHEN 'owner' THEN public_attention_member.role = 'owner' AND ${ROLE_RANK[authority.role]} = 0
        WHEN 'member' THEN public_attention_member.role IN ('owner','member') AND ${ROLE_RANK[authority.role]} <= 1
        WHEN 'reviewer' THEN public_attention_member.role IN ('owner','member','reviewer') ELSE 0 END`
      }`,
    parameters: [
      authority.humanId,
      authority.workspaceId,
      attentionId,
      ...task.parameters,
      ...(record
        ? [
            record.id,
            record.project_id,
            record.task_id,
            record.run_id,
            record.run_execution_id,
            record.assignment_generation,
          ]
        : []),
    ],
  };
}

export const answerAttentionCommand = publicBusinessCommand(answerAttentionBase, {
  admission: (input, authority) => {
    const selection = publicAttentionBusinessSelection(authority, input.attentionId);
    return { sql: `EXISTS (${selection.sql})`, parameters: selection.parameters };
  },
  delivery: (input, result, authority) =>
    publicAttentionBusinessSelection(authority, input.attentionId, result),
});
export const resolveAttentionCommand = publicBusinessCommand(resolveAttentionBase, {
  admission: (input, authority) => {
    const selection = publicAttentionBusinessSelection(authority, input.attentionId);
    return { sql: `EXISTS (${selection.sql})`, parameters: selection.parameters };
  },
  delivery: (input, result, authority) =>
    publicAttentionBusinessSelection(authority, input.attentionId, result),
});
