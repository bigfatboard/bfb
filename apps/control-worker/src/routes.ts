// ABOUTME: Defines Control Worker routes for health, auth, OAuth, work APIs, and MCP dispatch.
// ABOUTME: Browser sessions and MCP tokens are separated; domain commands own mutations.

import { Hono } from "hono";

import type { SqlDatabase } from "@bfb/db";

import { handleWorkApi } from "./api/work.js";
import { createHumanAuth } from "./auth/better-auth.js";
import { handleAuthRoute } from "./auth/routes.js";
import { assertBrowserMutation, resolveBrowserPrincipal } from "./auth/session.js";
import { isWorkerFirstPath, type ValidatedControlEnv } from "./env.js";
import { handleMcpRequest } from "./mcp/handler.js";
import {
  handleOauthAuthorize,
  handleOauthMetadata,
  handleOauthToken,
  handleProtectedResourceMetadata,
} from "./oauth/routes.js";

export type ControlAppVariables = {
  validated: ValidatedControlEnv;
  db?: SqlDatabase;
  now?: string;
};

export function createControlApp(
  validated?: ValidatedControlEnv,
  options: {
    db?: SqlDatabase | undefined;
    now?: string | undefined;
    authSecret?: string | undefined;
  } = {},
): Hono<{ Bindings: Record<string, unknown>; Variables: ControlAppVariables }> {
  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: ControlAppVariables }>();
  const now = options.now ?? new Date().toISOString();

  app.use("*", async (c, next) => {
    if (validated) {
      c.set("validated", validated);
    }
    if (options.db) {
      c.set("db", options.db);
    }
    c.set("now", now);
    await next();
  });

  app.get("/healthz", (c) => {
    const current = c.get("validated");
    return c.json({
      ok: true,
      package: "F03",
      environment: current?.environment ?? "local",
      jurisdiction: current?.jurisdiction ?? "eu",
      worker_first: true,
    });
  });

  app.get("/api/v1/_substrate", (c) => {
    const current = c.get("validated");
    return c.json({
      ok: true,
      app_origin: current?.origins.appOrigin,
      artifact_origin: current?.origins.artifactOrigin,
      launch_origin: current?.origins.launchOrigin,
      worker_first_prefixes: [
        "/api",
        "/auth",
        "/mcp",
        "/oauth",
        "/realtime",
        "/runner",
        "/webhooks",
        "/.well-known",
      ],
    });
  });

  app.all("/mcp", async (c) => {
    const current = c.get("validated");
    const db = c.get("db") ?? options.db;
    if (!current || !db) {
      return c.json({ ok: false, error: "mcp_misconfigured", message: "db/env required" }, 500);
    }
    // Hono test requests have no ExecutionContext; createMcpHandler accepts a minimal one.
    const execCtx = {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    const envBindings = (c.env ?? {}) as { WORKSPACE_HUB?: DurableObjectNamespace };
    return handleMcpRequest(
      c.req.raw,
      {
        db,
        allowedHostnames: [current.origins.appHostname],
        appOrigin: current.origins.appOrigin,
        jurisdiction: current.jurisdiction,
        now: c.get("now") ?? now,
        workspaceHubNs: envBindings.WORKSPACE_HUB,
      },
      execCtx,
    );
  });

  app.all("/auth/*", async (c) => {
    const db = c.get("db") ?? options.db;
    const current = c.get("validated");
    if (!db || !current) {
      return c.json({ error: "auth_misconfigured" }, 500);
    }
    const authSecret = options.authSecret ?? "synthetic-local-auth-secret-not-for-prod";
    const auth = createHumanAuth({
      APP_ORIGIN: current.origins.appOrigin,
      BETTER_AUTH_SECRET: authSecret,
    });
    return handleAuthRoute(c, {
      db,
      auth,
      now: c.get("now") ?? now,
      appOrigin: current.origins.appOrigin,
      authSecret,
    });
  });

  app.get("/.well-known/oauth-authorization-server", (c) => {
    const current = c.get("validated");
    return handleOauthMetadata(current?.origins.appOrigin ?? "https://bfb.example.test");
  });

  app.get("/.well-known/oauth-protected-resource", (c) => {
    const current = c.get("validated");
    return handleProtectedResourceMetadata(
      current?.origins.appOrigin ?? "https://bfb.example.test",
    );
  });

  app.get("/oauth/authorize", async (c) => {
    const db = c.get("db") ?? options.db;
    const current = c.get("validated");
    if (!db || !current) {
      return c.json({ error: "oauth_misconfigured" }, 500);
    }
    return handleOauthAuthorize(c.req.raw, {
      db,
      appOrigin: current.origins.appOrigin,
      now: c.get("now") ?? now,
    });
  });

  app.post("/oauth/token", async (c) => {
    const db = c.get("db") ?? options.db;
    const current = c.get("validated");
    if (!db || !current) {
      return c.json({ error: "oauth_misconfigured" }, 500);
    }
    return handleOauthToken(c.req.raw, {
      db,
      appOrigin: current.origins.appOrigin,
      now: c.get("now") ?? now,
    });
  });

  app.all("/api/v1/workspaces/*", async (c) => {
    const db = c.get("db") ?? options.db;
    const current = c.get("validated");
    if (!db || !current) {
      return c.json({ error: "api_misconfigured" }, 500);
    }
    // MCP tokens cannot authenticate browser API routes.
    const authHeader = c.req.header("authorization") ?? "";
    if (authHeader.startsWith("Bearer mcp_")) {
      return c.json(
        { error: "credential_confusion", message: "mcp token cannot auth browser routes" },
        401,
      );
    }
    const principal = await resolveBrowserPrincipal(db, c.req.raw, c.get("now") ?? now);
    if (!principal) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    try {
      assertBrowserMutation(c.req.raw, current.origins.appOrigin, {
        sessionId: principal.sessionId,
        authSecret: options.authSecret ?? "synthetic-local-auth-secret-not-for-prod",
      });
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? String((error as { code: string }).code)
          : "csrf_rejected";
      return c.json(
        { error: code, message: error instanceof Error ? error.message : "csrf rejected" },
        403,
      );
    }
    const match = c.req.path.match(/^\/api\/v1\/workspaces\/([^/]+)/);
    const workspaceId = match?.[1];
    if (!workspaceId) {
      return c.json({ error: "not_found" }, 404);
    }
    const envBindings = (c.env ?? {}) as { WORKSPACE_HUB?: DurableObjectNamespace };
    return handleWorkApi(c.req.raw, {
      db,
      principal,
      workspaceId,
      now: c.get("now") ?? now,
      jurisdiction: current.jurisdiction,
      workspaceHubNs: envBindings.WORKSPACE_HUB,
    });
  });

  app.all("/api/*", (c) =>
    c.json(
      {
        ok: false,
        error: "api_not_found",
        message: "Unknown API path",
      },
      404,
    ),
  );

  app.all("/realtime/*", (c) =>
    c.json(
      {
        ok: false,
        error: "realtime_not_implemented",
        message: "Realtime is owned by E02",
      },
      501,
    ),
  );

  app.all("/runner/*", (c) =>
    c.json(
      {
        ok: false,
        error: "runner_not_implemented",
        message: "Runner channel is owned by C06/L08",
      },
      501,
    ),
  );

  app.all("/webhooks/*", (c) =>
    c.json(
      {
        ok: false,
        error: "webhooks_not_implemented",
        message: "Webhooks are owned by X04",
      },
      501,
    ),
  );

  app.all("*", (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (isWorkerFirstPath(pathname)) {
      return c.json({ ok: false, error: "unhandled_worker_first_path" }, 404);
    }
    return c.json(
      {
        ok: false,
        error: "asset_path",
        message: "Non-worker-first paths are served by static assets",
      },
      404,
    );
  });

  return app;
}
