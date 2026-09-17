// ABOUTME: Local E2E HTTP server that mounts createControlApp against fixture DB plus the web SPA.
// ABOUTME: Prints FIX.workspace and listens on a fixed port so Playwright can drive real browser flows.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import { FIX, randomUlid, seedSyntheticWorkspace } from "@bfb/domain";

import {
  createHumanAuth,
  parseAuthKeys,
  type AuthEnv,
} from "../../../apps/control-worker/src/auth/better-auth.js";
import {
  isWorkerFirstPath,
  validateControlEnv,
  type ControlBindings,
} from "../../../apps/control-worker/src/env.js";
import { createTestWorkspaceHubNamespace } from "../../../apps/control-worker/src/hub-client.js";
import { createControlApp } from "../../../apps/control-worker/src/routes.js";
import type { SqlDatabase } from "@bfb/db";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
} from "../../../apps/control-worker/test/auth-helpers.js";

const PORT = Number(process.env.BFB_E2E_PORT ?? "4173");
const HOST = process.env.BFB_E2E_HOST ?? "127.0.0.1";
const ORIGIN_HOST = process.env.BFB_E2E_ORIGIN_HOST ?? "bfb.localhost";
const ORIGIN = `http://${ORIGIN_HOST}:${PORT}`;
const NOW = "2026-08-07T12:00:00Z";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const webRoot = path.join(rootDir, "apps/web");

function contentHash(body: string): string {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

async function seedWorkSurface(db: SqlDatabase): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tasks (
         workspace_id, id, project_id, parent_task_id, title, state, priority, due_at,
         next_owner_type, next_owner_id, next_action_reason, punchline,
         resource_version, created_by_human_id, created_by_delegation_id, created_at
       ) VALUES
         (?, ?, ?, NULL, 'Approve the release boundary', 'blocked', 'P0',
          '2026-08-07T11:00:00Z', 'human', ?,
          'Choose whether the credential boundary is ready to ship.',
          'One owner decision is holding the release.', 1, ?, NULL, ?),
         (?, ?, ?, NULL, 'Agent-proposed cache cleanup', 'proposed', 'P2', NULL,
          'human', ?, 'Promote or reject the agent proposal.',
          'Proposal is visible but cannot move itself.', 1, ?, NULL, ?),
         (?, ?, ?, NULL, 'Map the remaining webhook edge cases', 'ready', 'P1', NULL,
          'agent_profile', ?, 'The scope is bounded and ready for independent review.',
          'Codex can take the next pass; no run has started.', 1, ?, NULL, ?)`,
    )
    .run(
      FIX.workspace,
      FIX.taskAttention,
      FIX.projectA,
      FIX.owner,
      FIX.owner,
      NOW,
      FIX.workspace,
      FIX.taskProposed,
      FIX.projectA,
      FIX.owner,
      FIX.owner,
      NOW,
      FIX.workspace,
      FIX.taskDelegable,
      FIX.projectB,
      FIX.profileCodex,
      FIX.owner,
      NOW,
    );

  await db
    .prepare(
      `INSERT INTO runs
       (workspace_id, id, project_id, task_id, requested_by_human_id, agent_profile_id,
        result_state, activity, resource_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', 'unknown', 1, ?)`,
    )
    .run(
      FIX.workspace,
      FIX.runDelegable,
      FIX.projectB,
      FIX.taskDelegable,
      FIX.owner,
      FIX.profileCodex,
      NOW,
    );

  await seedAttentionSurface(db);

  await db
    .prepare(`INSERT INTO workspace_cursors (workspace_id, cursor) VALUES (?, 1)`)
    .run(FIX.workspace);
  await db
    .prepare(
      `INSERT INTO semantic_events
       (workspace_id, event_id, workspace_cursor, kind, payload_json, created_at)
       VALUES (?, ?, 1, 'task.update', ?, ?)`,
    )
    .run(
      FIX.workspace,
      FIX.eventAttention,
      JSON.stringify({ input: { taskId: FIX.taskAttention }, result: { id: FIX.taskAttention } }),
      NOW,
    );

  const humanBody = "Private release rationale for the human reviewer.";
  const agentBody = "Check webhook signature replay and delivery ordering.";
  await db
    .prepare(
      `INSERT INTO task_context_items
       (workspace_id, id, task_id, kind, audience, body, version, content_hash, created_at)
       VALUES (?, ?, ?, 'decision', 'human', ?, 1, ?, ?),
              (?, ?, ?, 'acceptance', 'agent', ?, 2, ?, ?)`,
    )
    .run(
      FIX.workspace,
      FIX.contextHuman,
      FIX.taskDelegable,
      humanBody,
      contentHash(humanBody),
      NOW,
      FIX.workspace,
      FIX.contextAgent,
      FIX.taskDelegable,
      agentBody,
      contentHash(agentBody),
      NOW,
    );
}

