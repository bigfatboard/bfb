// ABOUTME: Implements explicit result submission and human review decisions for runs.
// ABOUTME: Provider, session, and process endings never submit or accept; only these commands do.

import { assertEpoch, assertProjectAccess, assertRole, loadPrincipal } from "./authorization.js";
import type { SqlDatabase } from "@bfb/db";
import type { AgentEffectOrigin } from "@bfb/protocol";
import { authorizeAgentResult, type AgentResultInput } from "./agent-results.js";
import { canonicalLaunchJson, guardLaunchMutation, readLaunch } from "./launch-state.js";
import { runnerHash } from "./runner-crypto.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";
import { getTask, readTaskPredicate, type TaskReadAccess } from "./work-commands.js";
import { assertRunResultTransition, type ExecutionEndReason } from "./work-records.js";
import { agentTaskAccess } from "./agent-work.js";
import { prepareAgentArtifactAuthority } from "./artifact-agent-authority.js";
import {
  assertTaskAccess,
  sharedTaskPredicate,
  taskAccessPredicate,
  type TaskAccessAction,
} from "./task-access.js";

export const MAX_RESULT_SUMMARY_CHARS = 2048;
export const MAX_RESULT_LIMITATIONS_CHARS = 2048;
export const MAX_EVIDENCE_REFS = 20;
export const MAX_REVIEW_COMMENT_CHARS = 2048;

export interface EvidenceRef {
  kind: string;
  ref: string;
  version?: string | undefined;
  hash?: string | undefined;
}

export interface ResultSubmitter {
  kind: "agent_run" | "human";
  id: string;
}

export interface SubmitResultInput {
  runId: string;
  summary: string;
  limitations?: string | undefined;
  evidenceRefs?: EvidenceRef[] | undefined;
  gitBranch?: string | undefined;
  gitCommit?: string | undefined;
  gitDirty?: boolean | undefined;
}

export interface SubmissionRecord {
  id: string;
  run_id: string;
  version: number;
  summary: string;
  limitations: string;
  evidence_refs: EvidenceRef[];
  git_branch: string | null;
  git_commit: string | null;
  git_dirty: boolean | null;
  config_snapshot_id: string;
  config_hash: string;
  submitted_by_kind: "agent_run" | "human";
  submitted_by_id: string;
  submitted_at: string;
}

export interface SubmitResultResult {
  submission: SubmissionRecord;
  runResultState: "submitted";
  taskState: "review";
  runVersion: number;
  taskVersion: number;
  agentOrigin?: AgentEffectOrigin;
}
export type ResultSubmissionInput = SubmitResultInput | AgentResultInput;

export interface ReviewResultInput {
  runId: string;
  submissionId: string;
  expectedRunVersion: number;
  expectedTaskVersion: number;
  comment?: string | undefined;
}

export interface ReviewResultResult {
  decision: "request_changes" | "accept";
  runResultState: "changes_requested" | "accepted";
  taskState: "active" | "done";
  runVersion: number;
  taskVersion: number;
}

export interface CloseRunInput {
  runId: string;
  expectedRunVersion: number;
}

export interface HeadlessExitFacts {
  executionMode: "interactive" | "headless";
  endReason: ExecutionEndReason | null;
  exitCode: number | null;
  successAttested: boolean;
}

/**
 * The only permitted automatic submission: an unambiguous headless success.
 * Every other ending (Stop, tool failure, terminal close, session end,
 * non-zero exit, interactive mode, missing attestation) never qualifies.
 */
export function isUnambiguousHeadlessSuccess(facts: HeadlessExitFacts): boolean {
  return (
    facts.executionMode === "headless" &&
    facts.endReason === "process_exit" &&
    facts.exitCode === 0 &&
    facts.successAttested
  );
}

const EVIDENCE_KIND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function boundedText(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== "string") {
    throw new DomainError("invalid_argument", `${field} must be a string`);
  }
  const normalized = value.trim();
  if (
    [...normalized].length < minimum ||
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

function optionalBoundedText(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || (typeof value === "string" && value.trim().length === 0)) {
    return undefined;
  }
  return boundedText(value, field, 1, maximum);
}

function evidenceRefs(value: unknown): EvidenceRef[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_REFS) {
    throw new DomainError("invalid_argument", "evidence references are invalid");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DomainError("invalid_argument", "evidence reference is invalid");
    }
    const record = entry as Record<string, unknown>;
    const keys = new Set(Object.keys(record));
    for (const key of keys) {
      if (key !== "kind" && key !== "ref" && key !== "version" && key !== "hash") {
        throw new DomainError("invalid_argument", "evidence reference carries an unknown field");
      }
    }
    const kind = boundedText(record.kind, "evidence kind", 1, 64);
    if (!EVIDENCE_KIND_PATTERN.test(kind)) {
      throw new DomainError("invalid_argument", "evidence kind is invalid");
    }
    const ref = boundedText(record.ref, "evidence ref", 1, 512);
    let version: string | undefined;
    if (record.version !== undefined) {
      version = boundedText(record.version, "evidence version", 1, 128);
    }
    let hash: string | undefined;
    if (record.hash !== undefined) {
      if (typeof record.hash !== "string" || !SHA256_PATTERN.test(record.hash)) {
        throw new DomainError("invalid_argument", "evidence hash is invalid");
      }
      hash = record.hash;
    }
    const identity = `${kind}\n${ref}\n${version ?? ""}`;
    if (seen.has(identity)) {
      throw new DomainError("invalid_argument", "duplicate evidence reference");
    }
    seen.add(identity);
    return {
      kind,
      ref,
      ...(version === undefined ? {} : { version }),
      ...(hash === undefined ? {} : { hash }),
    };
  });
}

