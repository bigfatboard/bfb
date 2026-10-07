// ABOUTME: Records immutable human artifact reviews bound to exact version and hash.
// ABOUTME: Approval never accepts results or grants authority; durations come from A04 reads.

import type { SqlDatabase } from "@bfb/db";

import { assertEpoch, assertProjectAccess, assertRole, loadPrincipal } from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";
import { canonicalLaunchJson } from "./launch-state.js";
import { runnerHash } from "./runner-crypto.js";
import {
  artifactAccessPredicate,
  publicArtifactParentAuthorityPredicate,
  publicArtifactVersionBusinessSelection,
} from "./artifacts.js";
import { publicBusinessCommand, publicTaskRowAuthorityPredicate } from "./public-business.js";
import { sharedTaskPredicate, taskAccessPredicate, type TaskAccessContext } from "./task-access.js";

export const REVIEW_DECISIONS = ["approve", "request_changes", "comment"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const MAX_ARTIFACT_REVIEW_COMMENT_CHARS = 2048;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const CONFIG_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REVIEW_INPUT_FIELDS = [
  "artifactId",
  "versionId",
  "expectedContentHash",
  "expectedLatestVersionId",
  "decision",
  "comment",
  "gitCommit",
  "configHash",
  "reviewTimerObservationId",
] as const;

// Historical timer rows are not proof of an exact run/task association.
const timerRunRelation = `(timer.run_id IS NULL OR EXISTS (
  SELECT 1 FROM runs AS timer_run WHERE timer_run.workspace_id = timer.workspace_id
    AND timer_run.id = timer.run_id AND timer_run.task_id = timer_task.id
    AND timer_run.project_id = timer_task.project_id))`;

export interface RecordReviewInput {
  artifactId: string;
  versionId: string;
  /** Caller-observed content hash; must equal the version's stored hash. */
  expectedContentHash: string;
  /** Caller-observed latest available version; must equal the current latest. */
  expectedLatestVersionId: string;
  decision: ReviewDecision;
  comment?: string | undefined;
  gitCommit?: string | undefined;
  configHash?: string | undefined;
  /** Optional A04 review-timer observation; V03 reads durations, never computes them. */
  reviewTimerObservationId?: string | undefined;
}

export interface ReviewRecord {
  id: string;
  artifact_id: string;
  version_id: string;
  content_hash: string;
  reviewer_human_id: string;
  decision: ReviewDecision;
  comment: string | null;
  git_commit: string | null;
  config_hash: string | null;
  review_timer_observation_id: string | null;
  created_at: string;
}

export type ReviewOutdatedReason = "newer_version" | "config_changed" | "git_changed";

export interface ReviewView extends ReviewRecord {
  historical: boolean;
  outdated: boolean;
  outdated_reasons: ReviewOutdatedReason[];
}

export interface ReviewVersionView {
  id: string;
  state: string;
  format: string;
  content_hash: string | null;
  created_at: string;
  available_at: string | null;
  approvals: number;
  changes_requested: number;
}

export interface LinkedSubmissionView {
  submission_id: string;
  run_id: string;
  submission_version: number;
  result_state: string;
  bound_version: string | null;
  references_current_version: boolean;
}

export interface ArtifactReviewStatus {
  artifact_id: string;
  run_id: string | null;
  latest_version: ReviewVersionView | null;
  approved: boolean;
  changes_requested: boolean;
  review_count: number;
  historical_count: number;
  linked_submissions: LinkedSubmissionView[];
  reviews: ReviewView[];
}

function reviewObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new DomainError("invalid_argument", "review input is invalid");
  }
  return value as Record<string, unknown>;
}

function reviewComment(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new DomainError("invalid_argument", "review comment is invalid");
  }
  const normalized = value.trim();
  if (
    [...normalized].length < 1 ||
    [...normalized].length > MAX_ARTIFACT_REVIEW_COMMENT_CHARS ||
    [...normalized].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new DomainError("invalid_argument", "review comment is invalid");
  }
  return normalized;
}

function reviewGitCommit(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !HEX40.test(value)) {
    throw new DomainError("invalid_argument", "review git commit is invalid");
  }
  return value;
}

function reviewConfigHash(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !CONFIG_HASH_PATTERN.test(value)) {
    throw new DomainError("invalid_argument", "review config hash is invalid");
  }
  return value;
}

function reviewObservationId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !isUlid(value)) {
    throw new DomainError("invalid_argument", "review timer observation is invalid");
  }
  return value;
}

interface ArtifactRow {
  id: string;
  run_id: string | null;
}

interface VersionRow {
  id: string;
  artifact_id: string;
  state: string;
  content_hash: string | null;
  r2_key: string | null;
}

async function requireArtifact(ctx: HubContext, artifactId: unknown): Promise<ArtifactRow> {
  if (typeof artifactId !== "string" || !isUlid(artifactId)) {
    throw new DomainError("not_found", "artifact not found");
  }
  if (!ctx.actorHumanId || ctx.actorDelegationId || ctx.actorRunnerId || ctx.actorSystemId) {
    throw new DomainError("forbidden", "direct authorized human required");
  }
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertEpoch(principal, ctx.authorizationEpoch);
  const parent = artifactAccessPredicate(principal, "contribute");
  const row = (await ctx.db
    .prepare(
      `SELECT artifact.id, artifact.run_id FROM artifacts AS artifact
      WHERE artifact.workspace_id = ? AND artifact.id = ? AND ${parent.sql}`,
    )
    .get(ctx.workspaceId, artifactId, ...parent.parameters)) as ArtifactRow | undefined;
  if (!row) {
    throw new DomainError("not_found", "artifact not found");
  }
  return row;
}

