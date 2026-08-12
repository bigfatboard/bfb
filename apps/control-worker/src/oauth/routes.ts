// ABOUTME: Couples the pinned Better Auth OAuth Provider to BFB step-up delegation grants.
// ABOUTME: OAuth protocol mechanics stay provider-owned while BFB owns workspace authority.

import { createHmac } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";
import {
  abuseBucketKey,
  activateDelegationGrant,
  bindProviderAccessToken,
  consumeAbuseBudget,
  decideDelegationGrant,
  mcpResource,
  prepareDelegationGrant,
  revokeProviderTokenDelegation,
} from "@bfb/domain";

import type { HumanAuth } from "../auth/better-auth.js";
import { assertBrowserMutation, resolveBrowserPrincipal } from "../auth/session.js";
import { oauthAuthorizationPage } from "./authorization-page.js";

export interface OAuthDeps {
  db: SqlDatabase;
  auth: HumanAuth;
  appOrigin: string;
  abuseSecret: string;
  now: string;
}

const BODY_LIMIT = 16_384;
const STATE_LIMIT = 512;
const OAUTH_WINDOW_SECONDS = 300;
const OAUTH_POLICY = {
  attemptLimit: 30,
  pollLimit: 30,
  windowSeconds: OAUTH_WINDOW_SECONDS,
  maxBodyBytes: BODY_LIMIT,
} as const;

export async function handleOauthMetadata(request: Request, deps: OAuthDeps): Promise<Response> {
  const response = await deps.auth.handler(
    internalRequest(request, deps.appOrigin, "/auth/.well-known/oauth-authorization-server"),
  );
  if (!response.ok) {
    return response;
  }
  const provider = (await response.json()) as Record<string, unknown>;
  delete provider.introspection_endpoint;
  delete provider.introspection_endpoint_auth_methods_supported;
  delete provider.registration_endpoint;
  return Response.json({
    ...provider,
    authorization_endpoint: `${deps.appOrigin}/oauth/authorize`,
    token_endpoint: `${deps.appOrigin}/oauth/token`,
    revocation_endpoint: `${deps.appOrigin}/oauth/revoke`,
    registration_endpoint: undefined,
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
  });
}

export function handleProtectedResourceMetadata(appOrigin: string): Response {
  return Response.json({
    resource: mcpResource(appOrigin),
    authorization_servers: [`${appOrigin}/auth`],
    scopes_supported: ["bfb:read", "bfb:task:write", "offline_access"],
    bearer_methods_supported: ["header"],
  });
}