function gitFacts(input: SubmitResultInput): {
  branch: string | null;
  commit: string | null;
  dirty: number | null;
} {
  let branch: string | null = null;
  let commit: string | null = null;
  let dirty: number | null = null;
  if (input.gitBranch !== undefined) {
    branch = boundedText(input.gitBranch, "git branch", 1, 256);
  }
  if (input.gitCommit !== undefined) {
    if (typeof input.gitCommit !== "string" || !GIT_COMMIT_PATTERN.test(input.gitCommit)) {
      throw new DomainError("invalid_argument", "git commit is invalid");
    }
    commit = input.gitCommit;
  }
  if (input.gitDirty !== undefined) {
    if (typeof input.gitDirty !== "boolean") {
      throw new DomainError("invalid_argument", "git dirty is invalid");
    }
    dirty = input.gitDirty ? 1 : 0;
  }
  return { branch, commit, dirty };
}

function versionNumber(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new DomainError("invalid_argument", `${field} is invalid`);
  }
  return Number(value);
}

function reviewComment(value: unknown): string | null {
  const comment = optionalBoundedText(value, "review comment", MAX_REVIEW_COMMENT_CHARS);
  return comment ?? null;
}

interface RunRow {
  id: string;
  project_id: string;
  task_id: string;
  result_state: string;
  resource_version: number;
}

async function readRun(ctx: HubContext, runId: string): Promise<RunRow> {
  if (!isUlid(runId)) {
    throw new DomainError("not_found", "run not found");
  }
  const run = (await ctx.db
    .prepare(
      `SELECT run.id, run.project_id, run.task_id, run.result_state, run.resource_version
       FROM runs AS run JOIN tasks AS task
         ON task.workspace_id = run.workspace_id AND task.id = run.task_id
         AND task.project_id = run.project_id
       WHERE run.workspace_id = ? AND run.id = ? AND run.purpose = 'work'`,
    )
    .get(ctx.workspaceId, runId)) as RunRow | undefined;
  if (!run) {
    throw new DomainError("not_found", "run not found");
  }
  return run;
}

