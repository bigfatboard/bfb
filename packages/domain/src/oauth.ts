// ABOUTME: Manages BFB-owned OAuth delegations and opaque hashed access tokens for remote MCP.
// ABOUTME: Browser session cookies never mint MCP authority through these helpers.

import { createHash } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";

import { DomainError } from "./hub.js";
import { randomUlid } from "./ids.js";
import { consumeStepUpProof, type StepUpAction } from "./step-up.js";

export const MCP_RESOURCE = "https://bfb.example.test/mcp";
export const MCP_PROTOCOL_VERSION = "2026-07-28";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** PKCE S256 code challenge: BASE64URL(SHA256(verifier)). */
export function pkceS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function createDelegation(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    humanId: string;
    clientId: string;
    resource: string;
    projectId?: string | undefined;
    taskId?: string | undefined;
    scopes: string[];
    authorizationEpoch: number;
    expiresAt: string;
    now: string;
    stepUpProofId: string;
  },
): Promise<{ delegationId: string; accessToken: string }> {
  const client = (await db
    .prepare(`SELECT client_id, redirect_uri FROM preregistered_oauth_clients WHERE client_id = ?`)
    .get(input.clientId)) as { client_id: string; redirect_uri: string } | undefined;
  if (!client) {
    throw new DomainError("invalid_client", "client not preregistered");
  }
  if (input.resource !== MCP_RESOURCE) {
    throw new DomainError("invalid_resource", "resource mismatch");
  }

  const action: StepUpAction = {
    action: "oauth.delegation.create",
    clientId: input.clientId,
    resource: input.resource,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    taskId: input.taskId,
    scopes: input.scopes,
    authorizationEpoch: input.authorizationEpoch,
    expiresAt: input.expiresAt,
  };
  await consumeStepUpProof(db, input.stepUpProofId, action, input.now, input.humanId);

  const delegationId = randomUlid();
  await db
    .prepare(
      `INSERT INTO oauth_delegations (
      workspace_id, id, human_id, client_id, resource, project_id, task_id,
      scopes_json, authorization_epoch, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.workspaceId,
      delegationId,
      input.humanId,
      input.clientId,
      input.resource,
      input.projectId ?? null,
      input.taskId ?? null,
      JSON.stringify(input.scopes),
      input.authorizationEpoch,
      input.expiresAt,
      input.now,
    );

  const accessToken = "mcp_" + randomUlid() + randomUlid();
  await db
    .prepare(
      `INSERT INTO oauth_access_tokens (token_hash, workspace_id, delegation_id, expires_at)
     VALUES (?, ?, ?, ?)`,
    )
    .run(hashToken(accessToken), input.workspaceId, delegationId, input.expiresAt);

  return { delegationId, accessToken };
}

export interface ActiveDelegation {
  workspaceId: string;
  delegationId: string;
  humanId: string;
  clientId: string;
  projectId: string | null;
  taskId: string | null;
  scopes: string[];
  authorizationEpoch: number;
}

export async function resolveAccessToken(
  db: SqlDatabase,
  token: string,
  nowIso: string,
): Promise<ActiveDelegation> {
  if (token.startsWith("bfb_session_") || token.includes("cookie")) {
    throw new DomainError("credential_confusion", "browser cookie cannot authenticate mcp");
  }
  if (
    token.startsWith("bfb_cli_") ||
    token.startsWith("bfb_runner_") ||
    token.startsWith("bfb_agent_") ||
    token.startsWith("bfb_integration_")
  ) {
    throw new DomainError("credential_confusion", "reserved credential class rejected at mcp");
  }

  const row = (await db
    .prepare(
      `SELECT t.workspace_id, t.delegation_id, t.expires_at, t.revoked_at,
              d.human_id, d.client_id, d.project_id, d.task_id, d.scopes_json,
              d.authorization_epoch, d.revoked_at AS delegation_revoked_at, d.expires_at AS delegation_expires_at,
              m.authorization_epoch AS member_epoch
       FROM oauth_access_tokens t
       JOIN oauth_delegations d
         ON d.workspace_id = t.workspace_id AND d.id = t.delegation_id
       JOIN workspace_members m
         ON m.workspace_id = d.workspace_id AND m.human_id = d.human_id
       WHERE t.token_hash = ?`,
    )
    .get(hashToken(token))) as
    | {
        workspace_id: string;
        delegation_id: string;
        expires_at: string;
        revoked_at: string | null;
        human_id: string;
        client_id: string;
        project_id: string | null;
        task_id: string | null;
        scopes_json: string;
        authorization_epoch: number;
        delegation_revoked_at: string | null;
        delegation_expires_at: string;
        member_epoch: number;
      }
    | undefined;

  if (!row) {
    throw new DomainError("invalid_token", "access token unknown");
  }
  if (row.revoked_at || row.delegation_revoked_at) {
    throw new DomainError("revoked", "delegation or token revoked");
  }
  if (
    Date.parse(row.expires_at) <= Date.parse(nowIso) ||
    Date.parse(row.delegation_expires_at) <= Date.parse(nowIso)
  ) {
    throw new DomainError("token_expired", "token expired");
  }
  if (row.member_epoch !== row.authorization_epoch) {
    throw new DomainError("revoked", "authorization epoch no longer valid");
  }
  return {
    workspaceId: row.workspace_id,
    delegationId: row.delegation_id,
    humanId: row.human_id,
    clientId: row.client_id,
    projectId: row.project_id,
    taskId: row.task_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    authorizationEpoch: row.authorization_epoch,
  };
}

export async function revokeDelegation(
  db: SqlDatabase,
  workspaceId: string,
  delegationId: string,
  nowIso: string,
): Promise<void> {
  await db
    .prepare(`UPDATE oauth_delegations SET revoked_at = ? WHERE workspace_id = ? AND id = ?`)
    .run(nowIso, workspaceId, delegationId);
  await db
    .prepare(
      `UPDATE oauth_access_tokens SET revoked_at = ? WHERE workspace_id = ? AND delegation_id = ?`,
    )
    .run(nowIso, workspaceId, delegationId);
}

export function assertScope(delegation: ActiveDelegation, scope: string): void {
  if (!delegation.scopes.includes(scope)) {
    throw new DomainError("insufficient_scope", "missing scope " + scope);
  }
}

export function narrowBoundary(
  delegation: ActiveDelegation,
  projectId?: string,
  taskId?: string,
): void {
  if (delegation.projectId && projectId && delegation.projectId !== projectId) {
    throw new DomainError("forbidden", "project outside delegation");
  }
  if (delegation.taskId && taskId && delegation.taskId !== taskId) {
    throw new DomainError("forbidden", "task outside delegation");
  }
  if (projectId && delegation.projectId && projectId !== delegation.projectId) {
    throw new DomainError("forbidden", "cannot widen project boundary");
  }
}

/**
 * Enforces membership ∩ delegation scope on every MCP tool access path.
 * Caller-supplied project/task IDs may only narrow authority.
 */
export async function enforceDelegationAccess(
  db: SqlDatabase,
  delegation: ActiveDelegation,
  projectId?: string,
  taskId?: string,
): Promise<void> {
  const { assertProjectAccess, assertTaskChildAccess, loadPrincipal, assertEpoch } =
    await import("./authorization.js");
  const principal = await loadPrincipal(db, delegation.workspaceId, delegation.humanId);
  assertEpoch(principal, delegation.authorizationEpoch);
  narrowBoundary(delegation, projectId, taskId);
  if (taskId) {
    await assertTaskChildAccess(db, principal, taskId);
    return;
  }
  if (projectId) {
    assertProjectAccess(principal, projectId);
  }
}
