// ABOUTME: Owns first-owner bootstrap, workspace invitations, role changes, and member revocation.
// ABOUTME: One-time capabilities are hashed, identity-bound, atomically consumed, and audited.

import { randomBytes, timingSafeEqual } from "node:crypto";

import type { Jurisdiction, SqlDatabase } from "@bfb/db";

import { assertEpoch, assertRole, loadPrincipal, type WorkspaceRole } from "./authorization.js";
import { DomainError, type HubCommand } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";

const FLOW_TTL_MS = 10 * 60 * 1000;
const INVITATION_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface WorkspaceIdentity {
  humanId: string;
  authUserId: string;
  sessionId: string;
  email: string;
  emailVerified: boolean;
}

export interface BootstrapFlow {
  flowId: string;
  callbackUrl: string;
}

interface BootstrapFlowRow {
  human_id: string;
  auth_user_id: string;
  session_id: string;
  state: string;
  completion_hash: string | null;
  expires_at: string;
}

interface InvitationRow {
  normalized_email: string;
  role: "member" | "reviewer";
  secret_hash: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new DomainError("invalid_time", "workspace authorization timestamp is invalid");
  }
  return parsed;
}

function futureExpiry(now: string, ttlMs: number): string {
  return new Date(timestamp(now) + ttlMs).toISOString();
}

function hashEqual(expected: string, presented: string): boolean {
  if (!HASH_PATTERN.test(expected) || !HASH_PATTERN.test(presented)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(presented, "hex"));
}

function assertSecretHash(value: string): void {
  if (!HASH_PATTERN.test(value)) {
    throw new DomainError("invalid_secret", "secret verifier is invalid");
  }
}

export function normalizeInvitationEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 254 ||
    !normalized.includes("@") ||
    /\s/u.test(normalized) ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new DomainError("invalid_email", "invitation email is invalid");
  }
  return normalized;
}

export function workspaceCapability(): string {
  return Buffer.from(randomBytes(32)).toString("base64url");
}

export async function startWorkspaceBootstrap(
  db: SqlDatabase,
  identity: WorkspaceIdentity,
  appOrigin: string,
  completionHash: string,
  now: string,
): Promise<BootstrapFlow> {
  assertSecretHash(completionHash);
  if (!identity.emailVerified) {
    throw new DomainError("bootstrap_unavailable", "first-owner bootstrap is unavailable");
  }
  const existing = (await db.prepare(`SELECT COUNT(*) AS count FROM workspaces`).get()) as {
    count: number;
  };
  if (existing.count !== 0) {
    throw new DomainError("bootstrap_unavailable", "first-owner bootstrap is unavailable");
  }
  const state = (await db
    .prepare(`SELECT consumed_at, expires_at FROM bootstrap_state WHERE id = 'first_owner'`)
    .get()) as { consumed_at: string | null; expires_at: string } | undefined;
  if (!state || state.consumed_at || timestamp(state.expires_at) <= timestamp(now)) {
    throw new DomainError("bootstrap_unavailable", "first-owner bootstrap is unavailable");
  }
  const flowId = randomUlid();
  const callback = new URL("/api/v1/workspace-access/bootstrap/reauth", appOrigin);
  callback.searchParams.set("flow_id", flowId);
  await db
    .prepare(
      `INSERT INTO workspace_bootstrap_flows
       (id, human_id, auth_user_id, session_id, state, completion_hash,
        created_at, reauthenticated_at, expires_at, consumption_stamp)
       VALUES (?, ?, ?, ?, 'reauth_pending', ?, ?, NULL, ?, NULL)`,
    )
    .run(
      flowId,
      identity.humanId,
      identity.authUserId,
      identity.sessionId,
      completionHash,
      now,
      futureExpiry(now, FLOW_TTL_MS),
    );
  return { flowId, callbackUrl: callback.toString() };
}

