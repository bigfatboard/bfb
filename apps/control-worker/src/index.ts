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
      const authEnv: AuthEnv = options.authEnv ?? {
        APP_ORIGIN: validated.origins.appOrigin,
        BETTER_AUTH_SECRETS: env.BETTER_AUTH_SECRETS ?? "",
        GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID ?? "",
        GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET ?? "",
        AUTH_ABUSE_SECRET: env.AUTH_ABUSE_SECRET ?? "",
      };
      const app = createControlApp(validated, {
        db,
        now: options.now,
        abuseSecret: authEnv.AUTH_ABUSE_SECRET,
        humanAuth: () => {
          return {
            auth: createHumanAuth(options.authDatabase ?? env.DB, authEnv, {
              db,
              now: options.now ?? new Date().toISOString(),
            }),
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
  async queue(
    batch: MessageBatch,
    env: ControlBindings,
    _ctx?: ExecutionContext,
  ): Promise<void> {
    const validated = validateControlEnv(env);
    if (!validated.bindings.NOTIFY_JOBS || !validated.bindings.NOTIFY_DLQ) {
      throw new Error("notification queue bindings are not configured");
    }
    const { handleNotifyQueue } = await import("./notifications/queue.js");
    await handleNotifyQueue(
      batch as MessageBatch<import("./notifications/queue.js").NotifyMessage>,
      {
        DB: validated.bindings.DB,
        NOTIFY_JOBS: validated.bindings.NOTIFY_JOBS,
        NOTIFY_DLQ: validated.bindings.NOTIFY_DLQ,
        APP_ORIGIN: validated.origins.appOrigin,
        VAPID_PUBLIC_KEY: validated.bindings.VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY: validated.bindings.VAPID_PRIVATE_KEY,
        VAPID_SUBJECT: validated.bindings.VAPID_SUBJECT,
      },
    );
  },
  async scheduled(
    _controller: ScheduledController,
    env: ControlBindings,
    _ctx: ExecutionContext,
  ): Promise<void> {
    validateControlEnv(env);
    try {
      const { runArtifactSweep } = await import("./api/artifacts.js");
      await runArtifactSweep(adaptD1(env.DB), new Date().toISOString());
    } catch {
      // The sweep is idempotent and retried on the next Cron tick.
    }
    try {
      const { runNotificationSweep } = await import("./notifications/sweep.js");
      await runNotificationSweep(env);
    } catch {
      // Notification dispatch is idempotent and retried on the next Cron tick.
    }
  },
};