/** Seeds one claimed execution per attention run plus four ranked open requests. */
async function seedAttentionSurface(db: SqlDatabase): Promise<void> {
  const runner = "01SYNTHETICATNRUNNER0000001";
  const executionA = "01SYNTHETICATNEXECA0000001";
  const executionB = "01SYNTHETICATNEXECB0000001";
  const runA = "01SYNTHETICATNRUNA0000001";
  await db
    .prepare(
      `INSERT INTO tasks (
         workspace_id, id, project_id, parent_task_id, title, state, priority, due_at,
         next_owner_type, next_owner_id, next_action_reason, punchline,
         resource_version, created_by_human_id, created_by_delegation_id, created_at
       ) VALUES (?, ?, ?, NULL, 'Approve the attention queue shape', 'active', 'P1', NULL,
          'agent_profile', ?, 'An agent run is waiting on these decisions.',
          'Attention fixture task.', 1, ?, NULL, ?)`,
    )
    .run(FIX.workspace, FIX.attentionTask, FIX.projectA, FIX.profileCodex, FIX.owner, NOW);
  await db
    .prepare(
      `INSERT INTO runs
       (workspace_id, id, project_id, task_id, requested_by_human_id, agent_profile_id,
        result_state, activity, resource_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', 'needs_human', 1, ?)`,
    )
    .run(FIX.workspace, runA, FIX.projectA, FIX.attentionTask, FIX.owner, FIX.profileCodex, NOW);
  await db
    .prepare(
      `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
       VALUES (?, ?, ?, 'Synthetic attention Mac', '{}', 'synthetic-attention-e2e', 1, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, NOW);
  for (const project of [FIX.projectA, FIX.projectB]) {
    await db
      .prepare(`INSERT INTO runner_project_grants VALUES (?, ?, ?)`)
      .run(FIX.workspace, runner, project);
  }
  for (const [execution, run, task, project] of [
    [executionA, runA, FIX.attentionTask, FIX.projectA],
    [executionB, FIX.runDelegable, FIX.taskDelegable, FIX.projectB],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO run_executions (workspace_id, id, run_id, state, created_at)
         VALUES (?, ?, ?, 'attached', ?)`,
      )
      .run(FIX.workspace, execution, run, NOW);
    await db
      .prepare(
        `INSERT INTO execution_assignments
         (workspace_id, execution_id, assignment_generation, run_id, task_id, project_id,
          runner_id, checkout_id, physical_worktree_hash, requesting_human_id,
          requesting_human_epoch, runner_authorization_epoch, runner_grant_epoch,
          runner_key_thumbprint, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 'synthetic-attention-e2e', ?)`,
      )
      .run(
        FIX.workspace,
        execution,
        run,
        task,
        project,
        runner,
        `checkout-${execution}`,
        `sha256:${"e".repeat(64)}`,
        FIX.owner,
        NOW,
      );
  }
  const requests = [
    {
      id: FIX.attentionBlocker,
      project: FIX.projectA,
      task: FIX.attentionTask,
      run: runA,
      execution: executionA,
      kind: "blocker",
      role: "member",
      question: "Synthetic blocker question",
      blocking: 1,
      at: "2026-08-07T11:00:00Z",
    },
    {
      id: FIX.attentionDestructive,
      project: FIX.projectB,
      task: FIX.taskDelegable,
      run: FIX.runDelegable,
      execution: executionB,
      kind: "destructive_action",
      role: "owner",
      question: "Synthetic destructive-action question",
      blocking: 1,
      at: "2026-08-07T11:01:00Z",
    },
    {
      id: FIX.attentionCredential,
      project: FIX.projectA,
      task: FIX.attentionTask,
      run: runA,
      execution: executionA,
      kind: "credential",
      role: "owner",
      question: "Synthetic credential question",
      blocking: 0,
      at: "2026-08-07T11:02:00Z",
    },
    {
      id: FIX.attentionReview,
      project: FIX.projectA,
      task: FIX.attentionTask,
      run: runA,
      execution: executionA,
      kind: "review",
      role: "reviewer",
      question: "Synthetic review question",
      blocking: 0,
      at: "2026-08-07T11:03:00Z",
    },
  ] as const;
  for (const request of requests) {
    await db
      .prepare(
        `INSERT INTO attention_requests
         (workspace_id, id, project_id, task_id, run_id, run_execution_id,
          assignment_generation, kind, required_role, reference_kind, reference_id,
          question, blocking, state, answer, answered_by_human_id,
          requested_at, first_response_at, answered_at, resolved_at, resource_version)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, ?, ?, 'open', NULL, NULL, ?, NULL, NULL, NULL, 1)`,
      )
      .run(
        FIX.workspace,
        request.id,
        request.project,
        request.task,
        request.run,
        request.execution,
        request.kind,
        request.role,
        request.question,
        request.blocking,
        request.at,
      );
    await db
      .prepare(
        `INSERT INTO attention_observations
         (workspace_id, observation_id, attention_id, observed_kind, actor_type, actor_id, occurred_at)
         VALUES (?, ?, ?, 'requested', 'agent_run', ?, ?)`,
      )
      .run(FIX.workspace, `obs-${request.id}`, request.id, request.run, request.at);
  }
}

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