export async function completeWorkspaceBootstrapReauthentication(
  db: SqlDatabase,
  identity: WorkspaceIdentity,
  flowId: string,
  completionHash: string,
  now: string,
): Promise<void> {
  assertSecretHash(completionHash);
  const flow = (await db
    .prepare(`SELECT * FROM workspace_bootstrap_flows WHERE id = ?`)
    .get(flowId)) as BootstrapFlowRow | undefined;
  if (
    !flow ||
    !identity.emailVerified ||
    flow.state !== "reauth_pending" ||
    flow.human_id !== identity.humanId ||
    flow.auth_user_id !== identity.authUserId ||
    !flow.completion_hash ||
    !hashEqual(flow.completion_hash, completionHash) ||
    timestamp(flow.expires_at) <= timestamp(now)
  ) {
    throw new DomainError("reauthentication_invalid", "fresh GitHub reauthentication failed");
  }
  const result = await db
    .prepare(
      `UPDATE workspace_bootstrap_flows
       SET state = 'ready', session_id = ?, completion_hash = NULL, reauthenticated_at = ?
       WHERE id = ? AND state = 'reauth_pending' AND completion_hash = ?`,
    )
    .run(identity.sessionId, now, flowId, flow.completion_hash);
  if (result.changes !== 1) {
    throw new DomainError("reauthentication_replayed", "reauthentication already consumed");
  }
}

export async function createFirstWorkspace(
  db: SqlDatabase,
  identity: WorkspaceIdentity,
  values: {
    flowId: string;
    bootstrapSecretHash: string;
    slug: string;
    jurisdiction: Jurisdiction;
  },
  now: string,
): Promise<{ workspaceId: string; slug: string; role: "owner" }> {
  assertSecretHash(values.bootstrapSecretHash);
  if (!SLUG_PATTERN.test(values.slug)) {
    throw new DomainError("invalid_slug", "workspace slug is invalid");
  }
  const flow = (await db
    .prepare(`SELECT * FROM workspace_bootstrap_flows WHERE id = ?`)
    .get(values.flowId)) as BootstrapFlowRow | undefined;
  const state = (await db
    .prepare(`SELECT * FROM bootstrap_state WHERE id = 'first_owner'`)
    .get()) as
    | {
        secret_hash: string;
        expires_at: string;
        consumed_at: string | null;
      }
    | undefined;
  if (
    !flow ||
    !identity.emailVerified ||
    flow.state !== "ready" ||
    flow.human_id !== identity.humanId ||
    flow.auth_user_id !== identity.authUserId ||
    flow.session_id !== identity.sessionId ||
    timestamp(flow.expires_at) <= timestamp(now) ||
    !state ||
    state.consumed_at ||
    timestamp(state.expires_at) <= timestamp(now) ||
    !hashEqual(state.secret_hash, values.bootstrapSecretHash)
  ) {
    throw new DomainError("bootstrap_rejected", "first-owner bootstrap rejected");
  }

  const workspaceId = randomUlid();
  const consumptionStamp = `${now}#${randomUlid()}`;
  const eventId = randomUlid();
  const auditId = randomUlid();
  const outboxId = randomUlid();
  const payload = JSON.stringify({ workspaceId, ownerHumanId: identity.humanId });
  await db.withTransaction(async (tx) => {
    await tx
      .prepare(
        `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
         VALUES (?, ?, ?, ?, 1)`,
      )
      .run(workspaceId, values.slug, values.jurisdiction, now);
    await tx
      .prepare(
        `INSERT INTO workspace_members
         (workspace_id, human_id, role, authorization_epoch, created_at)
         VALUES (?, ?, 'owner', 1, ?)`,
      )
      .run(workspaceId, identity.humanId, now);
    await tx
      .prepare(
        `INSERT INTO workspace_authorization_epochs
         (workspace_id, human_id, authorization_epoch, revoked_at, updated_at)
         VALUES (?, ?, 1, NULL, ?)`,
      )
      .run(workspaceId, identity.humanId, now);
    await tx
      .prepare(
        `INSERT INTO workspace_bootstrap_claims (state_id, workspace_id, claimed_at)
         VALUES ('first_owner', ?, ?)`,
      )
      .run(workspaceId, now);
    await tx
      .prepare(
        `UPDATE workspace_bootstrap_flows
         SET state = 'consumed', consumption_stamp = ?
         WHERE id = ? AND state = 'ready' AND consumption_stamp IS NULL`,
      )
      .run(consumptionStamp, values.flowId);
    await tx
      .prepare(
        `UPDATE bootstrap_state
         SET consumed_at = ?, consumption_stamp = ?, consumed_by_human_id = ?, workspace_id = ?
         WHERE id = 'first_owner' AND consumed_at IS NULL`,
      )
      .run(now, consumptionStamp, identity.humanId, workspaceId);
    await tx
      .prepare(`INSERT INTO workspace_cursors (workspace_id, cursor) VALUES (?, 1)`)
      .run(workspaceId);
    await tx
      .prepare(
        `INSERT INTO semantic_events
         (workspace_id, event_id, workspace_cursor, kind, payload_json, created_at)
         VALUES (?, ?, 1, 'workspace.bootstrap', ?, ?)`,
      )
      .run(workspaceId, eventId, payload, now);
    await tx
      .prepare(
        `INSERT INTO audit_events
         (workspace_id, audit_id, actor_principal_id, action, payload_json, created_at)
         VALUES (?, ?, ?, 'workspace.bootstrap', ?, ?)`,
      )
      .run(workspaceId, auditId, identity.humanId, payload, now);
    await tx
      .prepare(
        `INSERT INTO outbox_records
         (workspace_id, outbox_id, kind, payload_json, created_at, delivered_at)
         VALUES (?, ?, 'workspace.bootstrap', ?, ?, NULL)`,
      )
      .run(workspaceId, outboxId, payload, now);
  });

  const owner = (await db
    .prepare(
      `SELECT state.consumption_stamp, flow.consumption_stamp AS flow_stamp
       FROM bootstrap_state AS state
       JOIN workspace_bootstrap_flows AS flow ON flow.id = ?
       JOIN workspace_bootstrap_claims AS claim ON claim.state_id = state.id
       WHERE state.id = 'first_owner' AND claim.workspace_id = ?`,
    )
    .get(values.flowId, workspaceId)) as
    { consumption_stamp: string | null; flow_stamp: string | null } | undefined;
  if (owner?.consumption_stamp !== consumptionStamp || owner.flow_stamp !== consumptionStamp) {
    throw new DomainError("bootstrap_replayed", "first-owner bootstrap already consumed");
  }
  return { workspaceId, slug: values.slug, role: "owner" };
}

