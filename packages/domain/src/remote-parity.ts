// ABOUTME: Delegated remote-MCP extensions over the A02/A03/V01 records and state machines.
// ABOUTME: X03 owns these commands; owning-package commands keep rejecting delegation.

import type { SqlDatabase } from "@bfb/db";

import {
  ARTIFACT_FORMATS,
  ARTIFACT_GRANT_TTL_MS,
  ARTIFACT_ROLES,
  artifactObjectKey,
  publicArtifactCreationBusinessSelection,
  publicArtifactFinalizationBusinessSelection,
  publicArtifactVersionBusinessSelection,
  roleMaxBytes,
  type ArtifactFormat,
  type ArtifactRole,
} from "./artifacts.js";
import {
  ATTENTION_KINDS,
  ATTENTION_KIND_ROLES,
  publicAttentionBusinessSelection,
  type AttentionKind,
  type AttentionRecord,
  type AttentionState,
} from "./attention.js";
import {
  assertEpoch,
  assertProjectAccess,
  assertRole,
  loadPrincipal,
  type WorkspaceRole,
} from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";
import { enforceDelegationAccess, type ActiveDelegation } from "./oauth.js";
import { canonicalLaunchJson } from "./launch-state.js";
import { runnerHash } from "./runner-crypto.js";
import {
  authorizeResultEvidence,
  cachedResultEvidence,
  guardResultEvidence,
  publicSubmissionBusinessSelection,
  MAX_EVIDENCE_REFS,
  MAX_RESULT_LIMITATIONS_CHARS,
  MAX_RESULT_SUMMARY_CHARS,
  type EvidenceRef,
  type SubmissionRecord,
} from "./results.js";
import {
  delegatedCredentialPredicate,
  getTask,
  readTaskPredicate,
  type TaskReadAccess,
} from "./work-commands.js";
import { assertRunResultTransition } from "./work-records.js";
import { assertTaskAccess, taskAccessPredicate } from "./task-access.js";
import { publicBusinessCommand, publicRunAuthorityPredicate } from "./public-business.js";

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

