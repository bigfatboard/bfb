// ABOUTME: Local E2E HTTP server that mounts createControlApp against fixture DB plus the web SPA.
// ABOUTME: Prints FIX.workspace and listens on a fixed port so Playwright can drive real browser flows.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { WebSocket, WebSocketServer } from "ws";

import {
  claimLaunchCommand,
  createAgentProfileCommand,
  createTaskCommand,
  FIX,
  type HubCommand,
  ingestRunnerEventsCommand,
  launchDeadline,
  randomUlid,
  replaceRunnerInventoryCommand,
  reportRepositoryConfigCommand,
  runnerHash,
  seedSyntheticWorkspace,
  startLaunchCommand,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  workspaceHub,
  type IngestRunnerEventsResult,
  type RunnerPrincipal,
} from "@bfb/domain";
import type { RunnerInventory } from "@bfb/protocol";
import {
  BrowserSockets,
  type RealtimeSocket,
} from "../../../apps/control-worker/src/realtime/browser-sockets.js";

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

interface E02Chain {
  key: string;
  taskId: string;
  runId: string;
  executionId: string;
  generation: number;
  stream: string;
  sequence: number;
}

interface E02State {
  chains: Record<string, E02Chain>;
  principal: RunnerPrincipal;
  runner: string;
}

const E02_NOW = NOW;
const E02_DIGEST = `sha256:${"e02".padEnd(64, "0")}`;
const E02_CONFIG = `sha256:${runnerHash("{}")}`;

