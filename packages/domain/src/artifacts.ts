// ABOUTME: Owns the artifact grant/upload/finalize state machine and durable abuse budgets.
// ABOUTME: Upload secrets are returned once; D1 keeps hashes, receipts, and audit rows.

import { createHash, randomBytes } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";

import { abuseBucketKey, consumeAbuseBudget } from "./abuse.js";
import { assertEpoch, assertRole, loadPrincipal } from "./authorization.js";
import { DomainError } from "./hub.js";
import type { HubCommand, HubContext } from "./hub.js";
import { isUlid, randomUlid, syntheticUlid } from "./ids.js";

/** Declared artifact formats; validated against sniffed bytes before any R2 write. */
export const ARTIFACT_FORMATS = [
  "markdown",
  "mermaid",
  "diff",
  "svg",
  "png",
  "jpeg",
  "html",
  "log",
  "json",
] as const;
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number];

/** Semantic roles. Review artifacts render for humans; log chunks are compressed run logs. */
export const ARTIFACT_ROLES = ["review", "log"] as const;
export type ArtifactRole = (typeof ARTIFACT_ROLES)[number];

/** Product upload ceiling for review artifacts (5 MiB). */
export const ARTIFACT_REVIEW_MAX_BYTES = 5 * 1024 * 1024;
/** Product upload ceiling for compressed log chunks (1 MiB). */
export const ARTIFACT_LOG_MAX_BYTES = 1 * 1024 * 1024;
/** One-time upload grant lifetime from issuance (milliseconds). */
export const ARTIFACT_GRANT_TTL_MS = 15 * 60_000;
/** Bounded JSON bodies for artifact hub-command routes. */
export const ARTIFACT_BODY_LIMIT = 8_192;
/** Grace after grant expiry before the recovery sweep marks a version failed. */
export const ARTIFACT_ABANDON_GRACE_MS = 5 * 60_000;
/** Fixed system principal for bounded recovery and artifact audit dispatch. */
export const ARTIFACT_RECOVERY_SYSTEM_ID = syntheticUlid("ARTIFACTRECOVERY");

const GRANT_SECRET_BYTES = 32;
const HEX64 = /^[0-9a-f]{64}$/;

/** Durable abuse policy shared by grant creation, issuance, upload attempts, and finalization. */
export const ARTIFACT_ABUSE_POLICY = {
  attemptLimit: 20,
  pollLimit: 60,
  windowSeconds: 60,
  maxBodyBytes: ARTIFACT_BODY_LIMIT,
} as const;

/**
 * Consumes a durable abuse budget for an artifact surface. Subjects carry only
 * hashes of principals, versions, or grants; raw secrets, digests, and IPs
 * never become rate keys or diagnostics.
 */
export async function consumeArtifactBudget(
  db: SqlDatabase,
  options: {
    ipSeed: string;
    subjectSeed: string;
    surface: string;
    subject: string;
    activity: "attempt" | "poll";
    now: string;
  },
): Promise<boolean> {
  const now = Date.parse(options.now);
  if (!Number.isFinite(now)) return false;
  const expiresAt = new Date(now + ARTIFACT_ABUSE_POLICY.windowSeconds * 1000).toISOString();
  for (const [subject, seed] of [
    ["all", options.ipSeed],
    [options.subject, options.subjectSeed],
  ] as const) {
    const decision = await consumeAbuseBudget(
      db,
      {
        bucketKey: abuseBucketKey({ ipHashSeed: seed, subject, surface: options.surface }),
        activity: options.activity,
        bodyBytes: 0,
        now: options.now,
        expiresAt,
      },
      ARTIFACT_ABUSE_POLICY,
    );
    if (!decision.allowed) return false;
  }
  return true;
}

export function rejectArtifactRequest(): never {
  throw new DomainError("request_rejected", "request rejected");
}

/** SHA-256 hex used for grant hashes, digest checks, and abuse subjects. */
export function artifactHash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hashes a caller-supplied identifier before it enters a rate key or diagnostic. */
export function artifactSubject(value: string): string {
  return artifactHash(`artifact-subject:${value}`);
}

export function mintUploadGrantSecret(): { secret: string; secretHash: string } {
  const secret = randomBytes(GRANT_SECRET_BYTES).toString("base64url");
  return { secret, secretHash: artifactHash(secret) };
}

/** Maximum accepted bytes for a semantic role. */
export function roleMaxBytes(role: ArtifactRole): number {
  return role === "log" ? ARTIFACT_LOG_MAX_BYTES : ARTIFACT_REVIEW_MAX_BYTES;
}

/** Server-derived R2 key. Callers never select a bucket key. */
export function artifactObjectKey(input: {
  workspaceId: string;
  role: ArtifactRole;
  runId: string | null;
  versionId: string;
  contentHash: string;
}): string {
  if (input.role === "log") {
    if (!input.runId) rejectArtifactRequest();
    return `workspaces/${input.workspaceId}/runs/${input.runId}/logs/${input.versionId}.jsonl.zst`;
  }
  return `workspaces/${input.workspaceId}/artifacts/sha256/${input.contentHash}`;
}

export type SniffedKind =
  "png" | "jpeg" | "svg" | "html" | "json" | "text" | "zstd" | "gzip" | "unknown";