function controlBindings(db: SqlDatabase): ControlBindings {
  return {
    DB: fakeBinding<D1Database>("db"),
    ARTIFACTS: fakeBinding<R2Bucket>("r2"),
    ASSETS: fakeBinding<Fetcher>("assets"),
    JOBS: fakeBinding<Queue>("jobs"),
    JOBS_DLQ: fakeBinding<Queue>("dlq"),
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(db),
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
}

function shouldHandleOnControl(pathname: string): boolean {
  if (pathname === "/healthz") {
    return true;
  }
  return isWorkerFirstPath(pathname);
}

type FixtureRole = "owner" | "member" | "restricted";

function handleFixtureSession(
  pathname: string,
  sessions: Readonly<Record<FixtureRole, string>>,
  res: ServerResponse,
): boolean {
  const match = pathname.match(/^\/__test\/session\/(owner|member|restricted)$/);
  const role = match?.[1] as FixtureRole | undefined;
  if (!role) {
    return false;
  }
  res.statusCode = 302;
  res.setHeader("location", "/");
  res.setHeader("set-cookie", `${sessions[role]}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  res.end();
  return true;
}

async function handleFixturePasskeyFlow(
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
  db: SqlDatabase,
  ownerCookie: string,
): Promise<boolean> {
  if (pathname !== "/__test/passkey-flow") {
    return false;
  }
  if (req.method !== "POST" || !req.headers.cookie?.includes(ownerCookie)) {
    res.statusCode = 401;
    res.end();
    return true;
  }
  const flowId = randomUlid();
  const expiresAt = "2026-08-07T12:05:00Z";
  await db
    .prepare(
      `INSERT INTO passkey_ceremonies
       (id, human_id, auth_user_id, session_id, kind, state, action_json,
        reauthenticated_at, created_at, expires_at)
       VALUES (?, ?, 'auth-owner-e2e', 'auth-owner-e2e-session', 'registration', 'ready',
               ?, ?, ?, ?)`,
    )
    .run(
      flowId,
      FIX.owner,
      JSON.stringify({
        action: "passkey.enroll.initial",
        scopes: [],
        authorizationEpoch: 0,
        expiresAt,
      }),
      NOW,
      NOW,
      expiresAt,
    );
  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ flow_id: flowId, fixture: "fresh_github_reauthentication" }));
  return true;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function forwardToControl(
  req: IncomingMessage,
  res: ServerResponse,
  app: ReturnType<typeof createControlApp>,
  bindings: ControlBindings,
): Promise<void> {
  const url = new URL(req.url ?? "/", ORIGIN);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readBody(req) : undefined;
  const request = new Request(url, {
    method,
    headers,
    body: body && body.length > 0 ? body : undefined,
  });

  const response = await app.fetch(request, bindings);
  res.statusCode = response.status;
  const setCookies: string[] = [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      setCookies.push(value);
      return;
    }
    res.setHeader(key, value);
  });
  if (setCookies.length === 1) {
    res.setHeader("set-cookie", setCookies[0]!);
  } else if (setCookies.length > 1) {
    res.setHeader("set-cookie", setCookies);
  }
  const ab = Buffer.from(await response.arrayBuffer());
  res.end(ab);
}

async function serveSpa(
  req: IncomingMessage,
  res: ServerResponse,
  vite: ViteDevServer,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    vite.middlewares(req, res, (error?: unknown) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  if (res.writableEnded) {
    return;
  }

  const url = req.url ?? "/";
  const indexHtmlPath = path.join(webRoot, "index.html");
  const fs = await import("node:fs/promises");
  let template = await fs.readFile(indexHtmlPath, "utf8");
  template = await vite.transformIndexHtml(url, template);
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(template);
}

async function main(): Promise<void> {
  const authContext = openAuthTestContext();
  await seedSyntheticWorkspace(authContext.db, NOW);
  await seedWorkSurface(authContext.db);
  const db = authContext.db;
  const authEnv: AuthEnv = { ...AUTH_TEST_ENV, APP_ORIGIN: ORIGIN };
  const auth = createHumanAuth(authContext.raw, authEnv, { db, now: NOW });
  const fixtureSessions: Record<FixtureRole, string> = {
    owner: (
      await seedAuthSession(authContext, {
        userId: "auth-owner-e2e",
        sessionId: "auth-owner-e2e-session",
        token: "auth-owner-e2e-token",
        email: "owner@synthetic.test",
        name: "Synthetic Owner",
        humanId: FIX.owner,
      })
    ).cookie,
    member: (
      await seedAuthSession(authContext, {
        userId: "auth-member-e2e",
        sessionId: "auth-member-e2e-session",
        token: "auth-member-e2e-token",
        email: "member@synthetic.test",
        name: "Synthetic Member",
        humanId: FIX.member,
      })
    ).cookie,
    restricted: (
      await seedAuthSession(authContext, {
        userId: "auth-restricted-e2e",
        sessionId: "auth-restricted-e2e-session",
        token: "auth-restricted-e2e-token",
        email: "restricted@synthetic.test",
        name: "Synthetic Restricted",
        humanId: FIX.restricted,
      })
    ).cookie,
  };
  const bindings = controlBindings(db);
  const validated = validateControlEnv(bindings);
  const app = createControlApp(validated, {
    db,
    now: NOW,
    abuseSecret: authEnv.AUTH_ABUSE_SECRET,
    humanAuth: () => ({
      auth,
      keys: parseAuthKeys(authEnv.BETTER_AUTH_SECRETS),
      abuseSecret: authEnv.AUTH_ABUSE_SECRET,
    }),
  });

  const vite = await createViteServer({
    configFile: path.join(webRoot, "vite.config.ts"),
    root: webRoot,
    server: {
      middlewareMode: true,
      hmr: false,
    },
    appType: "custom",
    logLevel: "error",
  });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const pathname = new URL(req.url ?? "/", ORIGIN).pathname;
        if (handleFixtureSession(pathname, fixtureSessions, res)) {
          return;
        }
        if (
          await handleFixturePasskeyFlow(
            pathname,
            req,
            res,
            db,
            fixtureSessions.owner.split(";", 1)[0]!,
          )
        ) {
          return;
        }
        if (shouldHandleOnControl(pathname)) {
          await forwardToControl(req, res, app, bindings);
          return;
        }
        await serveSpa(req, res, vite);
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain; charset=utf-8");
        }
        const message = error instanceof Error ? error.message : "e2e server error";
        res.end(message);
        console.error("[e2e-server]", error);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => resolve());
  });

  console.log(`BFB_E2E_READY ${ORIGIN}`);
  console.log(`BFB_E2E_WORKSPACE ${FIX.workspace}`);
  console.log(`BFB_E2E_PROJECT_A ${FIX.projectA}`);
  console.log(`BFB_E2E_PROJECT_B ${FIX.projectB}`);
  console.log(`BFB_E2E_CLIENT ${FIX.client}`);

  const shutdown = async () => {
    server.close();
    await vite.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
