// ABOUTME: Defines Control Worker routes for health, auth, OAuth, work APIs, and MCP dispatch.
// ABOUTME: Browser sessions and MCP tokens are separated; domain commands own mutations.

import { Hono } from "hono";

import type { SqlDatabase } from "@bfb/db";
import { DomainError } from "@bfb/domain";

import { handleAttentionApi } from "./api/attention.js";
import { handleNotificationApi } from "./api/notifications.js";
import {
  handleNotificationRunnerApi,
  isNotificationRunnerPath,
} from "./api/notification-runner.js";
import { handleEventBrowserApi, handleRunnerEventApi, isRunnerEventPath } from "./api/events.js";
import { handleBrowserRealtimeApi, isBrowserRealtimePath } from "./api/realtime.js";
import { handleGitHubBrowserApi, handleGitHubWebhook } from "./api/github.js";
import { handleOperationsApi } from "./api/operations.js";
import { handleWorkApi } from "./api/work.js";
import { handleArtifactBrowserApi } from "./api/artifacts.js";
import { handleCliBrowserApi, handleCliPublicApi } from "./api/cli-credentials.js";
import { handleCliHumanApi, isCliHumanPath } from "./api/cli-human.js";
import { handleDiscussionApi } from "./api/discussions.js";
import { handleProjectApi } from "./api/projects.js";
import { handleRunnerBrowserApi, handleRunnerNativeApi } from "./api/runners.js";
import { handleRunnerChannelApi, isRunnerChannelPath } from "./api/runner-channel.js";
import {
  handleLaunchBrowserApi,
  handleLaunchNativeApi,
  isRunnerLaunchPath,
} from "./api/launches.js";
import { handleWorkspaceAuthorization } from "./api/workspace-authorization.js";
import type { AuthKey, HumanAuth } from "./auth/better-auth.js";
import { handleAuthRoute } from "./auth/routes.js";
import {
  assertBrowserMutation,
  hasBrowserSessionCookie,
  resolveBrowserPrincipal,
} from "./auth/session.js";
import { isWorkerFirstPath, type ValidatedControlEnv } from "./env.js";
import { handleMcpRequest } from "./mcp/handler.js";
import { oauthAuthorizationScript, oauthAuthorizationStyles } from "./oauth/authorization-page.js";
import {
  handleOauthAuthorize,
  handleOauthConsent,
  handleOauthConsentPage,
  handleOauthMetadata,
  handleOauthRevoke,
  handleOauthToken,
  handleProtectedResourceMetadata,
} from "./oauth/routes.js";

export type ControlAppVariables = {
  validated: ValidatedControlEnv;
  db?: SqlDatabase;
  now?: string;
};

export interface HumanAuthRuntime {
  auth: HumanAuth;
  keys: readonly AuthKey[];
  abuseSecret: string;
}