/** Seeds one runner with two claimed executions (live + stale timelines) for E02. */
async function seedE02Chains(db: SqlDatabase): Promise<E02State> {
  const hub = workspaceHub(db, FIX.workspace);
  const runner = randomUlid();
  const tokenId = randomUlid();
  const principal: RunnerPrincipal = {
    kind: "runner",
    workspaceId: FIX.workspace,
    runnerId: runner,
    ownerHumanId: FIX.owner,
    authorizationEpoch: 1,
    ownerAuthorizationEpoch: 1,
    grantEpoch: 1,
    tokenEpoch: 1,
    tokenId,
    keyThumbprint: "synthetic-e02-e2e-key",
    // Ingest calls arrive on the real wall clock, so fixture authority stays
    // valid long after the synthetic workspace date.
    authExpiresAt: "2027-08-07T12:00:00.000Z",
    projectIds: [FIX.projectA],
  };
  async function human<T>(command: HubCommand<unknown, T>, input: unknown): Promise<T> {
    const outcome = await hub.execute(command, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: E02_NOW,
      input,
    });
    if (!outcome.ok) throw new Error(`e02 seed ${command.name} failed: ${outcome.error.code}`);
    return outcome.result;
  }
  async function native<T>(command: HubCommand<unknown, T>, input: unknown): Promise<T> {
    const outcome = await hub.execute(command, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorRunnerId: runner,
      authorizationEpoch: 1,
      now: E02_NOW,
      input,
    });
    if (!outcome.ok) throw new Error(`e02 seed ${command.name} failed: ${outcome.error.code}`);
    return outcome.result;
  }
  // Extend the v1 baseline instead of replacing it: the W01 browser surface
  // asserts the seeded providers and flags, so only "fake" is appended.
  const policy = {
    allowedProviders: ["claude", "codex", "grok", "fake"],
    allowAgentRootPropose: true,
    allowPassToAgent: true,
    allowRunOverrides: true,
  };
  await human(updateWorkspacePolicyCommand, { ...policy, expectedVersion: 1 });
  await human(updateProjectPolicyCommand, {
    ...policy,
    expectedVersion: 1,
    projectId: FIX.projectA,
  });
  await human(reportRepositoryConfigCommand, {
    projectId: FIX.projectA,
    expectedVersion: 1,
    document: {},
    contentHash: E02_CONFIG,
  });
  const profile = await human(createAgentProfileCommand, {
    name: "Synthetic E02 timeline provider",
    provider: "fake",
    model: "synthetic",
    executionMode: "interactive",
    harnessMode: "restricted",
  });
  await db
    .prepare(
      `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
       VALUES (?, ?, ?, 'Synthetic E02 e2e Mac', '{}', ?, 1, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, principal.keyThumbprint, E02_NOW);
  await db
    .prepare(`INSERT INTO runner_project_grants VALUES (?, ?, ?)`)
    .run(FIX.workspace, runner, FIX.projectA);
  await db
    .prepare(
      `INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, E02_NOW);
  await db
    .prepare(
      `INSERT INTO runner_tokens (workspace_id, runner_id, id, token_hash, claims_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      FIX.workspace,
      runner,
      tokenId,
      runnerHash("synthetic-e02-e2e-token"),
      JSON.stringify({
        v: 1,
        sub: runner,
        workspace_id: FIX.workspace,
        aud: "bfb-runner",
        iss: "https://bfb.example.test",
        jti: tokenId,
        iat: Date.parse(E02_NOW) / 1000,
        exp: Date.parse(principal.authExpiresAt) / 1000,
        authorization_epoch: 1,
        owner_authorization_epoch: 1,
        grant_epoch: 1,
        token_epoch: 1,
        cnf: { jkt: principal.keyThumbprint },
      }),
      principal.authExpiresAt,
    );
  const checkoutLive = randomUlid();
  const checkoutStale = randomUlid();
  const inventory: RunnerInventory = {
    schema_version: 1,
    workspace_id: FIX.workspace,
    runner_id: runner,
    revision: 1,
    checkouts: [
      {
        schema_version: 1,
        checkout_id: checkoutLive,
        workspace_id: FIX.workspace,
        runner_id: runner,
        project_id: FIX.projectA,
        label: "Synthetic E02 live checkout",
        repository_identity: "synthetic/e02-live",
        workspace_subpath: ".",
        physical_worktree_hash: E02_DIGEST,
        repository_config_hash: E02_CONFIG,
        is_default: true,
        dirty: false,
        status: "validated",
        validated_at: E02_NOW,
      },
      {
        schema_version: 1,
        checkout_id: checkoutStale,
        workspace_id: FIX.workspace,
        runner_id: runner,
        project_id: FIX.projectA,
        label: "Synthetic E02 stale checkout",
        repository_identity: "synthetic/e02-stale",
        workspace_subpath: ".",
        physical_worktree_hash: `sha256:${"e03".padEnd(64, "0")}`,
        repository_config_hash: E02_CONFIG,
        is_default: false,
        dirty: false,
        status: "validated",
        validated_at: E02_NOW,
      },
    ],
    providers: [
      {
        provider: "fake",
        version: "1.0.0",
        manifest_id: E02_DIGEST,
        status: "healthy",
        observed_at: E02_NOW,
        expires_at: launchDeadline(E02_NOW, 30_000),
        capabilities: [
          "launch.interactive",
          "filesystem.read_only",
          "approval.never",
          "context.session_start",
          "prompt.initial_constant",
          "hooks.session_start",
          "mcp.stdio",
          "control.interrupt",
          "control.terminate",
          "session.resume",
        ],
      },
    ],
  };
  await native(replaceRunnerInventoryCommand, { principal, inventory });
  const chains: Record<string, E02Chain> = {};
  for (const [key, checkoutId, title] of [
    ["live", checkoutLive, "Synthetic E02 live run"],
    ["stale", checkoutStale, "Synthetic E02 stale run"],
  ] as const) {
    const task = await human(createTaskCommand, {
      projectId: FIX.projectA,
      title,
      priority: "P2",
    });
    const launch = await human(startLaunchCommand, {
      schema_version: 1,
      idempotency_key: randomUlid(),
      task_id: task.id,
      expected_task_version: 1,
      runner_id: runner,
      checkout_id: checkoutId,
      agent_profile_id: profile.id,
      agent_profile_version: 1,
      workspace_policy_version: 2,
      project_policy_version: 2,
      repository_config_version: 2,
    });
    const claimed = await native(claimLaunchCommand, {
      principal,
      claim: {
        schema_version: 1,
        launch_id: launch.launch_id,
        runner_id: runner,
        idempotency_key: randomUlid(),
        claimed_at: E02_NOW,
      },
    });
    if (claimed.state !== "claimed") throw new Error(`e02 seed claim failed for ${key}`);
    chains[key] = {
      key,
      taskId: task.id,
      runId: claimed.claim.specification.run_id,
      executionId: claimed.claim.specification.run_execution_id,
      generation: claimed.claim.specification.assignment_generation,
      stream: randomUlid(),
      sequence: 0,
    };
  }
  return { chains, principal, runner };
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

interface NodeSocketEntry {
  ws: WebSocket;
  tags: string[];
  attachment: unknown;
}

const E02_SESSION_BY_ROLE: Record<FixtureRole, string> = {
  owner: "auth-owner-e2e-session",
  member: "auth-member-e2e-session",
  restricted: "auth-restricted-e2e-session",
};

const E02_HUMAN_BY_ROLE: Record<FixtureRole, string> = {
  owner: FIX.owner,
  member: FIX.member,
  restricted: FIX.restricted,
};

async function main(): Promise<void> {
  const authContext = openAuthTestContext();
  await seedSyntheticWorkspace(authContext.db, NOW);
  await seedWorkSurface(authContext.db);
  const db = authContext.db;
  const e02 = await seedE02Chains(db);
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

  // E02 browser realtime over the shared socket manager and fixture D1.
  const realtimeEntries = new Set<NodeSocketEntry>();
  const realtime = new BrowserSockets(
    (tag) => {
      const out: RealtimeSocket[] = [];
      for (const entry of realtimeEntries) {
        if (!entry.tags.includes(tag) || entry.ws.readyState !== WebSocket.OPEN) continue;
        out.push({
          get readyState() {
            return entry.ws.readyState;
          },
          send: (data: string) => entry.ws.send(data),
          close: (code: number, reason: string) => entry.ws.close(code, reason),
          readAttachment: () => entry.attachment,
          writeAttachment: (value: unknown) => {
            entry.attachment = value;
          },
        });
      }
      return out;
    },
    { db, newConnectionId: () => randomUlid() },
  );

  function e02RoleOf(req: IncomingMessage): FixtureRole | null {
    const cookie = req.headers.cookie ?? "";
    for (const role of ["owner", "member", "restricted"] as const) {
      if (cookie.includes(fixtureSessions[role].split(";", 1)[0]!)) return role;
    }
    return null;
  }

  async function handleE02Commit(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.url === undefined || !req.url.startsWith("/__test/events/commit")) return false;
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return true;
    }
    const body = JSON.parse((await readBody(req)).toString("utf8")) as {
      key?: string;
      kinds?: string[];
      occurred_at?: string;
      provider_session_id?: string;
    };
    const chain = e02.chains[body.key ?? "live"];
    if (!chain || !Array.isArray(body.kinds) || body.kinds.length === 0) {
      res.statusCode = 400;
      res.end();
      return true;
    }
    const occurredAt =
      typeof body.occurred_at === "string" && Number.isFinite(Date.parse(body.occurred_at))
        ? body.occurred_at
        : new Date().toISOString();
    const events = body.kinds.map((kind) => {
      chain.sequence += 1;
      return {
        schema_version: 1,
        event_id: randomUlid(),
        source_stream_id: chain.stream,
        source_sequence: chain.sequence,
        run_execution_id: chain.executionId,
        assignment_generation: chain.generation,
        kind,
        occurred_at: occurredAt,
        capture_origin: "runner_observed",
        payload: {},
        ...(body.provider_session_id === undefined
          ? {}
          : { provider_session_id: body.provider_session_id }),
      };
    });
    const outcome = await workspaceHub(db, FIX.workspace).execute(ingestRunnerEventsCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorRunnerId: e02.runner,
      authorizationEpoch: 1,
      now: occurredAt,
      input: { principal: e02.principal, events },
    });
    if (!outcome.ok) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: outcome.error.code }));
      return true;
    }
    const result = outcome.result as IngestRunnerEventsResult;
    await realtime.afterCommand();
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        high_water_cursor: result.high_water_cursor,
        dispositions: result.dispositions.map((entry) => entry.disposition),
      }),
    );
    return true;
  }

  function handleE02Task(pathname: string, res: ServerResponse): boolean {
    if (pathname !== "/__test/e02/task") return false;
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        live_task_id: e02.chains.live?.taskId,
        live_run_id: e02.chains.live?.runId,
        stale_task_id: e02.chains.stale?.taskId,
        stale_run_id: e02.chains.stale?.runId,
      }),
    );
    return true;
  }

  async function handleE02Revoke(pathname: string, res: ServerResponse): Promise<boolean> {
    const match = pathname.match(/^\/__test\/session\/revoke\/(owner|member|restricted)$/);
    const role = match?.[1] as FixtureRole | undefined;
    if (!role) return false;
    await db
      .prepare(`DELETE FROM better_auth_sessions WHERE id = ?`)
      .run(E02_SESSION_BY_ROLE[role]);
    await realtime.afterCommand();
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ revoked: role }));
    return true;
  }

  async function handleE02Restore(pathname: string, res: ServerResponse): Promise<boolean> {
    const match = pathname.match(/^\/__test\/session\/restore\/(owner|member|restricted)$/);
    const role = match?.[1] as FixtureRole | undefined;
    if (!role) return false;
    const userId =
      role === "owner"
        ? "auth-owner-e2e"
        : role === "member"
          ? "auth-member-e2e"
          : "auth-restricted-e2e";
    await db
      .prepare(
        `INSERT INTO better_auth_sessions
         (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
         VALUES (?, '2027-08-07T12:00:00.000Z', ?, ?, ?, NULL, NULL, ?)
         ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at`,
      )
      .run(E02_SESSION_BY_ROLE[role], `auth-${role}-e2e-token`, NOW, NOW, userId);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ restored: role }));
    return true;
  }

  const realtimeServer = new WebSocketServer({ noServer: true });
  function rejectUpgrade(socket: Socket, status: string): void {
    socket.write(`HTTP/1.1 ${status}\r\nconnection: close\r\n\r\n`);
    socket.destroy();
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const pathname = new URL(req.url ?? "/", ORIGIN).pathname;
        if (handleFixtureSession(pathname, fixtureSessions, res)) {
          return;
        }
        if (handleE02Task(pathname, res)) {
          return;
        }
        if (await handleE02Revoke(pathname, res)) {
          return;
        }
        if (await handleE02Restore(pathname, res)) {
          return;
        }
        if (await handleE02Commit(req, res)) {
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

  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", ORIGIN);
        const match = url.pathname.match(/^\/realtime\/workspaces\/([^/]+)\/subscribe$/);
        const role = e02RoleOf(req);
        const protocol = req.headers["sec-websocket-protocol"];
        if (!match?.[1] || match[1] !== FIX.workspace || url.search) {
          rejectUpgrade(socket, "400 Bad Request");
          return;
        }
        if (protocol !== "bfb.browser.v1") {
          rejectUpgrade(socket, "400 Bad Request");
          return;
        }
        if (!role || role === "restricted") {
          rejectUpgrade(socket, "403 Forbidden");
          return;
        }
        const sessionId = E02_SESSION_BY_ROLE[role];
        const session = (await db
          .prepare(`SELECT expires_at FROM better_auth_sessions WHERE id = ?`)
          .get(sessionId)) as { expires_at: string } | undefined;
        if (!session) {
          rejectUpgrade(socket, "403 Forbidden");
          return;
        }
        const handshake = {
          schema_version: 1,
          workspaceId: FIX.workspace,
          humanId: E02_HUMAN_BY_ROLE[role],
          authorizationEpoch: 1,
          role,
          sessionId,
          sessionExpiresAt: session.expires_at,
        };
        realtimeServer.handleUpgrade(req, socket, head, (ws) => {
          const entry: NodeSocketEntry = { ws, tags: ["bfb-browser"], attachment: null };
          realtimeEntries.add(entry);
          const adapter: RealtimeSocket = {
            get readyState() {
              return entry.ws.readyState;
            },
            send: (data: string) => entry.ws.send(data),
            close: (code: number, reason: string) => entry.ws.close(code, reason),
            readAttachment: () => entry.attachment,
            writeAttachment: (value: unknown) => {
              entry.attachment = value;
            },
          };
          ws.on("message", (data) => {
            void realtime.message(adapter, data.toString());
          });
          ws.on("close", () => {
            realtimeEntries.delete(entry);
          });
          void realtime.admit(adapter, handshake).catch(() => {
            try {
              ws.close(1011, "channel_unavailable");
            } catch {
              /* Already disconnected. */
            }
            realtimeEntries.delete(entry);
          });
        });
      } catch {
        rejectUpgrade(socket, "500 Internal Server Error");
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => resolve());
  });

  console.log(`BFB_E2E_READY ${ORIGIN}`);
  console.log(`BFB_E2E_E02_LIVE_TASK ${e02.chains.live?.taskId}`);
  console.log(`BFB_E2E_E02_STALE_TASK ${e02.chains.stale?.taskId}`);
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