async function readLatestSnapshot(
  ctx: HubContext,
  runId: string,
): Promise<{ id: string; content_hash: string }> {
  const snapshot = (await ctx.db
    .prepare(
      `SELECT id, content_hash FROM run_configuration_snapshots
       WHERE workspace_id = ? AND run_id = ?
       ORDER BY snapshot_generation DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, runId)) as { id: string; content_hash: string } | undefined;
  if (!snapshot) {
    throw new DomainError("invalid_transition", "run has no configuration snapshot");
  }
  return snapshot;
}

/**
 * Resolves the submitting principal. Human submission requires a direct
 * owner/member (delegated remote clients cannot submit: their provider
 * label is reported metadata, not a verified agent process). Agents use
 * the separately checked exact request, never this legacy human shape.
 */
async function resolveSubmitter(ctx: HubContext, run: RunRow): Promise<ResultSubmitter> {
  if (ctx.actorDelegationId || ctx.actorSystemId) {
    throw new DomainError("forbidden", "delegated and system actors cannot submit results");
  }
  if (ctx.actorHumanId && !ctx.actorRunnerId) {
    const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
    assertEpoch(principal, ctx.authorizationEpoch);
    assertRole(principal, ["owner", "member"]);
    assertProjectAccess(principal, run.project_id);
    await assertTaskAccess(ctx.db, principal, run.task_id, "contribute");
    return { kind: "human", id: principal.humanId };
  }
  throw new DomainError("forbidden", "result submission requires a human or runner authority");
}

async function resolveReviewer(
  ctx: HubContext,
  run: RunRow,
  decisions: Array<"owner" | "member" | "reviewer">,
  action: TaskAccessAction = "contribute",
): Promise<string> {
  if (!ctx.actorHumanId || ctx.actorDelegationId || ctx.actorRunnerId || ctx.actorSystemId) {
    throw new DomainError("forbidden", "direct authorized human required");
  }
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertEpoch(principal, ctx.authorizationEpoch);
  assertRole(principal, decisions);
  assertProjectAccess(principal, run.project_id);
  await assertTaskAccess(ctx.db, principal, run.task_id, action);
  return principal.humanId;
}

function submissionRow(row: {
  id: string;
  run_id: string;
  version: number;
  summary: string;
  limitations: string;
  evidence_refs_json: string;
  git_branch: string | null;
  git_commit: string | null;
  git_dirty: number | null;
  config_snapshot_id: string;
  config_hash: string;
  submitted_by_kind: "agent_run" | "human";
  submitted_by_id: string;
  submitted_at: string;
}): SubmissionRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    version: row.version,
    summary: row.summary,
    limitations: row.limitations,
    evidence_refs: JSON.parse(row.evidence_refs_json) as EvidenceRef[],
    git_branch: row.git_branch,
    git_commit: row.git_commit,
    git_dirty: row.git_dirty === null ? null : row.git_dirty === 1,
    config_snapshot_id: row.config_snapshot_id,
    config_hash: row.config_hash,
    submitted_by_kind: row.submitted_by_kind,
    submitted_by_id: row.submitted_by_id,
    submitted_at: row.submitted_at,
  };
}

function resultFingerprint(input: unknown): string {
  // Transport JSON omits absent optional fields. Preserve supplied values before trimming.
  return runnerHash(canonicalLaunchJson(JSON.parse(JSON.stringify(input))));
}
async function submissionAuthority(input: ResultSubmissionInput, ctx: HubContext) {
  if ("request" in input) {
    const row = await authorizeAgentResult(input, ctx);
    const request = input.request;
    const fields: SubmitResultInput = {
      runId: row.run_id,
      summary: request.summary,
      ...(request.limitations === undefined ? {} : { limitations: request.limitations }),
      ...(request.evidence_refs === undefined ? {} : { evidenceRefs: request.evidence_refs }),
      ...(request.git_branch === undefined ? {} : { gitBranch: request.git_branch }),
      ...(request.git_commit === undefined ? {} : { gitCommit: request.git_commit }),
      ...(request.git_dirty === undefined ? {} : { gitDirty: request.git_dirty }),
    };
    const launch = await readLaunch(ctx.db, ctx.workspaceId, row.launch_id);
    return {
      fields,
      run: await readRun(ctx, row.run_id),
      submitter: { kind: "agent_run", id: row.run_id } as ResultSubmitter,
      snapshot: { id: launch.snapshot_id, content_hash: launch.snapshot_hash },
      origin: {
        run_id: row.run_id,
        run_execution_id: row.execution_id,
        assignment_generation: row.assignment_generation,
        provider_session_id: request.binding.provider_session_id,
      } satisfies AgentEffectOrigin,
      access: agentTaskAccess(row),
    };
  }
  const run = await readRun(ctx, input.runId);
  return {
    fields: input,
    run,
    submitter: await resolveSubmitter(ctx, run),
    access: {
      workspaceId: ctx.workspaceId,
      humanId: ctx.actorHumanId!,
      authorizationEpoch: ctx.authorizationEpoch,
    },
    snapshot: undefined,
    origin: undefined,
  };
}
function validateSubmission(input: SubmitResultInput) {
  return {
    summary: boundedText(input.summary, "result summary", 1, MAX_RESULT_SUMMARY_CHARS),
    limitations:
      optionalBoundedText(input.limitations, "result limitations", MAX_RESULT_LIMITATIONS_CHARS) ??
      "",
    refs: evidenceRefs(input.evidenceRefs),
    git: gitFacts(input),
  };
}

function resultDelegationScope(
  access: TaskReadAccess | undefined,
  scope: "bfb:read" | "bfb:task:write" | ReadonlyArray<"bfb:read" | "bfb:task:write">,
  taskAlias: "task" | "target_task",
) {
  if (!access?.delegationId) return { sql: "1", parameters: [] };
  const required = typeof scope === "string" ? [scope] : scope;
  const scopes = `CASE WHEN json_valid(result_delegation.scopes_json) THEN
    CASE WHEN json_type(result_delegation.scopes_json) = 'array'
      THEN result_delegation.scopes_json ELSE '[]' END ELSE '[]' END`;
  return {
    sql: `EXISTS (SELECT 1 FROM oauth_delegations AS result_delegation
      WHERE result_delegation.workspace_id = ${taskAlias}.workspace_id AND result_delegation.id = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(${scopes}) AS invalid_scope WHERE invalid_scope.type <> 'text')
        AND (SELECT COUNT(DISTINCT required_scope.value) FROM json_each(${scopes}) AS required_scope
          WHERE required_scope.value IN (${required.map(() => "?").join(",")})) = ${required.length})`,
    parameters: [access.delegationId, ...required],
  };
}

function runFreeEvidence(access: TaskReadAccess | undefined) {
  return access?.delegationId
    ? {
        sql: `EXISTS (SELECT 1 FROM oauth_delegations AS unbound_delegation
          WHERE unbound_delegation.workspace_id = source_artifact.workspace_id AND unbound_delegation.id = ?
            AND unbound_delegation.project_id IS NULL AND unbound_delegation.task_id IS NULL)`,
        parameters: [access.delegationId],
      }
    : { sql: "1", parameters: [] };
}

function resultEvidenceSelection(
  workspaceId: string,
  taskId: string,
  refs: EvidenceRef[],
  access: TaskReadAccess,
  originatingRunId?: string,
  targetRunId?: string,
) {
  const target = taskAccessPredicate(access, "contribute", "target_task");
  const credential = readTaskPredicate(access, "target_task");
  const source = readTaskPredicate(access, "source_task");
  const scope = resultDelegationScope(access, ["bfb:read", "bfb:task:write"], "target_task");
  const runFree = runFreeEvidence(access);
  return {
    sql: `SELECT * FROM (WITH requested_evidence AS MATERIALIZED (
      SELECT evidence.key AS ref_index, json_extract(evidence.value,'$.ref') AS ref,
        json_extract(evidence.value,'$.version') AS version FROM json_each(?) AS evidence
    ), current_target AS MATERIALIZED (
      SELECT target_task.workspace_id, target_task.id FROM tasks AS target_task
      WHERE target_task.workspace_id = ? AND target_task.id = ?
        AND ${target.sql} AND ${credential.sql} AND ${scope.sql}
        AND EXISTS (SELECT 1 FROM workspace_members AS result_member
          WHERE result_member.workspace_id = target_task.workspace_id AND result_member.human_id = ?
            AND result_member.role IN ('owner','member'))
        ${
          targetRunId
            ? `AND EXISTS (SELECT 1 FROM runs AS target_run WHERE target_run.workspace_id = target_task.workspace_id
          AND target_run.id = ? AND target_run.task_id = target_task.id
          AND target_run.project_id = target_task.project_id AND target_run.purpose = 'work')`
            : ""
        }
    ), current_sources AS MATERIALIZED (
      SELECT evidence.ref_index FROM requested_evidence AS evidence
      JOIN current_target AS target ON 1
      JOIN artifact_versions AS source_version
        ON source_version.workspace_id = target.workspace_id AND source_version.id = COALESCE(evidence.version,evidence.ref)
      JOIN artifacts AS source_artifact ON source_artifact.workspace_id = source_version.workspace_id
        AND source_artifact.id = source_version.artifact_id
        AND (evidence.version IS NULL OR source_artifact.id = evidence.ref)
      LEFT JOIN runs AS source_run ON source_run.workspace_id = source_artifact.workspace_id AND source_run.id = source_artifact.run_id
      LEFT JOIN tasks AS source_task ON source_task.workspace_id = source_run.workspace_id
        AND source_task.id = source_run.task_id AND source_task.project_id = source_run.project_id
      WHERE (? IS NULL OR source_artifact.run_id = ?)
        AND ((source_artifact.run_id IS NULL AND ${runFree.sql}) OR (
          ${source.sql} AND (${sharedTaskPredicate("source_task")} OR source_task.id = target.id)
        ))
    ) SELECT 1 AS authorized,
      ${access.delegationId ? `(SELECT expires_at FROM oauth_delegations WHERE workspace_id = target.workspace_id AND id = ?)` : "NULL"} AS credential_expires_at
      FROM current_target AS target
      WHERE (SELECT COUNT(*) FROM current_sources) = (SELECT COUNT(*) FROM requested_evidence))`,
    parameters: [
      JSON.stringify(refs.filter((ref) => ref.kind === "artifact_version")),
      workspaceId,
      taskId,
      ...target.parameters,
      ...credential.parameters,
      ...scope.parameters,
      access.humanId,
      ...(targetRunId ? [targetRunId] : []),
      originatingRunId ?? null,
      originatingRunId ?? null,
      ...runFree.parameters,
      ...source.parameters,
      ...(access.delegationId ? [access.delegationId] : []),
    ],
  };
}

/** Select every exact reference together; no earlier source check survives later awaited work. */
export async function authorizeResultEvidence(
  db: SqlDatabase,
  workspaceId: string,
  taskId: string,
  refs: EvidenceRef[],
  access: TaskReadAccess,
  originatingRunId?: string,
  targetRunId?: string,
): Promise<void> {
  const query = resultEvidenceSelection(
    workspaceId,
    taskId,
    refs,
    access,
    originatingRunId,
    targetRunId,
  );
  const current = (await db.prepare(query.sql).get(...query.parameters)) as
    { credential_expires_at: string | null } | undefined;
  if (
    !current ||
    (access.delegationId && !(Date.parse(current.credential_expires_at ?? "") > Date.now()))
  )
    throw new DomainError("not_found", "evidence artifact not found");
}

/** The same current all-reference fact guards the entire committing D1 batch. */
export async function guardResultEvidence(
  ctx: HubContext,
  taskId: string,
  refs: EvidenceRef[],
  access: TaskReadAccess,
  originatingRunId?: string,
  targetRunId?: string,
) {
  const query = resultEvidenceSelection(
    ctx.workspaceId,
    taskId,
    refs,
    access,
    originatingRunId,
    targetRunId,
  );
  const id = randomUlid();
  await ctx.db
    .prepare(
      `INSERT INTO artifact_mutation_guards (id,valid)
    SELECT ?, CASE WHEN EXISTS (${query.sql}) THEN 1 ELSE 0 END`,
    )
    .run(id, ...query.parameters);
  await ctx.db.prepare("DELETE FROM artifact_mutation_guards WHERE id = ?").run(id);
}

/** Cache payloads are untrusted historical data, not authorization evidence. */
export function cachedResultEvidence(
  result: { submission: SubmissionRecord },
  runId: string,
): EvidenceRef[] {
  try {
    if (
      !result?.submission ||
      result.submission.run_id !== runId ||
      !Array.isArray(result.submission.evidence_refs)
    )
      throw new DomainError("invalid_argument", "invalid result cache");
    const refs = evidenceRefs(result.submission.evidence_refs);
    if (canonicalLaunchJson(refs) !== canonicalLaunchJson(result.submission.evidence_refs))
      throw new DomainError("invalid_argument", "invalid result cache");
    return refs;
  } catch (error) {
    if (error instanceof DomainError)
      throw new DomainError("not_found", "evidence artifact not found");
    throw error;
  }
}

function resultEvidenceProjection(access?: TaskReadAccess) {
  const predicate = readTaskPredicate(access, "source_task");
  const runFree = runFreeEvidence(access);
  // Materialized expression boundaries keep D1's depth limit while selecting
  // the target, every bounded source and the returned content in one statement.
  return {
    sql: `normalized_evidence AS MATERIALIZED (
      SELECT submission.workspace_id, submission.id AS submission_id, submission.target_task_id,
        element.key AS ref_index, CASE WHEN element.type = 'object' THEN element.value ELSE '{}' END AS value
      FROM authorized_submissions AS submission,
        json_each(CASE WHEN json_valid(submission.evidence_refs_json) THEN
          CASE WHEN json_type(submission.evidence_refs_json) = 'array'
            AND json_array_length(submission.evidence_refs_json) <= ${MAX_EVIDENCE_REFS}
            THEN submission.evidence_refs_json ELSE '[]' END ELSE '[]' END) AS element
    ), typed_evidence AS MATERIALIZED (
      SELECT evidence.*, json_extract(evidence.value,'$.kind') AS kind,
        json_extract(evidence.value,'$.ref') AS ref, json_type(evidence.value,'$.ref') AS ref_type,
        json_extract(evidence.value,'$.version') AS version, json_type(evidence.value,'$.version') AS version_type
      FROM normalized_evidence AS evidence
      WHERE NOT EXISTS (SELECT 1 FROM json_each(evidence.value) AS evidence_field
        GROUP BY evidence_field.key HAVING COUNT(*) > 1)
    ), resolved_evidence AS MATERIALIZED (
      SELECT evidence.*, source_version.id AS source_version_id, source_artifact.id AS source_artifact_id,
        source_artifact.run_id AS source_run_id, source_task.id AS source_task_id,
        ${sharedTaskPredicate("source_task")} AS source_shared,
        ${runFree.sql} AS run_free_authorized
      FROM typed_evidence AS evidence
      LEFT JOIN artifact_versions AS source_version
        ON source_version.workspace_id = evidence.workspace_id AND evidence.kind = 'artifact_version'
          AND source_version.id = COALESCE(evidence.version,evidence.ref)
      LEFT JOIN artifacts AS source_artifact
        ON source_artifact.workspace_id = evidence.workspace_id
          AND source_artifact.id = source_version.artifact_id
          AND (evidence.version_type IS NULL OR source_artifact.id = evidence.ref)
      LEFT JOIN runs AS source_run ON source_run.workspace_id = source_artifact.workspace_id AND source_run.id = source_artifact.run_id
      LEFT JOIN tasks AS source_task ON source_task.workspace_id = source_run.workspace_id
        AND source_task.id = source_run.task_id AND source_task.project_id = source_run.project_id
    ), authorized_source_tasks AS MATERIALIZED (
      SELECT source_task.workspace_id, source_task.id FROM tasks AS source_task
      JOIN (SELECT DISTINCT workspace_id,source_task_id FROM resolved_evidence WHERE kind = 'artifact_version') AS candidate
        ON candidate.workspace_id = source_task.workspace_id AND candidate.source_task_id = source_task.id
      WHERE ${predicate.sql}
    ), visible_evidence AS MATERIALIZED (
      SELECT evidence.submission_id, evidence.ref_index, evidence.value FROM resolved_evidence AS evidence
      LEFT JOIN authorized_source_tasks AS source ON source.workspace_id = evidence.workspace_id AND source.id = evidence.source_task_id
      WHERE evidence.kind <> 'artifact_version' OR (
        evidence.source_version_id IS NOT NULL AND evidence.source_artifact_id IS NOT NULL
        AND evidence.ref_type = 'text' AND (evidence.version_type IS NULL OR evidence.version_type = 'text')
        AND ((evidence.source_run_id IS NULL AND evidence.run_free_authorized)
          OR (source.id IS NOT NULL AND (evidence.source_shared OR source.id = evidence.target_task_id)))
      )
    )`,
    parameters: [...runFree.parameters, ...predicate.parameters],
  };
}

export const submitResultCommand: HubCommand<ResultSubmissionInput, SubmitResultResult> = {
  name: "result.submit",
  authorize: async (input, ctx) => {
    const authority = await submissionAuthority(input, ctx);
    const { refs } = validateSubmission(authority.fields);
    await authorizeResultEvidence(
      ctx.db,
      ctx.workspaceId,
      authority.run.task_id,
      refs,
      authority.access,
      "request" in input ? authority.run.id : undefined,
      authority.run.id,
    );
  },
  replayResult: async (result, ctx, input) => {
    const hasArtifacts =
      Array.isArray(result?.submission?.evidence_refs) &&
      result.submission.evidence_refs.some((ref) => ref?.kind === "artifact_version");
    try {
      const fresh = { ...ctx, now: new Date().toISOString() };
      const authority = await submissionAuthority(input, fresh);
      const refs = cachedResultEvidence(result, authority.run.id);
      if (
        canonicalLaunchJson(result.agentOrigin ?? null) !==
        canonicalLaunchJson(authority.origin ?? null)
      )
        throw new DomainError("not_found", "evidence artifact not found");
      await authorizeResultEvidence(
        fresh.db,
        fresh.workspaceId,
        authority.run.task_id,
        refs,
        authority.access,
        "request" in input ? authority.run.id : undefined,
        authority.run.id,
      );
      return result;
    } catch (error) {
      if (hasArtifacts && error instanceof DomainError)
        throw new DomainError("not_found", "evidence artifact not found");
      throw error;
    }
  },
  inputFingerprint: (input) => resultFingerprint("request" in input ? input.request : input),
  auditInput: (input) =>
    "request" in input
      ? {
          executionId: input.request.reference.run_execution_id,
          generation: input.request.reference.assignment_generation,
          sessionId: input.request.binding.provider_session_id,
          summaryLength: [...input.request.summary].length,
          evidenceRefs: input.request.evidence_refs?.length ?? 0,
        }
      : {
          runId: input.runId,
          summaryLength: typeof input.summary === "string" ? [...input.summary].length : 0,
          evidenceRefs: input.evidenceRefs?.length ?? 0,
        },
  auditResult: (result) => ({
    submission: {
      id: result.submission.id,
      version: result.submission.version,
      run_id: result.submission.run_id,
      submitted_by_kind: result.submission.submitted_by_kind,
      submitted_by_id: result.submission.submitted_by_id,
    },
    runResultState: result.runResultState,
    taskState: result.taskState,
    runVersion: result.runVersion,
    taskVersion: result.taskVersion,
    ...(result.agentOrigin ? { origin: result.agentOrigin } : {}),
  }),
  async run(input, ctx) {
    const authority = await submissionAuthority(input, ctx);
    const { run, submitter } = authority;
    const task = await getTask(ctx.db, ctx.workspaceId, run.task_id, authority.access);
    if (!task) {
      throw new DomainError("not_found", "task not found");
    }
    const { summary, limitations, refs, git } = validateSubmission(authority.fields);
    await authorizeResultEvidence(
      ctx.db,
      ctx.workspaceId,
      run.task_id,
      refs,
      authority.access,
      "request" in input ? run.id : undefined,
      run.id,
    );
    assertRunResultTransition(run.result_state as "open", "submitted");
    if (task.state !== "active") {
      throw new DomainError("invalid_transition", "submission requires an active task");
    }
    const snapshot = authority.snapshot ?? (await readLatestSnapshot(ctx, run.id));
    const current = (await ctx.db
      .prepare(
        `SELECT COALESCE(MAX(version), 0) AS latest FROM result_submissions
         WHERE workspace_id = ? AND run_id = ?`,
      )
      .get(ctx.workspaceId, run.id)) as { latest: number };
    const nextVersion = current.latest + 1;
    const nextRunVersion = run.resource_version + 1;
    const nextTaskVersion = task.resource_version + 1;
    const id = randomUlid();
    const localAuthority =
      "request" in input
        ? await prepareAgentArtifactAuthority(
            ctx,
            input.principal,
            input.request.reference,
            input.request.binding,
          )
        : undefined;
    await guardResultEvidence(
      ctx,
      run.task_id,
      refs,
      authority.access,
      "request" in input ? run.id : undefined,
      run.id,
    );
    if (localAuthority)
      await guardLaunchMutation(
        ctx,
        localAuthority.witness.predicate,
        localAuthority.witness.params,
      );
    await ctx.db
      .prepare(
        `INSERT INTO result_submissions
         (workspace_id, id, run_id, version, summary, limitations, evidence_refs_json,
          git_branch, git_commit, git_dirty, config_snapshot_id, config_hash,
          submitted_by_kind, submitted_by_id, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        id,
        run.id,
        nextVersion,
        summary,
        limitations,
        JSON.stringify(refs),
        git.branch,
        git.commit,
        git.dirty,
        snapshot.id,
        snapshot.content_hash,
        submitter.kind,
        submitter.id,
        ctx.now,
      );
    await ctx.db
      .prepare(
        `UPDATE runs SET result_state = 'submitted', resource_version = ?
         WHERE workspace_id = ? AND id = ? AND result_state IN ('open', 'changes_requested')`,
      )
      .run(nextRunVersion, ctx.workspaceId, run.id);
    await ctx.db
      .prepare(
        `UPDATE tasks SET state = 'review', resource_version = ?
         WHERE workspace_id = ? AND id = ? AND state = 'active'`,
      )
      .run(nextTaskVersion, ctx.workspaceId, task.id);
    return {
      submission: {
        id,
        run_id: run.id,
        version: nextVersion,
        summary,
        limitations,
        evidence_refs: refs,
        git_branch: git.branch,
        git_commit: git.commit,
        git_dirty: git.dirty === null ? null : git.dirty === 1,
        config_snapshot_id: snapshot.id,
        config_hash: snapshot.content_hash,
        submitted_by_kind: submitter.kind,
        submitted_by_id: submitter.id,
        submitted_at: ctx.now,
      },
      runResultState: "submitted",
      taskState: "review",
      runVersion: nextRunVersion,
      taskVersion: nextTaskVersion,
      ...(authority.origin ? { agentOrigin: authority.origin } : {}),
    };
  },
};

