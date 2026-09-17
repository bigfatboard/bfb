// ABOUTME: Delegated remote-MCP extensions over the A02/A03/V01 records and state machines.
// ABOUTME: X03 owns these commands; owning-package commands keep rejecting delegation.

import type { SqlDatabase } from "@bfb/db";

import {
  ARTIFACT_FORMATS,
  ARTIFACT_GRANT_TTL_MS,
  ARTIFACT_ROLES,
  roleMaxBytes,
  type ArtifactFormat,
  type ArtifactRole,
} from "./artifacts.js";
import {
  ATTENTION_KINDS,
  ATTENTION_KIND_ROLES,
  type AttentionKind,
  type AttentionRecord,
  type AttentionState,
} from "./attention.js";
import { assertEpoch, assertProjectAccess, assertRole, loadPrincipal } from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";
import { enforceDelegationAccess, type ActiveDelegation } from "./oauth.js";
import {
  MAX_EVIDENCE_REFS,
  MAX_RESULT_LIMITATIONS_CHARS,
  MAX_RESULT_SUMMARY_CHARS,
  type EvidenceRef,
  type SubmissionRecord,
} from "./results.js";
import { getTask } from "./work-commands.js";
import { assertRunResultTransition } from "./work-records.js";

const HEX64 = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const EVIDENCE_KIND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

interface DelegationRow {
  id: string;
  human_id: string;
  client_id: string;
  project_id: string | null;
  task_id: string | null;
  scopes_json: string;
  authorization_epoch: number;
  expires_at: string;
  revoked_at: string | null;
}

interface DelegationAuthority {
  principal: Awaited<ReturnType<typeof loadPrincipal>>;
  delegation: ActiveDelegation;
}

/**
 * Resolves the X03A delegation envelope to a live authority. Membership,
 * project access, scope, resource boundary, and epoch are re-evaluated on
 * every call; a revoked, expired, or epoch-mismatched delegation fails
 * before any domain effect.
 */
