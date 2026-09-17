// ABOUTME: Local E2E HTTP server that mounts createControlApp against fixture DB plus the web SPA.
// ABOUTME: Prints FIX.workspace and listens on a fixed port so Playwright can drive real browser flows.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import {
  authorizeLaunchCommand,
  claimLaunchCommand,
  createAgentProfileCommand,
  FIX,
  launchDeadline,
  observeCheckoutLeaseCommand,
  randomUlid,
  reportRepositoryConfigCommand,
  runnerHash,
  seedSyntheticWorkspace,
  startLaunchCommand,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  WorkspaceHub,
  type HubCommand,
  type RunnerPrincipal,
} from "@bfb/domain";

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

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

const W02_RUNNER = FIX.taskLaunch.slice(0, 24) + "R1";
const W02_CHECKOUT_A = FIX.taskLaunch.slice(0, 24) + "A1";
const W02_CHECKOUT_B = FIX.taskLaunch.slice(0, 24) + "B1";
const W02_CHECKOUT_C = FIX.taskLaunch.slice(0, 24) + "C1";
const W02_HASH_A = `sha256:${"a".repeat(64)}`;
const W02_HASH_B = `sha256:${"b".repeat(64)}`;
const W02_HASH_C = `sha256:${"c".repeat(64)}`;
const W02_EMPTY_CONFIG = `sha256:${runnerHash("{}")}`;

/**
 * Seeds one synthetic owner runner with two validated checkouts, a fake
 * provider profile, and three settled launch chains. The ready task is left
 * for the browser to Start; hub commands keep every settled chain honest.
 */