async function requireAvailableVersion(
  ctx: HubContext,
  artifactId: string,
  versionId: unknown,
): Promise<VersionRow> {
  if (typeof versionId !== "string" || !isUlid(versionId)) {
    throw new DomainError("not_found", "artifact version not found");
  }
  const row = (await ctx.db
    .prepare(
      `SELECT id, artifact_id, state, content_hash, r2_key
       FROM artifact_versions WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, versionId)) as VersionRow | undefined;
  // Only available versions may be reviewed; uploading rows hold no trusted
  // bytes and failed rows are terminal.
  if (!row || row.artifact_id !== artifactId || row.state !== "available" || !row.content_hash) {
    throw new DomainError("not_found", "artifact version not found");
  }
  return row;
}

// Publication order is insert order: version ids are random, so rowid breaks
// same-millisecond timestamp ties deterministically.
async function latestAvailableVersion(
  db: SqlDatabase,
  workspaceId: string,
  artifactId: string,
): Promise<VersionRow | undefined> {
  const rows = (await db
    .prepare(
      `SELECT id, artifact_id, state, content_hash, r2_key
       FROM artifact_versions
       WHERE workspace_id = ? AND artifact_id = ? AND state = 'available'
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(workspaceId, artifactId)) as VersionRow[];
  return rows[rows.length - 1];
}

async function requireReviewer(ctx: HubContext, projectId: string | null): Promise<string> {
  // Ordinary artifact review is a direct-human action for owner, member, or
  // reviewer. Runner, delegated, and system actors can never record a review,
  // and a review is never usable as step-up or authority elsewhere.
  if (!ctx.actorHumanId || ctx.actorDelegationId || ctx.actorRunnerId || ctx.actorSystemId) {
    throw new DomainError("forbidden", "direct authorized human required");
  }
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertEpoch(principal, ctx.authorizationEpoch);
  assertRole(principal, ["owner", "member", "reviewer"]);
  // Reviewer project scoping for artifact surfaces is a V03 concern: a bound
  // run pins the review to that run's project.
  if (projectId) {
    assertProjectAccess(principal, projectId);
  }
  return principal.humanId;
}

async function requireRunProject(
  db: SqlDatabase,
  workspaceId: string,
  runId: string | null,
): Promise<string | null> {
  if (!runId) return null;
  const run = (await db
    .prepare(`SELECT project_id FROM runs WHERE workspace_id = ? AND id = ?`)
    .get(workspaceId, runId)) as { project_id: string } | undefined;
  if (!run) return null;
  return run.project_id;
}

/**
 * Reads the project of an artifact already selected through parent authority.
 * Run-free artifacts have no project; dangling run references never pass the
 * artifact selection predicate.
 */
async function readArtifactProject(
  db: ReviewDb,
  workspaceId: string,
  runId: string | null,
): Promise<string | null> {
  if (!runId) return null;
  const run = (await db
    .prepare(`SELECT project_id FROM runs WHERE workspace_id = ? AND id = ?`)
    .get(workspaceId, runId)) as { project_id: string } | undefined;
  return run?.project_id ?? null;
}

async function requireTimerObservation(
  ctx: HubContext,
  observationId: string | null,
): Promise<void> {
  if (!observationId) return;
  const parent = taskAccessPredicate(
    {
      workspaceId: ctx.workspaceId,
      humanId: ctx.actorHumanId!,
      authorizationEpoch: ctx.authorizationEpoch,
    },
    "read",
    "timer_task",
  );
  // The observation must exist in this workspace. V03 reads A04 durations
  // from these rows and never writes timer state of its own.
  const row = (await ctx.db
    .prepare(
      `SELECT observation.observation_id FROM review_timer_observations AS observation
       JOIN review_timers AS timer ON timer.workspace_id = observation.workspace_id AND timer.id = observation.timer_id
       JOIN tasks AS timer_task ON timer_task.workspace_id = timer.workspace_id AND timer_task.id = timer.task_id
       WHERE observation.workspace_id = ? AND observation.observation_id = ? AND ${timerRunRelation} AND ${parent.sql}`,
    )
    .get(ctx.workspaceId, observationId, ...parent.parameters)) as
    { observation_id: string } | undefined;
  if (!row) {
    throw new DomainError("not_found", "review timer observation not found");
  }
}

async function reviewAuditOutbox(
  db: SqlDatabase,
  entry: {
    workspaceId: string;
    artifactId: string;
    versionId: string;
    reviewId: string;
    reviewerHumanId: string;
    decision: ReviewDecision;
    now: string;
  },
): Promise<void> {
  // Audit carries identities and the decision only: no comment text, no
  // hashes beyond the bound version identity, and no secrets (reviews mint none).
  await db
    .prepare(
      `INSERT INTO artifact_audit_outbox
       (id, workspace_id, version_id, grant_id, action, payload_json, created_at, dispatched_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)`,
    )
    .run(
      randomUlid(),
      entry.workspaceId,
      entry.versionId,
      "artifact.review_recorded",
      JSON.stringify({
        artifact_id: entry.artifactId,
        version_id: entry.versionId,
        review_id: entry.reviewId,
        reviewer_human_id: entry.reviewerHumanId,
        decision: entry.decision,
      }),
      entry.now,
    );
}

async function reviewAuthority(input: RecordReviewInput, ctx: HubContext) {
  const body = reviewObject(input, REVIEW_INPUT_FIELDS);
  const artifact = await requireArtifact(ctx, body.artifactId);
  const projectId = await requireRunProject(ctx.db, ctx.workspaceId, artifact.run_id);
  const reviewer = await requireReviewer(ctx, projectId);
  return { body, artifact, reviewer };
}

const recordReviewBase: HubCommand<RecordReviewInput, ReviewRecord> = {
  name: "artifact.record_review",
  authorize: async (input, ctx) => {
    // Historical retries may return their original decision, but only while
    // the direct human still holds current contribute authority to its task.
    await reviewAuthority(input, ctx);
  },
  replayResult: async (record, ctx) => {
    const access = {
      workspaceId: ctx.workspaceId,
      humanId: ctx.actorHumanId!,
      authorizationEpoch: ctx.authorizationEpoch,
    };
    const parent = artifactAccessPredicate(access, "contribute");
    const timer = reviewTimerReference(access);
    const row = (await ctx.db
      .prepare(
        `SELECT review.id, review.artifact_id, review.version_id, review.content_hash,
                review.reviewer_human_id, review.decision, review.comment, review.git_commit,
                review.config_hash, ${timer.sql} AS review_timer_observation_id, review.created_at
         FROM artifact_reviews AS review JOIN artifacts AS artifact
           ON artifact.workspace_id = review.workspace_id AND artifact.id = review.artifact_id
         WHERE review.workspace_id = ? AND review.id = ? AND review.artifact_id = ? AND ${parent.sql}`,
      )
      .get(
        ...timer.parameters,
        ctx.workspaceId,
        record.id,
        record.artifact_id,
        ...parent.parameters,
      )) as ReviewRow | undefined;
    if (!row) throw new DomainError("not_found", "artifact not found");
    return reviewRecord(row);
  },
  inputFingerprint: (input) => runnerHash(canonicalLaunchJson(JSON.parse(JSON.stringify(input)))),
  auditInput: (input) => ({
    artifactId: (input as RecordReviewInput)?.artifactId,
    versionId: (input as RecordReviewInput)?.versionId,
    decision: (input as RecordReviewInput)?.decision,
  }),
  auditResult: (record) => ({
    review_id: record.id,
    artifact_id: record.artifact_id,
    version_id: record.version_id,
    reviewer_human_id: record.reviewer_human_id,
    decision: record.decision,
    created_at: record.created_at,
  }),
  async run(input, ctx) {
    const { body, artifact, reviewer } = await reviewAuthority(input, ctx);
    const version = await requireAvailableVersion(ctx, artifact.id, body.versionId);
    if (typeof body.expectedContentHash !== "string" || !HEX64.test(body.expectedContentHash)) {
      throw new DomainError("invalid_argument", "expected content hash is invalid");
    }
    if (version.content_hash !== body.expectedContentHash) {
      throw new DomainError("version_mismatch", "review hash does not match the version bytes");
    }
    const latest = await latestAvailableVersion(ctx.db, ctx.workspaceId, artifact.id);
    if (!latest || latest.id !== version.id) {
      // A newer available version exists: the reviewer must re-check the
      // current bytes instead of approving history.
      throw new DomainError("stale_version", "a newer artifact version needs review");
    }
    if (
      typeof body.expectedLatestVersionId !== "string" ||
      body.expectedLatestVersionId !== latest.id
    ) {
      throw new DomainError("stale_version", "review state is stale; reload the artifact");
    }
    if (
      typeof body.decision !== "string" ||
      !(REVIEW_DECISIONS as readonly string[]).includes(body.decision)
    ) {
      throw new DomainError("invalid_argument", "review decision is invalid");
    }
    const comment = reviewComment(body.comment);
    const gitCommit = reviewGitCommit(body.gitCommit);
    const configHash = reviewConfigHash(body.configHash);
    const observationId = reviewObservationId(body.reviewTimerObservationId);
    await requireTimerObservation(ctx, observationId);
    const id = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO artifact_reviews
         (workspace_id, id, artifact_id, version_id, content_hash, reviewer_human_id,
          authorization_epoch, decision, comment, git_commit, config_hash,
          review_timer_observation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        id,
        artifact.id,
        version.id,
        version.content_hash,
        reviewer,
        ctx.authorizationEpoch,
        body.decision,
        comment,
        gitCommit,
        configHash,
        observationId,
        ctx.now,
      );
    await reviewAuditOutbox(ctx.db, {
      workspaceId: ctx.workspaceId,
      artifactId: artifact.id,
      versionId: version.id,
      reviewId: id,
      reviewerHumanId: reviewer,
      decision: body.decision as ReviewDecision,
      now: ctx.now,
    });
    const access = {
      workspaceId: ctx.workspaceId,
      humanId: reviewer,
      authorizationEpoch: ctx.authorizationEpoch,
    };
    const parent = artifactAccessPredicate(access, "contribute");
    const timerParent = taskAccessPredicate(access, "read", "timer_task");
    const guardId = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO artifact_mutation_guards (id, valid) VALUES (?,
      (SELECT COUNT(*) = 1 FROM artifact_reviews AS review
       JOIN artifacts AS artifact ON artifact.workspace_id = review.workspace_id AND artifact.id = review.artifact_id
       JOIN workspace_members AS member ON member.workspace_id = review.workspace_id AND member.human_id = review.reviewer_human_id
       JOIN workspace_authorization_epochs AS epoch ON epoch.workspace_id = member.workspace_id AND epoch.human_id = member.human_id
       WHERE review.workspace_id = ? AND review.id = ? AND member.authorization_epoch = epoch.authorization_epoch
         AND epoch.authorization_epoch = review.authorization_epoch AND epoch.revoked_at IS NULL AND ${parent.sql}
         AND (review.review_timer_observation_id IS NULL OR EXISTS (
           SELECT 1 FROM review_timer_observations AS observation
           JOIN review_timers AS timer ON timer.workspace_id = observation.workspace_id AND timer.id = observation.timer_id
           JOIN tasks AS timer_task ON timer_task.workspace_id = timer.workspace_id AND timer_task.id = timer.task_id
           WHERE observation.workspace_id = review.workspace_id AND observation.observation_id = review.review_timer_observation_id
             AND ${timerRunRelation} AND ${timerParent.sql}))))`,
      )
      .run(guardId, ctx.workspaceId, id, ...parent.parameters, ...timerParent.parameters);
    await ctx.db.prepare("DELETE FROM artifact_mutation_guards WHERE id = ?").run(guardId);
    return {
      id,
      artifact_id: artifact.id,
      version_id: version.id,
      content_hash: version.content_hash,
      reviewer_human_id: reviewer,
      decision: body.decision as ReviewDecision,
      comment,
      git_commit: gitCommit,
      config_hash: configHash,
      review_timer_observation_id: observationId,
      created_at: ctx.now,
    };
  },
};

export const recordReviewCommand = publicBusinessCommand(recordReviewBase, {
  admissionIsSelection: true,
  admission: (input, authority) =>
    publicArtifactVersionBusinessSelection<ReviewRecord>(authority, input.versionId, "contribute", [
      "owner",
      "member",
      "reviewer",
    ]),
  delivery: (input, result, authority) => {
    const parent = publicArtifactParentAuthorityPredicate(authority, "contribute", "artifact", [
        "owner",
        "member",
        "reviewer",
      ]),
      timer = publicTaskRowAuthorityPredicate(authority, "read", "timer_task");
    return {
      sql: `SELECT CASE WHEN EXISTS (
          SELECT 1 FROM review_timer_observations AS observation
          JOIN review_timers AS timer ON timer.workspace_id = observation.workspace_id AND timer.id = observation.timer_id
          JOIN tasks AS timer_task ON timer_task.workspace_id = timer.workspace_id AND timer_task.id = timer.task_id
          WHERE observation.workspace_id = review.workspace_id
            AND observation.observation_id = review.review_timer_observation_id AND ${timerRunRelation} AND ${timer.sql}
        ) THEN review.review_timer_observation_id ELSE NULL END AS review_timer_observation_id
        FROM artifact_reviews AS review
        JOIN artifact_versions AS version ON version.workspace_id = review.workspace_id AND version.id = review.version_id
          AND version.artifact_id = review.artifact_id AND version.content_hash = review.content_hash
        JOIN artifacts AS artifact ON artifact.workspace_id = version.workspace_id AND artifact.id = version.artifact_id
        WHERE review.workspace_id = ? AND review.id = ? AND review.artifact_id = ? AND review.artifact_id = ?
          AND review.version_id = ? AND review.version_id = ? AND review.content_hash = ?
          AND review.reviewer_human_id = ? AND review.decision = ?
          AND review.comment IS ? AND review.git_commit IS ? AND review.config_hash IS ? AND review.created_at = ?
          AND ${parent.sql}`,
      parameters: [
        ...timer.parameters,
        authority.workspaceId,
        result.id,
        result.artifact_id,
        input.artifactId,
        result.version_id,
        input.versionId,
        result.content_hash,
        result.reviewer_human_id,
        result.decision,
        result.comment,
        result.git_commit,
        result.config_hash,
        result.created_at,
        ...parent.parameters,
      ],
      project: (historical: ReviewRecord, row: Record<string, unknown>) => ({
        ...historical,
        review_timer_observation_id:
          typeof row.review_timer_observation_id === "string"
            ? row.review_timer_observation_id
            : null,
      }),
    };
  },
});

interface ReviewRow {
  id: string;
  artifact_id: string;
  version_id: string;
  content_hash: string;
  reviewer_human_id: string;
  decision: string;
  comment: string | null;
  git_commit: string | null;
  config_hash: string | null;
  review_timer_observation_id: string | null;
  created_at: string;
}

type ReviewDb = Pick<SqlDatabase, "prepare">;

/** Timer relations require their own current parent authority, not artifact access. */
function reviewTimerReference(access?: TaskAccessContext) {
  const parent = access
    ? taskAccessPredicate(access, "read", "timer_task")
    : { sql: sharedTaskPredicate("timer_task"), parameters: [] };
  return {
    sql: `CASE WHEN EXISTS (
      SELECT 1 FROM review_timer_observations AS observation
      JOIN review_timers AS timer ON timer.workspace_id = observation.workspace_id AND timer.id = observation.timer_id
      JOIN tasks AS timer_task ON timer_task.workspace_id = timer.workspace_id AND timer_task.id = timer.task_id
      WHERE observation.workspace_id = review.workspace_id
        AND observation.observation_id = review.review_timer_observation_id AND ${timerRunRelation} AND ${parent.sql}
    ) THEN review.review_timer_observation_id ELSE NULL END`,
    parameters: parent.parameters,
  };
}

function reviewRecord(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    artifact_id: row.artifact_id,
    version_id: row.version_id,
    content_hash: row.content_hash,
    reviewer_human_id: row.reviewer_human_id,
    decision: row.decision as ReviewDecision,
    comment: row.comment,
    git_commit: row.git_commit,
    config_hash: row.config_hash,
    review_timer_observation_id: row.review_timer_observation_id,
    created_at: row.created_at,
  };
}

async function readArtifact(
  db: ReviewDb,
  workspaceId: string,
  artifactId: string,
  access?: TaskAccessContext,
): Promise<{ id: string; run_id: string | null } | undefined> {
  if (!isUlid(artifactId)) return undefined;
  const parent = artifactAccessPredicate(access);
  return (await db
    .prepare(
      `SELECT artifact.id, artifact.run_id FROM artifacts AS artifact
      WHERE artifact.workspace_id = ? AND artifact.id = ? AND ${parent.sql}`,
    )
    .get(workspaceId, artifactId, ...parent.parameters)) as
    { id: string; run_id: string | null } | undefined;
}

async function readVersions(
  db: ReviewDb,
  workspaceId: string,
  artifactId: string,
  access?: TaskAccessContext,
): Promise<
  Array<{
    id: string;
    state: string;
    format: string;
    content_hash: string | null;
    created_at: string;
    available_at: string | null;
    approvals: number;
    changes_requested: number;
  }>
> {
  const parent = artifactAccessPredicate(access);
  return (await db
    .prepare(
      `SELECT v.id, v.state, v.format, v.content_hash,
              v.created_at, v.available_at,
              (SELECT COUNT(*) FROM artifact_reviews AS r
               WHERE r.workspace_id = v.workspace_id AND r.version_id = v.id AND r.decision = 'approve') AS approvals,
              (SELECT COUNT(*) FROM artifact_reviews AS r
               WHERE r.workspace_id = v.workspace_id AND r.version_id = v.id AND r.decision = 'request_changes') AS changes_requested
       FROM artifact_versions AS v
       JOIN artifacts AS artifact ON artifact.workspace_id = v.workspace_id AND artifact.id = v.artifact_id
       WHERE v.workspace_id = ? AND v.artifact_id = ? AND ${parent.sql}
       ORDER BY v.created_at ASC, v.rowid ASC`,
    )
    .all(workspaceId, artifactId, ...parent.parameters)) as Array<{
    id: string;
    state: string;
    format: string;
    content_hash: string | null;
    created_at: string;
    available_at: string | null;
    approvals: number;
    changes_requested: number;
  }>;
}

async function readLatestConfigHash(
  db: ReviewDb,
  workspaceId: string,
  runId: string | null,
): Promise<string | null> {
  if (!runId) return null;
  const row = (await db
    .prepare(
      `SELECT content_hash FROM run_configuration_snapshots
       WHERE workspace_id = ? AND run_id = ?
       ORDER BY snapshot_generation DESC LIMIT 1`,
    )
    .get(workspaceId, runId)) as { content_hash: string } | undefined;
  return row?.content_hash ?? null;
}

async function readLatestSubmissionGit(
  db: ReviewDb,
  workspaceId: string,
  runId: string | null,
): Promise<string | null> {
  if (!runId) return null;
  const row = (await db
    .prepare(
      `SELECT git_commit FROM result_submissions
       WHERE workspace_id = ? AND run_id = ?
       ORDER BY version DESC LIMIT 1`,
    )
    .get(workspaceId, runId)) as { git_commit: string | null } | undefined;
  return row?.git_commit ?? null;
}

function flagReview(
  record: ReviewRecord,
  latestVersionId: string | null,
  latestConfigHash: string | null,
  latestSubmissionGit: string | null,
): ReviewView {
  const reasons: ReviewOutdatedReason[] = [];
  if (latestVersionId && record.version_id !== latestVersionId) {
    reasons.push("newer_version");
  }
  if (record.config_hash && latestConfigHash && record.config_hash !== latestConfigHash) {
    reasons.push("config_changed");
  }
  if (record.git_commit && latestSubmissionGit && record.git_commit !== latestSubmissionGit) {
    reasons.push("git_changed");
  }
  return {
    ...record,
    historical: latestVersionId !== null && record.version_id !== latestVersionId,
    outdated: reasons.length > 0,
    outdated_reasons: reasons,
  };
}

/**
 * Lists an artifact's reviews oldest-first with computed historical and
 * outdated flags. History is never mutated: a newer available version, a
 * changed run configuration, or a changed submission commit only adds flags.
 */
export async function listArtifactReviews(
  db: ReviewDb,
  workspaceId: string,
  artifactId: string,
  access?: TaskAccessContext,
): Promise<ReviewView[]> {
  const artifact = await readArtifact(db, workspaceId, artifactId, access);
  if (!artifact) return [];
  const parent = artifactAccessPredicate(access);
  const versions = (await db
    .prepare(
      `SELECT version.id FROM artifact_versions AS version JOIN artifacts AS artifact
         ON artifact.workspace_id = version.workspace_id AND artifact.id = version.artifact_id
       WHERE version.workspace_id = ? AND version.artifact_id = ? AND version.state = 'available' AND ${parent.sql}
       ORDER BY version.created_at ASC, version.rowid ASC`,
    )
    .all(workspaceId, artifactId, ...parent.parameters)) as Array<{ id: string }>;
  const latestVersionId = versions[versions.length - 1]?.id ?? null;
  const latestConfigHash = await readLatestConfigHash(db, workspaceId, artifact.run_id);
  const latestSubmissionGit = await readLatestSubmissionGit(db, workspaceId, artifact.run_id);
  const timer = reviewTimerReference(access);
  // Decision order is insert order: review ids are random, so rowid breaks
  // same-millisecond timestamp ties deterministically.
  const rows = (await db
    .prepare(
      `SELECT review.id, review.artifact_id, review.version_id, review.content_hash, review.reviewer_human_id, review.decision,
              review.comment, review.git_commit, review.config_hash, ${timer.sql} AS review_timer_observation_id, review.created_at
       FROM artifact_reviews AS review JOIN artifacts AS artifact
         ON artifact.workspace_id = review.workspace_id AND artifact.id = review.artifact_id
       WHERE review.workspace_id = ? AND review.artifact_id = ? AND ${parent.sql}
       ORDER BY review.created_at ASC, review.rowid ASC`,
    )
    .all(...timer.parameters, workspaceId, artifactId, ...parent.parameters)) as ReviewRow[];
  return rows.map((row) =>
    flagReview(reviewRecord(row), latestVersionId, latestConfigHash, latestSubmissionGit),
  );
}

/** Re-selects parent visibility and independent timer relations in one final read. */
export async function readArtifactReviewReferences(
  db: ReviewDb,
  workspaceId: string,
  artifactId: string,
  access?: TaskAccessContext,
): Promise<Map<string, string | null> | undefined> {
  if (!isUlid(artifactId)) return undefined;
  const parent = artifactAccessPredicate(access);
  const timer = reviewTimerReference(access);
  const rows = (await db
    .prepare(
      `SELECT review.id, ${timer.sql} AS review_timer_observation_id
       FROM artifacts AS artifact LEFT JOIN artifact_reviews AS review
         ON review.workspace_id = artifact.workspace_id AND review.artifact_id = artifact.id
       WHERE artifact.workspace_id = ? AND artifact.id = ? AND ${parent.sql}`,
    )
    .all(...timer.parameters, workspaceId, artifactId, ...parent.parameters)) as Array<{
    id: string | null;
    review_timer_observation_id: string | null;
  }>;
  if (rows.length === 0) return undefined;
  const references = new Map<string, string | null>();
  for (const row of rows)
    if (row.id !== null) references.set(row.id, row.review_timer_observation_id);
  return references;
}

function boundArtifactVersion(
  entry: unknown,
  artifactId: string,
  versionIds: Set<string>,
): string | null | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  if (record.kind !== "artifact_version" || typeof record.ref !== "string") return undefined;
  if (record.ref !== artifactId && !versionIds.has(record.ref)) return undefined;
  return typeof record.version === "string" ? record.version : null;
}

/**
 * Finds result submissions that bind this artifact through an
 * `artifact_version` evidence reference. Read-only: V03 never mutates
 * submissions, runs, or tasks; recording a review changes no result state.
 */
export async function listLinkedSubmissions(
  db: ReviewDb,
  workspaceId: string,
  artifactId: string,
  latestVersionId: string | null,
  access?: TaskAccessContext,
): Promise<LinkedSubmissionView[]> {
  const artifact = await readArtifact(db, workspaceId, artifactId, access);
  if (!artifact?.run_id) return [];
  const versions = await readVersions(db, workspaceId, artifactId, access);
  const parent = artifactAccessPredicate(access);
  const versionIds = new Set(versions.map((version) => version.id));
  const rows = (await db
    .prepare(
      `SELECT s.id, s.run_id, s.version, s.evidence_refs_json, r.result_state
       FROM result_submissions AS s
       JOIN runs AS r ON r.workspace_id = s.workspace_id AND r.id = s.run_id
       JOIN artifacts AS artifact ON artifact.workspace_id = s.workspace_id AND artifact.run_id = s.run_id
       WHERE s.workspace_id = ? AND s.run_id = ? AND artifact.id = ? AND ${parent.sql}
       ORDER BY s.version DESC`,
    )
    .all(workspaceId, artifact.run_id, artifactId, ...parent.parameters)) as Array<{
    id: string;
    run_id: string;
    version: number;
    evidence_refs_json: string;
    result_state: string;
  }>;
  const linked: LinkedSubmissionView[] = [];
  for (const row of rows) {
    let refs: unknown[] = [];
    try {
      refs = JSON.parse(row.evidence_refs_json) as unknown[];
    } catch {
      continue;
    }
    if (!Array.isArray(refs)) continue;
    for (const entry of refs) {
      const bound = boundArtifactVersion(entry, artifactId, versionIds);
      if (bound === undefined) continue;
      linked.push({
        submission_id: row.id,
        run_id: row.run_id,
        submission_version: row.version,
        result_state: row.result_state,
        bound_version: bound,
        references_current_version: latestVersionId !== null && bound === latestVersionId,
      });
      break;
    }
  }
  return linked;
}

/**
 * Full review status for one artifact: every version with its decision
 * counts, every review with outdated flags, and linked result submissions.
 * The latest available version is unapproved until it carries its own
 * `approve` review; earlier approvals stay historical. Artifacts bound to
 * a run outside `projectIds` read as missing, so the project boundary
 * discloses no existence signal.
 */
export async function getArtifactReviewStatus(
  db: ReviewDb,
  workspaceId: string,
  artifactId: string,
  projectIds: readonly string[],
  access?: TaskAccessContext,
): Promise<ArtifactReviewStatus | undefined> {
  const artifact = await readArtifact(db, workspaceId, artifactId, access);
  if (!artifact) return undefined;
  const projectId = await readArtifactProject(db, workspaceId, artifact.run_id);
  if (projectId && !projectIds.includes(projectId)) return undefined;
  const versions = await readVersions(db, workspaceId, artifactId, access);
  const available = versions.filter((version) => version.state === "available");
  const latest = available[available.length - 1] ?? null;
  const reviews = await listArtifactReviews(db, workspaceId, artifactId, access);
  const linked = await listLinkedSubmissions(
    db,
    workspaceId,
    artifactId,
    latest?.id ?? null,
    access,
  );
  const references = await readArtifactReviewReferences(db, workspaceId, artifactId, access);
  if (!references) return undefined;
  const visibleReviews = reviews.map((review) => ({
    ...review,
    review_timer_observation_id: references.get(review.id) ?? null,
  }));
  const historical = reviews.filter((review) => review.historical).length;
  return {
    artifact_id: artifact.id,
    run_id: artifact.run_id,
    latest_version: latest
      ? {
          id: latest.id,
          state: latest.state,
          format: latest.format,
          content_hash: latest.content_hash,
          created_at: latest.created_at,
          available_at: latest.available_at,
          approvals: Number(latest.approvals),
          changes_requested: Number(latest.changes_requested),
        }
      : null,
    approved: latest !== null && Number(latest.approvals) > 0,
    changes_requested: latest !== null && Number(latest.changes_requested) > 0,
    review_count: reviews.length,
    historical_count: historical,
    linked_submissions: linked,
    reviews: visibleReviews,
  };
}

export interface ArtifactSummary {
  artifact_id: string;
  run_id: string | null;
  format: string;
  role: string;
  created_at: string;
  version_count: number;
  latest_version: ReviewVersionView | null;
  approved: boolean;
  changes_requested: boolean;
  review_count: number;
}

/**
 * Lists artifacts (optionally for one run) with each latest available
 * version and its approval state. Newer versions without their own approve
 * review always read unapproved, no matter the history behind them. Only
 * run-free artifacts and artifacts bound to a run in `projectIds` are
 * listed, matching the review write path's project scoping.
 */
export async function listArtifactsWithReviewState(
  db: ReviewDb,
  workspaceId: string,
  projectIds: readonly string[],
  runId?: string,
  access?: TaskAccessContext,
): Promise<ArtifactSummary[]> {
  const scope =
    projectIds.length === 0 ? "" : ` OR r.project_id IN (${projectIds.map(() => "?").join(", ")})`;
  const parent = artifactAccessPredicate(access, "read", "a");
  const visible = `(a.run_id IS NULL${scope}) AND ${parent.sql}`;
  const artifacts = (await db
    .prepare(
      runId === undefined
        ? `SELECT a.id, a.run_id, a.format, a.role, a.created_at FROM artifacts AS a
           LEFT JOIN runs AS r ON r.workspace_id = a.workspace_id AND r.id = a.run_id
           WHERE a.workspace_id = ? AND ${visible}
           ORDER BY a.created_at ASC, a.id ASC`
        : `SELECT a.id, a.run_id, a.format, a.role, a.created_at FROM artifacts AS a
           LEFT JOIN runs AS r ON r.workspace_id = a.workspace_id AND r.id = a.run_id
           WHERE a.workspace_id = ? AND a.run_id = ? AND ${visible}
           ORDER BY a.created_at ASC, a.id ASC`,
    )
    .all(
      ...(runId === undefined ? [workspaceId, ...projectIds] : [workspaceId, runId, ...projectIds]),
      ...parent.parameters,
    )) as Array<{
    id: string;
    run_id: string | null;
    format: string;
    role: string;
    created_at: string;
  }>;
  const summaries: ArtifactSummary[] = [];
  for (const artifact of artifacts) {
    const versions = await readVersions(db, workspaceId, artifact.id, access);
    const available = versions.filter((version) => version.state === "available");
    const latest = available[available.length - 1] ?? null;
    const reviewCount = (await db
      .prepare(
        `SELECT COUNT(*) AS total FROM artifact_reviews AS review JOIN artifacts AS a
           ON a.workspace_id = review.workspace_id AND a.id = review.artifact_id
         WHERE review.workspace_id = ? AND review.artifact_id = ? AND ${parent.sql}`,
      )
      .get(workspaceId, artifact.id, ...parent.parameters)) as { total: number };
    if (!(await readArtifact(db, workspaceId, artifact.id, access))) continue;
    summaries.push({
      artifact_id: artifact.id,
      run_id: artifact.run_id,
      format: artifact.format,
      role: artifact.role,
      created_at: artifact.created_at,
      version_count: versions.length,
      latest_version: latest
        ? {
            id: latest.id,
            state: latest.state,
            format: latest.format,
            content_hash: latest.content_hash,
            created_at: latest.created_at,
            available_at: latest.available_at,
            approvals: Number(latest.approvals),
            changes_requested: Number(latest.changes_requested),
          }
        : null,
      approved: latest !== null && Number(latest.approvals) > 0,
      changes_requested: latest !== null && Number(latest.changes_requested) > 0,
      review_count: Number(reviewCount.total),
    });
  }
  // Assembly performs several child reads. Re-select the visible identities
  // together so a grant closed during a later item's read cannot leak an
  // earlier item's previously authorized metadata.
  const current = (await db
    .prepare(
      `SELECT a.id FROM artifacts AS a
       LEFT JOIN runs AS r ON r.workspace_id = a.workspace_id AND r.id = a.run_id
       WHERE a.workspace_id = ? AND ${visible}`,
    )
    .all(workspaceId, ...projectIds, ...parent.parameters)) as Array<{ id: string }>;
  const visibleIds = new Set(current.map((row) => row.id));
  return summaries.filter((summary) => visibleIds.has(summary.artifact_id));
}

export interface ReviewTimerContext {
  observation: {
    observation_id: string;
    timer_id: string;
    observed_kind: "started" | "stopped";
    actor_type: string;
    actor_id: string;
    occurred_at: string;
  };
  timer: {
    id: string;
    task_id: string;
    run_id: string | null;
    started_by_human_id: string;
    started_at: string;
    stopped_at: string | null;
    state: "open" | "stopped";
    resource_version: number;
  } | null;
}

/**
 * Reads the A04 timer observation a review references, plus its parent
 * timer row. Raw rows only: review durations always come from A04's own
 * reads and derivations, never from a V03 calculation.
 */
export async function readReviewTimerContext(
  db: ReviewDb,
  workspaceId: string,
  observationId: string | null,
  access?: TaskAccessContext,
): Promise<ReviewTimerContext | null> {
  if (!observationId) return null;
  const parent = access
    ? taskAccessPredicate(access, "read", "timer_task")
    : { sql: sharedTaskPredicate("timer_task"), parameters: [] };
  const observation = (await db
    .prepare(
      `SELECT observation.observation_id, observation.timer_id, observation.observed_kind, observation.actor_type, observation.actor_id, observation.occurred_at
       FROM review_timer_observations AS observation
       JOIN review_timers AS timer ON timer.workspace_id = observation.workspace_id AND timer.id = observation.timer_id
       JOIN tasks AS timer_task ON timer_task.workspace_id = timer.workspace_id AND timer_task.id = timer.task_id
       WHERE observation.workspace_id = ? AND observation.observation_id = ? AND ${timerRunRelation} AND ${parent.sql}`,
    )
    .get(workspaceId, observationId, ...parent.parameters)) as
    ReviewTimerContext["observation"] | undefined;
  if (!observation) return null;
  const timer = (await db
    .prepare(
      `SELECT timer.* FROM review_timers AS timer JOIN tasks AS timer_task
      ON timer_task.workspace_id = timer.workspace_id AND timer_task.id = timer.task_id
      WHERE timer.workspace_id = ? AND timer.id = ? AND ${timerRunRelation} AND ${parent.sql}`,
    )
    .get(workspaceId, observation.timer_id, ...parent.parameters)) as
    Record<string, unknown> | undefined;
  if (!timer) return null;
  return {
    observation,
    timer: {
      id: String(timer.id),
      task_id: String(timer.task_id),
      run_id: (timer.run_id as string | null) ?? null,
      started_by_human_id: String(timer.started_by_human_id),
      started_at: String(timer.started_at),
      stopped_at: (timer.stopped_at as string | null) ?? null,
      state: timer.state as "open" | "stopped",
      resource_version: Number(timer.resource_version),
    },
  };
}

/**
 * Current artifact evidence versions for A03's computed `evidence_changed`
 * flag: `artifact_version\n<artifactId>` maps to the latest available
 * version id. Submitters bind `{kind: "artifact_version",
 * ref: "<artifactId>", version: "<versionId>"}`; a newer publication then
 * marks the submission outdated on read without mutating history.
 */
export async function artifactEvidenceVersionMap(
  db: ReviewDb,
  workspaceId: string,
  access?: TaskAccessContext,
  projectIds?: readonly string[],
): Promise<Map<string, string>> {
  const parent = artifactAccessPredicate(access);
  const projects =
    projectIds === undefined
      ? ""
      : `AND (artifact.run_id IS NULL OR EXISTS (
    SELECT 1 FROM runs AS scoped_run WHERE scoped_run.workspace_id = artifact.workspace_id AND scoped_run.id = artifact.run_id
      AND scoped_run.project_id IN (${projectIds.length ? projectIds.map(() => "?").join(",") : "NULL"})))`;
  const rows = (await db
    .prepare(
      `SELECT version.artifact_id, version.id FROM artifact_versions AS version JOIN artifacts AS artifact
         ON artifact.workspace_id = version.workspace_id AND artifact.id = version.artifact_id
       WHERE version.workspace_id = ? AND version.state = 'available' AND ${parent.sql} ${projects}
       ORDER BY version.created_at ASC, version.rowid ASC`,
    )
    .all(workspaceId, ...parent.parameters, ...(projectIds ?? []))) as Array<{
    artifact_id: string;
    id: string;
  }>;
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(`artifact_version\n${row.artifact_id}`, row.id);
  }
  return map;
}
