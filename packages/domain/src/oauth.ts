// ABOUTME: Binds Better Auth OAuth Provider tokens to action-approved BFB delegations.
// ABOUTME: Every MCP request rechecks provider token state, membership, resource, and epoch.

import { createHash } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";

import { DomainError } from "./hub.js";
import { randomUlid } from "./ids.js";
import { consumeStepUpProof, type StepUpAction } from "./step-up.js";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
const PROVIDER_ACCESS_TOKEN_PREFIX = "mcp_";
const PROVIDER_REFRESH_TOKEN_PREFIX = "mcp_refresh_";

export function mcpResource(appOrigin: string): string {
  const origin = new URL(appOrigin);
  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new DomainError("invalid_resource", "app origin must not contain a path");
  }
  return `${origin.origin}/mcp`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function providerTokenHash(token: string, prefix = PROVIDER_ACCESS_TOKEN_PREFIX): string {
  const value = token.startsWith(prefix) ? token.slice(prefix.length) : token;
  return createHash("sha256").update(value).digest("base64url");
}

const OAUTH_SCOPES = new Set(["bfb:read", "bfb:task:write", "offline_access"]);

export async function prepareDelegationGrant(
  db: SqlDatabase,
  input: {
    humanId: string;
    authUserId: string;
    sessionId: string;
    clientId: string;
    state: string;
    resource: string;
    workspaceId: string;
    projectId?: string | undefined;
    taskId?: string | undefined;
    scopes: string[];
    authorizationEpoch: number;
    stepUpProofId: string;
    providerLabel?: string | undefined;
    now: string;
  },
): Promise<string> {
  const scopes = [...new Set(input.scopes)].sort();
  if (
    scopes.length !== input.scopes.length ||
    !scopes.includes("offline_access") ||
    scopes.some((scope) => !OAUTH_SCOPES.has(scope))
  ) {
    throw new DomainError("invalid_scope", "OAuth scopes are invalid");
  }
  if (!input.state || input.state.length > 512) {
    throw new DomainError("invalid_request", "state is required and bounded");
  }
  if (
    input.providerLabel !== undefined &&
    (!input.providerLabel.trim() ||
      [...input.providerLabel].length > 64 ||
      [...input.providerLabel].some((character) => (character.codePointAt(0) ?? 0) < 32))
  ) {
    throw new DomainError("invalid_request", "provider label is invalid");
  }
  const client = (await db
    .prepare(
      `SELECT client_id FROM better_auth_oauth_clients
       WHERE client_id = ? AND disabled = 0 AND public = 1`,
    )
    .get(input.clientId)) as { client_id: string } | undefined;
  if (!client) {
    throw new DomainError("invalid_client", "client not preregistered public");
  }
  const proof = (await db
    .prepare(`SELECT * FROM passkey_step_up_proofs WHERE proof_id = ?`)
    .get(input.stepUpProofId)) as
    | {
        human_id: string;
        action: string;
        client_id: string | null;
        resource: string | null;
        boundary_json: string;
        scopes_json: string;
        authorization_epoch: number;
        expires_at: string;
        consumed_at: string | null;
      }
    | undefined;
  const boundary = proof
    ? (JSON.parse(proof.boundary_json) as {
        workspaceId: string | null;
        projectId: string | null;
        taskId: string | null;
      })
    : undefined;
  if (
    !proof ||
    proof.consumed_at ||
    Date.parse(proof.expires_at) <= Date.parse(input.now) ||
    proof.human_id !== input.humanId ||
    proof.action !== "oauth.delegation.create" ||
    proof.client_id !== input.clientId ||
    proof.resource !== input.resource ||
    boundary?.workspaceId !== input.workspaceId ||
    (boundary?.projectId ?? undefined) !== input.projectId ||
    (boundary?.taskId ?? undefined) !== input.taskId ||
    proof.authorization_epoch !== input.authorizationEpoch ||
    JSON.stringify(JSON.parse(proof.scopes_json)) !== JSON.stringify(scopes)
  ) {
    throw new DomainError("step_up_mismatch", "step-up proof does not match OAuth grant");
  }

  const { assertProjectAccess, assertTaskChildAccess, loadPrincipal } =
    await import("./authorization.js");
  const principal = await loadPrincipal(db, input.workspaceId, input.humanId);
  if (principal.authorizationEpoch !== input.authorizationEpoch) {
    throw new DomainError("revoked", "authorization epoch no longer valid");
  }
  if (input.projectId) {
    assertProjectAccess(principal, input.projectId);
  }
  if (input.taskId) {
    await assertTaskChildAccess(db, principal, input.taskId);
    const task = (await db
      .prepare(`SELECT project_id FROM tasks WHERE workspace_id = ? AND id = ?`)
      .get(input.workspaceId, input.taskId)) as { project_id: string } | undefined;
    if (!task || task.project_id !== input.projectId) {
      throw new DomainError("forbidden", "task outside selected project");
    }
  }

  const grantId = randomUlid();
  await db
    .prepare(
      `INSERT INTO oauth_delegation_grants (
         id, human_id, auth_user_id, session_id, client_id, state, resource,
         workspace_id, project_id, task_id, scopes_json, authorization_epoch,
         step_up_proof_id, provider_label, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      grantId,
      input.humanId,
      input.authUserId,
      input.sessionId,
      input.clientId,
      input.state,
      input.resource,
      input.workspaceId,
      input.projectId ?? null,
      input.taskId ?? null,
      JSON.stringify(scopes),
      input.authorizationEpoch,
      input.stepUpProofId,
      input.providerLabel?.trim() ?? null,
      proof.expires_at,
      input.now,
    );
  return grantId;
}

export async function delegationGrantForState(
  db: SqlDatabase,
  input: {
    state: string;
    authUserId: string;
    sessionId: string;
    scopes: string[];
    now: string;
  },
): Promise<string> {
  const row = (await db
    .prepare(
      `SELECT id, auth_user_id, session_id, scopes_json, expires_at, consumed_at
       FROM oauth_delegation_grants WHERE state = ?`,
    )
    .get(input.state)) as
    | {
        id: string;
        auth_user_id: string;
        session_id: string;
        scopes_json: string;
        expires_at: string;
        consumed_at: string | null;
      }
    | undefined;
  if (
    !row ||
    row.auth_user_id !== input.authUserId ||
    row.session_id !== input.sessionId ||
    row.consumed_at !== null ||
    Date.parse(row.expires_at) <= Date.parse(input.now) ||
    JSON.stringify(JSON.parse(row.scopes_json)) !== JSON.stringify([...input.scopes].sort())
  ) {
    throw new DomainError("invalid_grant", "OAuth delegation grant is unavailable");
  }
  return row.id;
}

export async function decideDelegationGrant(
  db: SqlDatabase,
  input: {
    grantId: string;
    authUserId: string;
    sessionId: string;
    decision: "accepted" | "denied";
    now: string;
  },
): Promise<string> {
  const stamp = randomUlid();
  await db
    .prepare(
      `UPDATE oauth_delegation_grants
       SET consent_decision = ?, consent_stamp = ?, decided_at = ?
       WHERE id = ? AND auth_user_id = ? AND session_id = ?
         AND consent_decision IS NULL AND consumed_at IS NULL AND expires_at > ?`,
    )
    .run(
      input.decision,
      stamp,
      input.now,
      input.grantId,
      input.authUserId,
      input.sessionId,
      input.now,
    );
  const decided = (await db
    .prepare(
      `SELECT consent_stamp FROM oauth_delegation_grants
       WHERE id = ? AND consent_decision = ?`,
    )
    .get(input.grantId, input.decision)) as { consent_stamp: string | null } | undefined;
  if (decided?.consent_stamp !== stamp) {
    throw new DomainError("invalid_grant", "OAuth consent was already decided");
  }
  return stamp;
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
): Promise<{ delegationId: string }> {
  const client = (await db
    .prepare(`SELECT client_id FROM better_auth_oauth_clients WHERE client_id = ? AND disabled = 0`)
    .get(input.clientId)) as { client_id: string; redirect_uri: string } | undefined;
  if (!client) {
    throw new DomainError("invalid_client", "client not preregistered");
  }
  if (!input.resource.endsWith("/mcp")) {
    throw new DomainError("invalid_resource", "MCP resource required");
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
  const delegationId = randomUlid();
  await consumeStepUpProof(
    db,
    input.stepUpProofId,
    action,
    input.now,
    input.humanId,
    async (tx, consumptionStamp) => {
      await tx
        .prepare(
          `INSERT INTO oauth_delegations (
             workspace_id, id, human_id, client_id, resource, project_id, task_id,
             scopes_json, authorization_epoch, expires_at, created_at, provider_label
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, grant.provider_label
           FROM oauth_delegation_grants AS grant
           JOIN passkey_step_up_proofs AS proof ON proof.proof_id = grant.step_up_proof_id
           WHERE grant.step_up_proof_id = ? AND grant.consumed_at IS NULL
             AND grant.consent_decision = 'accepted'
             AND proof.consumed_at = ?`,
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
          input.stepUpProofId,
          consumptionStamp,
        );
      await tx
        .prepare(
          `UPDATE oauth_delegation_grants SET consumed_at = ?
           WHERE step_up_proof_id = ? AND consumed_at IS NULL
             AND EXISTS (
               SELECT 1 FROM oauth_delegations
               WHERE workspace_id = ? AND id = ?
             )`,
        )
        .run(delegationId, input.stepUpProofId, input.workspaceId, delegationId);
    },
  );

  const stored = (await db
    .prepare(
      `SELECT delegation.id, grant.consumed_at
       FROM oauth_delegations AS delegation
       JOIN oauth_delegation_grants AS grant ON grant.step_up_proof_id = ?
       WHERE delegation.workspace_id = ? AND delegation.id = ?`,
    )
    .get(input.stepUpProofId, input.workspaceId, delegationId)) as
    { id: string; consumed_at: string | null } | undefined;
  if (!stored || stored.consumed_at !== delegationId) {
    throw new DomainError("invalid_grant", "delegation was not created");
  }

  return { delegationId };
}

export async function activateDelegationGrant(
  db: SqlDatabase,
  grantId: string,
  authUserId: string,
  grantedScopes: string[],
  nowIso: string,
): Promise<string> {
  const grant = (await db
    .prepare(`SELECT * FROM oauth_delegation_grants WHERE id = ?`)
    .get(grantId)) as
    | {
        id: string;
        human_id: string;
        auth_user_id: string;
        client_id: string;
        resource: string;
        workspace_id: string;
        project_id: string | null;
        task_id: string | null;
        scopes_json: string;
        authorization_epoch: number;
        step_up_proof_id: string;
        expires_at: string;
        consumed_at: string | null;
      }
    | undefined;
  if (!grant) {
    throw new DomainError("invalid_grant", "delegation grant unavailable");
  }
  if (grant.auth_user_id !== authUserId || Date.parse(grant.expires_at) <= Date.parse(nowIso)) {
    throw new DomainError("invalid_grant", "delegation grant identity or expiry mismatch");
  }
  const expectedScopes = JSON.parse(grant.scopes_json) as string[];
  if (JSON.stringify([...expectedScopes].sort()) !== JSON.stringify([...grantedScopes].sort())) {
    throw new DomainError("invalid_scope", "granted scopes differ from approved scopes");
  }
  if (grant.consumed_at) {
    return grant.consumed_at;
  }
  const { delegationId } = await createDelegation(db, {
    workspaceId: grant.workspace_id,
    humanId: grant.human_id,
    clientId: grant.client_id,
    resource: grant.resource,
    projectId: grant.project_id ?? undefined,
    taskId: grant.task_id ?? undefined,
    scopes: expectedScopes,
    authorizationEpoch: grant.authorization_epoch,
    expiresAt: grant.expires_at,
    now: nowIso,
    stepUpProofId: grant.step_up_proof_id,
  });
  const stored = (await db
    .prepare(`SELECT consumed_at FROM oauth_delegation_grants WHERE id = ?`)
    .get(grantId)) as { consumed_at: string | null } | undefined;
  if (stored?.consumed_at !== delegationId) {
    throw new DomainError("invalid_grant", "delegation grant already consumed");
  }
  return delegationId;
}

export async function bindProviderAccessToken(
  db: SqlDatabase,
  accessToken: string,
  nowIso: string,
): Promise<string> {
  if (!accessToken.startsWith(PROVIDER_ACCESS_TOKEN_PREFIX)) {
    throw new DomainError("invalid_token", "OAuth provider token prefix missing");
  }
  const row = (await db
    .prepare(
      `SELECT token.id AS provider_token_id, token.client_id, token.user_id,
              token.reference_id, token.expires_at, token.scopes,
              grant.consumed_at
       FROM better_auth_oauth_access_tokens AS token
       JOIN oauth_delegation_grants AS grant ON grant.id = token.reference_id
       WHERE token.token = ?`,
    )
    .get(providerTokenHash(accessToken))) as
    | {
        provider_token_id: string;
        client_id: string;
        user_id: string | null;
        reference_id: string;
        expires_at: unknown;
        scopes: string;
        consumed_at: string | null;
      }
    | undefined;
  if (!row || !row.user_id || timestampMs(row.expires_at) <= timestampMs(nowIso)) {
    throw new DomainError("invalid_token", "OAuth provider token is not active");
  }
  const grantedScopes = parseStringArray(row.scopes, "OAuth provider scopes");
  if (!row.consumed_at) {
    throw new DomainError("invalid_token", "OAuth delegation is not active");
  }
  const delegationId = row.consumed_at;
  const delegation = (await db
    .prepare(
      `SELECT workspace_id, id, human_id, client_id, scopes_json
       FROM oauth_delegations WHERE id = ?`,
    )
    .get(delegationId)) as
    | {
        workspace_id: string;
        id: string;
        human_id: string;
        client_id: string;
        scopes_json: string;
      }
    | undefined;
  const human = delegation
    ? ((await db
        .prepare(`SELECT better_auth_user_id FROM humans WHERE id = ?`)
        .get(delegation.human_id)) as { better_auth_user_id: string | null } | undefined)
    : undefined;
  if (
    !delegation ||
    delegation.client_id !== row.client_id ||
    human?.better_auth_user_id !== row.user_id ||
    JSON.stringify([...grantedScopes].sort()) !==
      JSON.stringify([...parseStringArray(delegation.scopes_json, "delegation scopes")].sort())
  ) {
    throw new DomainError("invalid_token", "OAuth provider token authority mismatch");
  }
  await db
    .prepare(
      `INSERT OR IGNORE INTO oauth_delegation_tokens
       (token_hash, workspace_id, delegation_id, provider_token_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      hashToken(accessToken),
      delegation.workspace_id,
      delegation.id,
      row.provider_token_id,
      nowIso,
    );
  return delegation.id;
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
  resource: string,
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
      `SELECT t.workspace_id, t.delegation_id,
              provider.expires_at AS token_expires_at,
              d.human_id, d.client_id, d.project_id, d.task_id, d.scopes_json,
              d.resource, d.authorization_epoch,
              d.revoked_at AS delegation_revoked_at, d.expires_at AS delegation_expires_at,
              m.authorization_epoch AS member_epoch, session.expires_at AS session_expires_at
       FROM oauth_delegation_tokens t
       JOIN better_auth_oauth_access_tokens provider ON provider.id = t.provider_token_id
       JOIN oauth_delegations d
         ON d.workspace_id = t.workspace_id AND d.id = t.delegation_id
       JOIN oauth_delegation_grants grant
         ON grant.id = provider.reference_id
        AND grant.workspace_id = d.workspace_id
        AND grant.consumed_at = d.id
       JOIN workspace_members m
         ON m.workspace_id = d.workspace_id AND m.human_id = d.human_id
       JOIN humans human
         ON human.id = d.human_id AND human.better_auth_user_id = provider.user_id
       JOIN better_auth_sessions session ON session.id = provider.session_id
       WHERE t.token_hash = ? AND provider.client_id = d.client_id`,
    )
    .get(hashToken(token))) as
    | {
        workspace_id: string;
        delegation_id: string;
        token_expires_at: unknown;
        human_id: string;
        client_id: string;
        project_id: string | null;
        task_id: string | null;
        scopes_json: string;
        resource: string;
        authorization_epoch: number;
        delegation_revoked_at: string | null;
        delegation_expires_at: unknown;
        member_epoch: number;
        session_expires_at: unknown;
      }
    | undefined;

  if (!row) {
    throw new DomainError("invalid_token", "access token unknown");
  }
  if (row.delegation_revoked_at) {
    throw new DomainError("revoked", "delegation or token revoked");
  }
  if (
    timestampMs(row.token_expires_at) <= timestampMs(nowIso) ||
    timestampMs(row.delegation_expires_at) <= timestampMs(nowIso) ||
    timestampMs(row.session_expires_at) <= timestampMs(nowIso)
  ) {
    throw new DomainError("token_expired", "token expired");
  }
  if (row.resource !== resource) {
    throw new DomainError("invalid_resource", "token resource mismatch");
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
    scopes: parseStringArray(row.scopes_json, "delegation scopes"),
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
}

export async function revokeProviderTokenDelegation(
  db: SqlDatabase,
  token: string,
  clientId: string,
  nowIso: string,
): Promise<boolean> {
  const providerTable = token.startsWith(PROVIDER_REFRESH_TOKEN_PREFIX)
    ? "better_auth_oauth_refresh_tokens"
    : "better_auth_oauth_access_tokens";
  const prefix =
    providerTable === "better_auth_oauth_refresh_tokens"
      ? PROVIDER_REFRESH_TOKEN_PREFIX
      : PROVIDER_ACCESS_TOKEN_PREFIX;
  const provider = (await db
    .prepare(
      `SELECT reference_id FROM ${providerTable}
       WHERE token = ? AND client_id = ?`,
    )
    .get(providerTokenHash(token, prefix), clientId)) as
    { reference_id: string | null } | undefined;
  if (!provider?.reference_id) {
    return false;
  }
  const result = await db
    .prepare(
      `UPDATE oauth_delegations SET revoked_at = ?
       WHERE revoked_at IS NULL AND EXISTS (
         SELECT 1 FROM oauth_delegation_grants grant
         WHERE grant.id = ?
           AND grant.workspace_id = oauth_delegations.workspace_id
           AND grant.consumed_at = oauth_delegations.id
       )`,
    )
    .run(nowIso, provider.reference_id);
  return result.changes === 1;
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
  if (delegation.taskId && !taskId) {
    throw new DomainError("forbidden", "task-bound delegation requires a task boundary");
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
    if (delegation.taskId && delegation.taskId !== taskId) {
      let currentTaskId: string | null = taskId;
      for (let depth = 0; currentTaskId && depth <= 64; depth++) {
        if (currentTaskId === delegation.taskId) {
          return;
        }
        const row = (await db
          .prepare(`SELECT parent_task_id FROM tasks WHERE workspace_id = ? AND id = ?`)
          .get(delegation.workspaceId, currentTaskId)) as
          { parent_task_id: string | null } | undefined;
        currentTaskId = row?.parent_task_id ?? null;
      }
      throw new DomainError("forbidden", "task outside delegation");
    }
    return;
  }
  if (projectId) {
    assertProjectAccess(principal, projectId);
  }
}

function timestampMs(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
    if (/^\d+$/u.test(value)) {
      return timestampMs(Number(value));
    }
  }
  throw new DomainError("invalid_token", "stored OAuth timestamp is invalid");
}

function parseStringArray(value: string, label: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new DomainError("invalid_token", `${label} are invalid`);
  }
  return parsed;
}
