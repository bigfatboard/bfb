// ABOUTME: Implements explicit result submission and human review decisions for runs.
// ABOUTME: Provider, session, and process endings never submit or accept; only these commands do.

import { assertEpoch, assertProjectAccess, assertRole, loadPrincipal } from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";
import { getTask } from "./work-commands.js";
import { assertRunResultTransition, type ExecutionEndReason } from "./work-records.js";

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
}

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
      `SELECT id, project_id, task_id, result_state, resource_version
       FROM runs WHERE workspace_id = ? AND id = ? AND purpose = 'work'`,
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
 * label is reported metadata, not a verified agent process). Agent
 * submission requires a live runner holding the run's execution assignment
 * and project grant plus a non-ended execution; possession proof stays at
 * the runner transport, this rechecks grants, assignment, and run state.
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
    return { kind: "human", id: principal.humanId };
  }
  if (ctx.actorRunnerId && !ctx.actorHumanId) {
    const runner = (await ctx.db
      .prepare(`SELECT id, revoked_at FROM runners WHERE workspace_id = ? AND id = ?`)
      .get(ctx.workspaceId, ctx.actorRunnerId)) as
      { id: string; revoked_at: string | null } | undefined;
    if (!runner || runner.revoked_at !== null) {
      throw new DomainError("forbidden", "runner cannot submit for this run");
    }
    const assignment = await ctx.db
      .prepare(
        `SELECT 1 AS found FROM execution_assignments
         WHERE workspace_id = ? AND run_id = ? AND runner_id = ?`,
      )
      .get(ctx.workspaceId, run.id, ctx.actorRunnerId);
    if (!assignment) {
      throw new DomainError("forbidden", "runner holds no assignment for this run");
    }
    const grant = await ctx.db
      .prepare(
        `SELECT 1 AS found FROM runner_project_grants
         WHERE workspace_id = ? AND runner_id = ? AND project_id = ?`,
      )
      .get(ctx.workspaceId, ctx.actorRunnerId, run.project_id);
    if (!grant) {
      throw new DomainError("forbidden", "runner project grant revoked");
    }
    const live = await ctx.db
      .prepare(
        `SELECT 1 AS found FROM run_executions
         WHERE workspace_id = ? AND run_id = ? AND state != 'ended'`,
      )
      .get(ctx.workspaceId, run.id);
    if (!live) {
      throw new DomainError("invalid_transition", "no live execution accepts a submission");
    }
    return { kind: "agent_run", id: run.id };
  }
  throw new DomainError("forbidden", "result submission requires a human or runner authority");
}

async function resolveReviewer(
  ctx: HubContext,
  run: RunRow,
  decisions: Array<"owner" | "member" | "reviewer">,
): Promise<string> {
  if (!ctx.actorHumanId || ctx.actorDelegationId || ctx.actorRunnerId || ctx.actorSystemId) {
    throw new DomainError("forbidden", "direct authorized human required");
  }
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertEpoch(principal, ctx.authorizationEpoch);
  assertRole(principal, decisions);
  assertProjectAccess(principal, run.project_id);
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

export const submitResultCommand: HubCommand<SubmitResultInput, SubmitResultResult> = {
  name: "result.submit",
  auditInput: (input) => ({
    runId: input.runId,
    summaryLength: typeof input.summary === "string" ? [...input.summary].length : 0,
    evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs.length : 0,
    gitCommit: typeof input.gitCommit === "string" ? input.gitCommit : null,
  }),
  async run(input, ctx) {
    const run = await readRun(ctx, input.runId);
    const task = await getTask(ctx.db, ctx.workspaceId, run.task_id);
    if (!task) {
      throw new DomainError("not_found", "task not found");
    }
    const submitter = await resolveSubmitter(ctx, run);
    const summary = boundedText(input.summary, "result summary", 1, MAX_RESULT_SUMMARY_CHARS);
    const limitations =
      optionalBoundedText(input.limitations, "result limitations", MAX_RESULT_LIMITATIONS_CHARS) ??
      "";
    const refs = evidenceRefs(input.evidenceRefs);
    const git = gitFacts(input);
    assertRunResultTransition(run.result_state as "open", "submitted");
    if (task.state !== "active") {
      throw new DomainError("invalid_transition", "submission requires an active task");
    }
    const snapshot = await readLatestSnapshot(ctx, run.id);
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
  const task = await getTask(ctx.db, ctx.workspaceId, run.task_id);
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

export const requestChangesCommand: HubCommand<ReviewResultInput, ReviewResultResult> = {
  name: "result.request_changes",
  async run(input, ctx) {
    return reviewRun(ctx, input, "request_changes");
  },
};

export const acceptResultCommand: HubCommand<ReviewResultInput, ReviewResultResult> = {
  name: "result.accept",
  async run(input, ctx) {
    return reviewRun(ctx, input, "accept");
  },
};

export const failRunCommand: HubCommand<CloseRunInput, { runResultState: "failed" }> = {
  name: "result.fail",
  async run(input, ctx) {
    const run = await readRun(ctx, input.runId);
    await resolveReviewer(ctx, run, ["owner", "member"]);
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
  async run(input, ctx) {
    const run = await readRun(ctx, input.runId);
    await resolveReviewer(ctx, run, ["owner", "member"]);
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
 * A03 resolves no referents itself; V01 supplies artifact versions here.
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
): Promise<SubmissionView[]> {
  const rows = (await db
    .prepare(
      `SELECT id, run_id, version, summary, limitations, evidence_refs_json,
              git_branch, git_commit, git_dirty, config_snapshot_id, config_hash,
              submitted_by_kind, submitted_by_id, submitted_at
       FROM result_submissions
       WHERE workspace_id = ? AND run_id = ?
       ORDER BY version DESC`,
    )
    .all(workspaceId, runId)) as Array<{
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
  }>;
  const snapshot = (await db
    .prepare(
      `SELECT content_hash FROM run_configuration_snapshots
       WHERE workspace_id = ? AND run_id = ?
       ORDER BY snapshot_generation DESC LIMIT 1`,
    )
    .get(workspaceId, runId)) as { content_hash: string } | undefined;
  return rows.map((row, index) => {
    const record = submissionRow(row);
    const reasons: SubmissionView["outdated_reasons"] = [];
    if (index > 0) {
      reasons.push("superseded");
    }
    if (snapshot && record.config_hash !== snapshot.content_hash) {
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
    return {
      ...record,
      superseded: index > 0,
      outdated: reasons.length > 0,
      outdated_reasons: reasons,
    };
  });
}