async function requireDelegationAuthority(
  ctx: HubContext,
  scope: "bfb:read" | "bfb:task:write",
): Promise<DelegationAuthority> {
  if (!ctx.actorHumanId || !ctx.actorDelegationId) {
    throw new DomainError("forbidden", "delegated authority required");
  }
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertEpoch(principal, ctx.authorizationEpoch);
  const row = (await ctx.db
    .prepare(
      `SELECT id, human_id, client_id, project_id, task_id, scopes_json,
              authorization_epoch, expires_at, revoked_at
       FROM oauth_delegations
       WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, ctx.actorDelegationId)) as DelegationRow | undefined;
  if (
    !row ||
    row.human_id !== principal.humanId ||
    row.authorization_epoch !== principal.authorizationEpoch ||
    row.revoked_at !== null ||
    Date.parse(row.expires_at) <= Date.parse(ctx.now)
  ) {
    throw new DomainError("forbidden", "delegation is not active for this authority");
  }
  let scopes: unknown;
  try {
    scopes = JSON.parse(row.scopes_json);
  } catch {
    throw new DomainError("forbidden", "delegation scopes are invalid");
  }
  if (!Array.isArray(scopes) || scopes.some((value) => typeof value !== "string")) {
    throw new DomainError("forbidden", "delegation scopes are invalid");
  }
  if (!scopes.includes(scope)) {
    throw new DomainError("insufficient_scope", `delegation is missing ${scope}`);
  }
  return {
    principal,
    delegation: {
      workspaceId: ctx.workspaceId,
      delegationId: row.id,
      humanId: row.human_id,
      clientId: row.client_id,
      projectId: row.project_id,
      taskId: row.task_id,
      scopes: scopes as string[],
      authorizationEpoch: row.authorization_epoch,
    },
  };
}

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

function exactKeys(
  value: unknown,
  keys: readonly string[],
  code: "invalid_argument" | "request_rejected",
): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new DomainError(
      code,
      code === "invalid_argument" ? "command input is invalid" : "request rejected",
    );
  }
}

function artifactDigest(value: unknown): string {
  if (typeof value !== "string" || !HEX64.test(value)) {
    throw new DomainError("request_rejected", "request rejected");
  }
  return value;
}

function artifactFormat(value: unknown): ArtifactFormat {
  if (typeof value !== "string" || !(ARTIFACT_FORMATS as readonly string[]).includes(value)) {
    throw new DomainError("request_rejected", "request rejected");
  }
  return value as ArtifactFormat;
}

function artifactRole(value: unknown): ArtifactRole {
  if (typeof value !== "string" || !(ARTIFACT_ROLES as readonly string[]).includes(value)) {
    throw new DomainError("request_rejected", "request rejected");
  }
  return value as ArtifactRole;
}

function artifactSize(value: unknown, role: ArtifactRole): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > roleMaxBytes(role)
  ) {
    throw new DomainError("request_rejected", "request rejected");
  }
  return value as number;
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
    for (const key of Object.keys(record)) {
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

async function latestExecutionAssignment(
  db: SqlDatabase,
  workspaceId: string,
  runId: string,
): Promise<{ execution_id: string; assignment_generation: number }> {
  const row = (await db
    .prepare(
      `SELECT execution_id, assignment_generation FROM execution_assignments
       WHERE workspace_id = ? AND run_id = ?
       ORDER BY assignment_generation DESC LIMIT 1`,
    )
    .get(workspaceId, runId)) as
    { execution_id: string; assignment_generation: number } | undefined;
  if (!row) {
    throw new DomainError("invalid_transition", "run has no execution context");
  }
  return row;
}

async function insertAttentionObservation(
  db: SqlDatabase,
  workspaceId: string,
  attentionId: string,
  actorId: string,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO attention_observations
       (workspace_id, observation_id, attention_id, observed_kind, actor_type, actor_id, occurred_at)
       VALUES (?, ?, ?, 'requested', 'human', ?, ?)`,
    )
    .run(workspaceId, randomUlid(), attentionId, actorId, now);
}

export interface RequestDelegatedAttentionInput {
  runId: string;
  kind: AttentionKind;
  question: string;
  referenceKind?: string | undefined;
  referenceId?: string | undefined;
  blocking: boolean;
}

/**
 * Files an attention request under a live OAuth delegation. The request
 * binds the named run (which must sit inside the delegation boundary with a
 * non-terminal result) and that run's latest execution assignment for
 * waiter context. The requesting actor is recorded as the authorizing
 * human; the hub audit row carries the delegation and client. Delegated
 * clients can never answer or resolve: those commands still require a
 * direct human.
 */
export const requestDelegatedAttentionCommand: HubCommand<
  RequestDelegatedAttentionInput,
  AttentionRecord
> = {
  name: "attention.request.delegation",
  auditInput: (input) => ({
    runId: (input as RequestDelegatedAttentionInput)?.runId,
    kind: (input as RequestDelegatedAttentionInput)?.kind,
    blocking: (input as RequestDelegatedAttentionInput)?.blocking,
    questionChars: [...(((input as RequestDelegatedAttentionInput)?.question as string) ?? "")]
      .length,
  }),
  async run(input, ctx) {
    const authority = await requireDelegationAuthority(ctx, "bfb:task:write");
    assertRole(authority.principal, ["owner", "member", "reviewer"]);
    exactKeys(
      input,
      ["runId", "kind", "question", "referenceKind", "referenceId", "blocking"],
      "invalid_argument",
    );
    if (!isUlid(input.runId)) {
      throw new DomainError("not_found", "run not found");
    }
    const run = (await ctx.db
      .prepare(
        `SELECT id, project_id, task_id, result_state FROM runs
         WHERE workspace_id = ? AND id = ? AND purpose = 'work'`,
      )
      .get(ctx.workspaceId, input.runId)) as
      { id: string; project_id: string; task_id: string; result_state: string } | undefined;
    if (!run) {
      throw new DomainError("not_found", "run not found");
    }
    const task = await getTask(ctx.db, ctx.workspaceId, run.task_id);
    if (!task || task.project_id !== run.project_id) {
      throw new DomainError("not_found", "run task not found");
    }
    assertProjectAccess(authority.principal, task.project_id);
    await enforceDelegationAccess(ctx.db, authority.delegation, task.project_id, task.id);
    if (run.result_state !== "open" && run.result_state !== "changes_requested") {
      throw new DomainError(
        "invalid_transition",
        `run in state ${run.result_state} cannot request attention`,
      );
    }
    if (typeof input.kind !== "string" || !ATTENTION_KINDS.includes(input.kind)) {
      throw new DomainError("invalid_argument", "attention kind is invalid");
    }
    const question = boundedText(input.question, "attention question", 1, 2048);
    let referenceKind: string | null = null;
    let referenceId: string | null = null;
    if (input.referenceKind !== undefined || input.referenceId !== undefined) {
      if (input.referenceKind === undefined || input.referenceId === undefined) {
        throw new DomainError("invalid_argument", "attention reference needs kind and id");
      }
      referenceKind = boundedText(input.referenceKind, "attention reference kind", 1, 64);
      referenceId = boundedText(input.referenceId, "attention reference", 1, 128);
    }
    if (typeof input.blocking !== "boolean") {
      throw new DomainError("invalid_argument", "attention blocking flag is invalid");
    }
    const binding = await latestExecutionAssignment(ctx.db, ctx.workspaceId, run.id);
    const requiredRole = ATTENTION_KIND_ROLES[input.kind];
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
        task.project_id,
        task.id,
        run.id,
        binding.execution_id,
        binding.assignment_generation,
        input.kind,
        requiredRole,
        referenceKind,
        referenceId,
        question,
        input.blocking ? 1 : 0,
        ctx.now,
      );
    await insertAttentionObservation(
      ctx.db,
      ctx.workspaceId,
      id,
      authority.principal.humanId,
      ctx.now,
    );
    return {
      id,
      project_id: task.project_id,
      task_id: task.id,
      run_id: run.id,
      run_execution_id: binding.execution_id,
      assignment_generation: binding.assignment_generation,
      kind: input.kind,
      required_role: requiredRole,
      reference_kind: referenceKind,
      reference_id: referenceId,
      question,
      blocking: input.blocking,
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

export interface SubmitDelegatedResultInput {
  runId: string;
  summary: string;
  limitations?: string | undefined;
  evidenceRefs?: EvidenceRef[] | undefined;
  gitBranch?: string | undefined;
  gitCommit?: string | undefined;
  gitDirty?: boolean | undefined;
}

export interface SubmitDelegatedResultResult {
  submission: SubmissionRecord;
  runResultState: "submitted";
  taskState: "review";
  runVersion: number;
  taskVersion: number;
}

/**
 * Submits an immutable result under a live OAuth delegation with the exact
 * A03 transition, versioning, and snapshot-binding semantics. The submitter
 * is recorded as the authorizing human; a delegated client never mints
 * `agent_run` identity. Review, acceptance, failure, and cancellation stay
 * direct-human only.
 */
export const submitDelegatedResultCommand: HubCommand<
  SubmitDelegatedResultInput,
  SubmitDelegatedResultResult
> = {
  name: "result.submit.delegation",
  auditInput: (input) => ({
    runId: (input as SubmitDelegatedResultInput)?.runId,
    summaryLength:
      typeof (input as SubmitDelegatedResultInput)?.summary === "string"
        ? [...(input as SubmitDelegatedResultInput).summary].length
        : 0,
    evidenceRefs: Array.isArray((input as SubmitDelegatedResultInput)?.evidenceRefs)
      ? (input as SubmitDelegatedResultInput).evidenceRefs!.length
      : 0,
    gitCommit:
      typeof (input as SubmitDelegatedResultInput)?.gitCommit === "string"
        ? (input as SubmitDelegatedResultInput).gitCommit
        : null,
  }),
  async run(input, ctx) {
    const authority = await requireDelegationAuthority(ctx, "bfb:task:write");
    assertRole(authority.principal, ["owner", "member"]);
    if (!isUlid(input.runId)) {
      throw new DomainError("not_found", "run not found");
    }
    const run = (await ctx.db
      .prepare(
        `SELECT id, project_id, task_id, result_state, resource_version
         FROM runs WHERE workspace_id = ? AND id = ? AND purpose = 'work'`,
      )
      .get(ctx.workspaceId, input.runId)) as
      | {
          id: string;
          project_id: string;
          task_id: string;
          result_state: string;
          resource_version: number;
        }
      | undefined;
    if (!run) {
      throw new DomainError("not_found", "run not found");
    }
    const task = await getTask(ctx.db, ctx.workspaceId, run.task_id);
    if (!task) {
      throw new DomainError("not_found", "task not found");
    }
    assertProjectAccess(authority.principal, task.project_id);
    await enforceDelegationAccess(ctx.db, authority.delegation, task.project_id, task.id);
    const summary = boundedText(input.summary, "result summary", 1, MAX_RESULT_SUMMARY_CHARS);
    const limitations =
      input.limitations === undefined ||
      (typeof input.limitations === "string" && input.limitations.trim().length === 0)
        ? ""
        : boundedText(input.limitations, "result limitations", 1, MAX_RESULT_LIMITATIONS_CHARS);
    const refs = evidenceRefs(input.evidenceRefs);
    let gitBranch: string | null = null;
    let gitCommit: string | null = null;
    let gitDirty: number | null = null;
    if (input.gitBranch !== undefined) {
      gitBranch = boundedText(input.gitBranch, "git branch", 1, 256);
    }
    if (input.gitCommit !== undefined) {
      if (typeof input.gitCommit !== "string" || !GIT_COMMIT_PATTERN.test(input.gitCommit)) {
        throw new DomainError("invalid_argument", "git commit is invalid");
      }
      gitCommit = input.gitCommit;
    }
    if (input.gitDirty !== undefined) {
      if (typeof input.gitDirty !== "boolean") {
        throw new DomainError("invalid_argument", "git dirty is invalid");
      }
      gitDirty = input.gitDirty ? 1 : 0;
    }
    assertRunResultTransition(run.result_state as "open", "submitted");
    if (task.state !== "active") {
      throw new DomainError("invalid_transition", "submission requires an active task");
    }
    const snapshot = (await ctx.db
      .prepare(
        `SELECT id, content_hash FROM run_configuration_snapshots
         WHERE workspace_id = ? AND run_id = ?
         ORDER BY snapshot_generation DESC LIMIT 1`,
      )
      .get(ctx.workspaceId, run.id)) as { id: string; content_hash: string } | undefined;
    if (!snapshot) {
      throw new DomainError("invalid_transition", "run has no configuration snapshot");
    }
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        id,
        run.id,
        nextVersion,
        summary,
        limitations,
        JSON.stringify(refs),
        gitBranch,
        gitCommit,
        gitDirty,
        snapshot.id,
        snapshot.content_hash,
        authority.principal.humanId,
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
        git_branch: gitBranch,
        git_commit: gitCommit,
        git_dirty: gitDirty === null ? null : gitDirty === 1,
        config_snapshot_id: snapshot.id,
        config_hash: snapshot.content_hash,
        submitted_by_kind: "human",
        submitted_by_id: authority.principal.humanId,
        submitted_at: ctx.now,
      },
      runResultState: "submitted",
      taskState: "review",
      runVersion: nextRunVersion,
      taskVersion: nextTaskVersion,
    };
  },
};

export interface CreateDelegatedArtifactInput {
  artifactId?: string | null;
  /** Delegated publication always binds an in-boundary run; run-less artifacts stay human-only. */
  runId: string;
  format: ArtifactFormat;
  role: ArtifactRole;
  declaredSize: number;
  expectedDigest: string;
  /** SHA-256 of the tool-minted plaintext secret; the secret itself never enters D1. */
  grantSecretHash: string;
}

export interface CreateDelegatedArtifactResult {
  schema_version: 1;
  artifact_id: string;
  version_id: string;
  state: "uploading";
  format: ArtifactFormat;
  role: ArtifactRole;
  declared_size: number;
  expected_digest: string;
  upload_grant: {
    schema_version: 1;
    grant_id: string;
    version_id: string;
    grant_hash: string;
    expires_at: string;
  };
}

/**
 * Starts an artifact publication under a live OAuth delegation with the
 * exact V01 uploading-version plus one-time-grant semantics. The grant is
 * bound to the authorizing human and current epoch; the plaintext secret is
 * minted by the calling tool and never enters D1. Finalization and recovery
 * stay on their own delegated/human commands.
 */
export const createDelegatedArtifactCommand: HubCommand<
  CreateDelegatedArtifactInput,
  CreateDelegatedArtifactResult
> = {
  name: "artifact.create_version.delegation",
  replay: "reject",
  auditInput: () => ({ action: "artifact.create_version.delegation" }),
  async run(input, ctx) {
    const authority = await requireDelegationAuthority(ctx, "bfb:task:write");
    assertRole(authority.principal, ["owner", "member"]);
    exactKeys(
      input,
      [
        "artifactId",
        "runId",
        "format",
        "role",
        "declaredSize",
        "expectedDigest",
        "grantSecretHash",
      ],
      "request_rejected",
    );
    const format = artifactFormat(input.format);
    const role = artifactRole(input.role);
    const declaredSize = artifactSize(input.declaredSize, role);
    const expectedDigest = artifactDigest(input.expectedDigest);
    if (typeof input.grantSecretHash !== "string" || !HEX64.test(input.grantSecretHash)) {
      throw new DomainError("request_rejected", "request rejected");
    }
    if (typeof input.runId !== "string" || !isUlid(input.runId)) {
      throw new DomainError("request_rejected", "request rejected");
    }
    const run = (await ctx.db
      .prepare(`SELECT id, project_id, task_id FROM runs WHERE workspace_id = ? AND id = ?`)
      .get(ctx.workspaceId, input.runId)) as
      { id: string; project_id: string; task_id: string } | undefined;
    if (!run) {
      throw new DomainError("request_rejected", "request rejected");
    }
    const task = await getTask(ctx.db, ctx.workspaceId, run.task_id);
    if (!task || task.project_id !== run.project_id) {
      throw new DomainError("request_rejected", "request rejected");
    }
    assertProjectAccess(authority.principal, task.project_id);
    await enforceDelegationAccess(ctx.db, authority.delegation, task.project_id, task.id);
    let artifactId: string | null =
      input.artifactId === undefined || input.artifactId === null ? null : input.artifactId;
    if (artifactId !== null) {
      if (typeof artifactId !== "string" || !isUlid(artifactId)) {
        throw new DomainError("request_rejected", "request rejected");
      }
      const existing = (await ctx.db
        .prepare(`SELECT id, run_id, format, role FROM artifacts WHERE workspace_id = ? AND id = ?`)
        .get(ctx.workspaceId, artifactId)) as
        { id: string; run_id: string | null; format: string; role: string } | undefined;
      if (!existing) {
        throw new DomainError("request_rejected", "request rejected");
      }
      if (existing.format !== format || existing.role !== role) {
        throw new DomainError("request_rejected", "request rejected");
      }
      if ((existing.run_id ?? null) !== run.id) {
        throw new DomainError("request_rejected", "request rejected");
      }
    } else {
      artifactId = randomUlid();
      await ctx.db
        .prepare(
          `INSERT INTO artifacts
           (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ctx.workspaceId,
          artifactId,
          run.id,
          format,
          role,
          authority.principal.humanId,
          ctx.now,
        );
    }
    const versionId = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO artifact_versions
         (workspace_id, id, artifact_id, state, format, declared_size, expected_digest,
          content_hash, r2_key, created_at, available_at)
         VALUES (?, ?, ?, 'uploading', ?, ?, ?, NULL, NULL, ?, NULL)`,
      )
      .run(ctx.workspaceId, versionId, artifactId, format, declaredSize, expectedDigest, ctx.now);
    const grantId = randomUlid();
    const expiresAt = new Date(Date.parse(ctx.now) + ARTIFACT_GRANT_TTL_MS).toISOString();
    await ctx.db
      .prepare(
        `INSERT INTO artifact_upload_grants
         (workspace_id, id, version_id, grant_hash, human_id, authorization_epoch,
          run_id, format, declared_size, expected_digest, expires_at, consumed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        grantId,
        versionId,
        input.grantSecretHash,
        authority.principal.humanId,
        authority.principal.authorizationEpoch,
        run.id,
        format,
        declaredSize,
        expectedDigest,
        expiresAt,
        null,
        ctx.now,
      );
    await ctx.db
      .prepare(
        `INSERT INTO artifact_audit_outbox
         (id, workspace_id, version_id, grant_id, action, payload_json, created_at, dispatched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        randomUlid(),
        ctx.workspaceId,
        versionId,
        grantId,
        "artifact.grant_issued",
        JSON.stringify({
          version_id: versionId,
          grant_id: grantId,
          grant_hash: input.grantSecretHash,
          format,
          role,
          declared_size: declaredSize,
        }),
        ctx.now,
      );
    return {
      schema_version: 1,
      artifact_id: artifactId,
      version_id: versionId,
      state: "uploading",
      format,
      role,
      declared_size: declaredSize,
      expected_digest: expectedDigest,
      upload_grant: {
        schema_version: 1,
        grant_id: grantId,
        version_id: versionId,
        grant_hash: input.grantSecretHash,
        expires_at: expiresAt,
      },
    };
  },
};

export interface FinalizeDelegatedArtifactInput {
  versionId: string;
  contentHash: string;
  size: number;
}

export interface FinalizeDelegatedArtifactResult {
  schema_version: 1;
  version_id: string;
  artifact_id: string;
  state: "available";
  content_hash: string;
  r2_key: string;
  available_at: string;
}

/**
 * Finalizes a delegated artifact version after the Artifact Worker verified
 * the uploaded bytes. Requires the same verified receipt, hash, size, and
 * server-derived key as the human path, plus a live delegation whose
 * boundary still contains the version's run. Approval and review stay
 * human-only surfaces.
 */
export const finalizeDelegatedArtifactCommand: HubCommand<
  FinalizeDelegatedArtifactInput,
  FinalizeDelegatedArtifactResult
> = {
  name: "artifact.finalize_version.delegation",
  replay: "reject",
  auditInput: () => ({ action: "artifact.finalize_version.delegation" }),
  async run(input, ctx) {
    const authority = await requireDelegationAuthority(ctx, "bfb:task:write");
    assertRole(authority.principal, ["owner", "member"]);
    exactKeys(input, ["versionId", "contentHash", "size"], "request_rejected");
    if (typeof input.versionId !== "string" || !isUlid(input.versionId)) {
      throw new DomainError("request_rejected", "request rejected");
    }
    const contentHash = artifactDigest(input.contentHash);
    if (!Number.isSafeInteger(input.size) || (input.size as number) < 1) {
      throw new DomainError("request_rejected", "request rejected");
    }
    const version = (await ctx.db
      .prepare(`SELECT * FROM artifact_versions WHERE workspace_id = ? AND id = ?`)
      .get(ctx.workspaceId, input.versionId)) as
      | {
          id: string;
          artifact_id: string;
          state: string;
          declared_size: number;
          expected_digest: string;
        }
      | undefined;
    if (!version) {
      throw new DomainError("request_rejected", "request rejected");
    }
    if (version.state !== "uploading") {
      throw new DomainError("request_rejected", "request rejected");
    }
    if (version.expected_digest !== contentHash || version.declared_size !== input.size) {
      throw new DomainError("request_rejected", "request rejected");
    }
    const artifact = (await ctx.db
      .prepare(`SELECT run_id FROM artifacts WHERE workspace_id = ? AND id = ?`)
      .get(ctx.workspaceId, version.artifact_id)) as { run_id: string | null } | undefined;
    if (!artifact || !artifact.run_id || !isUlid(artifact.run_id)) {
      throw new DomainError("request_rejected", "request rejected");
    }
    const run = (await ctx.db
      .prepare(`SELECT id, project_id, task_id FROM runs WHERE workspace_id = ? AND id = ?`)
      .get(ctx.workspaceId, artifact.run_id)) as
      { id: string; project_id: string; task_id: string } | undefined;
    if (!run) {
      throw new DomainError("request_rejected", "request rejected");
    }
    const task = await getTask(ctx.db, ctx.workspaceId, run.task_id);
    if (!task || task.project_id !== run.project_id) {
      throw new DomainError("request_rejected", "request rejected");
    }
    assertProjectAccess(authority.principal, task.project_id);
    await enforceDelegationAccess(ctx.db, authority.delegation, task.project_id, task.id);
    const receipt = (await ctx.db
      .prepare(
        `SELECT content_hash, size FROM artifact_upload_receipts
         WHERE workspace_id = ? AND version_id = ?`,
      )
      .get(ctx.workspaceId, input.versionId)) as { content_hash: string; size: number } | undefined;
    if (!receipt || receipt.content_hash !== contentHash || receipt.size !== input.size) {
      throw new DomainError("request_rejected", "request rejected");
    }
    const object = (await ctx.db
      .prepare(`SELECT r2_key, size FROM artifact_objects WHERE content_hash = ?`)
      .get(contentHash)) as { r2_key: string; size: number } | undefined;
    if (!object || object.size !== input.size) {
      throw new DomainError("request_rejected", "request rejected");
    }
    await ctx.db
      .prepare(
        `UPDATE artifact_versions
         SET state = 'available', content_hash = ?, r2_key = ?, available_at = ?
         WHERE workspace_id = ? AND id = ? AND state = 'uploading'`,
      )
      .run(contentHash, object.r2_key, ctx.now, ctx.workspaceId, input.versionId);
    const guardId = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO artifact_mutation_guards (id, valid) VALUES (?,
         (SELECT COUNT(*) = 1 FROM artifact_versions
          WHERE workspace_id = ? AND id = ? AND state = 'available'
            AND content_hash = ? AND r2_key = ?))`,
      )
      .run(guardId, ctx.workspaceId, input.versionId, contentHash, object.r2_key);
    await ctx.db.prepare(`DELETE FROM artifact_mutation_guards WHERE id = ?`).run(guardId);
    await ctx.db
      .prepare(
        `INSERT INTO artifact_audit_outbox
         (id, workspace_id, version_id, grant_id, action, payload_json, created_at, dispatched_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)`,
      )
      .run(
        randomUlid(),
        ctx.workspaceId,
        input.versionId,
        "artifact.finalized",
        JSON.stringify({
          version_id: input.versionId,
          content_hash: contentHash,
          r2_key: object.r2_key,
          size: input.size,
        }),
        ctx.now,
      );
    return {
      schema_version: 1,
      version_id: input.versionId,
      artifact_id: version.artifact_id,
      state: "available",
      content_hash: contentHash,
      r2_key: object.r2_key,
      available_at: ctx.now,
    };
  },
};
