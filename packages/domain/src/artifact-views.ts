// ABOUTME: Owns one-time artifact view grants bound to epoch, version, nonce, and expiry.
// ABOUTME: Redemption consumes the grant before bytes; audit carries the view ID only.

import { randomBytes, timingSafeEqual } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";

import { artifactHash, artifactSubject } from "./artifacts.js";
import { assertEpoch, loadPrincipal } from "./authorization.js";
import { DomainError, type HubCommand } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";

/** One-time view grant lifetime from issuance (milliseconds). Reloads mint a new grant. */
export const VIEW_GRANT_TTL_MS = 5 * 60_000;
/** Bounded redemption POST bodies (secret plus nonce with form overhead). */
export const VIEW_REDEEM_BODY_LIMIT = 4_096;
/** Channel nonce length in hex characters (16 random bytes). */
export const VIEW_NONCE_HEX_LENGTH = 32;
const VIEW_NONCE_PATTERN = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function rejectViewRequest(): never {
  throw new DomainError("request_rejected", "request rejected");
}

export function mintViewGrantSecret(): { secret: string; secretHash: string } {
  const secret = randomBytes(32).toString("base64url");
  return { secret, secretHash: artifactHash(secret) };
}

/** Mints the per-view channel nonce the browser must return with the secret. */
export function mintViewNonce(): string {
  return randomBytes(16).toString("hex");
}

export function assertViewNonce(value: unknown): string {
  if (typeof value !== "string" || !VIEW_NONCE_PATTERN.test(value)) rejectViewRequest();
  return value;
}

export function assertViewSecret(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    rejectViewRequest();
  }
  return value;
}

function viewObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    rejectViewRequest();
  }
  return value as Record<string, unknown>;
}

async function viewAuditOutbox(
  db: SqlDatabase,
  entry: { workspaceId: string; versionId: string | null; viewId: string | null; action: string; now: string },
): Promise<void> {
  // Audit carries the non-secret view ID only; secrets and nonces never persist here.
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
      entry.viewId,
      entry.action,
      JSON.stringify({ version_id: entry.versionId, view_id: entry.viewId }),
      entry.now,
    );
}

/**
 * Hub command result. The channel nonce is intentionally absent: the route
 * layer mints it, passes only its hash into the command, and returns it over
 * the authenticated session. Hub results persist in idempotency records, so
 * a nonce inside the result would be stored retrievably; it must never be.
 */
export interface ViewGrant {
  schema_version: 1;
  view_id: string;
  version_id: string;
  content_hash: string;
  format: string;
  grant_hash: string;
  expires_at: string;
}

/**
 * The route layer mints the plaintext secret, passes only its hash into the
 * hub command, and returns the secret once in the HTTP response. Hub results
 * persist in idempotency records, so a secret inside a command result would
 * be stored plaintext; it must never be there.
 */
export interface IssuedViewGrant extends ViewGrant {
  secret: string;
  nonce: string;
}

export function issueViewGrantResponse(
  grant: ViewGrant,
  secret: string,
  nonce: string,
): IssuedViewGrant {
  assertViewSecret(secret);
  assertViewNonce(nonce);
  if (artifactHash(secret) !== grant.grant_hash) rejectViewRequest();
  return { ...grant, secret, nonce };
}

export interface CreateViewGrantInput {
  versionId: string;
  /** SHA-256 of the route-minted plaintext secret; the secret itself never enters D1. */
  grantSecretHash: string;
  /** Per-view channel nonce the bootstrap must return with the secret. */
  viewNonce: string;
  /** SHA-256 of the issuing browser session ID; binds issuance without entering redemption. */
  sessionHash: string;
}