export interface CreateInvitationInput {
  invitationId: string;
  normalizedEmail: string;
  role: "member" | "reviewer";
  secretHash: string;
  expiresAt: string;
}

export const createInvitationCommand: HubCommand<
  CreateInvitationInput,
  { id: string; normalizedEmail: string; role: "member" | "reviewer"; expiresAt: string }
> = {
  name: "workspace.invitation.create",
  async run(input, ctx) {
    if (!ctx.actorHumanId) {
      throw new DomainError("unauthenticated", "human actor required");
    }
    const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
    assertEpoch(principal, ctx.authorizationEpoch);
    assertRole(principal, ["owner"]);
    if (!isUlid(input.invitationId)) {
      throw new DomainError("invalid_invitation", "invitation id is invalid");
    }
    const normalizedEmail = normalizeInvitationEmail(input.normalizedEmail);
    assertSecretHash(input.secretHash);
    const now = timestamp(ctx.now);
    const expiry = timestamp(input.expiresAt);
    if (expiry <= now || expiry - now > INVITATION_MAX_TTL_MS) {
      throw new DomainError("invalid_expiry", "invitation expiry is invalid");
    }
    const active = await ctx.db
      .prepare(
        `SELECT 1
         FROM workspace_members AS membership
         JOIN humans ON humans.id = membership.human_id
         WHERE membership.workspace_id = ? AND lower(trim(humans.email)) = ?
         LIMIT 1`,
      )
      .get(ctx.workspaceId, normalizedEmail);
    if (active) {
      throw new DomainError("already_member", "invitation recipient is already a member");
    }
    await ctx.db
      .prepare(
        `INSERT INTO workspace_invitations
         (workspace_id, id, normalized_email, role, secret_hash,
          created_by_human_id, created_at, expires_at, consumed_at,
          consumed_by_human_id, revoked_at, consumption_stamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
      )
      .run(
        ctx.workspaceId,
        input.invitationId,
        normalizedEmail,
        input.role,
        input.secretHash,
        ctx.actorHumanId,
        ctx.now,
        input.expiresAt,
      );
    return {
      id: input.invitationId,
      normalizedEmail,
      role: input.role,
      expiresAt: input.expiresAt,
    };
  },
};

export async function acceptInvitation(
  db: SqlDatabase,
  identity: WorkspaceIdentity,
  values: { workspaceId: string; invitationId: string; secretHash: string },
  now: string,
): Promise<{ workspaceId: string; role: "member" | "reviewer"; authorizationEpoch: number }> {
  assertSecretHash(values.secretHash);
  const invitation = (await db
    .prepare(`SELECT * FROM workspace_invitations WHERE workspace_id = ? AND id = ?`)
    .get(values.workspaceId, values.invitationId)) as InvitationRow | undefined;
  if (
    !identity.emailVerified ||
    !invitation ||
    invitation.consumed_at ||
    invitation.revoked_at ||
    invitation.normalized_email !== normalizeInvitationEmail(identity.email) ||
    timestamp(invitation.expires_at) <= timestamp(now) ||
    !hashEqual(invitation.secret_hash, values.secretHash)
  ) {
    throw new DomainError("invitation_rejected", "invitation rejected");
  }
  const retained = (await db
    .prepare(
      `SELECT authorization_epoch, revoked_at
       FROM workspace_authorization_epochs
       WHERE workspace_id = ? AND human_id = ?`,
    )
    .get(values.workspaceId, identity.humanId)) as
    { authorization_epoch: number; revoked_at: string | null } | undefined;
  if (retained && !retained.revoked_at) {
    throw new DomainError("invitation_rejected", "invitation rejected");
  }
  const authorizationEpoch = retained ? retained.authorization_epoch + 1 : 1;
  const consumptionStamp = `${now}#${randomUlid()}`;
  const payload = JSON.stringify({
    invitationId: values.invitationId,
    humanId: identity.humanId,
    role: invitation.role,
  });
  await db.withTransaction(async (tx) => {
    await tx
      .prepare(
        `INSERT INTO workspace_members
         (workspace_id, human_id, role, authorization_epoch, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(values.workspaceId, identity.humanId, invitation.role, authorizationEpoch, now);
    if (retained) {
      await tx
        .prepare(
          `UPDATE workspace_authorization_epochs
           SET authorization_epoch = ?, revoked_at = NULL, updated_at = ?
           WHERE workspace_id = ? AND human_id = ?
             AND authorization_epoch = ? AND revoked_at IS NOT NULL`,
        )
        .run(
          authorizationEpoch,
          now,
          values.workspaceId,
          identity.humanId,
          retained.authorization_epoch,
        );
    } else {
      await tx
        .prepare(
          `INSERT INTO workspace_authorization_epochs
           (workspace_id, human_id, authorization_epoch, revoked_at, updated_at)
           VALUES (?, ?, ?, NULL, ?)`,
        )
        .run(values.workspaceId, identity.humanId, authorizationEpoch, now);
    }
    await tx
      .prepare(
        `UPDATE workspace_invitations
         SET consumed_at = ?, consumed_by_human_id = ?, consumption_stamp = ?
         WHERE workspace_id = ? AND id = ? AND consumed_at IS NULL`,
      )
      .run(now, identity.humanId, consumptionStamp, values.workspaceId, values.invitationId);
    await tx
      .prepare(
        `INSERT INTO audit_events
         (workspace_id, audit_id, actor_principal_id, action, payload_json, created_at)
         VALUES (?, ?, ?, 'workspace.invitation.accept', ?, ?)`,
      )
      .run(values.workspaceId, randomUlid(), identity.humanId, payload, now);
    await tx
      .prepare(
        `INSERT INTO outbox_records
         (workspace_id, outbox_id, kind, payload_json, created_at, delivered_at)
         VALUES (?, ?, 'workspace.invitation.accept', ?, ?, NULL)`,
      )
      .run(values.workspaceId, randomUlid(), payload, now);
  });
  const accepted = (await db
    .prepare(
      `SELECT invitation.consumption_stamp, membership.role, epoch.authorization_epoch
       FROM workspace_invitations AS invitation
       JOIN workspace_members AS membership
         ON membership.workspace_id = invitation.workspace_id
        AND membership.human_id = invitation.consumed_by_human_id
       JOIN workspace_authorization_epochs AS epoch
         ON epoch.workspace_id = membership.workspace_id
        AND epoch.human_id = membership.human_id
       WHERE invitation.workspace_id = ? AND invitation.id = ?`,
    )
    .get(values.workspaceId, values.invitationId)) as
    | { consumption_stamp: string | null; role: "member" | "reviewer"; authorization_epoch: number }
    | undefined;
  if (
    accepted?.consumption_stamp !== consumptionStamp ||
    accepted.authorization_epoch !== authorizationEpoch
  ) {
    throw new DomainError("invitation_replayed", "invitation already consumed");
  }
  return { workspaceId: values.workspaceId, role: accepted.role, authorizationEpoch };
}

export interface ChangeMemberRoleInput {
  humanId: string;
  role: "member" | "reviewer";
}

export const changeMemberRoleCommand: HubCommand<
  ChangeMemberRoleInput,
  { humanId: string; role: "member" | "reviewer"; authorizationEpoch: number }
> = {
  name: "workspace.member.role.change",
  async run(input, ctx) {
    if (!ctx.actorHumanId) {
      throw new DomainError("unauthenticated", "human actor required");
    }
    const actor = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
    assertEpoch(actor, ctx.authorizationEpoch);
    assertRole(actor, ["owner"]);
    const target = (await ctx.db
      .prepare(
        `SELECT membership.role, epoch.authorization_epoch
         FROM workspace_members AS membership
         JOIN workspace_authorization_epochs AS epoch
           ON epoch.workspace_id = membership.workspace_id
          AND epoch.human_id = membership.human_id
         WHERE membership.workspace_id = ? AND membership.human_id = ?
           AND epoch.revoked_at IS NULL`,
      )
      .get(ctx.workspaceId, input.humanId)) as
      { role: WorkspaceRole; authorization_epoch: number } | undefined;
    if (!target) {
      throw new DomainError("not_found", "member not found");
    }
    if (target.role === "owner") {
      throw new DomainError("ownership_change_requires_step_up", "owner role cannot change here");
    }
    const nextEpoch = target.authorization_epoch + 1;
    await ctx.db
      .prepare(
        `UPDATE workspace_members
         SET role = ?, authorization_epoch = ?
         WHERE workspace_id = ? AND human_id = ? AND authorization_epoch = ?`,
      )
      .run(input.role, nextEpoch, ctx.workspaceId, input.humanId, target.authorization_epoch);
    await ctx.db
      .prepare(
        `UPDATE workspace_authorization_epochs
         SET authorization_epoch = ?, updated_at = ?
         WHERE workspace_id = ? AND human_id = ?
           AND authorization_epoch = ? AND revoked_at IS NULL`,
      )
      .run(nextEpoch, ctx.now, ctx.workspaceId, input.humanId, target.authorization_epoch);
    return { humanId: input.humanId, role: input.role, authorizationEpoch: nextEpoch };
  },
};

export interface RemoveMemberInput {
  humanId: string;
}

export const removeMemberCommand: HubCommand<
  RemoveMemberInput,
  { humanId: string; revokedAuthorizationEpoch: number }
> = {
  name: "workspace.member.remove",
  async run(input, ctx) {
    if (!ctx.actorHumanId) {
      throw new DomainError("unauthenticated", "human actor required");
    }
    const actor = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
    assertEpoch(actor, ctx.authorizationEpoch);
    assertRole(actor, ["owner"]);
    const target = (await ctx.db
      .prepare(
        `SELECT membership.role, epoch.authorization_epoch, humans.email
         FROM workspace_members AS membership
         JOIN workspace_authorization_epochs AS epoch
           ON epoch.workspace_id = membership.workspace_id
          AND epoch.human_id = membership.human_id
         JOIN humans ON humans.id = membership.human_id
         WHERE membership.workspace_id = ? AND membership.human_id = ?
           AND epoch.revoked_at IS NULL`,
      )
      .get(ctx.workspaceId, input.humanId)) as
      { role: WorkspaceRole; authorization_epoch: number; email: string } | undefined;
    if (!target) {
      throw new DomainError("not_found", "member not found");
    }
    if (target.role === "owner") {
      throw new DomainError("ownership_change_requires_step_up", "owner cannot be removed here");
    }
    const nextEpoch = target.authorization_epoch + 1;
    await ctx.db
      .prepare(
        `UPDATE workspace_invitations
         SET revoked_at = ?
         WHERE workspace_id = ? AND normalized_email = ?
           AND consumed_at IS NULL AND revoked_at IS NULL`,
      )
      .run(ctx.now, ctx.workspaceId, normalizeInvitationEmail(target.email));
    await ctx.db
      .prepare(`DELETE FROM project_access WHERE workspace_id = ? AND human_id = ?`)
      .run(ctx.workspaceId, input.humanId);
    await ctx.db
      .prepare(
        `UPDATE oauth_delegations
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE workspace_id = ? AND human_id = ?`,
      )
      .run(ctx.now, ctx.workspaceId, input.humanId);
    await ctx.db
      .prepare(
        `UPDATE workspace_authorization_epochs
         SET authorization_epoch = ?, revoked_at = ?, updated_at = ?
         WHERE workspace_id = ? AND human_id = ?
           AND authorization_epoch = ? AND revoked_at IS NULL`,
      )
      .run(nextEpoch, ctx.now, ctx.now, ctx.workspaceId, input.humanId, target.authorization_epoch);
    await ctx.db
      .prepare(`DELETE FROM workspace_members WHERE workspace_id = ? AND human_id = ?`)
      .run(ctx.workspaceId, input.humanId);
    return { humanId: input.humanId, revokedAuthorizationEpoch: nextEpoch };
  },
};