/** Detects the byte kind from magic numbers and bounded text probes. Never trusts extensions. */
export function sniffArtifactKind(bytes: Uint8Array): SniffedKind {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x28 &&
    bytes[1] === 0xb5 &&
    bytes[2] === 0x2f &&
    bytes[3] === 0xfd
  ) {
    return "zstd";
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return "gzip";
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 65_536));
  } catch {
    return "unknown";
  }
  if (text.includes("\0")) return "unknown";
  const head = text.slice(0, 4096).toLowerCase();
  if (/<svg[\s>]/.test(head)) return "svg";
  if (head.includes("<!doctype html") || /<html[\s>]/.test(head)) return "html";
  const trimmed = text.trim();
  if (trimmed.length > 1) {
    const first = trimmed[0];
    if (first === "{" || first === "[") {
      try {
        JSON.parse(trimmed);
        return "json";
      } catch {
        // Falls through to plain text.
      }
    }
  }
  return "text";
}

/** Declared format must match the sniffed kind; mismatches never become available. */
export function formatAllowsKind(format: ArtifactFormat, kind: SniffedKind): boolean {
  switch (format) {
    case "png":
      return kind === "png";
    case "jpeg":
      return kind === "jpeg";
    case "svg":
      return kind === "svg";
    case "html":
      return kind === "html";
    case "json":
      return kind === "json";
    case "markdown":
    case "mermaid":
    case "diff":
      return kind === "text";
    case "log":
      return kind === "text" || kind === "zstd" || kind === "gzip";
  }
}

/** Log chunks must be compressed; review artifacts must not ride the log key prefix. */
export function assertRoleKind(role: ArtifactRole, kind: SniffedKind): void {
  if (role === "log" && kind !== "zstd") rejectArtifactRequest();
}

function artifactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    rejectArtifactRequest();
  }
  return value as Record<string, unknown>;
}

function artifactFormat(value: unknown): ArtifactFormat {
  if (typeof value !== "string" || !(ARTIFACT_FORMATS as readonly string[]).includes(value)) {
    rejectArtifactRequest();
  }
  return value as ArtifactFormat;
}

function artifactRole(value: unknown): ArtifactRole {
  if (typeof value !== "string" || !(ARTIFACT_ROLES as readonly string[]).includes(value)) {
    rejectArtifactRequest();
  }
  return value as ArtifactRole;
}

function artifactSize(value: unknown, role: ArtifactRole): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > roleMaxBytes(role)
  ) {
    rejectArtifactRequest();
  }
  return value as number;
}

function artifactDigest(value: unknown): string {
  if (typeof value !== "string" || !HEX64.test(value)) rejectArtifactRequest();
  return value;
}

function optionalUlid(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !isUlid(value)) rejectArtifactRequest();
  return value;
}

async function artifactHuman(ctx: HubContext): Promise<{
  humanId: string;
  authorizationEpoch: number;
  projectIds: string[];
}> {
  if (!ctx.actorHumanId || ctx.actorDelegationId || ctx.actorRunnerId || ctx.actorSystemId) {
    rejectArtifactRequest();
  }
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertRole(principal, ["owner", "member"]);
  assertEpoch(principal, ctx.authorizationEpoch);
  return {
    humanId: principal.humanId,
    authorizationEpoch: principal.authorizationEpoch,
    projectIds: principal.projectIds,
  };
}

async function requireRun(
  ctx: Pick<HubContext, "db" | "workspaceId">,
  runId: string | null,
  projectIds: readonly string[],
): Promise<string | null> {
  if (!runId) return null;
  const row = (await ctx.db
    .prepare(`SELECT id, project_id FROM runs WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, runId)) as { id: string; project_id: string } | undefined;
  if (!row) rejectArtifactRequest();
  // Attaching bytes to another project's run needs project access; run-free
  // artifacts need membership only. The rejection stays uniform so the run's
  // project boundary discloses no existence signal.
  if (!projectIds.includes(row.project_id)) rejectArtifactRequest();
  return runId;
}

interface VersionRow {
  workspace_id: string;
  id: string;
  artifact_id: string;
  state: string;
  format: string;
  declared_size: number;
  expected_digest: string;
  content_hash: string | null;
  r2_key: string | null;
  created_at: string;
  available_at: string | null;
}

async function versionRow(
  db: SqlDatabase,
  workspaceId: string,
  versionId: string,
): Promise<VersionRow> {
  const row = (await db
    .prepare(`SELECT * FROM artifact_versions WHERE workspace_id = ? AND id = ?`)
    .get(workspaceId, versionId)) as VersionRow | undefined;
  if (!row) rejectArtifactRequest();
  return row;
}

async function artifactVersionScope(ctx: HubContext, versionId: string) {
  const author = await artifactHuman(ctx);
  if (typeof versionId !== "string" || !isUlid(versionId)) rejectArtifactRequest();
  const version = await versionRow(ctx.db, ctx.workspaceId, versionId);
  const artifact = (await ctx.db
    .prepare(`SELECT run_id, role FROM artifacts WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, version.artifact_id)) as
    { run_id: string | null; role: string } | undefined;
  if (!artifact) rejectArtifactRequest();
  await requireRun(ctx, artifact.run_id, author.projectIds);
  return { author, version, artifact };
}

