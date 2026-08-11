// ABOUTME: Hosts the BFB Control Worker entrypoint with validated bindings and full web/MCP routes.
// ABOUTME: Production fetch always adapts env.DB; tests may inject a SqlDatabase override.

import { adaptD1, type SqlDatabase } from "@bfb/db";

import {
  createHumanAuth,
  parseAuthKeys,
  type AuthDatabase,
  type AuthEnv,
} from "./auth/better-auth.js";
import { createControlApp } from "./routes.js";
import { validateControlEnv, type ControlBindings } from "./env.js";
export { WorkspaceHub } from "./workspace-hub.js";

/** Optional test/injection hook: supply a SqlDatabase when D1 is not the runtime binding. */
export interface ControlFetchOptions {
  db?: SqlDatabase;
  now?: string;
  authDatabase?: AuthDatabase;
  authEnv?: AuthEnv;
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
        humanAuth: () => {
          const authEnv: AuthEnv = options.authEnv ?? {
            APP_ORIGIN: validated.origins.appOrigin,
            BETTER_AUTH_SECRETS: env.BETTER_AUTH_SECRETS ?? "",
            GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID ?? "",
            GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET ?? "",
            AUTH_ABUSE_SECRET: env.AUTH_ABUSE_SECRET ?? "",
          };
          return {
            auth: createHumanAuth(options.authDatabase ?? env.DB, authEnv),
            keys: parseAuthKeys(authEnv.BETTER_AUTH_SECRETS),
            abuseSecret: authEnv.AUTH_ABUSE_SECRET,
          };
        },
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
  scheduled(_controller: ScheduledController, env: ControlBindings, _ctx: ExecutionContext): void {
    validateControlEnv(env);
  },
};
