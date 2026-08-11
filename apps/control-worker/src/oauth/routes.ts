// ABOUTME: Implements MCP OAuth authorization-code + PKCE S256 for preregistered public clients.
// ABOUTME: Creates a BFB delegation only after a fresh C03 step-up proof; tokens are opaque hashes.

import type { SqlDatabase } from "@bfb/db";
import {
  MCP_RESOURCE,
  createDelegation,
  issueStepUpProof,
  pkceS256Challenge,
  randomUlid,
} from "@bfb/domain";

import { resolveBrowserPrincipal } from "../auth/session.js";

export interface OAuthDeps {
  db: SqlDatabase;
  appOrigin: string;
  now: string;
}

interface AuthCodeRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  human_id: string;
  workspace_id: string;
  project_id: string | null;
  scopes_json: string;
  authorization_epoch: number;
  step_up_proof_id: string;
  expires_at: string;
  consumed_at: string | null;
}

// In-memory code store is not used; codes live in rate_limit_buckets-shaped side table via SQL.
// Use a simple table created lazily if missing for OAuth codes.
export async function ensureOauthCodeTable(db: SqlDatabase): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
      code TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      human_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      project_id TEXT,
      scopes_json TEXT NOT NULL,
      authorization_epoch INTEGER NOT NULL,
      step_up_proof_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    )`,
    )
    .run();
}

export function handleOauthMetadata(appOrigin: string): Response {
  return json({
    issuer: appOrigin,
    authorization_endpoint: `${appOrigin}/oauth/authorize`,
    token_endpoint: `${appOrigin}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["bfb:read", "bfb:task:write"],
  });
}

export function handleProtectedResourceMetadata(appOrigin: string): Response {
  return json({
    resource: MCP_RESOURCE,
    authorization_servers: [appOrigin],
    scopes_supported: ["bfb:read", "bfb:task:write"],
    bearer_methods_supported: ["header"],
  });
}