function delegationTaskAccess(authority: DelegationAuthority): TaskReadAccess {
  return {
    ...authority.delegation,
    ...(authority.delegation.taskId ? { taskBoundaryId: authority.delegation.taskId } : {}),
  };
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

async function delegatedRunAuthority(runId: string, ctx: HubContext, roles: WorkspaceRole[]) {
  const authority = await requireDelegationAuthority(ctx, "bfb:task:write");
  assertRole(authority.principal, roles);
  if (!isUlid(runId)) throw new DomainError("not_found", "run not found");
  const run = (await ctx.db
    .prepare(
      `SELECT id, project_id, task_id, result_state, resource_version FROM runs
     WHERE workspace_id = ? AND id = ? AND purpose = 'work'`,
    )
    .get(ctx.workspaceId, runId)) as
    | {
        id: string;
        project_id: string;
        task_id: string;
        result_state: string;
        resource_version: number;
      }
    | undefined;
  if (!run) throw new DomainError("not_found", "run not found");
  try {
    assertProjectAccess(authority.principal, run.project_id);
    await enforceDelegationAccess(ctx.db, authority.delegation, run.project_id, run.task_id);
    await assertTaskAccess(ctx.db, authority.delegation, run.task_id, "contribute");
    const task = await getTask(
      ctx.db,
      ctx.workspaceId,
      run.task_id,
      delegationTaskAccess(authority),
    );
    if (!task || task.project_id !== run.project_id)
      throw new DomainError("not_found", "run not found");
    return { authority, run, task };
  } catch (error) {
    if (error instanceof DomainError && error.code === "not_found")
      throw new DomainError("not_found", "run not found");
    throw error;
  }
}

async function delegatedArtifactRunAuthority(runId: string, ctx: HubContext) {
  try {
    return await delegatedRunAuthority(runId, ctx, ["owner", "member"]);
  } catch (error) {
    // Artifact publication preserves its uniform missing/denied rejection contract.
    if (error instanceof DomainError && error.code === "not_found")
      throw new DomainError("request_rejected", "request rejected");
    throw error;
  }
}

type DelegatedRunCommitTarget =
  | { kind: "attention"; executionId: string; assignmentGeneration: number }
  | { kind: "create"; artifactId: string | null; format: ArtifactFormat; role: ArtifactRole }
  | {
      kind: "finalize";
      artifactId: string;
      versionId: string;
      format: ArtifactFormat;
      role: ArtifactRole;
      contentHash: string;
      size: number;
      r2Key: string;
    };

/** Repeat retained delegated authority and the exact command target in the committing batch. */
async function guardDelegatedRunCommit(
  ctx: HubContext,
  authenticated: Awaited<ReturnType<typeof delegatedRunAuthority>>,
  target: DelegatedRunCommitTarget,
) {
  const { authority, run } = authenticated;
  const contribute = taskAccessPredicate(authority.delegation, "contribute", "task");
  const credential = readTaskPredicate(delegationTaskAccess(authority), "task");
  const scopes = `CASE WHEN json_valid(credential.scopes_json) THEN
    CASE WHEN json_type(credential.scopes_json) = 'array' THEN credential.scopes_json ELSE '[]' END
    ELSE '[]' END`;
  const roles = target.kind === "attention" ? "'owner', 'member', 'reviewer'" : "'owner', 'member'";
  let commandTarget = "1";
  const targetParameters: Array<string | number> = [];
  if (target.kind === "finalize") {
    commandTarget = `EXISTS (
      SELECT 1 FROM artifacts AS artifact
      JOIN artifact_versions AS version
        ON version.workspace_id = artifact.workspace_id AND version.artifact_id = artifact.id
      JOIN artifact_upload_receipts AS receipt
        ON receipt.workspace_id = version.workspace_id AND receipt.version_id = version.id
      JOIN artifact_objects AS object
        ON object.workspace_id = version.workspace_id AND object.r2_key = ?
      WHERE artifact.workspace_id = run.workspace_id AND artifact.id = ?
        AND artifact.run_id = run.id AND artifact.format = ? AND artifact.role = ?
        AND version.id = ? AND version.state = 'uploading' AND version.format = artifact.format
        AND version.expected_digest = ? AND version.declared_size = ?
        AND receipt.content_hash = version.expected_digest AND receipt.size = version.declared_size
        AND object.content_hash = receipt.content_hash AND object.size = receipt.size
    )`;
    targetParameters.push(
      target.r2Key,
      target.artifactId,
      target.format,
      target.role,
      target.versionId,
      target.contentHash,
      target.size,
    );
  } else if (target.kind === "attention") {
    commandTarget = `run.result_state IN ('open', 'changes_requested', 'submitted') AND EXISTS (
      SELECT 1 FROM execution_assignments AS assignment
      WHERE assignment.workspace_id = run.workspace_id AND assignment.execution_id = ?
        AND assignment.assignment_generation = ? AND assignment.run_id = run.id
        AND assignment.task_id = run.task_id AND assignment.project_id = run.project_id
    )`;
    targetParameters.push(target.executionId, target.assignmentGeneration);
  } else if (target.artifactId !== null) {
    commandTarget = `EXISTS (
      SELECT 1 FROM artifacts AS artifact
      WHERE artifact.workspace_id = run.workspace_id AND artifact.id = ?
        AND artifact.run_id = run.id AND artifact.format = ? AND artifact.role = ?
    )`;
    targetParameters.push(target.artifactId, target.format, target.role);
  }
  const id = randomUlid();
  // SQL execution time is an additional ceiling; prepared clocks and work observations stay intact.
  await ctx.db
    .prepare(
      `INSERT INTO artifact_mutation_guards (id,valid)
      SELECT ?, CASE WHEN EXISTS (
        SELECT 1 FROM oauth_delegations AS credential
        WHERE credential.workspace_id = ? AND credential.id = ?
          AND julianday(credential.expires_at) > julianday('now')
      ) THEN 1 ELSE 0 END`,
    )
    .run(id, ctx.workspaceId, authority.delegation.delegationId);
  await ctx.db.prepare("DELETE FROM artifact_mutation_guards WHERE id = ?").run(id);
  await ctx.db
    .prepare(
      `INSERT INTO artifact_mutation_guards (id,valid)
      SELECT ?, CASE WHEN EXISTS (
        SELECT 1 FROM runs AS run
        JOIN tasks AS task ON task.workspace_id = run.workspace_id AND task.id = run.task_id
        JOIN oauth_delegations AS credential ON credential.workspace_id = run.workspace_id
        JOIN workspace_members AS sponsor
          ON sponsor.workspace_id = credential.workspace_id AND sponsor.human_id = credential.human_id
        WHERE run.workspace_id = ? AND run.id = ? AND run.project_id = ? AND run.task_id = ?
          AND run.purpose = 'work' AND task.project_id = run.project_id
          AND credential.id = ? AND credential.human_id = ? AND credential.client_id = ?
          AND credential.authorization_epoch = ? AND credential.revoked_at IS NULL
          AND sponsor.role IN (${roles})
          AND EXISTS (SELECT 1 FROM json_each(${scopes}) AS scope
            WHERE scope.type = 'text' AND scope.value = 'bfb:task:write')
          AND NOT EXISTS (SELECT 1 FROM json_each(${scopes}) AS scope WHERE scope.type <> 'text')
          AND ${contribute.sql} AND ${credential.sql} AND ${commandTarget}
      ) THEN 1 ELSE 0 END`,
    )
    .run(
      id,
      ctx.workspaceId,
      run.id,
      run.project_id,
      run.task_id,
      authority.delegation.delegationId,
      authority.delegation.humanId,
      authority.delegation.clientId,
      authority.delegation.authorizationEpoch,
      ...contribute.parameters,
      ...credential.parameters,
      ...targetParameters,
    );
  await ctx.db.prepare("DELETE FROM artifact_mutation_guards WHERE id = ?").run(id);
}

function delegatedFingerprint(input: unknown): string {
  // Omit absent optional fields exactly as the transport JSON does; retain supplied input.
  return runnerHash(canonicalLaunchJson(JSON.parse(JSON.stringify(input))));
}

async function delegatedAttentionAuthority(input: RequestDelegatedAttentionInput, ctx: HubContext) {
  exactKeys(
    input,
    ["runId", "kind", "question", "referenceKind", "referenceId", "blocking"],
    "invalid_argument",
  );
  const state = await delegatedRunAuthority(input.runId, ctx, ["owner", "member", "reviewer"]);
  if (!["open", "changes_requested", "submitted"].includes(state.run.result_state)) {
    throw new DomainError(
      "invalid_transition",
      `run in state ${state.run.result_state} cannot request attention`,
    );
  }
  return state;
}

async function delegatedResultAuthority(input: SubmitDelegatedResultInput, ctx: HubContext) {
  exactKeys(
    input,
    ["runId", "summary", "limitations", "evidenceRefs", "gitBranch", "gitCommit", "gitDirty"],
    "invalid_argument",
  );
  // A historical result retry may replay after submission; transition validation stays in run().
  const state = await delegatedRunAuthority(input.runId, ctx, ["owner", "member"]);
  await authorizeResultEvidence(
    ctx.db,
    ctx.workspaceId,
    state.task.id,
    evidenceRefs(input.evidenceRefs),
    delegationTaskAccess(state.authority),
    undefined,
    state.run.id,
  );
  return state;
}

export interface RequestDelegatedAttentionInput {
  runId: string;
  kind: AttentionKind;
  question: string;
  referenceKind?: string | undefined;
  referenceId?: string | undefined;
  blocking: boolean;
}

const delegatedAttentionReplayAuthorities = new WeakMap<
  HubContext,
  Awaited<ReturnType<typeof delegatedAttentionAuthority>>
>();

async function replayDelegatedAttentionResult(
  result: AttentionRecord,
  ctx: HubContext,
): Promise<AttentionRecord> {
  const retained = delegatedAttentionReplayAuthorities.get(ctx);
  if (
    !retained ||
    result.run_id !== retained.run.id ||
    result.task_id !== retained.task.id ||
    result.project_id !== retained.task.project_id
  )
    throw new DomainError("not_found", "attention request not found");
  const { authority, run } = retained;
  const access = delegationTaskAccess(authority);
  const contribute = taskAccessPredicate(authority.principal, "contribute");
  const boundary = readTaskPredicate(access);
  const credential = delegatedCredentialPredicate(
    {
      ...access,
      delegationId: authority.delegation.delegationId,
      clientId: authority.delegation.clientId,
      projectBoundaryId: authority.delegation.projectId,
    },
    "bfb:task:write",
  );
  const row = await ctx.db
    .prepare(
      `SELECT 1 AS authorized FROM attention_requests AS attention
       JOIN tasks AS task ON task.workspace_id = attention.workspace_id
         AND task.id = attention.task_id AND task.project_id = attention.project_id
       JOIN runs AS run ON run.workspace_id = attention.workspace_id
         AND run.id = attention.run_id AND run.task_id = task.id AND run.project_id = task.project_id
       JOIN run_executions AS execution ON execution.workspace_id = attention.workspace_id
         AND execution.id = attention.run_execution_id AND execution.run_id = run.id
       JOIN execution_assignments AS assignment ON assignment.workspace_id = attention.workspace_id
         AND assignment.execution_id = execution.id
         AND assignment.assignment_generation = attention.assignment_generation
         AND assignment.run_id = run.id AND assignment.task_id = task.id
         AND assignment.project_id = task.project_id
       WHERE attention.workspace_id = ? AND attention.id = ? AND attention.run_id = ?
         AND attention.task_id = ? AND attention.project_id = ?
         AND attention.run_execution_id = ? AND attention.assignment_generation = ?
         AND run.purpose = 'work' AND run.result_state IN ('open', 'changes_requested', 'submitted')
         AND attention.project_id IN (SELECT value FROM json_each(?))
         AND ${contribute.sql} AND ${boundary.sql}
         AND EXISTS (SELECT 1 FROM oauth_delegations AS credential WHERE ${credential.sql})`,
    )
    .get(
      ctx.workspaceId,
      result.id,
      run.id,
      result.task_id,
      result.project_id,
      result.run_execution_id,
      result.assignment_generation,
      JSON.stringify(authority.principal.projectIds),
      ...contribute.parameters,
      ...boundary.parameters,
      ...credential.parameters,
    );
  if (!row) throw new DomainError("not_found", "attention request not found");
  return result;
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
const requestDelegatedAttentionBase: HubCommand<RequestDelegatedAttentionInput, AttentionRecord> = {
  name: "attention.request.delegation",
  authorize: async (input, ctx) => {
    delegatedAttentionReplayAuthorities.set(ctx, await delegatedAttentionAuthority(input, ctx));
  },
  replayResult: replayDelegatedAttentionResult,
  inputFingerprint: delegatedFingerprint,
  auditInput: (input) => ({
    runId: (input as RequestDelegatedAttentionInput)?.runId,
    kind: (input as RequestDelegatedAttentionInput)?.kind,
    blocking: (input as RequestDelegatedAttentionInput)?.blocking,
    questionChars: [...(((input as RequestDelegatedAttentionInput)?.question as string) ?? "")]
      .length,
  }),
  auditResult: (record) => ({
    id: record.id,
    kind: record.kind,
    state: record.state,
    resource_version: record.resource_version,
    project_id: record.project_id,
    task_id: record.task_id,
    run_id: record.run_id,
    run_execution_id: record.run_execution_id,
    assignment_generation: record.assignment_generation,
  }),
  async run(input, ctx) {
    const authenticated = await delegatedAttentionAuthority(input, ctx);
    const { authority, run, task } = authenticated;
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
    await guardDelegatedRunCommit(ctx, authenticated, {
      kind: "attention",
      executionId: binding.execution_id,
      assignmentGeneration: binding.assignment_generation,
    });
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
const submitDelegatedResultBase: HubCommand<
  SubmitDelegatedResultInput,
  SubmitDelegatedResultResult
> = {
  name: "result.submit.delegation",
  authorize: async (input, ctx) => {
    await delegatedResultAuthority(input, ctx);
  },
  replayResult: async (result, ctx, input) => {
    const refs = cachedResultEvidence(result, input.runId);
    try {
      const fresh = { ...ctx, now: new Date().toISOString() };
      const { authority, run, task } = await delegatedRunAuthority(input.runId, fresh, [
        "owner",
        "member",
      ]);
      await authorizeResultEvidence(
        fresh.db,
        fresh.workspaceId,
        task.id,
        refs,
        delegationTaskAccess(authority),
        undefined,
        run.id,
      );
      return result;
    } catch (error) {
      if (refs.some((ref) => ref.kind === "artifact_version") && error instanceof DomainError)
        throw new DomainError("not_found", "evidence artifact not found");
      throw error;
    }
  },
  inputFingerprint: delegatedFingerprint,
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
  auditResult: (result) => ({
    submission_id: result.submission.id,
    run_id: result.submission.run_id,
    submission_version: result.submission.version,
    submitted_by_kind: result.submission.submitted_by_kind,
    submitted_by_id: result.submission.submitted_by_id,
    submitted_at: result.submission.submitted_at,
    evidence_count: result.submission.evidence_refs.length,
    run_state: result.runResultState,
    task_state: result.taskState,
    run_version: result.runVersion,
    task_version: result.taskVersion,
  }),
  async run(input, ctx) {
    const { authority, run, task } = await delegatedResultAuthority(input, ctx);
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
    await guardResultEvidence(
      ctx,
      task.id,
      refs,
      delegationTaskAccess(authority),
      undefined,
      run.id,
    );
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

export const requestDelegatedAttentionCommand = publicBusinessCommand(
  requestDelegatedAttentionBase,
  {
    admission: (input, authority) =>
      publicRunAuthorityPredicate(authority, input.runId, "contribute"),
    delivery: (input, result, authority) => {
      const selection = publicAttentionBusinessSelection(authority, result.id, result, true);
      return {
        ...selection,
        sql: `${selection.sql} AND public_attention.run_id = ?`,
        parameters: [...selection.parameters, input.runId],
      };
    },
  },
);
export const submitDelegatedResultCommand = publicBusinessCommand(submitDelegatedResultBase, {
  admission: (input, authority) =>
    publicRunAuthorityPredicate(authority, input.runId, "contribute", ["owner", "member"]),
  delivery: (input, result, authority) =>
    publicSubmissionBusinessSelection(
      authority,
      input.runId,
      result.submission.id,
      ["owner", "member"],
      result.submission,
    ),
});

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
const createDelegatedArtifactBase: HubCommand<
  CreateDelegatedArtifactInput,
  CreateDelegatedArtifactResult
> = {
  name: "artifact.create_version.delegation",
  replay: "reject",
  authorize: async (input, ctx) => {
    if (!isUlid(input.runId ?? "")) throw new DomainError("request_rejected", "request rejected");
    await delegatedArtifactRunAuthority(input.runId, ctx);
  },
  auditInput: () => ({ action: "artifact.create_version.delegation" }),
  async run(input, ctx) {
    const authenticated = await delegatedArtifactRunAuthority(input.runId, ctx);
    const { authority, run } = authenticated;
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
    }
    await guardDelegatedRunCommit(ctx, authenticated, {
      kind: "create",
      artifactId,
      format,
      role,
    });
    if (artifactId === null) {
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
const finalizeDelegatedArtifactBase: HubCommand<
  FinalizeDelegatedArtifactInput,
  FinalizeDelegatedArtifactResult
> = {
  name: "artifact.finalize_version.delegation",
  replay: "reject",
  authorize: async (input, ctx) => {
    const artifact = (await ctx.db
      .prepare(
        `SELECT artifact.run_id
      FROM artifact_versions AS version JOIN artifacts AS artifact
        ON artifact.workspace_id = version.workspace_id AND artifact.id = version.artifact_id
      WHERE version.workspace_id = ? AND version.id = ?`,
      )
      .get(ctx.workspaceId, input.versionId)) as { run_id: string | null } | undefined;
    if (!artifact?.run_id) throw new DomainError("request_rejected", "request rejected");
    await delegatedArtifactRunAuthority(artifact.run_id, ctx);
  },
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
      .prepare(`SELECT role, run_id, format FROM artifacts WHERE workspace_id = ? AND id = ?`)
      .get(ctx.workspaceId, version.artifact_id)) as
      { role: string; run_id: string | null; format: string } | undefined;
    if (!artifact || !artifact.run_id || !isUlid(artifact.run_id)) {
      throw new DomainError("request_rejected", "request rejected");
    }
    const expectedKey = artifactObjectKey({
      workspaceId: ctx.workspaceId,
      role: artifactRole(artifact.role),
      runId: artifact.run_id,
      versionId: input.versionId,
      contentHash,
    });
    const authenticated = await delegatedArtifactRunAuthority(artifact.run_id, ctx);
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
      .prepare(
        `SELECT content_hash, size FROM artifact_objects
         WHERE workspace_id = ? AND r2_key = ?`,
      )
      .get(ctx.workspaceId, expectedKey)) as { content_hash: string; size: number } | undefined;
    if (!object || object.content_hash !== contentHash || object.size !== input.size) {
      throw new DomainError("request_rejected", "request rejected");
    }
    await guardDelegatedRunCommit(ctx, authenticated, {
      kind: "finalize",
      artifactId: version.artifact_id,
      versionId: input.versionId,
      format: artifactFormat(artifact.format),
      role: artifactRole(artifact.role),
      contentHash,
      size: input.size,
      r2Key: expectedKey,
    });
    await ctx.db
      .prepare(
        `UPDATE artifact_versions
         SET state = 'available', content_hash = ?, r2_key = ?, available_at = ?
         WHERE workspace_id = ? AND id = ? AND state = 'uploading'`,
      )
      .run(contentHash, expectedKey, ctx.now, ctx.workspaceId, input.versionId);
    const guardId = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO artifact_mutation_guards (id, valid) VALUES (?,
         (SELECT COUNT(*) = 1 FROM artifact_versions
          WHERE workspace_id = ? AND id = ? AND state = 'available'
            AND content_hash = ? AND r2_key = ?))`,
      )
      .run(guardId, ctx.workspaceId, input.versionId, contentHash, expectedKey);
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
          r2_key: expectedKey,
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
      r2_key: expectedKey,
      available_at: ctx.now,
    };
  },
};

export const createDelegatedArtifactCommand = publicBusinessCommand(createDelegatedArtifactBase, {
  admission: (input, authority) =>
    publicRunAuthorityPredicate(authority, input.runId, "contribute", ["owner", "member"]),
  delivery: (input, result, authority) =>
    publicArtifactCreationBusinessSelection(
      authority,
      { ...input, artifactId: input.artifactId ?? null },
      result,
    ),
});
export const finalizeDelegatedArtifactCommand = publicBusinessCommand(
  finalizeDelegatedArtifactBase,
  {
    admissionIsSelection: true,
    admission: (input, authority) =>
      publicArtifactVersionBusinessSelection<FinalizeDelegatedArtifactResult>(
        authority,
        input.versionId,
        "contribute",
      ),
    delivery: (input, result, authority) =>
      publicArtifactFinalizationBusinessSelection(authority, input, result),
  },
);