async function auditOutbox(
  db: SqlDatabase,
  entry: {
    workspaceId: string;
    versionId: string | null;
    grantId: string | null;
    action: string;
    payload: Record<string, unknown>;
    now: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO artifact_audit_outbox
       (id, workspace_id, version_id, grant_id, action, payload_json, created_at, dispatched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      randomUlid(),
      entry.workspaceId,
      entry.versionId,
      entry.grantId,
      entry.action,
      JSON.stringify(entry.payload),
      entry.now,
    );
}

export interface ArtifactGrant {
  schema_version: 1;
  grant_id: string;
  version_id: string;
  grant_hash: string;
  expires_at: string;
}

/**
 * The route layer mints the plaintext secret, passes only its hash into the
 * hub command, and returns the secret once in the HTTP response. Hub results
 * persist in idempotency records, so a secret inside a command result would
 * be stored plaintext; it must never be there.
 */
export interface IssuedArtifactGrant extends ArtifactGrant {
  secret: string;
}

export function issueGrantResponse(grant: ArtifactGrant, secret: string): IssuedArtifactGrant {
  if (typeof secret !== "string" || secret.length < 16 || secret.length > 256) {
    rejectArtifactRequest();
  }
  if (artifactHash(secret) !== grant.grant_hash) rejectArtifactRequest();
  return { ...grant, secret };
}

export interface CreateArtifactResult {
  schema_version: 1;
  artifact_id: string;
  version_id: string;
  state: "uploading";
  format: ArtifactFormat;
  role: ArtifactRole;
  declared_size: number;
  expected_digest: string;
  upload_grant: ArtifactGrant;
}

function mintGrant(input: {
  workspaceId: string;
  versionId: string;
  humanId: string;
  authorizationEpoch: number;
  runId: string | null;
  format: ArtifactFormat;
  declaredSize: number;
  expectedDigest: string;
  grantSecretHash: string;
  now: string;
}): { row: Record<string, unknown>; grant: ArtifactGrant } {
  if (!HEX64.test(input.grantSecretHash)) rejectArtifactRequest();
  const grantId = randomUlid();
  const expiresAt = new Date(Date.parse(input.now) + ARTIFACT_GRANT_TTL_MS).toISOString();
  return {
    row: {
      workspace_id: input.workspaceId,
      id: grantId,
      version_id: input.versionId,
      grant_hash: input.grantSecretHash,
      human_id: input.humanId,
      authorization_epoch: input.authorizationEpoch,
      run_id: input.runId,
      format: input.format,
      declared_size: input.declaredSize,
      expected_digest: input.expectedDigest,
      expires_at: expiresAt,
      consumed_at: null,
      created_at: input.now,
    },
    grant: {
      schema_version: 1,
      grant_id: grantId,
      version_id: input.versionId,
      grant_hash: input.grantSecretHash,
      expires_at: expiresAt,
    },
  };
}

async function insertGrant(db: SqlDatabase, row: Record<string, unknown>): Promise<void> {
  await db
    .prepare(
      `INSERT INTO artifact_upload_grants
       (workspace_id, id, version_id, grant_hash, human_id, authorization_epoch,
        run_id, format, declared_size, expected_digest, expires_at, consumed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.workspace_id,
      row.id,
      row.version_id,
      row.grant_hash,
      row.human_id,
      row.authorization_epoch,
      row.run_id,
      row.format,
      row.declared_size,
      row.expected_digest,
      row.expires_at,
      row.consumed_at,
      row.created_at,
    );
}

export interface CreateArtifactInput {
  artifactId?: string | null;
  runId?: string | null;
  format: ArtifactFormat;
  role: ArtifactRole;
  declaredSize: number;
  expectedDigest: string;
  /** SHA-256 of the route-minted plaintext secret; the secret itself never enters D1. */
  grantSecretHash: string;
}

export const createArtifactCommand: HubCommand<CreateArtifactInput, CreateArtifactResult> = {
  name: "artifact.create_version",
  replay: "reject",
  auditInput: () => ({ action: "artifact.create_version" }),
  async authorize(input, ctx) {
    const author = await artifactHuman(ctx);
    await requireRun(ctx, optionalUlid(input.runId), author.projectIds);
  },
  async run(input, ctx) {
    artifactObject(input, [
      "artifactId",
      "runId",
      "format",
      "role",
      "declaredSize",
      "expectedDigest",
      "grantSecretHash",
    ]);
    const author = await artifactHuman(ctx);
    const format = artifactFormat(input.format);
    const role = artifactRole(input.role);
    const declaredSize = artifactSize(input.declaredSize, role);
    const expectedDigest = artifactDigest(input.expectedDigest);
    if (typeof input.grantSecretHash !== "string" || !HEX64.test(input.grantSecretHash)) {
      rejectArtifactRequest();
    }
    const runId = await requireRun(ctx, optionalUlid(input.runId), author.projectIds);
    const nowMs = Date.parse(ctx.now);
    if (!Number.isFinite(nowMs)) rejectArtifactRequest();

    let artifactId = optionalUlid(input.artifactId);
    if (artifactId) {
      const existing = (await ctx.db
        .prepare(`SELECT id, run_id, format, role FROM artifacts WHERE workspace_id = ? AND id = ?`)
        .get(ctx.workspaceId, artifactId)) as
        { id: string; run_id: string | null; format: string; role: string } | undefined;
      if (!existing) rejectArtifactRequest();
      if (existing.format !== format || existing.role !== role) rejectArtifactRequest();
      if ((existing.run_id ?? null) !== runId) rejectArtifactRequest();
    } else {
      artifactId = randomUlid();
      await ctx.db
        .prepare(
          `INSERT INTO artifacts
           (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ctx.workspaceId, artifactId, runId, format, role, author.humanId, ctx.now);
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
    const { row, grant } = mintGrant({
      workspaceId: ctx.workspaceId,
      versionId,
      humanId: author.humanId,
      authorizationEpoch: author.authorizationEpoch,
      runId,
      format,
      declaredSize,
      expectedDigest,
      grantSecretHash: input.grantSecretHash,
      now: ctx.now,
    });
    await insertGrant(ctx.db, row);
    await auditOutbox(ctx.db, {
      workspaceId: ctx.workspaceId,
      versionId,
      grantId: grant.grant_id,
      action: "artifact.grant_issued",
      payload: {
        version_id: versionId,
        grant_id: grant.grant_id,
        grant_hash: row.grant_hash,
        format,
        role,
        declared_size: declaredSize,
      },
      now: ctx.now,
    });
    return {
      schema_version: 1,
      artifact_id: artifactId,
      version_id: versionId,
      state: "uploading",
      format,
      role,
      declared_size: declaredSize,
      expected_digest: expectedDigest,
      upload_grant: grant,
    };
  },
};

export interface IssueArtifactGrantInput {
  versionId: string;
  /** SHA-256 of the route-minted plaintext secret; the secret itself never enters D1. */
  grantSecretHash: string;
}

export const issueArtifactGrantCommand: HubCommand<IssueArtifactGrantInput, ArtifactGrant> = {
  name: "artifact.issue_grant",
  replay: "reject",
  auditInput: () => ({ action: "artifact.issue_grant" }),
  async authorize(input, ctx) {
    await artifactVersionScope(ctx, input.versionId);
  },
  async run(input, ctx) {
    artifactObject(input, ["versionId", "grantSecretHash"]);
    const { author, version, artifact } = await artifactVersionScope(ctx, input.versionId);
    if (typeof input.grantSecretHash !== "string" || !HEX64.test(input.grantSecretHash)) {
      rejectArtifactRequest();
    }
    if (version.state !== "uploading") rejectArtifactRequest();
    const { row, grant } = mintGrant({
      workspaceId: ctx.workspaceId,
      versionId: version.id,
      humanId: author.humanId,
      authorizationEpoch: author.authorizationEpoch,
      runId: artifact.run_id,
      format: artifactFormat(version.format),
      declaredSize: version.declared_size,
      expectedDigest: artifactDigest(version.expected_digest),
      grantSecretHash: input.grantSecretHash,
      now: ctx.now,
    });
    await insertGrant(ctx.db, row);
    await auditOutbox(ctx.db, {
      workspaceId: ctx.workspaceId,
      versionId: version.id,
      grantId: grant.grant_id,
      action: "artifact.grant_reissued",
      payload: { version_id: version.id, grant_id: grant.grant_id, grant_hash: row.grant_hash },
      now: ctx.now,
    });
    return grant;
  },
};

export interface RedeemedGrant {
  workspaceId: string;
  versionId: string;
  artifactId: string;
  runId: string | null;
  role: ArtifactRole;
  format: ArtifactFormat;
  declaredSize: number;
  expectedDigest: string;
  humanId: string | null;
  authorizationEpoch: number;
  grantId: string;
  consumeAttemptId: string;
}

/**
 * Atomically consumes a one-time upload grant before the Artifact Worker reads
 * any bytes. Rechecks grant expiry, version state, and the current
 * authorization epoch inside the guarded update; a racing or replayed
 * redemption aborts the whole batch with no body effect.
 */
export async function redeemUploadGrant(
  db: SqlDatabase,
  input: { grantId: string; secret: string; now: string },
): Promise<RedeemedGrant> {
  if (typeof input.grantId !== "string" || !isUlid(input.grantId)) rejectArtifactRequest();
  if (typeof input.secret !== "string" || input.secret.length < 16 || input.secret.length > 256) {
    rejectArtifactRequest();
  }
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) rejectArtifactRequest();
  const secretHash = artifactHash(input.secret);
  const candidate = (await db
    .prepare(
      `SELECT g.workspace_id, g.version_id, g.human_id, g.authorization_epoch,
              g.run_id, g.format, g.declared_size, g.expected_digest, g.expires_at, g.consumed_at,
              v.artifact_id, v.state
       FROM artifact_upload_grants AS g
       JOIN artifact_versions AS v
         ON v.workspace_id = g.workspace_id AND v.id = g.version_id
       WHERE g.id = ? AND g.grant_hash = ?`,
    )
    .get(input.grantId, secretHash)) as
    | {
        workspace_id: string;
        version_id: string;
        human_id: string;
        authorization_epoch: number;
        run_id: string | null;
        format: string;
        declared_size: number;
        expected_digest: string;
        expires_at: string;
        consumed_at: string | null;
        artifact_id: string;
        state: string;
      }
    | undefined;
  if (
    !candidate ||
    candidate.consumed_at !== null ||
    Date.parse(candidate.expires_at) <= nowMs ||
    candidate.state !== "uploading"
  ) {
    rejectArtifactRequest();
  }
  const artifact = (await db
    .prepare(`SELECT role, run_id FROM artifacts WHERE workspace_id = ? AND id = ?`)
    .get(candidate.workspace_id, candidate.artifact_id)) as
    { role: string; run_id: string | null } | undefined;
  if (!artifact) rejectArtifactRequest();
  if (artifact.run_id !== candidate.run_id || !candidate.human_id) rejectArtifactRequest();
  const principal = await loadPrincipal(db, candidate.workspace_id, candidate.human_id);
  assertRole(principal, ["owner", "member"]);
  assertEpoch(principal, candidate.authorization_epoch);
  await requireRun(
    { db, workspaceId: candidate.workspace_id },
    candidate.run_id,
    principal.projectIds,
  );
  // An immutable per-grant claim identifies THIS consume attempt, not another
  // request that happened to observe the same timestamp. A loser rolls back
  // this whole batch before the Worker reads its body.
  const attemptId = randomUlid();
  await db
    .prepare(
      `INSERT INTO artifact_upload_consumptions (workspace_id, grant_id, attempt_id, consumed_at)
     VALUES (?, ?, ?, ?)`,
    )
    .run(candidate.workspace_id, input.grantId, attemptId, input.now);
  // Repeat current role/project and exact grant scope at commit, because the
  // candidate and principal reads happen before D1 flushes this write batch.
  await db
    .prepare(
      `UPDATE artifact_upload_grants SET consumed_at = ?
       WHERE id = ? AND grant_hash = ? AND consumed_at IS NULL AND expires_at > ?
         AND EXISTS (
           SELECT 1 FROM artifact_versions AS v
           JOIN artifacts AS a ON a.workspace_id = v.workspace_id AND a.id = v.artifact_id
           LEFT JOIN runs AS r ON r.workspace_id = a.workspace_id AND r.id = a.run_id
           LEFT JOIN projects AS p ON p.workspace_id = r.workspace_id AND p.id = r.project_id
           WHERE v.workspace_id = artifact_upload_grants.workspace_id
             AND v.id = artifact_upload_grants.version_id
             AND v.state = 'uploading'
             AND v.format = artifact_upload_grants.format
             AND v.declared_size = artifact_upload_grants.declared_size
             AND v.expected_digest = artifact_upload_grants.expected_digest
             AND a.run_id IS artifact_upload_grants.run_id
             AND (a.run_id IS NULL OR (r.id IS NOT NULL AND
               (p.access_mode = 'workspace' OR EXISTS (
                 SELECT 1 FROM project_access AS access
                 WHERE access.workspace_id = r.workspace_id AND access.project_id = r.project_id
                   AND access.human_id = artifact_upload_grants.human_id
               ))))
         )
         AND EXISTS (
           SELECT 1 FROM workspace_members AS m
           JOIN workspace_authorization_epochs AS e
             ON e.workspace_id = m.workspace_id AND e.human_id = m.human_id
           WHERE m.workspace_id = artifact_upload_grants.workspace_id
             AND m.human_id = artifact_upload_grants.human_id
             AND m.authorization_epoch = e.authorization_epoch
             AND m.role IN ('owner', 'member')
             AND e.revoked_at IS NULL
             AND e.authorization_epoch = artifact_upload_grants.authorization_epoch
         )`,
    )
    .run(input.now, input.grantId, secretHash, input.now);
  // The guard must identify our claim as well as the consumed timestamp.
  // D1 evaluates it inside the same atomic batch, with no read-after-write.
  const guardId = randomUlid();
  await db
    .prepare(
      `INSERT INTO artifact_mutation_guards (id, valid) VALUES (?,
       (SELECT COUNT(*) = 1 FROM artifact_upload_grants AS g
        JOIN artifact_upload_consumptions AS c ON c.workspace_id = g.workspace_id AND c.grant_id = g.id
        WHERE g.id = ? AND g.grant_hash = ? AND g.consumed_at = ? AND c.attempt_id = ?))`,
    )
    .run(guardId, input.grantId, secretHash, input.now, attemptId);
  await db.prepare(`DELETE FROM artifact_mutation_guards WHERE id = ?`).run(guardId);
  await auditOutbox(db, {
    workspaceId: candidate.workspace_id,
    versionId: candidate.version_id,
    grantId: input.grantId,
    action: "artifact.grant_consumed",
    payload: { version_id: candidate.version_id, grant_id: input.grantId, grant_hash: secretHash },
    now: input.now,
  });
  return {
    workspaceId: candidate.workspace_id,
    versionId: candidate.version_id,
    artifactId: candidate.artifact_id,
    runId: candidate.run_id,
    role: artifactRole(artifact.role),
    format: artifactFormat(candidate.format),
    declaredSize: candidate.declared_size,
    expectedDigest: candidate.expected_digest,
    humanId: candidate.human_id,
    authorizationEpoch: candidate.authorization_epoch,
    grantId: input.grantId,
    consumeAttemptId: attemptId,
  };
}

