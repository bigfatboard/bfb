// ABOUTME: Exercises the X02 human CLI mirror over bearer CLI credentials.
// ABOUTME: Same-human browser/CLI parity, step-up gating, and credential separation are asserted.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  claimLaunchCommand,
  createAgentProfileCommand,
  createTaskCommand,
  FIX,
  issueStepUpProof,
  launchDeadline,
  randomUlid,
  replaceRunnerInventoryCommand,
  reportRepositoryConfigCommand,
  requestAttentionCommand,
  runnerHash,
  seedSyntheticWorkspace,
  startLaunchCommand,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  WorkspaceHub,
  type RunnerPrincipal,
} from "@bfb/domain";
import type { RunnerInventory } from "@bfb/protocol";

import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
  type AuthTestContext,
} from "./auth-helpers.js";

// Frozen in the past relative to wall-clock: the Better Auth device plugin
// stamps real-time expiries, so a future-frozen NOW would read codes as expired.
const NOW = "2026-08-18T12:00:00.000Z";
const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;
const DIGEST = `sha256:${"a".repeat(64)}`;
const EMPTY_CONFIG = `sha256:${runnerHash("{}")}`;

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

function bindings(context: AuthTestContext): ControlBindings {
  return {
    DB: fakeBinding<D1Database>("db"),
    ARTIFACTS: fakeBinding<R2Bucket>("r2"),
    ASSETS: fakeBinding<Fetcher>("assets"),
    JOBS: fakeBinding<Queue>("jobs"),
    JOBS_DLQ: fakeBinding<Queue>("dlq"),
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(context.db),
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
}

function appFor(context: AuthTestContext) {
  return createControlApp(validateControlEnv(bindings(context)), {
    db: context.db,
    now: NOW,
    abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
}

async function ownerSession(context: AuthTestContext) {
  const session = await seedAuthSession(context, {
    userId: "x02-owner-user",
    sessionId: "x02-owner-session",
    token: "x02-owner-token",
    email: "owner@synthetic.test",
    name: "Synthetic Owner",
    humanId: FIX.owner,
  });
  const app = appFor(context);
  const current = bindings(context);
  const authenticated = await app.request(
    new Request(`${ORIGIN}/auth/session`, { headers: { cookie: session.cookie } }),
    undefined,
    current,
  );
  expect(authenticated.status).toBe(200);
  const csrf = ((await authenticated.json()) as { csrf_token: string }).csrf_token;
  return { session, csrf };
}

function browserHeaders(session: { cookie: string }, csrf: string) {
  return {
    cookie: session.cookie,
    origin: ORIGIN,
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    "x-bfb-csrf": csrf,
  };
}

/** Mints one human CLI credential through the real device flow for the given browser session. */
async function mintCredential(
  context: AuthTestContext,
  session: { cookie: string },
  csrf: string,
  projectIds: string[] = [],
  ip = "192.0.2.201",
): Promise<{ credential: string; bindingId: string }> {
  const app = appFor(context);
  const current = bindings(context);
  const issued = await app.request(
    new Request(`${ORIGIN}/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ client_id: "bfb-cli" }),
    }),
    undefined,
    current,
  );
  expect(issued.status).toBe(200);
  const codes = (await issued.json()) as { device_code: string; user_code: string };
  const authorized = await app.request(
    new Request(`${ORIGIN}/api/v1/workspaces/${FIX.workspace}/cli/authorize`, {
      method: "POST",
      headers: { ...browserHeaders(session, csrf), "cf-connecting-ip": ip },
      body: JSON.stringify({ user_code: codes.user_code, project_ids: projectIds }),
    }),
    undefined,
    current,
  );
  expect(authorized.status, await authorized.clone().text()).toBe(201);
  const binding = ((await authorized.json()) as { binding: { binding_id: string } }).binding;
  const exchanged = await app.request(
    new Request(`${ORIGIN}/api/v1/cli/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ client_id: "bfb-cli", device_code: codes.device_code }),
    }),
    undefined,
    current,
  );
  expect(exchanged.status, await exchanged.clone().text()).toBe(200);
  const credential = ((await exchanged.json()) as { credential: string }).credential;
  return { credential, bindingId: binding.binding_id };
}

