// ABOUTME: Hosts the BFB Control Worker entrypoint with validated bindings and full web/MCP routes.
// ABOUTME: Production fetch always adapts env.DB; tests may inject a SqlDatabase override.

import { adaptD1, type SqlDatabase } from "@bfb/db";

import { createControlApp } from "./routes.js";
import { validateControlEnv, type ControlBindings } from "./env.js";
export { WorkspaceHub } from "./workspace-hub.js";

/** Optional test/injection hook: supply a SqlDatabase when D1 is not the runtime binding. */
export interface ControlFetchOptions {
  db?: SqlDatabase;
  now?: string;
  authSecret?: string;
}

export function createFetchHandler(options: ControlFetchOptions = {}) {
  return async function fetch(
    request: Request,
    env: ControlBindings,
    _ctx?: ExecutionContext,
  ): Promise<Response> {
    try {
      const validated = validateControlEnv(env);
      // Production always binds D1. Tests inject options.db (better-sqlite3).
      const db = options.db ?? adaptD1(env.DB);
      const app = createControlApp(validated, {
        db,
        now: options.now,
        authSecret:
          options.authSecret ?? (env as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET,
      });
      return await app.fetch(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_environment";
      return new Response(JSON.stringify({ ok: false, error: "config_invalid", message }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  };
}

export default {
  fetch: createFetchHandler(),
};

export const BETTER_AUTH_VERSION = "1.6.26";