export interface VerifiedUpload {
  workspaceId: string;
  versionId: string;
  contentHash: string;
  r2Key: string;
  size: number;
  deduplicated: boolean;
}

/**
 * Records physically verified bytes against the exact successful consumption.
 * Scope, role and storage key derive from canonical rows, never caller claims.
 * This immutable bookkeeping does not authorize a business availability transition.
 */
export async function recordVerifiedUpload(
  db: SqlDatabase,
  input: {
    grantId: string;
    consumeAttemptId: string;
    contentHash: string;
    size: number;
    now: string;
  },
): Promise<VerifiedUpload> {
  artifactObject(input, ["grantId", "consumeAttemptId", "contentHash", "size", "now"]);
  if (
    !isUlid(input.grantId) ||
    !isUlid(input.consumeAttemptId) ||
    !HEX64.test(input.contentHash) ||
    !Number.isSafeInteger(input.size) ||
    input.size < 1 ||
    !Number.isFinite(Date.parse(input.now))
  )
    rejectArtifactRequest();
  // All reads precede the queued writes: D1 batches cannot read after a write.
  const source = (await db
    .prepare(
      `SELECT g.workspace_id, g.version_id, g.run_id, a.role, v.state,
    v.expected_digest, v.declared_size, v.content_hash, v.r2_key
    FROM artifact_upload_grants AS g
    JOIN artifact_upload_consumptions AS c ON c.workspace_id=g.workspace_id AND c.grant_id=g.id
    JOIN artifact_versions AS v ON v.workspace_id=g.workspace_id AND v.id=g.version_id
    JOIN artifacts AS a ON a.workspace_id=v.workspace_id AND a.id=v.artifact_id
    WHERE g.id=? AND c.attempt_id=? AND g.consumed_at IS NOT NULL AND c.consumed_at=g.consumed_at
      AND g.run_id IS a.run_id AND g.format=v.format AND g.expected_digest=v.expected_digest
      AND g.declared_size=v.declared_size`,
    )
    .get(input.grantId, input.consumeAttemptId)) as
    | {
        workspace_id: string;
        version_id: string;
        run_id: string | null;
        role: string;
        state: string;
        expected_digest: string;
        declared_size: number;
        content_hash: string | null;
        r2_key: string | null;
      }
    | undefined;
  if (
    !source ||
    !["uploading", "available"].includes(source.state) ||
    source.expected_digest !== input.contentHash ||
    source.declared_size !== input.size
  )
    rejectArtifactRequest();
  const role = artifactRole(source.role);
  artifactSize(input.size, role);
  const r2Key = artifactObjectKey({
    workspaceId: source.workspace_id,
    role,
    runId: source.run_id,
    versionId: source.version_id,
    contentHash: input.contentHash,
  });
  if (
    source.state === "available" &&
    (source.content_hash !== input.contentHash || source.r2_key !== r2Key)
  )
    rejectArtifactRequest();
  const stored = (await db
    .prepare(
      `SELECT content_hash, size FROM artifact_objects
       WHERE workspace_id = ? AND r2_key = ?`,
    )
    .get(source.workspace_id, r2Key)) as { content_hash: string; size: number } | undefined;
  if (stored && (stored.content_hash !== input.contentHash || stored.size !== input.size)) {
    rejectArtifactRequest();
  }
  const existing = (await db
    .prepare(
      `SELECT content_hash, size FROM artifact_upload_receipts
       WHERE workspace_id = ? AND version_id = ?`,
    )
    .get(source.workspace_id, source.version_id)) as
    { content_hash: string; size: number } | undefined;
  if (existing) {
    if (existing.content_hash !== input.contentHash || existing.size !== input.size) {
      rejectArtifactRequest();
    }
  }
  if (source.state === "available" && !existing) rejectArtifactRequest();
  await db
    .prepare(
      `INSERT INTO artifact_objects (workspace_id, r2_key, content_hash, size, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, r2_key) DO NOTHING`,
    )
    .run(source.workspace_id, r2Key, input.contentHash, input.size, input.now);
  await db
    .prepare(
      `INSERT INTO artifact_upload_receipts
       (workspace_id, version_id, content_hash, size, verified_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, version_id) DO NOTHING`,
    )
    .run(source.workspace_id, source.version_id, input.contentHash, input.size, input.now);
  const outboxId = randomUlid();
  await db
    .prepare(
      `INSERT INTO artifact_upload_receipt_sources
    (workspace_id,version_id,grant_id,attempt_id,outbox_id,verified_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(workspace_id,version_id) DO NOTHING`,
    )
    .run(
      source.workspace_id,
      source.version_id,
      input.grantId,
      input.consumeAttemptId,
      outboxId,
      input.now,
    );
  // Only the winning immutable receipt source creates its outbox row. Two
  // different consumed grants can converge without duplicate verification events.
  await db
    .prepare(
      `INSERT INTO artifact_audit_outbox
    (id,workspace_id,version_id,grant_id,action,payload_json,created_at,dispatched_at)
    SELECT ?,workspace_id,version_id,grant_id,'artifact.upload_verified',?,?,NULL
    FROM artifact_upload_receipt_sources WHERE workspace_id=? AND version_id=? AND outbox_id=?`,
    )
    .run(
      outboxId,
      JSON.stringify({
        version_id: source.version_id,
        content_hash: input.contentHash,
        size: input.size,
        r2_key: r2Key,
        consume_attempt_id: input.consumeAttemptId,
      }),
      input.now,
      source.workspace_id,
      source.version_id,
      outboxId,
    );
  // The committing batch must still contain the exact source and matching
  // physical registry/receipt, including when another same-hash insert wins.
  const guardId = randomUlid();
  await db
    .prepare(
      `INSERT INTO artifact_mutation_guards (id,valid) VALUES (?,
    (SELECT COUNT(*)=1 FROM artifact_upload_grants AS g
     JOIN artifact_upload_consumptions AS c ON c.workspace_id=g.workspace_id AND c.grant_id=g.id
     JOIN artifact_versions AS v ON v.workspace_id=g.workspace_id AND v.id=g.version_id
     JOIN artifacts AS a ON a.workspace_id=v.workspace_id AND a.id=v.artifact_id
     JOIN artifact_upload_receipts AS receipt ON receipt.workspace_id=v.workspace_id AND receipt.version_id=v.id
     JOIN artifact_objects AS object ON object.workspace_id=v.workspace_id AND object.r2_key=?
     JOIN artifact_upload_receipt_sources AS lineage ON lineage.workspace_id=v.workspace_id AND lineage.version_id=v.id
     JOIN artifact_audit_outbox AS outbox ON outbox.workspace_id=lineage.workspace_id AND outbox.id=lineage.outbox_id
     WHERE g.id=? AND c.attempt_id=? AND g.consumed_at IS NOT NULL AND c.consumed_at=g.consumed_at
       AND g.run_id IS a.run_id AND a.role=? AND v.state IN ('uploading','available')
       AND g.format=v.format AND g.expected_digest=v.expected_digest AND g.declared_size=v.declared_size
       AND receipt.content_hash=? AND v.expected_digest=receipt.content_hash AND receipt.size=? AND v.declared_size=receipt.size
       AND object.content_hash=receipt.content_hash AND object.size=receipt.size
       AND outbox.version_id=v.id AND outbox.grant_id=lineage.grant_id AND outbox.action='artifact.upload_verified'
       AND (v.state='uploading' OR (v.content_hash=receipt.content_hash AND v.r2_key=object.r2_key))))`,
    )
    .run(
      guardId,
      r2Key,
      input.grantId,
      input.consumeAttemptId,
      role,
      input.contentHash,
      input.size,
    );
  await db.prepare(`DELETE FROM artifact_mutation_guards WHERE id=?`).run(guardId);
  return {
    workspaceId: source.workspace_id,
    versionId: source.version_id,
    contentHash: input.contentHash,
    r2Key,
    size: input.size,
    deduplicated: existing != null,
  };
}