export async function handleOauthAuthorize(request: Request, deps: OAuthDeps): Promise<Response> {
  if (!(await consumeOauthBudget(request, deps, "authorize", 0))) {
    return rejected();
  }
  const url = new URL(request.url);
  if (
    singleParam(url.searchParams, "response_type") !== "code" ||
    singleParam(url.searchParams, "code_challenge_method") !== "S256" ||
    !validPkceChallenge(singleParam(url.searchParams, "code_challenge")) ||
    !bounded(singleParam(url.searchParams, "state"), STATE_LIMIT)
  ) {
    return oauthError("invalid_request", "code, PKCE S256, and state are required");
  }
  const principal = await resolveBrowserPrincipal(deps.db, deps.auth, request, deps.now);
  const resource = singleParam(url.searchParams, "resource");
  const clientId = singleParam(url.searchParams, "client_id");
  const scopes = normalizeScopes(singleParam(url.searchParams, "scope"));
  const redirectUri = singleParam(url.searchParams, "redirect_uri");
  if (resource !== mcpResource(deps.appOrigin) || !clientId || !scopes || !redirectUri) {
    return oauthError("invalid_request", "resource and scopes are required");
  }
  const client = (await deps.db
    .prepare(
      `SELECT name, redirect_uris FROM better_auth_oauth_clients
       WHERE client_id = ? AND disabled = 0 AND public = 1`,
    )
    .get(clientId)) as { name: string | null; redirect_uris: string } | undefined;
  if (!client || !parseStringArray(client.redirect_uris).includes(redirectUri)) {
    return oauthError("invalid_redirect", "redirect_uri must match exactly");
  }
  const workspaceId = optionalSingleParam(url.searchParams, "workspace_id");
  const projectId = optionalSingleParam(url.searchParams, "project_id");
  const taskId = optionalSingleParam(url.searchParams, "task_id");
  const stepUpProofId = optionalSingleParam(url.searchParams, "step_up_proof_id");
  const providerLabel = optionalSingleParam(url.searchParams, "provider_label");
  if ([workspaceId, projectId, taskId, stepUpProofId, providerLabel].includes(null)) {
    return oauthError("invalid_request", "OAuth parameters must not be repeated");
  }
  if (!principal || !workspaceId || !stepUpProofId) {
    return oauthAuthorizationPage(client.name ?? clientId, scopes);
  }
  const member = (await deps.db
    .prepare(
      `SELECT authorization_epoch FROM workspace_members
       WHERE workspace_id = ? AND human_id = ?`,
    )
    .get(workspaceId, principal.humanId)) as { authorization_epoch: number } | undefined;
  if (!member) {
    return oauthError("access_denied", "workspace membership required", 403);
  }
  try {
    await prepareDelegationGrant(deps.db, {
      humanId: principal.humanId,
      authUserId: principal.authUserId,
      sessionId: principal.sessionId,
      clientId,
      state: singleParam(url.searchParams, "state")!,
      resource,
      workspaceId,
      projectId: projectId ?? undefined,
      taskId: taskId ?? undefined,
      scopes,
      authorizationEpoch: member.authorization_epoch,
      stepUpProofId,
      providerLabel: providerLabel ?? undefined,
      now: deps.now,
    });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "access_denied";
    return oauthError(code, "delegation grant rejected", 403);
  }
  return deps.auth.handler(internalRequest(request, deps.appOrigin, "/auth/oauth2/authorize"));
}

export async function handleOauthConsentPage(request: Request, deps: OAuthDeps): Promise<Response> {
  if (!(await consumeOauthBudget(request, deps, "consent-view", 0))) {
    return rejected();
  }
  const principal = await resolveBrowserPrincipal(deps.db, deps.auth, request, deps.now);
  const oauthQuery = new URL(request.url).searchParams.toString();
  const state = signedQueryValue(oauthQuery, "state");
  if (!principal || !state) {
    return oauthError("invalid_request", "signed OAuth state and browser session required", 403);
  }
  const grant = (await deps.db
    .prepare(
      `SELECT grant.auth_user_id, grant.session_id, grant.resource, grant.workspace_id,
              grant.project_id, grant.task_id, grant.scopes_json, grant.provider_label,
              grant.expires_at, grant.consumed_at, grant.consent_decision,
              client.name AS client_name,
              client.redirect_uris,
              project.name AS project_name, task.title AS task_title
       FROM oauth_delegation_grants AS grant
       JOIN better_auth_oauth_clients AS client ON client.client_id = grant.client_id
       LEFT JOIN projects AS project
         ON project.workspace_id = grant.workspace_id AND project.id = grant.project_id
       LEFT JOIN tasks AS task
         ON task.workspace_id = grant.workspace_id AND task.id = grant.task_id
       WHERE grant.state = ?`,
    )
    .get(state)) as
    | {
        auth_user_id: string;
        session_id: string;
        resource: string;
        workspace_id: string;
        project_id: string | null;
        task_id: string | null;
        scopes_json: string;
        provider_label: string | null;
        expires_at: string;
        consumed_at: string | null;
        consent_decision: "accepted" | "denied" | null;
        client_name: string;
        redirect_uris: string;
        project_name: string | null;
        task_title: string | null;
      }
    | undefined;
  if (
    !grant ||
    grant.auth_user_id !== principal.authUserId ||
    grant.session_id !== principal.sessionId ||
    grant.consumed_at !== null ||
    grant.consent_decision !== null ||
    Date.parse(grant.expires_at) <= Date.parse(deps.now)
  ) {
    return oauthError("access_denied", "delegation consent no longer valid", 403);
  }
  const scopes = parseStringArray(grant.scopes_json);
  const redirectUri = signedQueryValue(oauthQuery, "redirect_uri");
  if (!redirectUri || !parseStringArray(grant.redirect_uris).includes(redirectUri)) {
    return oauthError("invalid_redirect", "signed redirect no longer registered", 400);
  }
  const redirectOrigin = new URL(redirectUri).origin;
  const boundary = grant.task_title ?? grant.project_name ?? grant.workspace_id;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Authorize BFB MCP</title></head>
<body><main><h1>Authorize ${escapeHtml(grant.client_name)}</h1>
<p>${escapeHtml(grant.provider_label ?? "Remote MCP client")} will act through your BFB account.</p>
<dl><dt>Boundary</dt><dd>${escapeHtml(boundary)}</dd><dt>Resource</dt><dd>${escapeHtml(grant.resource)}</dd><dt>Scopes</dt><dd>${escapeHtml(scopes.join(", "))}</dd></dl>
<form method="post" action="/oauth/consent">
<input type="hidden" name="oauth_query" value="${escapeHtml(oauthQuery)}">
<input type="hidden" name="scope" value="${escapeHtml(scopes.join(" "))}">
<button type="submit" name="accept" value="true">Authorize</button>
<button type="submit" name="accept" value="false">Deny</button>
</form></main></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; base-uri 'none'; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
    },
  });
}

