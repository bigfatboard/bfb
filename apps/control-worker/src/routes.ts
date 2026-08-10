// ABOUTME: Defines Control Worker route ownership for API, auth, MCP, and discovery paths.
// ABOUTME: F03 reserves Worker-first paths without implementing product handlers.

import { Hono } from "hono";

import { isWorkerFirstPath, type ValidatedControlEnv } from "./env.js";

export type ControlAppVariables = {
  validated: ValidatedControlEnv;
};

export function createControlApp(
  validated?: ValidatedControlEnv,
): Hono<{ Bindings: Record<string, unknown>; Variables: ControlAppVariables }> {
  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: ControlAppVariables }>();

  if (validated) {
    app.use("*", async (c, next) => {
      c.set("validated", validated);
      await next();
    });
  }

  app.get("/healthz", (c) => {
    const current = c.get("validated");
    return c.json({
      ok: true,
      package: "F03",
      environment: current.environment,
      jurisdiction: current.jurisdiction,
      worker_first: true,
    });
  });

  app.get("/api/v1/_substrate", (c) => {
    const validated = c.get("validated");
    return c.json({
      ok: true,
      app_origin: validated.origins.appOrigin,
      artifact_origin: validated.origins.artifactOrigin,
      launch_origin: validated.origins.launchOrigin,
      worker_first_prefixes: [
        "/api",
        "/auth",
        "/mcp",
        "/realtime",
        "/runner",
        "/webhooks",
        "/.well-known",
      ],
    });
  });

  app.all("/mcp", (c) =>
    c.json(
      {
        ok: false,
        error: "mcp_not_implemented",
        message: "Remote MCP is owned by X03A",
      },
      501,
    ),
  );

  app.all("/auth/*", (c) =>
    c.json(
      {
        ok: false,
        error: "auth_not_implemented",
        message: "Human identity is owned by C02",
      },
      501,
    ),
  );

  app.all("/api/*", (c) =>
    c.json(
      {
        ok: false,
        error: "api_not_implemented",
        message: "Domain APIs are owned by later control-plane packages",
      },
      501,
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

  app.all("/.well-known/*", (c) =>
    c.json(
      {
        ok: false,
        error: "discovery_not_implemented",
        message: "OAuth discovery is owned by X03A",
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