export async function handleOauthAuthorize(request: Request, deps: OAuthDeps): Promise<Response> {
  await ensureOauthCodeTable(deps.db);
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const method = url.searchParams.get("code_challenge_method") ?? "";
  const scope = url.searchParams.get("scope") ?? "bfb:read";
  const resource = url.searchParams.get("resource") ?? MCP_RESOURCE;
  const workspaceId = url.searchParams.get("workspace_id") ?? "";
  const projectId = url.searchParams.get("project_id") ?? undefined;
  const stepUpProofId = url.searchParams.get("step_up_proof_id") ?? "";

  if (method !== "S256" || !codeChallenge) {
    return json({ error: "invalid_request", message: "PKCE S256 required" }, 400);
  }
  if (resource !== MCP_RESOURCE) {
    return json({ error: "invalid_target", message: "resource mismatch" }, 400);
  }

  const client = (await deps.db
    .prepare(
      `SELECT client_id, redirect_uri, public_client FROM preregistered_oauth_clients WHERE client_id = ?`,
    )
    .get(clientId)) as
    { client_id: string; redirect_uri: string; public_client: number } | undefined;
  if (!client || client.public_client !== 1) {
    return json({ error: "invalid_client", message: "client not preregistered public" }, 400);
  }
  if (client.redirect_uri !== redirectUri) {
    return json({ error: "invalid_request", message: "redirect_uri must match exactly" }, 400);
  }

  const principal = await resolveBrowserPrincipal(deps.db, request, deps.now);
  if (!principal) {
    return json({ error: "login_required", message: "browser session required" }, 401);
  }
  if (!workspaceId || !stepUpProofId) {
    return json(
      { error: "invalid_request", message: "workspace_id and step_up_proof_id required" },
      400,
    );
  }

  const member = (await deps.db
    .prepare(
      `SELECT authorization_epoch FROM workspace_members WHERE workspace_id = ? AND human_id = ?`,
    )
    .get(workspaceId, principal.humanId)) as { authorization_epoch: number } | undefined;
  if (!member) {
    return json({ error: "access_denied", message: "not a workspace member" }, 403);
  }

  // Pre-validate step-up by issuing is already done by caller; store proof id for token exchange.
  const code = randomUlid() + randomUlid();
  const expiresAt = new Date(Date.parse(deps.now) + 120_000).toISOString();
  await deps.db
    .prepare(
      `INSERT INTO oauth_authorization_codes (
        code, client_id, redirect_uri, code_challenge, human_id, workspace_id, project_id,
        scopes_json, authorization_epoch, step_up_proof_id, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      code,
      clientId,
      redirectUri,
      codeChallenge,
      principal.humanId,
      workspaceId,
      projectId ?? null,
      JSON.stringify(scope.split(" ").filter(Boolean)),
      member.authorization_epoch,
      stepUpProofId,
      expiresAt,
    );

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) {
    redirect.searchParams.set("state", state);
  }
  return Response.redirect(redirect.toString(), 302);
}

export async function handleOauthToken(request: Request, deps: OAuthDeps): Promise<Response> {
  await ensureOauthCodeTable(deps.db);
  const contentType = request.headers.get("content-type") ?? "";
  let params: Record<string, string> = {};
  if (contentType.includes("application/json")) {
    params = (await request.json()) as Record<string, string>;
  } else {
    const form = await request.formData();
    for (const [key, value] of form.entries()) {
      params[key] = String(value);
    }
  }

  if (params.grant_type !== "authorization_code") {
    return json({ error: "unsupported_grant_type" }, 400);
  }
  const code = params.code ?? "";
  const redirectUri = params.redirect_uri ?? "";
  const clientId = params.client_id ?? "";
  const verifier = params.code_verifier ?? "";
  if (!code || !redirectUri || !clientId || !verifier) {
    return json({ error: "invalid_request" }, 400);
  }

  const row = (await deps.db
    .prepare(`SELECT * FROM oauth_authorization_codes WHERE code = ?`)
    .get(code)) as AuthCodeRow | undefined;
  if (!row || row.consumed_at) {
    return json({ error: "invalid_grant", message: "code invalid or consumed" }, 400);
  }
  if (Date.parse(row.expires_at) <= Date.parse(deps.now)) {
    return json({ error: "invalid_grant", message: "code expired" }, 400);
  }
  if (row.client_id !== clientId || row.redirect_uri !== redirectUri) {
    return json({ error: "invalid_grant", message: "client/redirect mismatch" }, 400);
  }
  if (pkceS256Challenge(verifier) !== row.code_challenge) {
    return json({ error: "invalid_grant", message: "pkce verification failed" }, 400);
  }

  // Conditional single-use consume with unique stamp (D1 batch has no mid-TX changes).
  const consumeStamp = `${deps.now}#${randomUlid()}`;
  await deps.db
    .prepare(
      `UPDATE oauth_authorization_codes SET consumed_at = ? WHERE code = ? AND consumed_at IS NULL`,
    )
    .run(consumeStamp, code);
  const after = (await deps.db
    .prepare(`SELECT consumed_at FROM oauth_authorization_codes WHERE code = ?`)
    .get(code)) as { consumed_at: string | null } | undefined;
  if (after?.consumed_at !== consumeStamp) {
    return json({ error: "invalid_grant", message: "code invalid or consumed" }, 400);
  }

  const scopes = JSON.parse(row.scopes_json) as string[];
  const expiresAt = new Date(Date.parse(deps.now) + 3600_000).toISOString();

  try {
    const { accessToken, delegationId } = await createDelegation(deps.db, {
      workspaceId: row.workspace_id,
      humanId: row.human_id,
      clientId: row.client_id,
      resource: MCP_RESOURCE,
      projectId: row.project_id ?? undefined,
      scopes,
      authorizationEpoch: row.authorization_epoch,
      expiresAt,
      now: deps.now,
      stepUpProofId: row.step_up_proof_id,
    });
    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: scopes.join(" "),
      delegation_id: delegationId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "token_failed";
    return json({ error: "invalid_grant", message }, 400);
  }
}

/** Test helper: issue a step-up proof for the current human to create a delegation. */
export async function issueDelegationStepUp(
  db: SqlDatabase,
  humanId: string,
  workspaceId: string,
  clientId: string,
  scopes: string[],
  authorizationEpoch: number,
  now: string,
  projectId?: string,
): Promise<string> {
  return issueStepUpProof(
    db,
    humanId,
    {
      action: "oauth.delegation.create",
      clientId,
      resource: MCP_RESOURCE,
      workspaceId,
      projectId,
      scopes,
      authorizationEpoch,
      expiresAt: new Date(Date.parse(now) + 300_000).toISOString(),
    },
    now,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