export interface FinalizeArtifactInput {
  versionId: string;
  contentHash: string;
  size: number;
}

export interface FinalizeArtifactResult {
  schema_version: 1;
  version_id: string;
  artifact_id: string;
  state: "available";
  content_hash: string;
  r2_key: string;
  available_at: string;
}

export const finalizeArtifactCommand: HubCommand<FinalizeArtifactInput, FinalizeArtifactResult> = {
  name: "artifact.finalize_version",
  replay: "reject",
  auditInput: () => ({ action: "artifact.finalize_version" }),
  async authorize(input, ctx) {
    await artifactVersionScope(ctx, input.versionId);
  },
  async run(input, ctx) {
    artifactObject(input, ["versionId", "contentHash", "size"]);
    const { version, artifact } = await artifactVersionScope(ctx, input.versionId);
    const contentHash = artifactDigest(input.contentHash);
    if (!Number.isSafeInteger(input.size) || (input.size as number) < 1) rejectArtifactRequest();
    if (version.state !== "uploading") rejectArtifactRequest();
    if (version.expected_digest !== contentHash || version.declared_size !== input.size) {
      rejectArtifactRequest();
    }
    const expectedKey = artifactObjectKey({
      workspaceId: ctx.workspaceId,
      role: artifactRole(artifact.role),
      runId: artifact.run_id,
      versionId: input.versionId,
      contentHash,
    });
    const receipt = (await ctx.db
      .prepare(
        `SELECT content_hash, size FROM artifact_upload_receipts
         WHERE workspace_id = ? AND version_id = ?`,
      )
      .get(ctx.workspaceId, input.versionId)) as { content_hash: string; size: number } | undefined;
    if (!receipt || receipt.content_hash !== contentHash || receipt.size !== input.size) {
      rejectArtifactRequest();
    }
    const object = (await ctx.db
      .prepare(
        `SELECT content_hash, size FROM artifact_objects
         WHERE workspace_id = ? AND r2_key = ?`,
      )
      .get(ctx.workspaceId, expectedKey)) as { content_hash: string; size: number } | undefined;
    if (!object || object.content_hash !== contentHash || object.size !== input.size) {
      rejectArtifactRequest();
    }
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
    await auditOutbox(ctx.db, {
      workspaceId: ctx.workspaceId,
      versionId: input.versionId,
      grantId: null,
      action: "artifact.finalized",
      payload: {
        version_id: input.versionId,
        content_hash: contentHash,
        r2_key: expectedKey,
        size: input.size,
      },
      now: ctx.now,
    });
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

export interface MarkArtifactFailedInput {
  versionId: string;
}

export interface MarkArtifactFailedResult {
  schema_version: 1;
  version_id: string;
  state: "failed";
}

function abandonmentCutoffs(now: string) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) rejectArtifactRequest();
  return {
    created: new Date(nowMs - ARTIFACT_GRANT_TTL_MS - ARTIFACT_ABANDON_GRACE_MS).toISOString(),
    expiry: new Date(nowMs - ARTIFACT_ABANDON_GRACE_MS).toISOString(),
  };
}