export function createControlApp(
  validated?: ValidatedControlEnv,
  options: {
    db?: SqlDatabase | undefined;
    now?: string | undefined;
    humanAuth?: (() => HumanAuthRuntime) | undefined;
    abuseSecret?: string | undefined;
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
    if (!current || !db || !options.abuseSecret) {
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
        abuseSecret: options.abuseSecret,
        jurisdiction: current.jurisdiction,
        now: c.get("now") ?? now,
        workspaceHubNs: envBindings.WORKSPACE_HUB,
      },
      execCtx,
    );
  });

  app.all("/runner/*", async (c) => {
    const current = c.get("validated");
    const db = c.get("db") ?? options.db;
    if (!current || !db || !options.abuseSecret)
      return c.json({ error: "runner_misconfigured" }, 500);
    const envBindings = (c.env ?? {}) as { WORKSPACE_HUB?: DurableObjectNamespace };
    const handler = isRunnerLaunchPath(c.req.path)
      ? handleLaunchNativeApi
      : isRunnerEventPath(c.req.path)
        ? handleRunnerEventApi
        : isRunnerChannelPath(c.req.path)
          ? handleRunnerChannelApi
          : isNotificationRunnerPath(c.req.path)
            ? handleNotificationRunnerApi
            : handleRunnerNativeApi;
    return handler(c.req.raw, {
      db,
      now: c.get("now") ?? now,
      jurisdiction: current.jurisdiction,
      appOrigin: current.origins.appOrigin,
      abuseSecret: options.abuseSecret,
      workspaceHubNs: envBindings.WORKSPACE_HUB,
    });
  });

  app.all("/auth/*", async (c) => {
    if (c.req.header("authorization")) {
      return c.json(
        { error: "credential_confusion", message: "bearer credentials cannot auth browser routes" },
        401,
      );
    }
    if (c.req.path.startsWith("/auth/oauth2/") || c.req.path.startsWith("/auth/.well-known/")) {
      return c.json({ error: "not_found" }, 404);
    }
    const db = c.get("db") ?? options.db;
    const current = c.get("validated");
    if (!db || !current) {
      return c.json({ error: "auth_misconfigured" }, 500);
    }
    try {
      const runtime = options.humanAuth?.();
      if (!runtime) {
        return c.json({ error: "auth_misconfigured" }, 500);
      }
      return handleAuthRoute(c, {
        db,
        auth: runtime.auth,
        authKeys: runtime.keys,
        authAbuseSecret: runtime.abuseSecret,
        now: c.get("now") ?? now,
        appOrigin: current.origins.appOrigin,
      });
    } catch {
      return c.json({ error: "auth_misconfigured" }, 500);
    }
  });

  app.get("/.well-known/oauth-authorization-server/auth", async (c) => {
    const current = c.get("validated");
    const db = c.get("db") ?? options.db;
    if (!db || !current) {
      return c.json({ error: "oauth_misconfigured" }, 500);
    }
    const runtime = options.humanAuth?.();
    if (!runtime) {
      return c.json({ error: "oauth_misconfigured" }, 500);
    }
    return handleOauthMetadata(c.req.raw, {
      db,
      auth: runtime.auth,
      appOrigin: current.origins.appOrigin,
      abuseSecret: runtime.abuseSecret,
      now: c.get("now") ?? now,
    });
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
    try {
      const runtime = options.humanAuth?.();
      if (!runtime) {
        return c.json({ error: "oauth_misconfigured" }, 500);
      }
      return handleOauthAuthorize(c.req.raw, {
        db,
        auth: runtime.auth,
        appOrigin: current.origins.appOrigin,
        abuseSecret: runtime.abuseSecret,
        now: c.get("now") ?? now,
      });
    } catch {
      return c.json({ error: "oauth_misconfigured" }, 500);
    }
  });

  app.get("/oauth/authorize.css", () => oauthAuthorizationStyles());
  app.get("/oauth/authorize.js", () => oauthAuthorizationScript());

  app.post("/oauth/consent", async (c) => {
    const db = c.get("db") ?? options.db;
    const current = c.get("validated");
    const runtime = options.humanAuth?.();
    if (!db || !current || !runtime) {
      return c.json({ error: "oauth_misconfigured" }, 500);
    }
    return handleOauthConsent(c.req.raw, {
      db,
      auth: runtime.auth,
      appOrigin: current.origins.appOrigin,
      abuseSecret: runtime.abuseSecret,
      now: c.get("now") ?? now,
    });
  });

  app.get("/oauth/consent", async (c) => {
    const db = c.get("db") ?? options.db;
    const current = c.get("validated");
    const runtime = options.humanAuth?.();
    if (!db || !current || !runtime) {
      return c.json({ error: "oauth_misconfigured" }, 500);
    }
    return handleOauthConsentPage(c.req.raw, {
      db,
      auth: runtime.auth,
      appOrigin: current.origins.appOrigin,
      abuseSecret: runtime.abuseSecret,
      now: c.get("now") ?? now,
    });
  });

  app.post("/oauth/token", async (c) => {
    const db = c.get("db") ?? options.db;
    const current = c.get("validated");
    if (!db || !current) {
      return c.json({ error: "oauth_misconfigured" }, 500);
    }
    if (hasBrowserSessionCookie(c.req.raw)) {
      return c.json(
        { error: "credential_confusion", message: "browser cookie cannot auth token endpoint" },
        401,
      );
    }
    const runtime = options.humanAuth?.();
    if (!runtime) {
      return c.json({ error: "oauth_misconfigured" }, 500);
    }
    return handleOauthToken(c.req.raw, {
      db,
      auth: runtime.auth,
      appOrigin: current.origins.appOrigin,
      abuseSecret: runtime.abuseSecret,
      now: c.get("now") ?? now,
    });
  });

  app.post("/oauth/revoke", async (c) => {
    const db = c.get("db") ?? options.db;
    const current = c.get("validated");
    const runtime = options.humanAuth?.();
    if (!db || !current || !runtime) {
      return c.json({ error: "oauth_misconfigured" }, 500);
    }
    if (hasBrowserSessionCookie(c.req.raw)) {
      return c.json({ error: "credential_confusion" }, 401);
    }
    return handleOauthRevoke(c.req.raw, {
      db,
      auth: runtime.auth,
      appOrigin: current.origins.appOrigin,
      abuseSecret: runtime.abuseSecret,
      now: c.get("now") ?? now,
    });
  });

  app.all("/api/v1/workspace-access/*", async (c) => {
    const db = c.get("db") ?? options.db;
    const current = c.get("validated");
    if (!db || !current) {
      return c.json({ error: "api_misconfigured" }, 500);
    }
    const authHeader = c.req.header("authorization") ?? "";
    if (authHeader) {
      return c.json(
        { error: "credential_confusion", message: "bearer credentials cannot auth browser routes" },
        401,
      );
    }
    try {
      const runtime = options.humanAuth?.();
      if (!runtime) {
        return c.json({ error: "api_misconfigured" }, 500);
      }
      const envBindings = (c.env ?? {}) as { WORKSPACE_HUB?: DurableObjectNamespace };
      return await handleWorkspaceAuthorization(c.req.raw, {
        db,
        auth: runtime.auth,
        authKeys: runtime.keys,
        abuseSecret: runtime.abuseSecret,
        appOrigin: current.origins.appOrigin,
        jurisdiction: current.jurisdiction,
        now: c.get("now") ?? now,
        workspaceHubNs: envBindings.WORKSPACE_HUB,
      });
    } catch {
      return c.json({ error: "request_rejected", message: "request rejected" }, 500);
    }
  });

  app.get("/api/v1/workspaces", async (c) => {
    const db = c.get("db") ?? options.db;
    const current = c.get("validated");
    if (!db || !current) {
      return c.json({ error: "api_misconfigured" }, 500);
    }
    if (c.req.header("authorization")) {
      return c.json(
        { error: "credential_confusion", message: "bearer credentials cannot auth browser routes" },
        401,
      );
    }
    try {
      const runtime = options.humanAuth?.();
      if (!runtime) {
        return c.json({ error: "api_misconfigured" }, 500);
      }
      const principal = await resolveBrowserPrincipal(
        db,
        runtime.auth,
        c.req.raw,
        c.get("now") ?? now,
      );
      if (!principal) {
        return c.json({ error: "unauthenticated" }, 401);
      }
      const workspaces = await db
        .prepare(
          `SELECT workspace.id, workspace.slug, workspace.jurisdiction,
                  member.role, member.authorization_epoch
           FROM workspace_members AS member
           JOIN workspace_authorization_epochs AS epoch
             ON epoch.workspace_id = member.workspace_id
            AND epoch.human_id = member.human_id
            AND epoch.authorization_epoch = member.authorization_epoch
           JOIN workspaces AS workspace ON workspace.id = member.workspace_id
           WHERE member.human_id = ? AND epoch.revoked_at IS NULL
           ORDER BY workspace.slug ASC, workspace.id ASC`,
        )
        .all(principal.humanId);
      return c.json({ workspaces });
    } catch {
      return c.json({ error: "identity_conflict", message: "identity linking required" }, 409);
    }
  });

  app.all("/api/v1/workspaces/*", async (c) => {
    const db = c.get("db") ?? options.db;
    const current = c.get("validated");
    if (!db || !current) {
      return c.json({ error: "api_misconfigured" }, 500);
    }
    // Bearer credentials cannot authenticate browser API routes.
    const authHeader = c.req.header("authorization") ?? "";
    if (authHeader) {
      return c.json(
        { error: "credential_confusion", message: "bearer credentials cannot auth browser routes" },
        401,
      );
    }
    let runtime: HumanAuthRuntime;
    try {
      const resolved = options.humanAuth?.();
      if (!resolved) {
        return c.json({ error: "api_misconfigured" }, 500);
      }
      runtime = resolved;
    } catch {
      return c.json({ error: "api_misconfigured" }, 500);
    }
    let principal;
    try {
      principal = await resolveBrowserPrincipal(db, runtime.auth, c.req.raw, c.get("now") ?? now);
    } catch {
      return c.json({ error: "identity_conflict", message: "identity linking required" }, 409);
    }
    if (!principal) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    try {
      assertBrowserMutation(c.req.raw, current.origins.appOrigin, {
        sessionId: principal.sessionId,
        authKeys: runtime.keys,
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
    try {
      const apiDeps = {
        db,
        principal,
        workspaceId,
        now: c.get("now") ?? now,
        jurisdiction: current.jurisdiction,
        workspaceHubNs: envBindings.WORKSPACE_HUB,
      };
      const projectPrefix = `/api/v1/workspaces/${workspaceId}`;
      if (
        c.req.path === `${projectPrefix}/cli/authorize` ||
        c.req.path.startsWith(`${projectPrefix}/cli/bindings/`)
      ) {
        return await handleCliBrowserApi(c.req.raw, {
          ...apiDeps,
          db,
          auth: runtime.auth,
          appOrigin: current.origins.appOrigin,
          abuseSecret: runtime.abuseSecret,
        });
      }
      if (
        /^\/api\/v1\/workspaces\/[^/]+\/(?:discussions(?:\/|$)|tasks\/[^/]+\/discussions(?:\/|$))/.test(
          c.req.path,
        )
      )
        return await handleDiscussionApi(c.req.raw, apiDeps);
      if (
        c.req.path === `${projectPrefix}/artifacts` ||
        c.req.path.startsWith(`${projectPrefix}/artifacts/`)
      ) {
        return await handleArtifactBrowserApi(c.req.raw, {
          ...apiDeps,
          db,
          auth: runtime.auth,
          appOrigin: current.origins.appOrigin,
          abuseSecret: runtime.abuseSecret,
        });
      }
      if (
        c.req.path === `${projectPrefix}/launches` ||
        c.req.path.startsWith(`${projectPrefix}/launches/`) ||
        c.req.path === `${projectPrefix}/run-controls`
      ) {
        return await handleLaunchBrowserApi(c.req.raw, {
          ...apiDeps,
          appOrigin: current.origins.appOrigin,
          abuseSecret: runtime.abuseSecret,
        });
      }
      if (
        c.req.path === `${projectPrefix}/runners` ||
        c.req.path.startsWith(`${projectPrefix}/runners/`)
      ) {
        return await handleRunnerBrowserApi(c.req.raw, {
          ...apiDeps,
          appOrigin: current.origins.appOrigin,
          abuseSecret: runtime.abuseSecret,
        });
      }
      if (
        c.req.path === `${projectPrefix}/events` ||
        c.req.path === `${projectPrefix}/events/high-water`
      ) {
        return await handleEventBrowserApi(c.req.raw, {
          ...apiDeps,
          appOrigin: current.origins.appOrigin,
          abuseSecret: runtime.abuseSecret,
        });
      }
      if (
        c.req.path.startsWith(`${projectPrefix}/projects`) ||
        c.req.path.startsWith(`${projectPrefix}/members`) ||
        c.req.path.startsWith(`${projectPrefix}/agent-profiles`) ||
        c.req.path.startsWith(`${projectPrefix}/workspace-policy`)
      ) {
        return await handleProjectApi(c.req.raw, apiDeps);
      }
      if (
        c.req.path === `${projectPrefix}/attention` ||
        c.req.path.startsWith(`${projectPrefix}/attention/`)
      ) {
        return await handleAttentionApi(c.req.raw, apiDeps);
      }
      if (
        c.req.path === `${projectPrefix}/github` ||
        c.req.path.startsWith(`${projectPrefix}/github/`)
      ) {
        return await handleGitHubBrowserApi(c.req.raw, {
          ...apiDeps,
          appOrigin: current.origins.appOrigin,
          abuseSecret: runtime.abuseSecret,
        });
      }
      if (
        c.req.path === `${projectPrefix}/notifications/preferences` ||
        c.req.path === `${projectPrefix}/notifications/deliveries` ||
        c.req.path === `${projectPrefix}/notifications/push-endpoints` ||
        c.req.path.startsWith(`${projectPrefix}/notifications/push-endpoints/`)
      ) {
        return await handleNotificationApi(c.req.raw, {
          ...apiDeps,
          abuseSecret: runtime.abuseSecret,
        });
      }
      if (c.req.path === `${projectPrefix}/operations` || c.req.path.startsWith(`${projectPrefix}/operations/`)) {
        const opsBindings = (c.env ?? {}) as { OPS_JOBS?: Queue | undefined };
        return await handleOperationsApi(c.req.raw, {
          ...apiDeps,
          abuseSecret: runtime.abuseSecret,
          opsJobs: opsBindings.OPS_JOBS,
        });
      }
      return await handleWorkApi(c.req.raw, apiDeps);
    } catch (error) {
      if (error instanceof DomainError) {
        const status =
          error.code === "not_found"
            ? 404
            : error.code === "forbidden" || error.code === "unauthenticated"
              ? 403
              : error.code.startsWith("step_up_")
                ? 403
                : error.code === "body_too_large"
                  ? 413
                  : error.code === "invalid_argument" || error.code === "invalid_json"
                    ? 400
                    : 409;
        return c.json({ error: error.code, message: error.message }, status);
      }
      return c.json({ error: "request_failed", message: "request failed" }, 500);
    }
  });

  app.all("/api/v1/cli/*", async (c) => {
    const db = c.get("db") ?? options.db;
    const current = c.get("validated");
    if (!db || !current) {
      return c.json({ error: "api_misconfigured" }, 500);
    }
    try {
      const runtime = options.humanAuth?.();
      if (!runtime) {
        return c.json({ error: "api_misconfigured" }, 500);
      }
      const envBindings = (c.env ?? {}) as { WORKSPACE_HUB?: DurableObjectNamespace };
      if (isCliHumanPath(new URL(c.req.raw.url).pathname)) {
        return await handleCliHumanApi(c.req.raw, {
          db,
          now: c.get("now") ?? now,
          jurisdiction: current.jurisdiction,
          workspaceHubNs: envBindings.WORKSPACE_HUB,
        });
      }
      return await handleCliPublicApi(c.req.raw, {
        db,
        auth: runtime.auth,
        now: c.get("now") ?? now,
        jurisdiction: current.jurisdiction,
        appOrigin: current.origins.appOrigin,
        abuseSecret: runtime.abuseSecret,
        workspaceHubNs: envBindings.WORKSPACE_HUB,
      });
    } catch {
      return c.json({ error: "request_rejected", message: "request rejected" }, 403);
    }
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

  app.all("/realtime/*", async (c) => {
    const db = c.get("db") ?? options.db;
    const current = c.get("validated");
    if (!db || !current) {
      return c.json({ error: "api_misconfigured" }, 500);
    }
    if (!isBrowserRealtimePath(c.req.path)) {
      return c.json({ error: "not_found" }, 404);
    }
    const origin = c.req.header("origin") ?? "";
    if (origin !== current.origins.appOrigin) {
      return c.json({ error: "csrf_origin", message: "origin check failed for realtime" }, 403);
    }
    let runtime: HumanAuthRuntime;
    try {
      const resolved = options.humanAuth?.();
      if (!resolved) {
        return c.json({ error: "api_misconfigured" }, 500);
      }
      runtime = resolved;
    } catch {
      return c.json({ error: "api_misconfigured" }, 500);
    }
    let principal;
    try {
      principal = await resolveBrowserPrincipal(db, runtime.auth, c.req.raw, c.get("now") ?? now);
    } catch {
      return c.json({ error: "identity_conflict", message: "identity linking required" }, 409);
    }
    if (!principal) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    const match = c.req.path.match(/^\/realtime\/workspaces\/([^/]+)/);
    const workspaceId = match?.[1];
    if (!workspaceId) {
      return c.json({ error: "not_found" }, 404);
    }
    const envBindings = (c.env ?? {}) as { WORKSPACE_HUB?: DurableObjectNamespace };
    return handleBrowserRealtimeApi(c.req.raw, {
      db,
      principal,
      workspaceId,
      now: c.get("now") ?? now,
      jurisdiction: current.jurisdiction,
      appOrigin: current.origins.appOrigin,
      abuseSecret: options.abuseSecret ?? "",
      workspaceHubNs: envBindings.WORKSPACE_HUB,
      auth: runtime.auth,
    });
  });

  app.all("/runner/*", (c) => {
    if (hasBrowserSessionCookie(c.req.raw)) {
      return c.json(
        { error: "credential_confusion", message: "browser cookie cannot auth runner routes" },
        401,
      );
    }
    return c.json(
      {
        ok: false,
        error: "runner_not_implemented",
        message: "Runner channel is owned by C06/L08",
      },
      501,
    );
  });

  app.all("/webhooks/*", async (c) => {
    if (hasBrowserSessionCookie(c.req.raw)) {
      return c.json(
        { error: "credential_confusion", message: "browser cookie cannot auth webhook routes" },
        401,
      );
    }
    if (new URL(c.req.url).pathname === "/webhooks/github") {
      const db = c.get("db") ?? options.db;
      const current = c.get("validated");
      if (!db || !current) {
        return c.json({ error: "api_misconfigured" }, 500);
      }
      const envBindings = (c.env ?? {}) as {
        WORKSPACE_HUB?: DurableObjectNamespace;
        JOBS?: Queue;
        GITHUB_WEBHOOK_SECRET?: string;
        GITHUB_API_BASE?: string;
        GITHUB_APP_ID?: string;
        GITHUB_APP_PRIVATE_KEY?: string;
      };
      return handleGitHubWebhook(c.req.raw, {
        db,
        now: c.get("now") ?? now,
        jurisdiction: current.jurisdiction,
        appOrigin: current.origins.appOrigin,
        abuseSecret: options.abuseSecret ?? "",
        workspaceHubNs: envBindings.WORKSPACE_HUB,
        jobs: envBindings.JOBS,
        githubWebhookSecret: envBindings.GITHUB_WEBHOOK_SECRET,
        githubApiBase: envBindings.GITHUB_API_BASE,
        githubAppId: envBindings.GITHUB_APP_ID,
        githubAppPrivateKey: envBindings.GITHUB_APP_PRIVATE_KEY,
      });
    }
    return c.json(
      {
        ok: false,
        error: "webhooks_not_implemented",
        message: "Only /webhooks/github is implemented",
      },
      501,
    );
  });

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
