// ABOUTME: Exercises the real mounted Control Worker routes for health, MCP, and auth.
// ABOUTME: Drives createControlApp with fixture DB so /mcp is not a frozen 501 stub.

import { afterEach, describe, expect, it, vi } from "vitest";

import { FIX, seedSyntheticWorkspace } from "../../../packages/domain/src/fixtures.js";
import { mcpResource } from "../../../packages/domain/src/oauth.js";
import { issueStepUpProof } from "../../../packages/domain/src/step-up.js";
import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createControlApp } from "../src/routes.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
  type AuthTestContext,
} from "./auth-helpers.js";

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

function env(db?: import("@bfb/db").SqlDatabase): ControlBindings {
  return {
    DB: fakeBinding<D1Database>("db"),
    ARTIFACTS: fakeBinding<R2Bucket>("r2"),
    ASSETS: fakeBinding<Fetcher>("assets"),
    JOBS: fakeBinding<Queue>("jobs"),
    JOBS_DLQ: fakeBinding<Queue>("dlq"),
    WORKSPACE_HUB: db
      ? createTestWorkspaceHubNamespace(db)
      : fakeBinding<DurableObjectNamespace>("hub"),
    APP_ORIGIN: "https://bfb.example.test",
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
}

async function openRouteContext(): Promise<AuthTestContext> {
  const context = openAuthTestContext("2026-08-07T12:00:00.000Z");
  await seedSyntheticWorkspace(context.db);
  return context;
}

afterEach(() => vi.useRealTimers());

function modernMcpRequest(method: string, name?: string, args: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...(name ? { name, arguments: args } : {}),
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "bfb-test", version: "1.0.0" },
      },
    },
  };
}