async function requireArtifactRecovery(input: MarkArtifactFailedInput, ctx: HubContext) {
  if (
    ctx.actorSystemId !== ARTIFACT_RECOVERY_SYSTEM_ID ||
    ctx.authorizationEpoch !== 1 ||
    ctx.actorHumanId ||
    ctx.actorDelegationId ||
    ctx.actorRunnerId
  )
    rejectArtifactRequest();
  if (typeof input.versionId !== "string" || !isUlid(input.versionId)) rejectArtifactRequest();
  const cutoffs = abandonmentCutoffs(ctx.now);
  const eligible = await ctx.db
    .prepare(
      `SELECT v.id FROM artifact_versions AS v
    WHERE v.workspace_id = ? AND v.id = ? AND v.state = 'uploading' AND v.created_at <= ?
      AND NOT EXISTS (SELECT 1 FROM artifact_upload_grants AS g
        WHERE g.workspace_id = v.workspace_id AND g.version_id = v.id
          AND g.expires_at > ?)`,
    )
    .get(ctx.workspaceId, input.versionId, cutoffs.created, cutoffs.expiry);
  if (!eligible) rejectArtifactRequest();
  return cutoffs;
}

/**
 * Marks an abandoned uploading version failed. Human members use it for
 * explicit recovery; the recovery Cron uses the system actor. Terminal rows
 * are rejected so history can never be rewritten.
 */
