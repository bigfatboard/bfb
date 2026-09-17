// ABOUTME: Owns the artifact grant/upload/finalize state machine and durable abuse budgets.
// ABOUTME: Upload secrets are returned once; D1 keeps hashes, receipts, and audit rows.

import { createHash, randomBytes } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";

import { abuseBucketKey, consumeAbuseBudget } from "./abuse.js";
import { assertEpoch, assertRole, loadPrincipal } from "./authorization.js";
import { DomainError } from "./hub.js";
import type { HubCommand, HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";

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

async function requireRun(ctx: HubContext, runId: string | null): Promise<string | null> {
  if (!runId) return null;
  const row = (await ctx.db
    .prepare(`SELECT id FROM runs WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, runId)) as { id: string } | undefined;
  if (!row) rejectArtifactRequest();
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
    const runId = await requireRun(ctx, optionalUlid(input.runId));
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
  async run(input, ctx) {
    artifactObject(input, ["versionId", "grantSecretHash"]);
    const author = await artifactHuman(ctx);
    if (typeof input.versionId !== "string" || !isUlid(input.versionId)) rejectArtifactRequest();
    if (typeof input.grantSecretHash !== "string" || !HEX64.test(input.grantSecretHash)) {
      rejectArtifactRequest();
    }
    const version = await versionRow(ctx.db, ctx.workspaceId, input.versionId);
    if (version.state !== "uploading") rejectArtifactRequest();
    const artifact = (await ctx.db
      .prepare(`SELECT run_id, role FROM artifacts WHERE workspace_id = ? AND id = ?`)
      .get(ctx.workspaceId, version.artifact_id)) as
      { run_id: string | null; role: string } | undefined;
    if (!artifact) rejectArtifactRequest();
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
  humanId: string;
  authorizationEpoch: number;
  grantId: string;
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
    .prepare(`SELECT role FROM artifacts WHERE workspace_id = ? AND id = ?`)
    .get(candidate.workspace_id, candidate.artifact_id)) as { role: string } | undefined;
  if (!artifact) rejectArtifactRequest();
  // The membership/epoch fence is part of the guarded update so revocation
  // between the read above and the consume cannot grant upload authority.
  await db
    .prepare(
      `UPDATE artifact_upload_grants SET consumed_at = ?
       WHERE id = ? AND grant_hash = ? AND consumed_at IS NULL AND expires_at > ?
         AND EXISTS (
           SELECT 1 FROM artifact_versions AS v
           WHERE v.workspace_id = artifact_upload_grants.workspace_id
             AND v.id = artifact_upload_grants.version_id
             AND v.state = 'uploading'
         )
         AND EXISTS (
           SELECT 1 FROM workspace_members AS m
           JOIN workspace_authorization_epochs AS e
             ON e.workspace_id = m.workspace_id AND e.human_id = m.human_id
           WHERE m.workspace_id = artifact_upload_grants.workspace_id
             AND m.human_id = artifact_upload_grants.human_id
             AND m.authorization_epoch = e.authorization_epoch
             AND e.revoked_at IS NULL
             AND e.authorization_epoch = artifact_upload_grants.authorization_epoch
         )`,
    )
    .run(input.now, input.grantId, secretHash, input.now);
  // D1 batches cannot read after a queued write, so the single-consume check
  // is a guard row: D1 evaluates the predicate at commit time and aborts the
  // entire batch when a racing redemption consumed the grant first.
  const guardId = randomUlid();
  await db
    .prepare(
      `INSERT INTO artifact_mutation_guards (id, valid) VALUES (?,
       (SELECT COUNT(*) = 1 FROM artifact_upload_grants
        WHERE id = ? AND grant_hash = ? AND consumed_at = ?))`,
    )
    .run(guardId, input.grantId, secretHash, input.now);
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
 * Records a verified upload after the Artifact Worker validated size, digest,
 * and MIME and confirmed the R2 object. Inserts the shared content-addressed
 * object row first so same-hash races converge instead of overwriting.
 */
export async function recordVerifiedUpload(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    versionId: string;
    runId: string | null;
    role: ArtifactRole;
    contentHash: string;
    r2Key: string;
    size: number;
    now: string;
  },
): Promise<VerifiedUpload> {
  if (!HEX64.test(input.contentHash)) rejectArtifactRequest();
  // All reads precede the queued writes: D1 batches cannot read after a write.
  const version = await versionRow(db, input.workspaceId, input.versionId);
  if (version.state !== "uploading") rejectArtifactRequest();
  if (version.expected_digest !== input.contentHash) rejectArtifactRequest();
  if (version.declared_size !== input.size) rejectArtifactRequest();
  const expectedKey = artifactObjectKey({
    workspaceId: input.workspaceId,
    role: input.role,
    runId: input.runId,
    versionId: input.versionId,
    contentHash: input.contentHash,
  });
  if (input.r2Key !== expectedKey) rejectArtifactRequest();
  const stored = (await db
    .prepare(`SELECT r2_key, size FROM artifact_objects WHERE content_hash = ?`)
    .get(input.contentHash)) as { r2_key: string; size: number } | undefined;
  if (stored && (stored.r2_key !== input.r2Key || stored.size !== input.size)) {
    rejectArtifactRequest();
  }
  const existing = (await db
    .prepare(
      `SELECT content_hash, size FROM artifact_upload_receipts
       WHERE workspace_id = ? AND version_id = ?`,
    )
    .get(input.workspaceId, input.versionId)) as { content_hash: string; size: number } | undefined;
  if (existing) {
    if (existing.content_hash !== input.contentHash || existing.size !== input.size) {
      rejectArtifactRequest();
    }
    return {
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      contentHash: input.contentHash,
      r2Key: input.r2Key,
      size: input.size,
      deduplicated: true,
    };
  }
  await db
    .prepare(
      `INSERT INTO artifact_objects (content_hash, r2_key, size, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(content_hash) DO NOTHING`,
    )
    .run(input.contentHash, input.r2Key, input.size, input.now);
  await db
    .prepare(
      `INSERT INTO artifact_upload_receipts
       (workspace_id, version_id, content_hash, size, verified_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.workspaceId, input.versionId, input.contentHash, input.size, input.now);
  await auditOutbox(db, {
    workspaceId: input.workspaceId,
    versionId: input.versionId,
    grantId: null,
    action: "artifact.upload_verified",
    payload: {
      version_id: input.versionId,
      content_hash: input.contentHash,
      size: input.size,
      r2_key: input.r2Key,
    },
    now: input.now,
  });
  return {
    workspaceId: input.workspaceId,
    versionId: input.versionId,
    contentHash: input.contentHash,
    r2Key: input.r2Key,
    size: input.size,
    deduplicated: false,
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
  async run(input, ctx) {
    artifactObject(input, ["versionId", "contentHash", "size"]);
    await artifactHuman(ctx);
    if (typeof input.versionId !== "string" || !isUlid(input.versionId)) rejectArtifactRequest();
    const contentHash = artifactDigest(input.contentHash);
    if (!Number.isSafeInteger(input.size) || (input.size as number) < 1) rejectArtifactRequest();
    const version = await versionRow(ctx.db, ctx.workspaceId, input.versionId);
    if (version.state !== "uploading") rejectArtifactRequest();
    if (version.expected_digest !== contentHash || version.declared_size !== input.size) {
      rejectArtifactRequest();
    }
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
      .prepare(`SELECT r2_key, size FROM artifact_objects WHERE content_hash = ?`)
      .get(contentHash)) as { r2_key: string; size: number } | undefined;
    if (!object || object.size !== input.size) rejectArtifactRequest();
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
    await auditOutbox(ctx.db, {
      workspaceId: ctx.workspaceId,
      versionId: input.versionId,
      grantId: null,
      action: "artifact.finalized",
      payload: {
        version_id: input.versionId,
        content_hash: contentHash,
        r2_key: object.r2_key,
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
      r2_key: object.r2_key,
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
  async run(input, ctx) {
    artifactObject(input, ["versionId"]);
    if (typeof input.versionId !== "string" || !isUlid(input.versionId)) rejectArtifactRequest();
    if (ctx.actorSystemId) {
      if (ctx.actorHumanId || ctx.actorDelegationId || ctx.actorRunnerId) rejectArtifactRequest();
    } else {
      await artifactHuman(ctx);
    }
    const version = await versionRow(ctx.db, ctx.workspaceId, input.versionId);
    if (version.state !== "uploading") rejectArtifactRequest();
    await ctx.db
      .prepare(
        `UPDATE artifact_versions SET state = 'failed'
         WHERE workspace_id = ? AND id = ? AND state = 'uploading'`,
      )
      .run(ctx.workspaceId, input.versionId);
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
 * Recovery sweep used by the Cron trigger. Marks uploading versions failed
 * once every outstanding grant has expired past a grace interval, so crashed
 * uploads settle without deleting shared content-addressed bytes.
 */
export async function sweepAbandonedArtifactUploads(
  db: SqlDatabase,
  now: string,
  options: { graceMs?: number } = {},
): Promise<string[]> {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return [];
  const grace = options.graceMs ?? ARTIFACT_ABANDON_GRACE_MS;
  const rows = (await db
    .prepare(
      `SELECT v.workspace_id, v.id
       FROM artifact_versions AS v
       WHERE v.state = 'uploading'
         AND datetime(v.created_at) <= datetime(?, ?)
         AND NOT EXISTS (
           SELECT 1 FROM artifact_upload_grants AS g
           WHERE g.workspace_id = v.workspace_id
             AND g.version_id = v.id
             AND g.consumed_at IS NULL
             AND datetime(g.expires_at) > datetime(?)
         )`,
    )
    .all(now, `-${Math.floor((ARTIFACT_GRANT_TTL_MS + grace) / 1000)} seconds`, now)) as Array<{
    workspace_id: string;
    id: string;
  }>;
  const marked: string[] = [];
  for (const row of rows) {
    await db
      .prepare(
        `UPDATE artifact_versions SET state = 'failed'
         WHERE workspace_id = ? AND id = ? AND state = 'uploading'`,
      )
      .run(row.workspace_id, row.id);
    await auditOutbox(db, {
      workspaceId: row.workspace_id,
      versionId: row.id,
      grantId: null,
      action: "artifact.abandoned",
      payload: { version_id: row.id, reason: "recovery_sweep" },
      now,
    });
    marked.push(row.id);
  }
  return marked.sort();
}
