// ABOUTME: Exercises the real mounted Control Worker routes for health, MCP, and auth.
// ABOUTME: Drives createControlApp with fixture DB so /mcp is not a frozen 501 stub.

import { describe, expect, it } from "vitest";

import { FIX, seedSyntheticWorkspace } from "../../../packages/domain/src/fixtures.js";
import { MCP_RESOURCE } from "../../../packages/domain/src/oauth.js";
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
  const context = openAuthTestContext();
  await seedSyntheticWorkspace(context.db);
  return context;
}

function appFor(context: AuthTestContext) {
  return createControlApp(validateControlEnv(env()), {
    db: context.db,
    now: "2026-08-07T12:00:00Z",
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

  it("serves tools/list on mounted /mcp without 501", async () => {
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
        body: JSON.stringify({ method: "tools/list" }),
      }),
      undefined,
      bindings,
    );
    expect(response.status).not.toBe(501);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tools: Array<{ name: string }> };
    expect(body.tools.length).toBe(7);
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
    const meta = await app.request("/.well-known/oauth-authorization-server", {}, bindings);
    expect(meta.status).toBe(200);
    const body = (await meta.json()) as { code_challenge_methods_supported: string[] };
    expect(body.code_challenge_methods_supported).toContain("S256");

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
  });

  it("completes OAuth code+PKCE and calls propose via MCP token", async () => {
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
        resource: MCP_RESOURCE,
        workspaceId: FIX.workspace,
        projectId: FIX.projectA,
        scopes: ["bfb:read", "bfb:task:write"],
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
    authorizeUrl.searchParams.set("scope", "bfb:read bfb:task:write");
    authorizeUrl.searchParams.set("resource", MCP_RESOURCE);
    authorizeUrl.searchParams.set("workspace_id", FIX.workspace);
    authorizeUrl.searchParams.set("project_id", FIX.projectA);
    authorizeUrl.searchParams.set("step_up_proof_id", proofId);
    authorizeUrl.searchParams.set("state", "xyz");

    const authorize = await app.request(
      new Request(authorizeUrl.toString(), { headers: { cookie } }),
      undefined,
      bindings,
    );
    expect(authorize.status).toBe(302);
    const location = authorize.headers.get("location");
    expect(location).toBeTruthy();
    const code = new URL(location!).searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await app.request(
      new Request("https://bfb.example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://127.0.0.1:9999/callback",
          client_id: FIX.client,
          code_verifier: verifier,
        }),
      }),
      undefined,
      bindings,
    );
    expect(token.status).toBe(200);
    const tokenBody = (await token.json()) as { access_token: string; expires_in: number };
    expect(tokenBody.access_token.startsWith("mcp_")).toBe(true);
    expect(tokenBody.expires_in).toBe(600);
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
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "bfb_propose_task",
            arguments: {
              request_id: "oauth-mcp-1",
              project_id: FIX.projectA,
              title: "OAuth proposed",
              priority: "P2",
            },
          },
        }),
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
  });
});