async function seedLaunchOperations(db: SqlDatabase): Promise<void> {
  const hub = new WorkspaceHub(db);
  async function human<I, R>(command: HubCommand<I, R>, input: I): Promise<R> {
    const outcome = await hub.execute(command, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      idempotencyKey: randomUlid(),
      input,
    });
    if (!outcome.ok) {
      throw new Error(`w02 seed failed: ${JSON.stringify(outcome)}`);
    }
    return outcome.result;
  }
  function native<I, R>(command: HubCommand<I, R>, input: I, now = NOW) {
    return hub.execute(command, {
      workspaceId: FIX.workspace,
      actorRunnerId: W02_RUNNER,
      authorizationEpoch: 1,
      now,
      idempotencyKey: randomUlid(),
      input,
    });
  }
  async function nativeOk<I, R>(command: HubCommand<I, R>, input: I, now = NOW): Promise<R> {
    const outcome = await native(command, input, now);
    if (!outcome.ok) {
      throw new Error(`w02 seed failed: ${JSON.stringify(outcome)}`);
    }
    return outcome.result;
  }

  const policy = {
    allowedProviders: ["claude", "codex", "grok", "fake"],
    allowAgentRootPropose: false,
    allowPassToAgent: true,
    allowRunOverrides: true,
  } as const;
  await human(updateWorkspacePolicyCommand, {
    ...policy,
    allowedProviders: [...policy.allowedProviders],
    expectedVersion: 1,
  });
  await human(updateProjectPolicyCommand, {
    ...policy,
    allowedProviders: [...policy.allowedProviders],
    expectedVersion: 1,
    projectId: FIX.projectA,
  });
  await human(reportRepositoryConfigCommand, {
    projectId: FIX.projectA,
    expectedVersion: 1,
    document: {},
    contentHash: W02_EMPTY_CONFIG,
  });
  const profile = await human(createAgentProfileCommand, {
    name: "Synthetic launch provider",
    provider: "fake",
    model: "synthetic",
    executionMode: "interactive",
    harnessMode: "restricted",
  });

  const thumbprint = `sha256:${"c".repeat(64)}`;
  await db
    .prepare(
      `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
       VALUES (?, ?, ?, 'Synthetic Launch Mac', '{}', ?, 1, ?)`,
    )
    .run(FIX.workspace, W02_RUNNER, FIX.owner, thumbprint, NOW);
  await db
    .prepare(`INSERT INTO runner_project_grants VALUES (?, ?, ?)`)
    .run(FIX.workspace, W02_RUNNER, FIX.projectA);
  for (const launcher of [FIX.owner, FIX.member]) {
    await db
      .prepare(
        `INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(FIX.workspace, W02_RUNNER, launcher, NOW);
  }
  const tokenId = randomUlid();
  await db
    .prepare(
      `INSERT INTO runner_tokens (workspace_id, runner_id, id, token_hash, claims_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      FIX.workspace,
      W02_RUNNER,
      tokenId,
      runnerHash("synthetic-not-a-token"),
      JSON.stringify({
        v: 1,
        sub: W02_RUNNER,
        workspace_id: FIX.workspace,
        aud: "bfb-runner",
        iss: "https://bfb.example.test",
        jti: tokenId,
        iat: Date.parse(NOW) / 1000,
        exp: Date.parse(NOW) / 1000 + 3600,
        authorization_epoch: 1,
        owner_authorization_epoch: 1,
        grant_epoch: 1,
        token_epoch: 1,
        cnf: { jkt: thumbprint },
      }),
      new Date(Date.parse(NOW) + 3600_000).toISOString(),
    );
  const inventory = {
    schema_version: 1,
    workspace_id: FIX.workspace,
    runner_id: W02_RUNNER,
    revision: 1,
    checkouts: [
      {
        schema_version: 1,
        checkout_id: W02_CHECKOUT_A,
        workspace_id: FIX.workspace,
        runner_id: W02_RUNNER,
        project_id: FIX.projectA,
        label: "Synthetic Alpha Checkout",
        repository_identity: "synthetic/alpha",
        workspace_subpath: ".",
        physical_worktree_hash: W02_HASH_A,
        repository_config_hash: W02_EMPTY_CONFIG,
        is_default: true,
        branch: "main",
        head: "a".repeat(40),
        dirty: false,
        status: "validated",
        validated_at: NOW,
      },
      {
        schema_version: 1,
        checkout_id: W02_CHECKOUT_B,
        workspace_id: FIX.workspace,
        runner_id: W02_RUNNER,
        project_id: FIX.projectA,
        label: "Synthetic Beta Checkout",
        repository_identity: "synthetic/alpha",
        workspace_subpath: ".",
        physical_worktree_hash: W02_HASH_B,
        repository_config_hash: W02_EMPTY_CONFIG,
        is_default: false,
        branch: "feature/synthetic",
        head: "b".repeat(40),
        dirty: true,
        status: "validated",
        validated_at: NOW,
      },
      {
        schema_version: 1,
        checkout_id: W02_CHECKOUT_C,
        workspace_id: FIX.workspace,
        runner_id: W02_RUNNER,
        project_id: FIX.projectA,
        label: "Synthetic Gamma Checkout",
        repository_identity: "synthetic/alpha",
        workspace_subpath: ".",
        physical_worktree_hash: W02_HASH_C,
        repository_config_hash: W02_EMPTY_CONFIG,
        is_default: false,
        branch: "main",
        head: "c".repeat(40),
        dirty: false,
        status: "validated",
        validated_at: NOW,
      },
    ],
    providers: [
      {
        provider: "fake",
        version: "1.0.0",
        manifest_id: W02_HASH_A,
        status: "healthy",
        observed_at: NOW,
        expires_at: launchDeadline(NOW, 30_000),
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
  await db
    .prepare(
      `INSERT INTO runner_inventories (workspace_id, runner_id, revision, inventory_json, received_at)
       VALUES (?, ?, 1, ?, ?)`,
    )
    .run(FIX.workspace, W02_RUNNER, JSON.stringify(inventory), NOW);

  for (const [taskId, title] of [
    [FIX.taskLaunch, "Synthetic launch card"],
    [FIX.taskLaunchStart, "Synthetic member launch card"],
    [FIX.taskLaunchExpired, "Synthetic expired launch"],
    [FIX.taskLaunchContained, "Synthetic contained launch"],
    [FIX.taskLaunchEnded, "Synthetic ended launch"],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO tasks (
           workspace_id, id, project_id, parent_task_id, title, state, priority, due_at,
           next_owner_type, next_owner_id, next_action_reason, punchline,
           resource_version, created_by_human_id, created_by_delegation_id, created_at
         ) VALUES (?, ?, ?, NULL, ?, 'ready', 'P1', NULL, 'human', ?, 'Launch the synthetic card.', 'Synthetic punchline.', 1, ?, NULL, ?)`,
      )
      .run(FIX.workspace, taskId, FIX.projectA, title, FIX.owner, FIX.owner, NOW);
  }

  const principal: RunnerPrincipal = {
    kind: "runner",
    workspaceId: FIX.workspace,
    runnerId: W02_RUNNER,
    ownerHumanId: FIX.owner,
    authorizationEpoch: 1,
    ownerAuthorizationEpoch: 1,
    grantEpoch: 1,
    tokenEpoch: 1,
    tokenId,
    keyThumbprint: thumbprint,
    authExpiresAt: new Date(Date.parse(NOW) + 3600_000).toISOString(),
    projectIds: [FIX.projectA],
  };
  async function start(taskId: string, checkoutId: string) {
    return human(startLaunchCommand, {
      schema_version: 1,
      idempotency_key: randomUlid(),
      task_id: taskId,
      expected_task_version: 1,
      runner_id: W02_RUNNER,
      checkout_id: checkoutId,
      agent_profile_id: profile.id,
      agent_profile_version: 1,
      workspace_policy_version: 2,
      project_policy_version: 2,
      repository_config_version: 2,
    });
  }

  const expired = await start(FIX.taskLaunchExpired, W02_CHECKOUT_A);
  const expiredAt = new Date(Date.parse(NOW) + 130_000).toISOString();
  await nativeOk(
    claimLaunchCommand,
    {
      principal,
      claim: {
        schema_version: 1,
        launch_id: expired.launch_id,
        runner_id: W02_RUNNER,
        idempotency_key: randomUlid(),
        claimed_at: expiredAt,
      },
    },
    expiredAt,
  );

  const contained = await start(FIX.taskLaunchContained, W02_CHECKOUT_B);
  const containedClaim = await nativeOk(claimLaunchCommand, {
    principal,
    claim: {
      schema_version: 1,
      launch_id: contained.launch_id,
      runner_id: W02_RUNNER,
      idempotency_key: randomUlid(),
      claimed_at: NOW,
    },
  });
  if (containedClaim.state !== "claimed") {
    throw new Error("w02 seed failed: contained claim did not win");
  }
  await nativeOk(observeCheckoutLeaseCommand, {
    principal,
    observation: {
      schema_version: 1,
      run_execution_id: containedClaim.claim.specification.run_execution_id,
      assignment_generation: containedClaim.claim.specification.assignment_generation,
      fencing_generation: containedClaim.claim.fencing_generation,
      sequence: 1,
      observed_at: NOW,
      operation: "renew",
      supervisor: {
        pid: 1234,
        start_identity: "123456:1000",
        executable_hash: W02_HASH_A,
      },
      local_lock_id: randomUlid(),
      owned_group_id: 1235,
      owned_group_start_identity: "123456:2000",
      supervisor_state: "verified",
      group_state: "live",
      lock_state: "held",
      descendants_state: "escaped",
      recovery_local: false,
    },
  });

  const ended = await start(FIX.taskLaunchEnded, W02_CHECKOUT_C);
  const endedClaim = await nativeOk(claimLaunchCommand, {
    principal,
    claim: {
      schema_version: 1,
      launch_id: ended.launch_id,
      runner_id: W02_RUNNER,
      idempotency_key: randomUlid(),
      claimed_at: NOW,
    },
  });
  if (endedClaim.state !== "claimed") {
    throw new Error("w02 seed failed: ended claim did not win");
  }
  const final = endedClaim.claim;
  const endedLockId = randomUlid();
  await nativeOk(authorizeLaunchCommand, {
    principal,
    authorization: {
      schema_version: 1,
      launch_id: ended.launch_id,
      run_execution_id: final.specification.run_execution_id,
      assignment_generation: final.specification.assignment_generation,
      fencing_generation: final.fencing_generation,
      config_snapshot_id: final.specification.config_snapshot_id,
      config_snapshot_hash: final.specification.config_snapshot_hash,
      repository_config_hash: final.snapshot.repository_config_hash,
      physical_worktree_hash: final.snapshot.physical_worktree_hash,
      supervisor: {
        pid: 1234,
        start_identity: "123456:1000",
        executable_hash: W02_HASH_A,
      },
      local_lock_id: endedLockId,
    },
  });
  const liveObservation = {
    schema_version: 1,
    run_execution_id: final.specification.run_execution_id,
    assignment_generation: final.specification.assignment_generation,
    fencing_generation: final.fencing_generation,
    sequence: 1,
    observed_at: NOW,
    operation: "renew",
    supervisor: {
      pid: 1234,
      start_identity: "123456:1000",
      executable_hash: W02_HASH_A,
    },
    local_lock_id: endedLockId,
    owned_group_id: 1235,
    owned_group_start_identity: "123456:2000",
    supervisor_state: "verified",
    group_state: "live",
    lock_state: "held",
    descendants_state: "contained",
    recovery_local: false,
  } as const;
  await nativeOk(observeCheckoutLeaseCommand, { principal, observation: liveObservation });
  await nativeOk(observeCheckoutLeaseCommand, {
    principal,
    observation: {
      ...liveObservation,
      sequence: 2,
      operation: "release",
      supervisor_state: "gone",
      group_state: "gone",
      lock_state: "gone",
      descendants_state: "gone",
    },
  });
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
  await seedLaunchOperations(authContext.db);
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
