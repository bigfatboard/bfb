// ABOUTME: Records immutable human artifact reviews bound to exact version and hash.
// ABOUTME: Approval never accepts results or grants authority; durations come from A04 reads.

import type { SqlDatabase } from "@bfb/db";

import { assertEpoch, assertProjectAccess, assertRole, loadPrincipal } from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";

export const REVIEW_DECISIONS = ["approve", "request_changes", "comment"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const MAX_ARTIFACT_REVIEW_COMMENT_CHARS = 2048;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const CONFIG_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

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
  const row = (await ctx.db
    .prepare(`SELECT id, run_id FROM artifacts WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, artifactId)) as ArtifactRow | undefined;
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
       ORDER BY created_at ASC, id ASC`,
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

async function requireTimerObservation(
  ctx: HubContext,
  observationId: string | null,
): Promise<void> {
  if (!observationId) return;
  // The observation must exist in this workspace. V03 reads A04 durations
  // from these rows and never writes timer state of its own.
  const row = (await ctx.db
    .prepare(
      `SELECT observation_id FROM review_timer_observations
       WHERE workspace_id = ? AND observation_id = ?`,
    )
    .get(ctx.workspaceId, observationId)) as { observation_id: string } | undefined;
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

export const recordReviewCommand: HubCommand<RecordReviewInput, ReviewRecord> = {
  name: "artifact.record_review",
  auditInput: (input) => ({
    artifactId: (input as RecordReviewInput)?.artifactId,
    versionId: (input as RecordReviewInput)?.versionId,
    decision: (input as RecordReviewInput)?.decision,
  }),
  async run(input, ctx) {
    const body = reviewObject(input, [
      "artifactId",
      "versionId",
      "expectedContentHash",
      "expectedLatestVersionId",
      "decision",
      "comment",
      "gitCommit",
      "configHash",
      "reviewTimerObservationId",
    ]);
    const artifact = await requireArtifact(ctx, body.artifactId);
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
    const projectId = await requireRunProject(ctx.db, ctx.workspaceId, artifact.run_id);
    const reviewer = await requireReviewer(ctx, projectId);
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
): Promise<{ id: string; run_id: string | null } | undefined> {
  if (!isUlid(artifactId)) return undefined;
  return (await db
    .prepare(`SELECT id, run_id FROM artifacts WHERE workspace_id = ? AND id = ?`)
    .get(workspaceId, artifactId)) as { id: string; run_id: string | null } | undefined;
}

async function readVersions(
  db: ReviewDb,
  workspaceId: string,
  artifactId: string,
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
  return (await db
    .prepare(
      `SELECT v.id, v.state, v.format, v.content_hash,
              v.created_at, v.available_at,
              (SELECT COUNT(*) FROM artifact_reviews AS r
               WHERE r.workspace_id = v.workspace_id AND r.version_id = v.id AND r.decision = 'approve') AS approvals,
              (SELECT COUNT(*) FROM artifact_reviews AS r
               WHERE r.workspace_id = v.workspace_id AND r.version_id = v.id AND r.decision = 'request_changes') AS changes_requested
       FROM artifact_versions AS v
       WHERE v.workspace_id = ? AND v.artifact_id = ?
       ORDER BY v.created_at ASC, v.id ASC`,
    )
    .all(workspaceId, artifactId)) as Array<{
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
): Promise<ReviewView[]> {
  const artifact = await readArtifact(db, workspaceId, artifactId);
  if (!artifact) return [];
  const versions = (await db
    .prepare(
      `SELECT id FROM artifact_versions
       WHERE workspace_id = ? AND artifact_id = ? AND state = 'available'
       ORDER BY created_at ASC, id ASC`,
    )
    .all(workspaceId, artifactId)) as Array<{ id: string }>;
  const latestVersionId = versions[versions.length - 1]?.id ?? null;
  const latestConfigHash = await readLatestConfigHash(db, workspaceId, artifact.run_id);
  const latestSubmissionGit = await readLatestSubmissionGit(db, workspaceId, artifact.run_id);
  const rows = (await db
    .prepare(
      `SELECT id, artifact_id, version_id, content_hash, reviewer_human_id, decision,
              comment, git_commit, config_hash, review_timer_observation_id, created_at
       FROM artifact_reviews
       WHERE workspace_id = ? AND artifact_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(workspaceId, artifactId)) as ReviewRow[];
  return rows.map((row) =>
    flagReview(reviewRecord(row), latestVersionId, latestConfigHash, latestSubmissionGit),
  );
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
): Promise<LinkedSubmissionView[]> {
  const artifact = await readArtifact(db, workspaceId, artifactId);
  if (!artifact?.run_id) return [];
  const versions = (await db
    .prepare(`SELECT id FROM artifact_versions WHERE workspace_id = ? AND artifact_id = ?`)
    .all(workspaceId, artifactId)) as Array<{ id: string }>;
  const versionIds = new Set(versions.map((version) => version.id));
  const rows = (await db
    .prepare(
      `SELECT s.id, s.run_id, s.version, s.evidence_refs_json, r.result_state
       FROM result_submissions AS s
       JOIN runs AS r ON r.workspace_id = s.workspace_id AND r.id = s.run_id
       WHERE s.workspace_id = ? AND s.run_id = ?
       ORDER BY s.version DESC`,
    )
    .all(workspaceId, artifact.run_id)) as Array<{
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
 * `approve` review; earlier approvals stay historical.
 */
export async function getArtifactReviewStatus(
  db: ReviewDb,
  workspaceId: string,
  artifactId: string,
): Promise<ArtifactReviewStatus | undefined> {
  const artifact = await readArtifact(db, workspaceId, artifactId);
  if (!artifact) return undefined;
  const versions = await readVersions(db, workspaceId, artifactId);
  const available = versions.filter((version) => version.state === "available");
  const latest = available[available.length - 1] ?? null;
  const reviews = await listArtifactReviews(db, workspaceId, artifactId);
  const linked = await listLinkedSubmissions(db, workspaceId, artifactId, latest?.id ?? null);
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
    reviews,
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
): Promise<Map<string, string>> {
  const rows = (await db
    .prepare(
      `SELECT artifact_id, id FROM artifact_versions
       WHERE workspace_id = ? AND state = 'available'
       ORDER BY created_at ASC, id ASC`,
    )
    .all(workspaceId)) as Array<{ artifact_id: string; id: string }>;
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(`artifact_version\n${row.artifact_id}`, row.id);
  }
  return map;
}