export const createViewGrantCommand: HubCommand<CreateViewGrantInput, ViewGrant> = {
  name: "artifact.create_view_grant",
  replay: "reject",
  auditInput: () => ({ action: "artifact.create_view_grant" }),
  async run(input, ctx) {
    viewObject(input, ["versionId", "grantSecretHash", "viewNonce", "sessionHash"]);
    if (!ctx.actorHumanId || ctx.actorDelegationId || ctx.actorRunnerId || ctx.actorSystemId) {
      rejectViewRequest();
    }
    // Any workspace member may open a preview, including reviewers who approve
    // artifacts; project scoping for views is a V03 review concern.
    const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
    assertEpoch(principal, ctx.authorizationEpoch);
    if (typeof input.versionId !== "string" || !isUlid(input.versionId)) rejectViewRequest();
    if (typeof input.grantSecretHash !== "string" || !HEX64.test(input.grantSecretHash)) {
      rejectViewRequest();
    }
    const nonce = assertViewNonce(input.viewNonce);
    if (typeof input.sessionHash !== "string" || !HEX64.test(input.sessionHash)) {
      rejectViewRequest();
    }
    const version = (await ctx.db
      .prepare(
        `SELECT id, artifact_id, state, format, content_hash, r2_key
         FROM artifact_versions WHERE workspace_id = ? AND id = ?`,
      )
      .get(ctx.workspaceId, input.versionId)) as
      | {
          id: string;
          artifact_id: string;
          state: string;
          format: string;
          content_hash: string | null;
          r2_key: string | null;
        }
      | undefined;
    if (!version || version.state !== "available" || !version.content_hash || !version.r2_key) {
      rejectViewRequest();
    }
    const nowMs = Date.parse(ctx.now);
    if (!Number.isFinite(nowMs)) rejectViewRequest();
    const viewId = randomUlid();
    const expiresAt = new Date(nowMs + VIEW_GRANT_TTL_MS).toISOString();
    await ctx.db
      .prepare(
        `INSERT INTO artifact_view_grants
         (workspace_id, id, version_id, grant_hash, view_nonce_hash, human_id, session_hash,
          authorization_epoch, content_hash, expires_at, consumed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        ctx.workspaceId,
        viewId,
        version.id,
        input.grantSecretHash,
        artifactHash(nonce),
        principal.humanId,
        input.sessionHash,
        principal.authorizationEpoch,
        version.content_hash,
        expiresAt,
        ctx.now,
      );
    await viewAuditOutbox(ctx.db, {
      workspaceId: ctx.workspaceId,
      versionId: version.id,
      viewId,
      action: "artifact.view_issued",
      now: ctx.now,
    });
    return {
      schema_version: 1,
      view_id: viewId,
      version_id: version.id,
      content_hash: version.content_hash,
      format: version.format,
      grant_hash: input.grantSecretHash,
      expires_at: expiresAt,
    };
  },
};

export interface RedeemedView {
  workspaceId: string;
  viewId: string;
  versionId: string;
  artifactId: string;
  format: string;
  role: string;
  contentHash: string;
  r2Key: string;
  humanId: string;
}

function nonceEqual(stored: string, supplied: string): boolean {
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(supplied, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Atomically consumes a one-time view grant before the Artifact Worker reads
 * any bytes. Rechecks the channel nonce, grant expiry, version availability,
 * exact content hash, and the current authorization epoch inside the guarded
 * update; a racing or replayed redemption aborts the whole batch with no
 * byte effect.
 */
export async function redeemViewGrant(
  db: SqlDatabase,
  input: { viewId: string; secret: string; nonce: string; now: string },
): Promise<RedeemedView> {
  if (typeof input.viewId !== "string" || !isUlid(input.viewId)) rejectViewRequest();
  const secret = assertViewSecret(input.secret);
  const nonce = assertViewNonce(input.nonce);
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) rejectViewRequest();
  const secretHash = artifactHash(secret);
  const candidate = (await db
    .prepare(
      `SELECT g.workspace_id, g.version_id, g.human_id, g.authorization_epoch,
              g.view_nonce_hash, g.content_hash AS grant_content_hash, g.expires_at, g.consumed_at,
              v.artifact_id, v.state, v.format, v.content_hash, v.r2_key
       FROM artifact_view_grants AS g
       JOIN artifact_versions AS v
         ON v.workspace_id = g.workspace_id AND v.id = g.version_id
       WHERE g.id = ? AND g.grant_hash = ?`,
    )
    .get(input.viewId, secretHash)) as
    | {
        workspace_id: string;
        version_id: string;
        human_id: string;
        authorization_epoch: number;
        view_nonce_hash: string;
        grant_content_hash: string;
        expires_at: string;
        consumed_at: string | null;
        artifact_id: string;
        state: string;
        format: string;
        content_hash: string | null;
        r2_key: string | null;
      }
    | undefined;
  if (
    !candidate ||
    candidate.consumed_at !== null ||
    Date.parse(candidate.expires_at) <= nowMs ||
    !nonceEqual(candidate.view_nonce_hash, artifactHash(nonce)) ||
    candidate.state !== "available" ||
    !candidate.content_hash ||
    !candidate.r2_key ||
    candidate.grant_content_hash !== candidate.content_hash
  ) {
    rejectViewRequest();
  }
  const artifact = (await db
    .prepare(`SELECT role FROM artifacts WHERE workspace_id = ? AND id = ?`)
    .get(candidate.workspace_id, candidate.artifact_id)) as { role: string } | undefined;
  if (!artifact) rejectViewRequest();
  // The nonce, expiry, version, and membership/epoch fences are part of the
  // guarded update so revocation between the read above and the consume
  // cannot grant view authority.
  await db
    .prepare(
      `UPDATE artifact_view_grants SET consumed_at = ?
       WHERE id = ? AND grant_hash = ? AND view_nonce_hash = ?
         AND consumed_at IS NULL AND expires_at > ?
         AND EXISTS (
           SELECT 1 FROM artifact_versions AS v
           WHERE v.workspace_id = artifact_view_grants.workspace_id
             AND v.id = artifact_view_grants.version_id
             AND v.state = 'available'
             AND v.content_hash = artifact_view_grants.content_hash
         )
         AND EXISTS (
           SELECT 1 FROM workspace_members AS m
           JOIN workspace_authorization_epochs AS e
             ON e.workspace_id = m.workspace_id AND e.human_id = m.human_id
           WHERE m.workspace_id = artifact_view_grants.workspace_id
             AND m.human_id = artifact_view_grants.human_id
             AND m.authorization_epoch = e.authorization_epoch
             AND e.revoked_at IS NULL
             AND e.authorization_epoch = artifact_view_grants.authorization_epoch
         )`,
    )
    .run(input.now, input.viewId, secretHash, artifactHash(nonce), input.now);
  // D1 batches cannot read after a queued write, so the single-consume check
  // is a guard row: D1 evaluates the predicate at commit time and aborts the
  // entire batch when a racing redemption consumed the grant first.
  const guardId = randomUlid();
  await db
    .prepare(
      `INSERT INTO artifact_mutation_guards (id, valid) VALUES (?,
       (SELECT COUNT(*) = 1 FROM artifact_view_grants
        WHERE id = ? AND grant_hash = ? AND consumed_at = ?))`,
    )
    .run(guardId, input.viewId, secretHash, input.now);
  await db.prepare(`DELETE FROM artifact_mutation_guards WHERE id = ?`).run(guardId);
  await viewAuditOutbox(db, {
    workspaceId: candidate.workspace_id,
    versionId: candidate.version_id,
    viewId: input.viewId,
    action: "artifact.view_redeemed",
    now: input.now,
  });
  return {
    workspaceId: candidate.workspace_id,
    viewId: input.viewId,
    versionId: candidate.version_id,
    artifactId: candidate.artifact_id,
    format: candidate.format,
    role: artifact.role,
    contentHash: candidate.content_hash,
    r2Key: candidate.r2_key,
    humanId: candidate.human_id,
  };
}

/** Hashes a caller-supplied identifier before it enters a rate key or diagnostic. */
export function viewSubject(value: string): string {
  return artifactSubject(`artifact-view:${value}`);
}