export async function handleOauthConsent(request: Request, deps: OAuthDeps): Promise<Response> {
  if (!hasFormContentType(request)) {
    return oauthError("invalid_request", "form-encoded consent is required");
  }
  const body = await boundedBody(request);
  if (body === null) {
    return oauthError("invalid_request", "request body too large");
  }
  if (
    !(await consumeOauthBudget(request, deps, "consent", new TextEncoder().encode(body).length))
  ) {
    return rejected();
  }
  const params = new URLSearchParams(body);
  if (hasRepeated(params, ["oauth_query", "scope", "accept"])) {
    return oauthError("invalid_request", "consent parameters must not be repeated");
  }
  const state = signedQueryValue(params.get("oauth_query"), "state");
  const principal = await resolveBrowserPrincipal(deps.db, deps.auth, request, deps.now);
  if (!principal || !state) {
    return oauthError("invalid_request", "signed OAuth state and browser session required", 403);
  }
  try {
    assertBrowserMutation(request, deps.appOrigin);
  } catch (error) {
    const reason = error instanceof Error && "code" in error ? String(error.code) : "csrf_rejected";
    return oauthError("access_denied", `same-origin consent required: ${reason}`, 403);
  }
  const grant = (await deps.db
    .prepare(
      `SELECT id, auth_user_id, session_id, scopes_json, expires_at, consumed_at
       FROM oauth_delegation_grants WHERE state = ?`,
    )
    .get(state)) as
    | {
        id: string;
        auth_user_id: string;
        session_id: string;
        scopes_json: string;
        expires_at: string;
        consumed_at: string | null;
      }
    | undefined;
  const acceptedScopes = normalizeScopes(params.get("scope"));
  const approvedScopes = grant ? (JSON.parse(grant.scopes_json) as string[]) : [];
  if (
    !grant ||
    !acceptedScopes ||
    grant.auth_user_id !== principal.authUserId ||
    grant.session_id !== principal.sessionId ||
    Date.parse(grant.expires_at) <= Date.parse(deps.now) ||
    JSON.stringify(acceptedScopes) !== JSON.stringify([...approvedScopes].sort())
  ) {
    return oauthError("access_denied", "delegation consent no longer valid", 403);
  }
  const next = new URLSearchParams(body);
  next.set("scope", acceptedScopes.join(" "));
  const accepted = params.get("accept");
  if (accepted !== "true" && accepted !== "false") {
    return oauthError("invalid_request", "consent decision required");
  }
  const response = await deps.auth.handler(
    internalRequest(
      request,
      deps.appOrigin,
      "/auth/oauth2/consent",
      JSON.stringify({
        accept: accepted === "true",
        scope: next.get("scope"),
        oauth_query: next.get("oauth_query"),
      }),
      "application/json",
    ),
  );
  if (!response.ok) {
    return browserRedirect(response);
  }
  try {
    await decideDelegationGrant(deps.db, {
      grantId: grant.id,
      authUserId: principal.authUserId,
      sessionId: principal.sessionId,
      decision: accepted === "true" ? "accepted" : "denied",
      now: deps.now,
    });
  } catch {
    return oauthError("access_denied", "consent was already decided", 403);
  }
  if (accepted === "true" && response.ok) {
    try {
      await activateDelegationGrant(
        deps.db,
        grant.id,
        principal.authUserId,
        acceptedScopes,
        deps.now,
      );
    } catch {
      return oauthError("access_denied", "delegation activation rejected", 403);
    }
  }
  return browserRedirect(response);
}