function cliHeaders(credential: string, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${credential}`, ...extra };
}

function cliGet(credential: string, path: string): Request {
  return new Request(`${ORIGIN}${path}`, { headers: cliHeaders(credential) });
}

function cliPost(credential: string, path: string, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: cliHeaders(credential, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

interface Seed {
  context: AuthTestContext;
  session: { cookie: string };
  csrf: string;
  credential: string;
  scopedCredential: string;
  taskId: string;
  runId: string;
  runVersion: number;
  attentionId: string;
}

/** Seeds owner auth, full and project-scoped CLI credentials, one launched run, and one open request. */
async function seed(): Promise<Seed> {
  const context = openAuthTestContext(NOW);
  await seedSyntheticWorkspace(context.db, NOW);
  const { session, csrf } = await ownerSession(context);
  const full = await mintCredential(context, session, csrf, [], "192.0.2.201");
  const scoped = await mintCredential(context, session, csrf, [FIX.projectA], "192.0.2.202");

  const db = context.db;
  const runner = randomUlid();
  const checkout = randomUlid();
  const tokenId = randomUlid();
  const hub = new WorkspaceHub(db);
  async function human<T>(command: Parameters<typeof hub.execute>[0], input: unknown): Promise<T> {
    const outcome = await hub.execute(command as never, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      input: input as never,
    });
    if (!outcome.ok) throw new Error(`seed human command failed: ${outcome.error.code}`);
    return outcome.result as T;
  }
  async function native<T>(command: Parameters<typeof hub.execute>[0], input: unknown): Promise<T> {
    const outcome = await hub.execute(command as never, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorRunnerId: runner,
      authorizationEpoch: 1,
      now: NOW,
      input: input as never,
    });
    if (!outcome.ok) throw new Error(`seed runner command failed: ${outcome.error.code}`);
    return outcome.result as T;
  }

  const authExpiresAt = launchDeadline(NOW, 300_000);
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
    keyThumbprint: "synthetic-x02-key",
    authExpiresAt,
    projectIds: [FIX.projectA],
  };
  await db
    .prepare(
      `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
       VALUES (?, ?, ?, 'Synthetic X02 Mac', '{}', ?, 1, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, principal.keyThumbprint, NOW);
  await db
    .prepare(`INSERT INTO runner_project_grants VALUES (?, ?, ?)`)
    .run(FIX.workspace, runner, FIX.projectA);
  await db
    .prepare(
      `INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, NOW);
  await db
    .prepare(
      `INSERT INTO runner_tokens (workspace_id, runner_id, id, token_hash, claims_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      FIX.workspace,
      runner,
      tokenId,
      runnerHash("synthetic-x02-token"),
      JSON.stringify({
        v: 1,
        sub: runner,
        workspace_id: FIX.workspace,
        aud: "bfb-runner",
        iss: ORIGIN,
        jti: tokenId,
        iat: Date.parse(NOW) / 1000,
        exp: Date.parse(authExpiresAt) / 1000,
        authorization_epoch: 1,
        owner_authorization_epoch: 1,
        grant_epoch: 1,
        token_epoch: 1,
        cnf: { jkt: principal.keyThumbprint },
      }),
      authExpiresAt,
    );
  const policy = {
    allowedProviders: ["fake"],
    allowAgentRootPropose: false,
    allowPassToAgent: true,
    allowRunOverrides: true,
  };
  await human(updateWorkspacePolicyCommand, { ...policy, expectedVersion: 1 });
  await human(updateProjectPolicyCommand, {
    ...policy,
    projectId: FIX.projectA,
    expectedVersion: 1,
  });
  await human(reportRepositoryConfigCommand, {
    projectId: FIX.projectA,
    expectedVersion: 1,
    document: {},
    contentHash: EMPTY_CONFIG,
  });
  const profile = await human<{ id: string }>(createAgentProfileCommand, {
    name: "Synthetic X02 provider",
    provider: "fake",
    model: "synthetic",
    executionMode: "interactive",
    harnessMode: "restricted",
  });
  const task = await human<{ id: string }>(createTaskCommand, {
    projectId: FIX.projectA,
    title: "Synthetic X02 route task",
    priority: "P2",
  });
  const inventory: RunnerInventory = {
    schema_version: 1,
    workspace_id: FIX.workspace,
    runner_id: runner,
    revision: 1,
    checkouts: [
      {
        schema_version: 1,
        checkout_id: checkout,
        workspace_id: FIX.workspace,
        runner_id: runner,
        project_id: FIX.projectA,
        label: "Synthetic X02 checkout",
        repository_identity: "synthetic/x02",
        workspace_subpath: ".",
        physical_worktree_hash: DIGEST,
        repository_config_hash: EMPTY_CONFIG,
        is_default: true,
        dirty: false,
        status: "validated",
        validated_at: NOW,
      },
    ],
    providers: [
      {
        provider: "fake",
        version: "1.0.0",
        manifest_id: DIGEST,
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
  await native(replaceRunnerInventoryCommand, { principal, inventory });
  const launch = await human<{ launch_id: string }>(startLaunchCommand, {
    schema_version: 1,
    idempotency_key: randomUlid(),
    task_id: task.id,
    expected_task_version: 1,
    runner_id: runner,
    checkout_id: checkout,
    agent_profile_id: profile.id,
    agent_profile_version: 1,
    workspace_policy_version: 2,
    project_policy_version: 2,
    repository_config_version: 2,
  });
  const claimed = await native<{
    state: string;
    claim: {
      specification: { run_execution_id: string; assignment_generation: number; run_id: string };
    };
  }>(claimLaunchCommand, {
    principal,
    claim: {
      schema_version: 1,
      launch_id: launch.launch_id,
      runner_id: runner,
      idempotency_key: randomUlid(),
      claimed_at: NOW,
    },
  });
  if (claimed.state !== "claimed") throw new Error(claimed.state);
  const requested = await native<{ id: string; run_id: string }>(requestAttentionCommand, {
    principal,
    runId: claimed.claim.specification.run_id,
    executionId: claimed.claim.specification.run_execution_id,
    assignmentGeneration: claimed.claim.specification.assignment_generation,
    kind: "clarification",
    question: "Synthetic X02 route question",
    blocking: true,
  });
  const run = (await db
    .prepare(`SELECT resource_version FROM runs WHERE workspace_id = ? AND id = ?`)
    .get(FIX.workspace, requested.run_id)) as { resource_version: number };
  return {
    context,
    session,
    csrf,
    credential: full.credential,
    scopedCredential: scoped.credential,
    taskId: task.id,
    runId: requested.run_id,
    runVersion: run.resource_version,
    attentionId: requested.id,
  };
}

function browserGet(session: { cookie: string }, path: string): Request {
  return new Request(`${ORIGIN}${path}`, { headers: { cookie: session.cookie } });
}

async function proofFor(
  context: AuthTestContext,
  runId: string,
  expectedRunVersion: number,
  scopes = ["bfb:read", "bfb:task:write"],
): Promise<string> {
  return issueStepUpProof(
    context.db,
    FIX.owner,
    {
      action: "cli:run:cancel",
      workspaceId: FIX.workspace,
      targetId: `cli:run:cancel:${runId}:${expectedRunVersion}`,
      scopes: [...scopes].sort(),
      authorizationEpoch: 1,
      expiresAt: new Date(Date.parse(NOW) + 5 * 60 * 1000).toISOString(),
    },
    NOW,
  );
}

describe("X02 human CLI surface", () => {
  it("serves public version diagnostics without a credential", async () => {
    const context = openAuthTestContext(NOW);
    await seedSyntheticWorkspace(context.db, NOW);
    const response = await appFor(context).request(
      new Request(`${ORIGIN}/api/v1/cli/version`),
      undefined,
      bindings(context),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      api_version: "1",
      wire_protocol: "bfb-wire/1",
      cli_min_version: "0.1.0",
      now: NOW,
    });
  });

  it("rejects missing, malformed, and cookie-mixed CLI credentials", async () => {
    const s = await seed();
    const app = appFor(s.context);
    const current = bindings(s.context);
    const anonymous = await app.request(
      new Request(`${ORIGIN}/api/v1/cli/projects`),
      undefined,
      current,
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({
      error: "unauthenticated",
      message: "CLI credential required",
    });
    const garbage = await app.request(
      cliGet("not-a-credential", "/api/v1/cli/projects"),
      undefined,
      current,
    );
    expect(garbage.status).toBe(401);
    const mixed = await app.request(
      new Request(`${ORIGIN}/api/v1/cli/projects`, {
        headers: { ...cliHeaders(s.credential), cookie: s.session.cookie },
      }),
      undefined,
      current,
    );
    expect(mixed.status).toBe(401);
    expect(await mixed.json()).toEqual({
      error: "credential_confusion",
      message: "CLI routes accept bearer CLI credentials only",
    });
    // Unknown CLI paths are uniformly rejected without an existence oracle.
    const unknown = await app.request(
      cliGet(s.credential, "/api/v1/cli/unknown"),
      undefined,
      current,
    );
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toEqual({
      error: "request_rejected",
      message: "request rejected",
    });
  });

  it("keeps CLI credentials off browser, runner, and MCP routes", async () => {
    const s = await seed();
    const app = appFor(s.context);
    const current = bindings(s.context);
    const base = `/api/v1/workspaces/${FIX.workspace}`;
    const browser = await app.request(
      new Request(`${ORIGIN}${base}/tasks`, {
        headers: { authorization: `Bearer ${s.credential}` },
      }),
      undefined,
      current,
    );
    expect(browser.status).toBe(401);
    expect(await browser.json()).toEqual({
      error: "credential_confusion",
      message: "bearer credentials cannot auth browser routes",
    });
    const runner = await app.request(
      new Request(`${ORIGIN}/runner/workspaces/${FIX.workspace}/runners/synthetic/commands/pull`, {
        headers: { authorization: `Bearer ${s.credential}` },
      }),
      undefined,
      current,
    );
    expect([401, 403]).toContain(runner.status);
    expect(JSON.stringify(await runner.clone().json()).includes(s.credential)).toBe(false);
    const mcp = await app.request(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${s.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      undefined,
      current,
    );
    expect([401, 403]).toContain(mcp.status);
    expect(JSON.stringify(await mcp.clone().json()).includes(s.credential)).toBe(false);
  });

  it("matches browser project reads and hides out-of-scope projects on both", async () => {
    const s = await seed();
    const app = appFor(s.context);
    const current = bindings(s.context);
    const base = `/api/v1/workspaces/${FIX.workspace}`;
    const viaBrowser = await app.request(
      browserGet(s.session, `${base}/projects`),
      undefined,
      current,
    );
    const viaCli = await app.request(
      cliGet(s.credential, "/api/v1/cli/projects"),
      undefined,
      current,
    );
    expect(viaCli.status).toBe(200);
    expect(await viaCli.json()).toEqual(await viaBrowser.json());
    for (const projectId of [FIX.projectA, FIX.projectB]) {
      const b = await app.request(
        browserGet(s.session, `${base}/projects/${projectId}`),
        undefined,
        current,
      );
      const c = await app.request(
        cliGet(s.credential, `/api/v1/cli/projects/${projectId}`),
        undefined,
        current,
      );
      expect(c.status).toBe(b.status);
      expect(await c.json()).toEqual(await b.json());
    }
    const scopedDenied = await app.request(
      cliGet(s.scopedCredential, `/api/v1/cli/projects/${FIX.projectB}`),
      undefined,
      current,
    );
    expect(scopedDenied.status).toBe(404);
    const scopedList = await app.request(
      cliGet(s.scopedCredential, "/api/v1/cli/projects"),
      undefined,
      current,
    );
    expect(((await scopedList.json()) as { projects: unknown[] }).projects).toHaveLength(1);
  });

  it("creates tasks through the CLI and reads them identically on both surfaces", async () => {
    const s = await seed();
    const app = appFor(s.context);
    const current = bindings(s.context);
    const base = `/api/v1/workspaces/${FIX.workspace}`;
    const created = await app.request(
      cliPost(s.credential, "/api/v1/cli/tasks", {
        project_id: FIX.projectA,
        title: "Synthetic X02 CLI task",
        request_id: randomUlid(),
      }),
      undefined,
      current,
    );
    expect(created.status, await created.clone().text()).toBe(200);
    const outcome = (await created.json()) as { ok: boolean; result: { id: string } };
    expect(outcome.ok).toBe(true);
    const viaCli = await app.request(
      cliGet(s.credential, `/api/v1/cli/tasks/${outcome.result.id}`),
      undefined,
      current,
    );
    const viaBrowser = await app.request(
      browserGet(s.session, `${base}/tasks/${outcome.result.id}`),
      undefined,
      current,
    );
    expect(viaCli.status).toBe(200);
    expect(await viaCli.json()).toEqual(await viaBrowser.json());
    const listed = await app.request(
      cliGet(s.credential, "/api/v1/cli/tasks?limit=50"),
      undefined,
      current,
    );
    expect(
      ((await listed.json()) as { tasks: Array<{ id: string }> }).tasks.map((entry) => entry.id),
    ).toContain(outcome.result.id);
    const missing = await app.request(
      cliPost(s.credential, "/api/v1/cli/tasks", {
        project_id: FIX.projectA,
        request_id: randomUlid(),
      }),
      undefined,
      current,
    );
    expect(missing.status).toBe(400);
    // Out-of-binding writes hide the project, mirroring browser reads.
    const foreign = await app.request(
      cliPost(s.scopedCredential, "/api/v1/cli/tasks", {
        project_id: FIX.projectB,
        title: "Synthetic X02 scoped task",
        request_id: randomUlid(),
      }),
      undefined,
      current,
    );
    expect(foreign.status).toBe(404);
  });

  it("reads runs identically and gates cancellation on confirm plus fresh proof", async () => {
    const s = await seed();
    const app = appFor(s.context);
    const current = bindings(s.context);
    const base = `/api/v1/workspaces/${FIX.workspace}`;
    const listed = await app.request(
      cliGet(s.credential, `/api/v1/cli/runs?task_id=${s.taskId}`),
      undefined,
      current,
    );
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { runs: Array<{ id: string }> }).runs.map((entry) => entry.id),
    ).toContain(s.runId);
    const read = await app.request(
      cliGet(s.credential, `/api/v1/cli/runs/${s.runId}`),
      undefined,
      current,
    );
    expect(read.status).toBe(200);
    const scopedRead = await app.request(
      cliGet(s.scopedCredential, `/api/v1/cli/runs/${s.runId}`),
      undefined,
      current,
    );
    expect(scopedRead.status).toBe(200);
    const missingTask = await app.request(
      cliGet(s.credential, `/api/v1/cli/runs?task_id=${FIX.taskProposed}`),
      undefined,
      current,
    );
    expect(missingTask.status).toBe(404);

    const path = `/api/v1/cli/runs/${s.runId}/cancellation`;
    const noConfirm = await app.request(
      cliPost(s.credential, path, {
        expected_run_version: s.runVersion,
        step_up_proof_id: await proofFor(s.context, s.runId, s.runVersion),
        request_id: randomUlid(),
      }),
      undefined,
      current,
    );
    expect(noConfirm.status).toBe(400);
    const noProof = await app.request(
      cliPost(s.credential, path, {
        expected_run_version: s.runVersion,
        confirm: `run:${s.runId}`,
        step_up_proof_id: "synthetic-unknown-proof",
        request_id: randomUlid(),
      }),
      undefined,
      current,
    );
    expect(noProof.status).toBe(403);
    expect(((await noProof.json()) as { error: string }).error).toBe("step_up_invalid");
    const wrongTarget = await app.request(
      cliPost(s.credential, path, {
        expected_run_version: s.runVersion,
        confirm: `run:${s.runId}`,
        step_up_proof_id: await proofFor(s.context, FIX.runDelegable, s.runVersion),
        request_id: randomUlid(),
      }),
      undefined,
      current,
    );
    expect(wrongTarget.status).toBe(403);
    expect(((await wrongTarget.json()) as { error: string }).error).toBe("step_up_mismatch");
    const cancelled = await app.request(
      cliPost(s.credential, path, {
        expected_run_version: s.runVersion,
        confirm: `run:${s.runId}`,
        step_up_proof_id: await proofFor(s.context, s.runId, s.runVersion),
        request_id: randomUlid(),
      }),
      undefined,
      current,
    );
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    const cliRun = await app.request(
      cliGet(s.credential, `/api/v1/cli/runs/${s.runId}`),
      undefined,
      current,
    );
    const browserRun = await app.request(
      browserGet(s.session, `${base}/runs/${s.runId}`),
      undefined,
      current,
    );
    expect(browserRun.status).toBe(200);
    const cliRunBody = (await cliRun.json()) as { run: { result_state: string } };
    const browserRunBody = (await browserRun.json()) as { run: { result_state: string } };
    expect(cliRunBody).toEqual(browserRunBody);
    expect(browserRunBody.run.result_state).toBe("cancelled");
  });

  it("answers and resolves attention with identical outcomes on both surfaces", async () => {
    const s = await seed();
    const app = appFor(s.context);
    const current = bindings(s.context);
    const base = `/api/v1/workspaces/${FIX.workspace}`;
    const listed = await app.request(
      cliGet(s.credential, "/api/v1/cli/attention?state=open"),
      undefined,
      current,
    );
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { attention: Array<{ id: string }> }).attention.map(
        (entry) => entry.id,
      ),
    ).toContain(s.attentionId);
    const viaCli = await app.request(
      cliGet(s.credential, `/api/v1/cli/attention/${s.attentionId}`),
      undefined,
      current,
    );
    const viaBrowser = await app.request(
      browserGet(s.session, `${base}/attention/${s.attentionId}`),
      undefined,
      current,
    );
    expect(viaCli.status).toBe(200);
    expect(await viaCli.json()).toEqual(await viaBrowser.json());

    const answered = await app.request(
      cliPost(s.credential, `/api/v1/cli/attention/${s.attentionId}/answer`, {
        expected_version: 1,
        answer: "Synthetic X02 CLI answer",
        request_id: randomUlid(),
      }),
      undefined,
      current,
    );
    expect(answered.status, await answered.clone().text()).toBe(200);
    const duplicate = await app.request(
      cliPost(s.credential, `/api/v1/cli/attention/${s.attentionId}/answer`, {
        expected_version: 2,
        answer: "Synthetic X02 second answer",
        request_id: randomUlid(),
      }),
      undefined,
      current,
    );
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as { error: { code: string } }).error.code).toBe(
      "already_answered",
    );
    const resolved = await app.request(
      cliPost(s.credential, `/api/v1/cli/attention/${s.attentionId}/resolve`, {
        expected_version: 2,
        request_id: randomUlid(),
      }),
      undefined,
      current,
    );
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    const cliFinal = await app.request(
      cliGet(s.credential, `/api/v1/cli/attention/${s.attentionId}`),
      undefined,
      current,
    );
    const browserFinal = await app.request(
      browserGet(s.session, `${base}/attention/${s.attentionId}`),
      undefined,
      current,
    );
    expect(cliFinal.status).toBe(200);
    const cliFinalBody = (await cliFinal.json()) as {
      attention: { state: string; answer: string };
    };
    const browserFinalBody = (await browserFinal.json()) as {
      attention: { state: string; answer: string };
    };
    expect(cliFinalBody).toEqual(browserFinalBody);
    expect(browserFinalBody.attention).toMatchObject({
      state: "resolved",
      answer: "Synthetic X02 CLI answer",
    });
  });

  it("reads run-bound artifact metadata and hides unbound or foreign rows", async () => {
    const s = await seed();
    const app = appFor(s.context);
    const current = bindings(s.context);
    const artifactId = randomUlid();
    const versionId = randomUlid();
    await s.context.db
      .prepare(
        `INSERT INTO artifacts (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
         VALUES (?, ?, ?, 'markdown', 'review', ?, ?)`,
      )
      .run(FIX.workspace, artifactId, s.runId, FIX.owner, NOW);
    await s.context.db
      .prepare(
        `INSERT INTO artifact_versions
         (workspace_id, id, artifact_id, state, format, declared_size, expected_digest, content_hash, r2_key, created_at, available_at)
         VALUES (?, ?, ?, 'available', 'markdown', 12, ?, ?, ?, ?, ?)`,
      )
      .run(
        FIX.workspace,
        versionId,
        artifactId,
        "a".repeat(64),
        "b".repeat(64),
        `${FIX.workspace}/artifacts/${"b".repeat(64)}`,
        NOW,
        NOW,
      );
    const listed = await app.request(
      cliGet(s.credential, `/api/v1/cli/artifacts?run_id=${s.runId}`),
      undefined,
      current,
    );
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as {
      artifacts: Array<{ id: string }>;
      versions: Array<Record<string, unknown>>;
    };
    expect(listBody.artifacts.map((entry) => entry.id)).toContain(artifactId);
    expect(listBody.versions.map((entry) => entry.id)).toContain(versionId);
    for (const version of listBody.versions) {
      expect(version).not.toHaveProperty("secret");
      expect(version).not.toHaveProperty("grant");
    }
    const read = await app.request(
      cliGet(s.credential, `/api/v1/cli/artifacts/${artifactId}`),
      undefined,
      current,
    );
    expect(read.status).toBe(200);
    const orphanId = randomUlid();
    await s.context.db
      .prepare(
        `INSERT INTO artifacts (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
         VALUES (?, ?, NULL, 'markdown', 'review', ?, ?)`,
      )
      .run(FIX.workspace, orphanId, FIX.owner, NOW);
    const orphan = await app.request(
      cliGet(s.credential, `/api/v1/cli/artifacts/${orphanId}`),
      undefined,
      current,
    );
    expect(orphan.status).toBe(404);
    const missingRun = await app.request(
      cliGet(s.credential, `/api/v1/cli/artifacts?run_id=${FIX.runDelegable}`),
      undefined,
      current,
    );
    expect(missingRun.status).toBe(404);
  });

  it("revokes its own binding on logout and disables the credential", async () => {
    const s = await seed();
    const app = appFor(s.context);
    const current = bindings(s.context);
    const revoked = await app.request(
      cliPost(s.credential, "/api/v1/cli/session/revoke", {}),
      undefined,
      current,
    );
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    const after = await app.request(
      cliGet(s.credential, "/api/v1/cli/projects"),
      undefined,
      current,
    );
    expect(after.status).toBe(401);
    const again = await app.request(
      cliPost(s.credential, "/api/v1/cli/session/revoke", {}),
      undefined,
      current,
    );
    expect(again.status).toBe(401);
  });

  it("keeps domain mutation inside owning packages, never in the CLI assembler", () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../src/api/cli-human.ts"),
      "utf8",
    );
    for (const keyword of ["INSERT INTO", "UPDATE ", "DELETE FROM"]) {
      expect(source.includes(keyword)).toBe(false);
    }
    for (const owned of [
      "cancelRunCommand",
      "answerAttentionCommand",
      "resolveAttentionCommand",
      "createTaskCommand",
      "revokeBindingCommand",
    ]) {
      expect(source.includes(owned)).toBe(true);
    }
  });
});