export const markArtifactFailedCommand: HubCommand<
  MarkArtifactFailedInput,
  MarkArtifactFailedResult
> = {
  name: "artifact.mark_failed",
  replay: "reject",
  auditInput: () => ({ action: "artifact.mark_failed" }),
  async authorize(input, ctx) {
    if (ctx.actorSystemId) {
      await requireArtifactRecovery(input, ctx);
    } else {
      await artifactVersionScope(ctx, input.versionId);
    }
  },
  async run(input, ctx) {
    artifactObject(input, ["versionId"]);
    if (typeof input.versionId !== "string" || !isUlid(input.versionId)) rejectArtifactRequest();
    const cutoffs = ctx.actorSystemId ? await requireArtifactRecovery(input, ctx) : null;
    if (!ctx.actorSystemId) {
      await artifactVersionScope(ctx, input.versionId);
    }
    const version = await versionRow(ctx.db, ctx.workspaceId, input.versionId);
    if (version.state !== "uploading") rejectArtifactRequest();
    if (cutoffs) {
      await ctx.db
        .prepare(
          `UPDATE artifact_versions SET state = 'failed'
        WHERE workspace_id = ? AND id = ? AND state = 'uploading' AND created_at <= ?
          AND NOT EXISTS (SELECT 1 FROM artifact_upload_grants AS g
            WHERE g.workspace_id = artifact_versions.workspace_id AND g.version_id = artifact_versions.id
              AND g.expires_at > ?)`,
        )
        .run(ctx.workspaceId, input.versionId, cutoffs.created, cutoffs.expiry);
    } else {
      await ctx.db
        .prepare(
          `UPDATE artifact_versions SET state = 'failed'
        WHERE workspace_id = ? AND id = ? AND state = 'uploading'`,
        )
        .run(ctx.workspaceId, input.versionId);
    }
    const guardId = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO artifact_mutation_guards (id, valid) VALUES (?,
      (SELECT COUNT(*) = 1 FROM artifact_versions WHERE workspace_id = ? AND id = ? AND state = 'failed'))`,
      )
      .run(guardId, ctx.workspaceId, input.versionId);
    await ctx.db.prepare(`DELETE FROM artifact_mutation_guards WHERE id = ?`).run(guardId);
    await auditOutbox(ctx.db, {
      workspaceId: ctx.workspaceId,
      versionId: input.versionId,
      grantId: null,
      action: "artifact.abandoned",
      payload: { version_id: input.versionId },
      now: ctx.now,
    });
    return { schema_version: 1, version_id: input.versionId, state: "failed" };
  },
};

/**
 * Selects a bounded page of recovery candidates without mutating business
 * state. Each candidate must pass the fresh Hub recovery command again.
 */
export async function listAbandonedArtifactUploads(
  db: SqlDatabase,
  now: string,
  options: { limit?: number } = {},
): Promise<Array<{ workspace_id: string; id: string }>> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) rejectArtifactRequest();
  const cutoffs = abandonmentCutoffs(now);
  return (await db
    .prepare(
      `SELECT v.workspace_id, v.id
       FROM artifact_versions AS v
       WHERE v.state = 'uploading'
         AND v.created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM artifact_upload_grants AS g
           WHERE g.workspace_id = v.workspace_id
             AND g.version_id = v.id
             AND g.expires_at > ?
         ) ORDER BY v.created_at, v.workspace_id, v.id LIMIT ?`,
    )
    .all(cutoffs.created, cutoffs.expiry, limit)) as Array<{
    workspace_id: string;
    id: string;
  }>;
}
