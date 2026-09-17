// ABOUTME: Implements typed human attention requests, answers, and ranked cross-project reads.
// ABOUTME: Runner-bound agents request; workspace humans answer under rechecked role, epoch, and project scope.

import type { SqlDatabase } from "@bfb/db";

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
import { launchRunner } from "./launch-state.js";
import { rejectRunnerRequest, runnerId, runnerObject } from "./runner-crypto.js";
import type { RunnerPrincipal } from "./runners.js";

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

function optionalBoundedText(
  value: unknown,
  field: string,
  maximum: number,
): string | null {
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

function rowToRecord(row: Record<string, unknown>): AttentionRecord {
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

function rankReason(record: AttentionRecord): string {
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
  const row = (await ctx.db
    .prepare(`SELECT * FROM attention_requests WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, attentionId)) as Record<string, unknown> | undefined;
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
  runId: string;
  executionId: string;
  assignmentGeneration: number;
  kind: AttentionKind;
  question: string;
  referenceKind?: string;
  referenceId?: string;
  blocking: boolean;
}

export const requestAttentionCommand: HubCommand<RequestAttentionInput, AttentionRecord> = {
  name: "attention.request",
  auditInput: (input) => ({
    runId: (input as RequestAttentionInput)?.runId,
    executionId: (input as RequestAttentionInput)?.executionId,
    kind: (input as RequestAttentionInput)?.kind,
    blocking: (input as RequestAttentionInput)?.blocking,
    questionChars: [...(((input as RequestAttentionInput)?.question as string) ?? "")].length,
  }),
  async run(raw, ctx) {
    const body = runnerObject(raw as unknown, [
      "principal",
      "runId",
      "executionId",
      "assignmentGeneration",
      "kind",
      "question",
      "referenceKind",
      "referenceId",
      "blocking",
    ]);
    const principal = await launchRunner(ctx, body.principal as RunnerPrincipal);
    const runId = runnerId(body.runId);
    const executionId = runnerId(body.executionId);
    const generation = body.assignmentGeneration;
    if (!Number.isSafeInteger(generation) || Number(generation) < 1) {
      rejectRunnerRequest();
    }
    const kind = body.kind;
    if (typeof kind !== "string" || !ATTENTION_KINDS.includes(kind as AttentionKind)) {
      rejectRunnerRequest();
    }
    let question: string;
    try {
      question = boundedText(body.question, "attention question", 2048);
    } catch {
      rejectRunnerRequest();
    }
    let referenceKind: string | null = null;
    let referenceId: string | null = null;
    try {
      referenceKind = optionalBoundedText(body.referenceKind, "attention reference kind", 64);
      const rawReference = optionalBoundedText(body.referenceId, "attention reference", 128);
      referenceId = rawReference;
      if (typeof body.blocking !== "boolean") {
        throw new DomainError("invalid_argument", "attention blocking flag is invalid");
      }
    } catch {
      rejectRunnerRequest();
    }
    if ((referenceKind === null) !== (referenceId === null)) {
      rejectRunnerRequest();
    }
    const binding = (await ctx.db
      .prepare(
        `SELECT a.runner_id, a.project_id, a.task_id, a.run_id,
                r.result_state
         FROM execution_assignments AS a
         JOIN runs AS r ON r.workspace_id = a.workspace_id AND r.id = a.run_id
         WHERE a.workspace_id = ? AND a.execution_id = ? AND a.assignment_generation = ?`,
      )
      .get(ctx.workspaceId, executionId, Number(generation))) as
      | {
          runner_id: string;
          project_id: string;
          task_id: string;
          run_id: string;
          result_state: string;
        }
      | undefined;
    if (!binding || binding.runner_id !== principal.runnerId || binding.run_id !== runId) {
      rejectRunnerRequest();
    }
    if (!principal.projectIds.includes(binding.project_id)) {
      rejectRunnerRequest();
    }
    if (binding.result_state !== "open" && binding.result_state !== "changes_requested") {
      throw new DomainError(
        "invalid_transition",
        `run in state ${binding.result_state} cannot request attention`,
      );
    }
    const requiredRole = ATTENTION_KIND_ROLES[kind as AttentionKind];
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
        binding.project_id,
        binding.task_id,
        runId,
        executionId,
        Number(generation),
        kind as string,
        requiredRole,
        referenceKind,
        referenceId,
        question!,
        body.blocking === true ? 1 : 0,
        ctx.now,
      );
    await insertObservation(
      ctx.db,
      ctx.workspaceId,
      id,
      "requested",
      "agent_run",
      runId,
      ctx.now,
    );
    const row = (await ctx.db
      .prepare(`SELECT * FROM attention_requests WHERE workspace_id = ? AND id = ?`)
      .get(ctx.workspaceId, id)) as Record<string, unknown>;
    return rowToRecord(row);
  },
};

export interface AnswerAttentionInput {
  attentionId: string;
  expectedVersion: number;
  answer: string;
}

export const answerAttentionCommand: HubCommand<AnswerAttentionInput, AttentionRecord> = {
  name: "attention.answer",
  auditInput: (input) => ({
    attentionId: (input as AnswerAttentionInput)?.attentionId,
    expectedVersion: (input as AnswerAttentionInput)?.expectedVersion,
    answerChars: [...(((input as AnswerAttentionInput)?.answer as string) ?? "")].length,
  }),
  async run(input, ctx) {
    const principal = await requireAttentionHuman(ctx);
    const record = await loadRequestForHuman(ctx, principal, input.attentionId);
    if (!attentionRoleSatisfies(principal.role, record.required_role)) {
      throw new DomainError(
        "forbidden",
        `answering this ${record.kind} request requires the ${record.required_role} role`,
      );
    }
    const expected = version(input.expectedVersion, "expected attention version");
    if (record.resource_version !== expected) {
      throw new DomainError("stale_version", "attention version conflict");
    }
    if (record.state !== "open") {
      throw new DomainError("already_answered", "attention request already has a committed answer");
    }
    const answer = boundedText(input.answer, "attention answer", 2048);
    const next = expected + 1;
    const updated = (await ctx.db
      .prepare(
        `UPDATE attention_requests
         SET state = 'answered', answer = ?, answered_by_human_id = ?,
             answered_at = ?, first_response_at = ?, resource_version = ?
         WHERE workspace_id = ? AND id = ? AND resource_version = ?
         RETURNING *`,
      )
      .get(
        answer,
        principal.humanId,
        ctx.now,
        ctx.now,
        next,
        ctx.workspaceId,
        record.id,
        expected,
      )) as Record<string, unknown> | undefined;
    if (!updated) {
      throw new DomainError("stale_version", "attention version conflict");
    }
    await insertObservation(
      ctx.db,
      ctx.workspaceId,
      record.id,
      "answered",
      "human",
      principal.humanId,
      ctx.now,
    );
    return rowToRecord(updated);
  },
};

export interface ResolveAttentionInput {
  attentionId: string;
  expectedVersion: number;
}

export const resolveAttentionCommand: HubCommand<ResolveAttentionInput, AttentionRecord> = {
  name: "attention.resolve",
  async run(input, ctx) {
    const principal = await requireAttentionHuman(ctx);
    const record = await loadRequestForHuman(ctx, principal, input.attentionId);
    if (!attentionRoleSatisfies(principal.role, record.required_role)) {
      throw new DomainError(
        "forbidden",
        `resolving this ${record.kind} request requires the ${record.required_role} role`,
      );
    }
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
    const updated = (await ctx.db
      .prepare(
        `UPDATE attention_requests
         SET state = 'resolved', resolved_at = ?, resource_version = ?
         WHERE workspace_id = ? AND id = ? AND resource_version = ?
         RETURNING *`,
      )
      .get(ctx.now, next, ctx.workspaceId, record.id, expected)) as
      | Record<string, unknown>
      | undefined;
    if (!updated) {
      throw new DomainError("stale_version", "attention version conflict");
    }
    await insertObservation(
      ctx.db,
      ctx.workspaceId,
      record.id,
      "resolved",
      "human",
      principal.humanId,
      ctx.now,
    );
    return rowToRecord(updated);
  },
};

/** Reads one request within the reader's project scope. Cross-project IDs stay hidden as null. */
export async function getAttention(
  db: SqlDatabase,
  workspaceId: string,
  projectIds: string[],
  attentionId: string,
): Promise<AttentionRecord | null> {
  if (!isUlid(attentionId) || projectIds.length === 0) {
    return null;
  }
  const placeholders = projectIds.map(() => "?").join(", ");
  const row = (await db
    .prepare(
      `SELECT * FROM attention_requests
       WHERE workspace_id = ? AND id = ? AND project_id IN (${placeholders})`,
    )
    .get(workspaceId, attentionId, ...projectIds)) as Record<string, unknown> | undefined;
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
  const rows = (await db
    .prepare(
      `SELECT a.*,
              t.title AS task_title, p.name AS project_name,
              r.result_state AS run_result_state, r.activity AS run_activity
       FROM attention_requests AS a
       JOIN tasks AS t ON t.workspace_id = a.workspace_id AND t.id = a.task_id
       JOIN projects AS p ON p.workspace_id = a.workspace_id AND p.id = a.project_id
       JOIN runs AS r ON r.workspace_id = a.workspace_id AND r.id = a.run_id
       WHERE a.workspace_id = ? AND a.project_id IN (${placeholders})
         ${state === undefined ? "" : "AND a.state = ?"}
       ORDER BY a.blocking DESC,
                CASE a.kind
                  WHEN 'blocker' THEN 0
                  WHEN 'destructive_action' THEN 1
                  WHEN 'credential' THEN 2
                  WHEN 'capability' THEN 3
                  WHEN 'review' THEN 4
                  ELSE 5
                END ASC,
                a.requested_at ASC, a.id ASC
       LIMIT ?`,
    )
    .all(
      workspaceId,
      ...projectIds,
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
): Promise<AttentionObservation[]> {
  const record = await getAttention(db, workspaceId, projectIds, attentionId);
  if (!record) {
    return [];
  }
  const rows = (await db
    .prepare(
      `SELECT observation_id, attention_id, observed_kind, actor_type, actor_id, occurred_at
       FROM attention_observations
       WHERE workspace_id = ? AND attention_id = ?
       ORDER BY occurred_at ASC, rowid ASC`,
    )
    .all(workspaceId, attentionId)) as Array<{
    observation_id: string;
    attention_id: string;
    observed_kind: (typeof ATTENTION_OBSERVATION_KINDS)[number];
    actor_type: AttentionObservation["actor_type"];
    actor_id: string;
    occurred_at: string;
  }>;
  return rows;
}