function appFor(context: AuthTestContext) {
  return createControlApp(validateControlEnv(env()), {
    db: context.db,
    now: "2026-08-07T12:00:00Z",
    abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
}

describe("control routes", () => {
  it("serves healthz with substrate metadata", async () => {
    const context = await openRouteContext();
    const app = appFor(context);
    const response = await app.request("/healthz", {}, env(context.db));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { package: string; environment: string };
    expect(body.package).toBe("F03");
    expect(body.environment).toBe("local");
  });

  it("requires delegated bearer auth even for tools/list", async () => {
    const context = await openRouteContext();
    const app = appFor(context);
    const bindings = env(context.db);
    const response = await app.request(
      new Request("https://bfb.example.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
          Host: "bfb.example.test",
        },
        body: JSON.stringify(modernMcpRequest("tools/list")),
      }),
      undefined,
      bindings,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("resolves a Better Auth human session", async () => {
    const context = await openRouteContext();
    const seeded = await seedAuthSession(context, {
      userId: "auth-owner-routes",
      sessionId: "auth-owner-routes-session",
      token: "auth-owner-routes-token",
      email: "owner@synthetic.test",
      name: "Synthetic Owner",
      humanId: FIX.owner,
    });
    const app = appFor(context);
    const bindings = env(context.db);

    const session = await app.request(
      new Request("https://bfb.example.test/auth/session", {
        headers: { cookie: seeded.cookie },
      }),
      undefined,
      bindings,
    );
    expect(session.status).toBe(200);
    const body = (await session.json()) as { authenticated: boolean; csrf_token?: string };
    expect(body.authenticated).toBe(true);
    expect(body.csrf_token?.length ?? 0).toBeGreaterThan(10);
  });

  it("publishes OAuth metadata and rejects cookie auth on /mcp", async () => {
    const context = await openRouteContext();
    const app = appFor(context);
    const bindings = env(context.db);
    const meta = await app.request("/.well-known/oauth-authorization-server/auth", {}, bindings);
    expect(meta.status).toBe(200);
    const body = (await meta.json()) as Record<string, unknown> & {
      code_challenge_methods_supported: string[];
    };
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body).toMatchObject({
      issuer: "https://bfb.example.test/auth",
      authorization_endpoint: "https://bfb.example.test/oauth/authorize",
      token_endpoint: "https://bfb.example.test/oauth/token",
      revocation_endpoint: "https://bfb.example.test/oauth/revoke",
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    expect(body).not.toHaveProperty("introspection_endpoint");
    expect(body).not.toHaveProperty("registration_endpoint");

    const resource = await app.request("/.well-known/oauth-protected-resource", {}, bindings);
    expect(await resource.json()).toMatchObject({
      resource: "https://bfb.example.test/mcp",
      authorization_servers: ["https://bfb.example.test/auth"],
      bearer_methods_supported: ["header"],
    });

    const cookieMcp = await app.request(
      new Request("https://bfb.example.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
          Host: "bfb.example.test",
          cookie: "__Host-bfb_session=synthetic",
        },
        body: JSON.stringify({ method: "tools/list" }),
      }),
      undefined,
      bindings,
    );
    expect(cookieMcp.status).toBe(401);

    const bearerBrowser = await app.request(
      new Request("https://bfb.example.test/auth/session", {
        headers: { authorization: "Bearer mcp_reserved-for-browser-route" },
      }),
      undefined,
      bindings,
    );
    expect(bearerBrowser.status).toBe(401);
    expect(await bearerBrowser.json()).toMatchObject({ error: "credential_confusion" });
  });

  it("renders a passkey boundary checkpoint before OAuth consent", async () => {
    const context = await openRouteContext();
    const app = appFor(context);
    const bindings = env(context.db);
    const authorize = oauthAuthorizeUrl("not-present-yet", "browser-checkpoint");
    authorize.searchParams.delete("workspace_id");
    authorize.searchParams.delete("project_id");
    authorize.searchParams.delete("step_up_proof_id");

    const page = await app.request(new Request(authorize), undefined, bindings);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await page.text();
    expect(html).toContain("Choose what Synthetic MCP Client can touch");
    expect(html).toContain("/oauth/authorize.js");
    expect(html).not.toContain("browser-checkpoint");

    const script = await app.request("/oauth/authorize.js", {}, bindings);
    expect(script.status).toBe(200);
    expect(await script.text()).toContain('action: "oauth.delegation.create"');
    expect((await app.request("/oauth/authorize.css", {}, bindings)).status).toBe(200);
  });

  it("completes OAuth code+PKCE and calls propose via MCP token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));
    const context = await openRouteContext();
    const db = context.db;
    const now = "2026-08-07T12:00:00Z";
    const seeded = await seedAuthSession(context, {
      userId: "auth-owner-oauth",
      sessionId: "auth-owner-oauth-session",
      token: "auth-owner-oauth-token",
      email: "owner@synthetic.test",
      name: "Synthetic Owner",
      humanId: FIX.owner,
      now,
      expiresAt: "2026-08-07T13:00:00.000Z",
    });
    const app = appFor(context);
    const bindings = env(db);
    const cookie = seeded.cookie;

    const proofId = await issueStepUpProof(
      db,
      FIX.owner,
      {
        action: "oauth.delegation.create",
        clientId: FIX.client,
        resource: mcpResource(AUTH_TEST_ENV.APP_ORIGIN),
        workspaceId: FIX.workspace,
        projectId: FIX.projectA,
        scopes: ["bfb:read", "bfb:task:write", "offline_access"],
        authorizationEpoch: 1,
        expiresAt: "2026-08-07T12:10:00Z",
      },
      now,
    );

    // PKCE
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    // Precomputed S256 for the RFC example verifier
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    const authorizeUrl = new URL("https://bfb.example.test/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", FIX.client);
    authorizeUrl.searchParams.set("redirect_uri", "http://127.0.0.1:9999/callback");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "bfb:read bfb:task:write offline_access");
    authorizeUrl.searchParams.set("resource", mcpResource(AUTH_TEST_ENV.APP_ORIGIN));
    authorizeUrl.searchParams.set("workspace_id", FIX.workspace);
    authorizeUrl.searchParams.set("project_id", FIX.projectA);
    authorizeUrl.searchParams.set("step_up_proof_id", proofId);
    authorizeUrl.searchParams.set("state", "xyz");

    const authorize = await app.request(
      new Request(authorizeUrl.toString(), { headers: { cookie } }),
      undefined,
      bindings,
    );
    expect(authorize.status, await authorize.clone().text()).toBe(302);
    const consentLocation = authorize.headers.get("location");
    expect(consentLocation).toContain("/oauth/consent?");

    const consentPage = await app.request(
      new Request(new URL(consentLocation!, AUTH_TEST_ENV.APP_ORIGIN), { headers: { cookie } }),
      undefined,
      bindings,
    );
    expect(consentPage.status).toBe(200);
    expect(await consentPage.text()).toContain("Authorize Synthetic MCP Client");
    expect(consentPage.headers.get("content-security-policy")).toContain(
      "form-action 'self' http://127.0.0.1:9999",
    );

    const consentQuery = new URL(
      consentLocation!,
      AUTH_TEST_ENV.APP_ORIGIN,
    ).searchParams.toString();
    const consent = await app.request(
      new Request("https://bfb.example.test/oauth/consent", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/x-www-form-urlencoded",
          origin: AUTH_TEST_ENV.APP_ORIGIN,
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({
          accept: "true",
          scope: "bfb:read bfb:task:write offline_access",
          oauth_query: consentQuery,
        }),
      }),
      undefined,
      bindings,
    );
    expect(consent.status, await consent.clone().text()).toBe(302);
    const location = consent.headers.get("location");
    expect(location).toContain("iss=");
    const code = new URL(location!).searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await app.request(
      new Request("https://bfb.example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: "http://127.0.0.1:9999/callback",
          client_id: FIX.client,
          code_verifier: verifier,
          resource: mcpResource(AUTH_TEST_ENV.APP_ORIGIN),
        }),
      }),
      undefined,
      bindings,
    );
    expect(token.status).toBe(200);
    const tokenBody = (await token.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token: string;
    };
    expect(tokenBody.access_token.startsWith("mcp_")).toBe(true);
    expect(tokenBody.refresh_token.startsWith("mcp_refresh_")).toBe(true);
    expect(tokenBody.expires_in).toBe(300);
    expect(
      (
        (await db
          .prepare(`SELECT expires_at FROM oauth_delegations WHERE workspace_id = ?`)
          .get(FIX.workspace)) as { expires_at: string }
      ).expires_at,
    ).toBe("2026-08-07T12:10:00Z");

    const propose = await app.request(
      new Request("https://bfb.example.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "bfb_propose_task",
          Host: "bfb.example.test",
          authorization: "Bearer " + tokenBody.access_token,
        },
        body: JSON.stringify(
          modernMcpRequest("tools/call", "bfb_propose_task", {
            request_id: "oauth-mcp-1",
            project_id: FIX.projectA,
            title: "OAuth proposed",
            priority: "P2",
          }),
        ),
      }),
      undefined,
      bindings,
    );
    expect(propose.status).not.toBe(501);
    expect([200, 202]).toContain(propose.status);
    const proposeBody = (await propose.json()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const text = proposeBody.result?.content?.[0]?.text ?? JSON.stringify(proposeBody);
    const parsed = JSON.parse(text) as {
      ok: boolean;
      result: { state: string; title: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.result.state).toBe("proposed");
    expect(parsed.result.title).toBe("OAuth proposed");

    const refreshed = await app.request(
      new Request("https://bfb.example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: FIX.client,
          refresh_token: tokenBody.refresh_token,
          resource: mcpResource(AUTH_TEST_ENV.APP_ORIGIN),
        }),
      }),
      undefined,
      bindings,
    );
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const refreshedBody = (await refreshed.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(refreshedBody.access_token).not.toBe(tokenBody.access_token);
    expect(refreshedBody.refresh_token).not.toBe(tokenBody.refresh_token);
    expect((await mcpList(app, bindings, refreshedBody.access_token)).status).toBe(200);

    const revoked = await app.request(
      new Request("https://bfb.example.test/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: FIX.client,
          token: refreshedBody.access_token,
          token_type_hint: "access_token",
        }),
      }),
      undefined,
      bindings,
    );
    expect(revoked.status).toBe(200);
    expect((await mcpList(app, bindings, refreshedBody.access_token)).status).toBe(401);

    const replay = await app.request(
      new Request("https://bfb.example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: FIX.client,
          refresh_token: tokenBody.refresh_token,
          resource: mcpResource(AUTH_TEST_ENV.APP_ORIGIN),
        }),
      }),
      undefined,
      bindings,
    );
    expect(replay.status).toBe(400);
    expect((await replay.json()) as Record<string, unknown>).toMatchObject({
      error: "invalid_grant",
    });
    expect((await mcpList(app, bindings, refreshedBody.access_token)).status).toBe(401);
  });

  it("rejects malformed, stolen, replayed, and denied delegation grants", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));
    const context = await openRouteContext();
    const owner = await seedAuthSession(context, {
      userId: "auth-owner-negatives",
      sessionId: "auth-owner-negatives-session",
      token: "auth-owner-negatives-token",
      email: "owner-negatives@synthetic.test",
      name: "Synthetic Owner",
      humanId: FIX.owner,
      now: "2026-08-07T12:00:00Z",
      expiresAt: "2026-08-07T13:00:00.000Z",
    });
    const member = await seedAuthSession(context, {
      userId: "auth-member-negatives",
      sessionId: "auth-member-negatives-session",
      token: "auth-member-negatives-token",
      email: "member-negatives@synthetic.test",
      name: "Synthetic Member",
      humanId: FIX.member,
      now: "2026-08-07T12:00:00Z",
      expiresAt: "2026-08-07T13:00:00.000Z",
    });
    const proofId = await issueOauthProof(context.db);
    const app = appFor(context);
    const bindings = env(context.db);

    const missingState = oauthAuthorizeUrl(proofId, "missing-state");
    missingState.searchParams.delete("state");
    expect(
      (
        await app.request(
          new Request(missingState, { headers: { cookie: owner.cookie } }),
          undefined,
          bindings,
        )
      ).status,
    ).toBe(400);

    const shortPkce = oauthAuthorizeUrl(proofId, "short-pkce");
    shortPkce.searchParams.set("code_challenge", "short");
    expect(
      (
        await app.request(
          new Request(shortPkce, { headers: { cookie: owner.cookie } }),
          undefined,
          bindings,
        )
      ).status,
    ).toBe(400);

    const wrongRedirect = oauthAuthorizeUrl(proofId, "wrong-redirect");
    wrongRedirect.searchParams.set("redirect_uri", "http://127.0.0.1:9999/callback/extra");
    expect(
      (
        await app.request(
          new Request(wrongRedirect, { headers: { cookie: owner.cookie } }),
          undefined,
          bindings,
        )
      ).status,
    ).toBe(400);

    const stolen = await app.request(
      new Request(oauthAuthorizeUrl(proofId, "stolen-cookie"), {
        headers: { cookie: member.cookie },
      }),
      undefined,
      bindings,
    );
    expect(stolen.status).toBe(403);

    const authorize = await app.request(
      new Request(oauthAuthorizeUrl(proofId, "deny-this"), {
        headers: { cookie: owner.cookie },
      }),
      undefined,
      bindings,
    );
    expect(authorize.status).toBe(302);
    const consentLocation = authorize.headers.get("location");
    expect(consentLocation).toBeTruthy();
    const denial = await app.request(
      new Request("https://bfb.example.test/oauth/consent", {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/x-www-form-urlencoded",
          origin: AUTH_TEST_ENV.APP_ORIGIN,
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({
          accept: "false",
          scope: "bfb:read bfb:task:write offline_access",
          oauth_query: new URL(consentLocation!, AUTH_TEST_ENV.APP_ORIGIN).searchParams.toString(),
        }),
      }),
      undefined,
      bindings,
    );
    expect(denial.status).toBe(302);
    expect(
      await context.db.prepare(`SELECT COUNT(*) AS count FROM oauth_delegations`).get(),
    ).toEqual({ count: 0 });
    const deniedReplay = await app.request(
      new Request("https://bfb.example.test/oauth/consent", {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/x-www-form-urlencoded",
          origin: AUTH_TEST_ENV.APP_ORIGIN,
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({
          accept: "true",
          scope: "bfb:read bfb:task:write offline_access",
          oauth_query: new URL(consentLocation!, AUTH_TEST_ENV.APP_ORIGIN).searchParams.toString(),
        }),
      }),
      undefined,
      bindings,
    );
    expect(deniedReplay.status).toBe(403);
    expect(
      await context.db.prepare(`SELECT COUNT(*) AS count FROM oauth_delegations`).get(),
    ).toEqual({ count: 0 });

    const duplicate = oauthAuthorizeUrl(await issueOauthProof(context.db), "duplicate-parameter");
    duplicate.searchParams.append("resource", mcpResource(AUTH_TEST_ENV.APP_ORIGIN));
    expect(
      (
        await app.request(
          new Request(duplicate, { headers: { cookie: owner.cookie } }),
          undefined,
          bindings,
        )
      ).status,
    ).toBe(400);

    const malformedScopeProof = await issueOauthProof(context.db);
    const malformedScopeAuthorize = await app.request(
      new Request(oauthAuthorizeUrl(malformedScopeProof, "malformed-consent-scope"), {
        headers: { cookie: owner.cookie },
      }),
      undefined,
      bindings,
    );
    const malformedScopeLocation = malformedScopeAuthorize.headers.get("location");
    expect(malformedScopeLocation).toBeTruthy();
    const malformedScopeConsent = await app.request(
      new Request("https://bfb.example.test/oauth/consent", {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "content-type": "application/x-www-form-urlencoded",
          origin: AUTH_TEST_ENV.APP_ORIGIN,
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({
          accept: "true",
          scope: "bfb:read bfb:read offline_access",
          oauth_query: new URL(
            malformedScopeLocation!,
            AUTH_TEST_ENV.APP_ORIGIN,
          ).searchParams.toString(),
        }),
      }),
      undefined,
      bindings,
    );
    expect(malformedScopeConsent.status).toBe(403);
    expect(
      await context.db
        .prepare(`SELECT consent_decision FROM oauth_delegation_grants WHERE step_up_proof_id = ?`)
        .get(malformedScopeProof),
    ).toEqual({ consent_decision: null });

    const replay = await app.request(
      new Request(oauthAuthorizeUrl(proofId, "replayed-proof"), {
        headers: { cookie: owner.cookie },
      }),
      undefined,
      bindings,
    );
    expect(replay.status).toBe(403);

    const clientCredentials = await app.request(
      new Request("https://bfb.example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: FIX.client,
          resource: mcpResource(AUTH_TEST_ENV.APP_ORIGIN),
        }),
      }),
      undefined,
      bindings,
    );
    expect(clientCredentials.status).toBe(400);

    const duplicateToken = new URLSearchParams({
      grant_type: "authorization_code",
      code: "not-a-code",
      redirect_uri: "http://127.0.0.1:9999/callback",
      client_id: FIX.client,
      code_verifier: "x".repeat(43),
      resource: mcpResource(AUTH_TEST_ENV.APP_ORIGIN),
    });
    duplicateToken.append("client_id", FIX.client);
    expect(
      (
        await app.request(
          new Request("https://bfb.example.test/oauth/token", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: duplicateToken,
          }),
          undefined,
          bindings,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          new Request("https://bfb.example.test/oauth/token", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
          undefined,
          bindings,
        )
      ).status,
    ).toBe(400);

    for (const path of [
      "/auth/oauth2/register",
      "/auth/oauth2/create-client",
      "/auth/oauth2/get-clients",
      "/auth/oauth2/introspect",
    ]) {
      const disabled = await app.request(
        new Request(`https://bfb.example.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: owner.cookie },
          body: "{}",
        }),
        undefined,
        bindings,
      );
      expect(disabled.status, path).toBe(404);
    }
  });
});

async function issueOauthProof(db: import("@bfb/db").SqlDatabase): Promise<string> {
  return issueStepUpProof(
    db,
    FIX.owner,
    {
      action: "oauth.delegation.create",
      clientId: FIX.client,
      resource: mcpResource(AUTH_TEST_ENV.APP_ORIGIN),
      workspaceId: FIX.workspace,
      projectId: FIX.projectA,
      scopes: ["bfb:read", "bfb:task:write", "offline_access"],
      authorizationEpoch: 1,
      expiresAt: "2026-08-07T12:10:00Z",
    },
    "2026-08-07T12:00:00Z",
  );
}

function oauthAuthorizeUrl(proofId: string, state: string): URL {
  const url = new URL("https://bfb.example.test/oauth/authorize");
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: FIX.client,
    redirect_uri: "http://127.0.0.1:9999/callback",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    scope: "bfb:read bfb:task:write offline_access",
    resource: mcpResource(AUTH_TEST_ENV.APP_ORIGIN),
    workspace_id: FIX.workspace,
    project_id: FIX.projectA,
    step_up_proof_id: proofId,
    state,
  })) {
    url.searchParams.set(key, value);
  }
  return url;
}

function mcpList(
  app: ReturnType<typeof createControlApp>,
  bindings: ControlBindings,
  accessToken: string,
): Promise<Response> {
  return app.request(
    new Request("https://bfb.example.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
        Host: "bfb.example.test",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(modernMcpRequest("tools/list")),
    }),
    undefined,
    bindings,
  );
}