export async function handleOauthToken(request: Request, deps: OAuthDeps): Promise<Response> {
  if (!hasFormContentType(request)) {
    return oauthError("invalid_request", "form-encoded token request is required");
  }
  const body = await boundedBody(request);
  if (!body) {
    return oauthError("invalid_request", "request body too large");
  }
  if (!(await consumeOauthBudget(request, deps, "token", new TextEncoder().encode(body).length))) {
    return rejected();
  }
  const params = new URLSearchParams(body);
  if (
    hasRepeated(params, [
      "grant_type",
      "code",
      "redirect_uri",
      "client_id",
      "code_verifier",
      "refresh_token",
      "resource",
    ])
  ) {
    return oauthError("invalid_request", "token parameters must not be repeated");
  }
  if (params.get("resource") !== mcpResource(deps.appOrigin)) {
    return oauthError("invalid_target", "resource is required and must match");
  }
  if (!validVerifierForGrant(params)) {
    return oauthError("invalid_request", "PKCE verifier is invalid");
  }
  const response = await deps.auth.handler(
    internalRequest(request, deps.appOrigin, "/auth/oauth2/token", body),
  );
  if (!response.ok) {
    return response;
  }
  const payload = (await response.clone().json()) as Record<string, unknown>;
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : undefined;
  if (!accessToken) {
    return oauthError("server_error", "provider returned no access token", 500);
  }
  try {
    await bindProviderAccessToken(deps.db, accessToken, deps.now);
  } catch {
    return oauthError("invalid_grant", "OAuth token has no active BFB delegation", 400);
  }
  return response;
}

export async function handleOauthRevoke(request: Request, deps: OAuthDeps): Promise<Response> {
  if (!hasFormContentType(request)) {
    return oauthError("invalid_request", "form-encoded revocation is required");
  }
  const body = await boundedBody(request);
  if (!body) {
    return oauthError("invalid_request", "request body too large");
  }
  if (!(await consumeOauthBudget(request, deps, "revoke", new TextEncoder().encode(body).length))) {
    return rejected();
  }
  const params = new URLSearchParams(body);
  if (hasRepeated(params, ["token", "client_id", "token_type_hint"])) {
    return oauthError("invalid_request", "revocation parameters must not be repeated");
  }
  const token = params.get("token");
  const clientId = params.get("client_id");
  if (token && clientId) {
    await revokeProviderTokenDelegation(deps.db, token, clientId, deps.now);
  }
  return deps.auth.handler(internalRequest(request, deps.appOrigin, "/auth/oauth2/revoke", body));
}

