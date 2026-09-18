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
import { consumeGitHubQueueBatch, createGitHubRestClient, runGitHubSweep } from "./api/github.js";
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
  async queue(batch: MessageBatch, env: ControlBindings): Promise<void> {
    const validated = validateControlEnv(env);
    // X01 owns the bfb-notify* queues, X05 the bfb-ops* queues;
    // every other consumer batch is X04's JOBS queue.
    if (/^bfb-ops(-staging|-local)?$/.test(batch.queue)) {
      if (!validated.bindings.OPS_JOBS || !validated.bindings.OPS_DLQ) {
        throw new Error("operations queue bindings are not configured");
      }
      const { consumeOpsQueueBatch } = await import("./operations/queue.js");
      const dlq = validated.bindings.OPS_DLQ;
      const r2 = validated.bindings.ARTIFACTS;
      const handles = batch.messages.map((message) => ({
        body: message.body,
        attempts: (message as { attempts?: number }).attempts ?? 0,
        ack: () => message.ack(),
        retry: (options?: { delaySeconds?: number }) => message.retry(options),
      }));
      await consumeOpsQueueBatch(handles, {
        db: adaptD1(validated.bindings.DB),
        r2: {
          put: (key: string, value: string) => r2.put(key, value),
          delete: (key: string) => r2.delete(key),
        },
        sendDlq: async (copy) => {
          await dlq.send(copy, { contentType: "json" });
        },
      });
      return;
    }
    if (/^bfb-notify(-staging|-local)?$/.test(batch.queue)) {
      if (!validated.bindings.NOTIFY_JOBS || !validated.bindings.NOTIFY_DLQ) {
        throw new Error("notification queue bindings are not configured");
      }
      const { handleNotifyQueue } = await import("./notifications/queue.js");
      const dlq = validated.bindings.NOTIFY_DLQ;
      const vapid =
        validated.bindings.VAPID_PUBLIC_KEY &&
        validated.bindings.VAPID_PRIVATE_KEY &&
        validated.bindings.VAPID_SUBJECT
          ? {
              publicKey: validated.bindings.VAPID_PUBLIC_KEY,
              privateKey: validated.bindings.VAPID_PRIVATE_KEY,
              subject: validated.bindings.VAPID_SUBJECT,
            }
          : null;
      await handleNotifyQueue(
        batch as MessageBatch<import("./notifications/queue.js").NotifyMessage>,
        {
          db: adaptD1(validated.bindings.DB),
          sendDlq: async (copy) => {
            await dlq.send(copy, { contentType: "json" });
          },
          appOrigin: validated.origins.appOrigin,
          vapid,
        },
      );
      return;
    }
    const db = adaptD1(env.DB);
    const now = new Date().toISOString();
    const client = createGitHubRestClient({
      githubApiBase: env.GITHUB_API_BASE,
      githubAppId: env.GITHUB_APP_ID,
      githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
    });
    const handles = [];
    for (const message of batch.messages) {
      const body = message.body;
      if (
        !!body &&
        typeof body === "object" &&
        (body as { kind?: unknown }).kind === "github.outbox.dispatch"
      ) {
        handles.push({
          body,
          ack: () => message.ack(),
          retry: (options?: { delaySeconds?: number }) => message.retry(options),
        });
      } else {
        // Unknown producer payload: retry into the platform DLQ for triage.
        message.retry();
      }
    }
    await consumeGitHubQueueBatch(handles, {
      db,
      now,
      jurisdiction: validated.jurisdiction,
      appOrigin: validated.origins.appOrigin,
      abuseSecret: env.AUTH_ABUSE_SECRET ?? "",
      workspaceHubNs: env.WORKSPACE_HUB,
      jobs: env.JOBS,
      githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
      githubApiBase: env.GITHUB_API_BASE,
      githubAppId: env.GITHUB_APP_ID,
      githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
      client,
    });
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
      await runGitHubSweep(adaptD1(env.DB), env.JOBS, new Date().toISOString());
    } catch {
      // The sweep is idempotent and retried on the next Cron tick.
    }
    try {
      const { runNotificationSweep } = await import("./notifications/sweep.js");
      await runNotificationSweep(env);
    } catch {
      // Notification dispatch is idempotent and retried on the next Cron tick.
    }
    try {
      const { runRetentionSweep } = await import("./operations/sweep.js");
      await runRetentionSweep(adaptD1(env.DB), env.ARTIFACTS, new Date().toISOString());
    } catch {
      // Retention deletes only explicitly eligible log objects and records
      // its run; a tick failure retries on the next Cron tick.
    }
  },
};