async function latestSubmission(
  ctx: HubContext,
  runId: string,
): Promise<SubmissionRecord | undefined> {
  const row = (await ctx.db
    .prepare(
      `SELECT id, run_id, version, summary, limitations, evidence_refs_json,
              git_branch, git_commit, git_dirty, config_snapshot_id, config_hash,
              submitted_by_kind, submitted_by_id, submitted_at
       FROM result_submissions
       WHERE workspace_id = ? AND run_id = ?
       ORDER BY version DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, runId)) as
    | {
        id: string;
        run_id: string;
        version: number;
        summary: string;
        limitations: string;
        evidence_refs_json: string;
        git_branch: string | null;
        git_commit: string | null;
        git_dirty: number | null;
        config_snapshot_id: string;
        config_hash: string;
        submitted_by_kind: "agent_run" | "human";
        submitted_by_id: string;
        submitted_at: string;
      }
    | undefined;
  return row ? submissionRow(row) : undefined;
}

async function reviewRun(
  ctx: HubContext,
  input: ReviewResultInput,
  decision: "request_changes" | "accept",
): Promise<ReviewResultResult> {
  const run = await readRun(ctx, input.runId);
  const reviewer =
    decision === "accept"
      ? await resolveReviewer(ctx, run, ["owner", "member"])
      : await resolveReviewer(ctx, run, ["owner", "member", "reviewer"]);
  if (!isUlid(input.submissionId)) {
    throw new DomainError("invalid_argument", "review targets the latest submission only");
  }
  if (run.result_state !== "submitted") {
    throw new DomainError("invalid_transition", "review requires a submitted run");
  }
  assertRunResultTransition("submitted", decision === "accept" ? "accepted" : "changes_requested");
  const task = await getTask(ctx.db, ctx.workspaceId, run.task_id, {
    workspaceId: ctx.workspaceId,
    humanId: reviewer,
    authorizationEpoch: ctx.authorizationEpoch,
  });
  if (!task || task.state !== "review") {
    throw new DomainError("invalid_transition", "review requires a task in review");
  }
  const expectedRunVersion = versionNumber(input.expectedRunVersion, "expected run version");
  const expectedTaskVersion = versionNumber(input.expectedTaskVersion, "expected task version");
  if (run.resource_version !== expectedRunVersion) {
    throw new DomainError("stale_version", "run version conflict");
  }
  if (task.resource_version !== expectedTaskVersion) {
    throw new DomainError("stale_version", "task version conflict");
  }
  const submission = await latestSubmission(ctx, run.id);
  if (!submission || submission.id !== input.submissionId) {
    throw new DomainError("invalid_argument", "review targets the latest submission only");
  }
  const comment = reviewComment(input.comment);
  const nextRunState = decision === "accept" ? "accepted" : "changes_requested";
  const nextTaskState = decision === "accept" ? "done" : "active";
  const nextRunVersion = run.resource_version + 1;
  const nextTaskVersion = task.resource_version + 1;
  await ctx.db
    .prepare(
      `INSERT INTO result_reviews
       (workspace_id, id, run_id, submission_id, submission_version,
        decision, reviewer_human_id, comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.workspaceId,
      randomUlid(),
      run.id,
      submission.id,
      submission.version,
      decision,
      reviewer,
      comment,
      ctx.now,
    );
  await ctx.db
    .prepare(
      `UPDATE runs SET result_state = ?, resource_version = ?
       WHERE workspace_id = ? AND id = ? AND result_state = 'submitted'`,
    )
    .run(nextRunState, nextRunVersion, ctx.workspaceId, run.id);
  await ctx.db
    .prepare(
      `UPDATE tasks SET state = ?, resource_version = ?
       WHERE workspace_id = ? AND id = ? AND state = 'review'`,
    )
    .run(nextTaskState, nextTaskVersion, ctx.workspaceId, task.id);
  return {
    decision,
    runResultState: nextRunState,
    taskState: nextTaskState,
    runVersion: nextRunVersion,
    taskVersion: nextTaskVersion,
  };
}

async function reviewAuthority(
  input: ReviewResultInput,
  ctx: HubContext,
  roles: Array<"owner" | "member" | "reviewer">,
) {
  await resolveReviewer(ctx, await readRun(ctx, input.runId), roles);
  if (!isUlid(input.submissionId))
    throw new DomainError("invalid_argument", "invalid submission reference");
  versionNumber(input.expectedRunVersion, "expected run version");
  versionNumber(input.expectedTaskVersion, "expected task version");
  reviewComment(input.comment);
}
const reviewAuditInput = (input: ReviewResultInput) => ({
  runId: input.runId,
  submissionId: input.submissionId,
  expectedRunVersion: input.expectedRunVersion,
  expectedTaskVersion: input.expectedTaskVersion,
  commentLength: typeof input.comment === "string" ? [...input.comment].length : 0,
});
async function closeAuthority(input: CloseRunInput, ctx: HubContext) {
  await resolveReviewer(ctx, await readRun(ctx, input.runId), ["owner", "member"], "edit");
  versionNumber(input.expectedRunVersion, "expected run version");
}
export const requestChangesCommand: HubCommand<ReviewResultInput, ReviewResultResult> = {
  name: "result.request_changes",
  authorize: (input, ctx) => reviewAuthority(input, ctx, ["owner", "member", "reviewer"]),
  inputFingerprint: resultFingerprint,
  auditInput: reviewAuditInput,
  async run(input, ctx) {
    return reviewRun(ctx, input, "request_changes");
  },
};

export const acceptResultCommand: HubCommand<ReviewResultInput, ReviewResultResult> = {
  name: "result.accept",
  authorize: (input, ctx) => reviewAuthority(input, ctx, ["owner", "member"]),
  inputFingerprint: resultFingerprint,
  auditInput: reviewAuditInput,
  async run(input, ctx) {
    return reviewRun(ctx, input, "accept");
  },
};

export const failRunCommand: HubCommand<CloseRunInput, { runResultState: "failed" }> = {
  name: "result.fail",
  authorize: closeAuthority,
  inputFingerprint: resultFingerprint,
  async run(input, ctx) {
    const run = await readRun(ctx, input.runId);
    await resolveReviewer(ctx, run, ["owner", "member"], "edit");
    assertRunResultTransition(run.result_state as "open", "failed");
    const expected = versionNumber(input.expectedRunVersion, "expected run version");
    if (run.resource_version !== expected) {
      throw new DomainError("stale_version", "run version conflict");
    }
    await ctx.db
      .prepare(
        `UPDATE runs SET result_state = 'failed', resource_version = ?
         WHERE workspace_id = ? AND id = ? AND result_state IN ('open', 'changes_requested')`,
      )
      .run(expected + 1, ctx.workspaceId, run.id);
    return { runResultState: "failed" };
  },
};

export const cancelRunCommand: HubCommand<CloseRunInput, { runResultState: "cancelled" }> = {
  name: "result.cancel",
  authorize: closeAuthority,
  inputFingerprint: resultFingerprint,
  async run(input, ctx) {
    const run = await readRun(ctx, input.runId);
    await resolveReviewer(ctx, run, ["owner", "member"], "edit");
    assertRunResultTransition(run.result_state as "open", "cancelled");
    const expected = versionNumber(input.expectedRunVersion, "expected run version");
    if (run.resource_version !== expected) {
      throw new DomainError("stale_version", "run version conflict");
    }
    await ctx.db
      .prepare(
        `UPDATE runs SET result_state = 'cancelled', resource_version = ?
         WHERE workspace_id = ? AND id = ? AND result_state IN ('open', 'changes_requested')`,
      )
      .run(expected + 1, ctx.workspaceId, run.id);
    return { runResultState: "cancelled" };
  },
};

export interface SubmissionView extends SubmissionRecord {
  superseded: boolean;
  outdated: boolean;
  outdated_reasons: Array<"superseded" | "config_changed" | "evidence_changed">;
}

/**
 * Lists a run's submissions newest-first with computed outdated flags.
 * History is never mutated: `superseded` means a newer version exists,
 * `config_changed` means the bound config hash differs from the run's
 * latest snapshot, and `evidence_changed` compares bound ref versions
 * against the caller-supplied current version map (`kind\nref` → version).
 * Known artifact sources are current-ACL selected; other evidence stays opaque.
 */
export async function listResultSubmissions(
  db: {
    prepare(query: string): {
      get(...params: unknown[]): Promise<unknown>;
      all(...params: unknown[]): Promise<unknown[]>;
    };
  },
  workspaceId: string,
  runId: string,
  currentEvidenceVersions: ReadonlyMap<string, string> = new Map(),
  access?: TaskReadAccess,
): Promise<SubmissionView[]> {
  const taskPredicate = readTaskPredicate(access, "task");
  const scope = resultDelegationScope(access, "bfb:read", "task");
  const predicate = {
    sql: `(${taskPredicate.sql} AND ${scope.sql})`,
    parameters: [...taskPredicate.parameters, ...scope.parameters],
  };
  const current = await db
    .prepare(
      `SELECT run.id FROM runs AS run JOIN tasks AS task
    ON task.workspace_id = run.workspace_id AND task.id = run.task_id
      AND task.project_id = run.project_id
    WHERE run.workspace_id = ? AND run.id = ? AND ${predicate.sql}`,
    )
    .get(workspaceId, runId, ...predicate.parameters);
  if (!current) return [];
  const evidence = resultEvidenceProjection(access);
  const rows = (await db
    .prepare(
      `SELECT * FROM (WITH authorized_submissions AS MATERIALIZED (
        SELECT submission.*, task.id AS target_task_id,
          (SELECT snapshot.content_hash FROM run_configuration_snapshots AS snapshot
           WHERE snapshot.workspace_id = run.workspace_id AND snapshot.run_id = run.id
           ORDER BY snapshot.snapshot_generation DESC LIMIT 1) AS current_config_hash
        FROM result_submissions AS submission
        JOIN runs AS run ON run.workspace_id = submission.workspace_id AND run.id = submission.run_id
        JOIN tasks AS task ON task.workspace_id = run.workspace_id
          AND task.id = run.task_id AND task.project_id = run.project_id
        WHERE submission.workspace_id = ? AND submission.run_id = ? AND ${predicate.sql}
      ), ${evidence.sql}
      SELECT submission.id, submission.run_id, submission.version, submission.summary,
              submission.limitations, (SELECT json_group_array(json(visible.value))
                FROM (SELECT value FROM visible_evidence WHERE submission_id = submission.id ORDER BY ref_index) AS visible) AS evidence_refs_json,
              submission.git_branch, submission.git_commit, submission.git_dirty,
              submission.config_snapshot_id, submission.config_hash,
              submission.submitted_by_kind, submission.submitted_by_id, submission.submitted_at,
              submission.current_config_hash
       FROM authorized_submissions AS submission ORDER BY submission.version DESC)`,
    )
    .all(workspaceId, runId, ...predicate.parameters, ...evidence.parameters)) as Array<{
    id: string;
    run_id: string;
    version: number;
    summary: string;
    limitations: string;
    evidence_refs_json: string;
    git_branch: string | null;
    git_commit: string | null;
    git_dirty: number | null;
    config_snapshot_id: string;
    config_hash: string;
    submitted_by_kind: "agent_run" | "human";
    submitted_by_id: string;
    submitted_at: string;
    current_config_hash: string | null;
  }>;
  const views: SubmissionView[] = [];
  for (const [index, row] of rows.entries()) {
    const record = submissionRow(row);
    record.evidence_refs = record.evidence_refs.filter((ref) => {
      try {
        const validated = evidenceRefs([ref])[0];
        return canonicalLaunchJson(ref) === canonicalLaunchJson(validated);
      } catch (error) {
        if (error instanceof DomainError && error.code === "invalid_argument") return false;
        throw error;
      }
    });
    const reasons: SubmissionView["outdated_reasons"] = [];
    if (index > 0) {
      reasons.push("superseded");
    }
    if (row.current_config_hash && record.config_hash !== row.current_config_hash) {
      reasons.push("config_changed");
    }
    for (const ref of record.evidence_refs) {
      if (ref.version === undefined) {
        continue;
      }
      const current = currentEvidenceVersions.get(`${ref.kind}\n${ref.ref}`);
      if (current !== undefined && current !== ref.version) {
        reasons.push("evidence_changed");
        break;
      }
    }
    views.push({
      ...record,
      superseded: index > 0,
      outdated: reasons.length > 0,
      outdated_reasons: reasons,
    });
  }
  return views;
}