function internalRequest(
  request: Request,
  appOrigin: string,
  path: string,
  body?: string,
  contentType?: string,
): Request {
  const target = new URL(path, appOrigin);
  target.search = new URL(request.url).search;
  const headers = new Headers(request.headers);
  if (contentType) {
    headers.set("content-type", contentType);
    headers.set("origin", appOrigin);
    headers.set("sec-fetch-site", "same-origin");
  }
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (body !== undefined) {
    init.body = body;
  }
  return new Request(target, init);
}

async function browserRedirect(response: Response): Promise<Response> {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    return response;
  }
  const payload = (await response.clone().json()) as { redirect?: unknown; url?: unknown };
  if (payload.redirect !== true || typeof payload.url !== "string") {
    return response;
  }
  try {
    const location = new URL(payload.url).toString();
    return new Response(null, {
      status: 302,
      headers: { location, "cache-control": "no-store" },
    });
  } catch {
    return oauthError("server_error", "provider returned an invalid redirect", 500);
  }
}

async function boundedBody(request: Request): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > BODY_LIMIT)) {
    return null;
  }
  const body = await request.clone().text();
  return new TextEncoder().encode(body).byteLength <= BODY_LIMIT ? body : null;
}

async function consumeOauthBudget(
  request: Request,
  deps: OAuthDeps,
  surface: string,
  bodyBytes: number,
): Promise<boolean> {
  const nowMs = Date.parse(deps.now);
  if (!Number.isFinite(nowMs) || deps.abuseSecret.length < 32) {
    return false;
  }
  const ip = (request.headers.get("cf-connecting-ip") ?? "unavailable").slice(0, 64);
  const ipHashSeed = createHmac("sha256", deps.abuseSecret)
    .update(`bfb-oauth-ip:${ip}`)
    .digest("hex");
  try {
    const decision = await consumeAbuseBudget(
      deps.db,
      {
        bucketKey: abuseBucketKey({
          ipHashSeed,
          subject: surface,
          surface: "remote-oauth",
        }),
        activity: "attempt",
        bodyBytes,
        now: deps.now,
        expiresAt: new Date(nowMs + OAUTH_WINDOW_SECONDS * 1000).toISOString(),
      },
      OAUTH_POLICY,
    );
    return decision.allowed;
  } catch {
    return false;
  }
}

function validPkceChallenge(value: string | null): boolean {
  return value !== null && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function validVerifierForGrant(params: URLSearchParams): boolean {
  if (params.get("grant_type") !== "authorization_code") {
    return true;
  }
  const verifier = params.get("code_verifier");
  return verifier !== null && /^[A-Za-z0-9._~-]{43,128}$/u.test(verifier);
}

function normalizeScopes(value: string | null): string[] | null {
  if (!value) {
    return null;
  }
  const scopes = value.split(" ").filter(Boolean).sort();
  return scopes.length > 0 && new Set(scopes).size === scopes.length ? scopes : null;
}

function singleParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0]! : null;
}

function optionalSingleParam(params: URLSearchParams, name: string): string | null | undefined {
  const values = params.getAll(name);
  return values.length > 1 ? null : values[0];
}

function hasRepeated(params: URLSearchParams, names: readonly string[]): boolean {
  return names.some((name) => params.getAll(name).length > 1);
}

function hasFormContentType(request: Request): boolean {
  return (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/x-www-form-urlencoded"
  );
}

function signedQueryValue(oauthQuery: string | null, key: string): string | null {
  if (!oauthQuery) {
    return null;
  }
  const query = new URLSearchParams(oauthQuery);
  const signedNames = new Set(query.getAll("ba_param"));
  return signedNames.has(key) ? query.get(key) : null;
}

function bounded(value: string | null, limit: number): boolean {
  return value !== null && value.length > 0 && value.length <= limit;
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function oauthError(error: string, errorDescription: string, status = 400): Response {
  return Response.json({ error, error_description: errorDescription }, { status });
}

function rejected(): Response {
  return Response.json({ error: "request_rejected", message: "request rejected" }, { status: 429 });
}
