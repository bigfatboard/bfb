// ABOUTME: Exercises mounted A02 attention list, read, answer, and resolve browser routes.
// ABOUTME: Route tests enforce session auth, role scope, version conflicts, and duplicate-answer safety.

import { describe, expect, it } from "vitest";

import {
  claimLaunchCommand,
  createAgentProfileCommand,
  FIX,
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
  createTaskCommand,
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

const NOW = "2026-08-12T08:00:00Z";
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
    APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
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
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
}

async function csrf(
  app: ReturnType<typeof appFor>,
  currentBindings: ControlBindings,
  cookie: string,
): Promise<string> {
  const response = await app.request(
    new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/session`, { headers: { cookie } }),
    undefined,
    currentBindings,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { csrf_token: string }).csrf_token;
}

function mutation(
  path: string,
  method: "POST",
  cookie: string,
  csrfToken: string,
  value: unknown,
): Request {
  return new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, {
    method,
    headers: {
      cookie,
      "content-type": "application/json",
      origin: AUTH_TEST_ENV.APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-bfb-csrf": csrfToken,
    },
    body: JSON.stringify(value),
  });
}

function get(path: string, cookie: string): Request {
  return new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, { headers: { cookie } });
}

async function contextWithSessions() {
  const context = openAuthTestContext();
  await seedSyntheticWorkspace(context.db, NOW);
  const owner = await seedAuthSession(context, {
    userId: "attention-owner-user",
    sessionId: "attention-owner-session",
    token: "attention-owner-token",
    email: "owner@synthetic.test",
    name: "Synthetic Owner",
    humanId: FIX.owner,
  });
  const reviewer = await seedAuthSession(context, {
    userId: "attention-reviewer-user",
    sessionId: "attention-reviewer-session",
    token: "attention-reviewer-token",
    email: "restricted@synthetic.test",
    name: "Synthetic Restricted",
    humanId: FIX.reviewer,
  });
  return { context, owner, reviewer };
}

/** Seeds one claimed run and one open attention request per kind through real hub commands. */
async function seedAttentionRun(
  context: AuthTestContext,
  kind: "clarification" | "credential",
  question: string,
): Promise<{ attentionId: string; runId: string }> {
  const db = context.db;
  const hub = new WorkspaceHub(db);
  const runner = randomUlid();
  const checkout = randomUlid();
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
    keyThumbprint: "synthetic-attention-key",
    authExpiresAt: launchDeadline(NOW, 300_000),
    projectIds: [FIX.projectA],
  };
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
  await db
    .prepare(
      `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
       VALUES (?, ?, ?, 'Synthetic attention Mac', '{}', ?, 1, ?)`,
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
      runnerHash("synthetic-attention-token"),
      JSON.stringify({
        v: 1,
        sub: runner,
        workspace_id: FIX.workspace,
        aud: "bfb-runner",
        iss: "https://bfb.example.test",
        jti: tokenId,
        iat: Date.parse(NOW) / 1000,
        exp: Date.parse(principal.authExpiresAt) / 1000,
        authorization_epoch: 1,
        owner_authorization_epoch: 1,
        grant_epoch: 1,
        token_epoch: 1,
        cnf: { jkt: principal.keyThumbprint },
      }),
      principal.authExpiresAt,
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
    name: "Synthetic attention provider",
    provider: "fake",
    model: "synthetic",
    executionMode: "interactive",
    harnessMode: "restricted",
  });
  const task = await human<{ id: string }>(createTaskCommand, {
    projectId: FIX.projectA,
    title: `Synthetic attention route task ${question.length}`,
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
        label: "Synthetic attention checkout",
        repository_identity: "synthetic/attention",
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
    kind,
    question,
    blocking: kind === "credential",
  });
  return { attentionId: requested.id, runId: requested.run_id };
}

describe("A02 browser attention API", () => {
  it("lists ranked attention and hides unknown IDs", async () => {
    const { context, owner, reviewer } = await contextWithSessions();
    const { attentionId } = await seedAttentionRun(
      context,
      "clarification",
      "Synthetic route question",
    );
    const app = appFor(context);
    const currentBindings = bindings(context);
    const base = `/api/v1/workspaces/${FIX.workspace}`;

    const listed = await app.request(
      get(`${base}/attention`, owner.cookie),
      undefined,
      currentBindings,
    );
    expect(listed.status, await listed.clone().text()).toBe(200);
    const body = (await listed.json()) as { attention: Array<{ id: string; rank_reason: string }> };
    expect(body.attention.map((entry) => entry.id)).toContain(attentionId);
    expect(body.attention[0]?.rank_reason).toContain("clarification");

    const reviewerListed = await app.request(
      get(`${base}/attention?state=open`, reviewer.cookie),
      undefined,
      currentBindings,
    );
    expect(reviewerListed.status).toBe(200);

    const missing = await app.request(
      get(`${base}/attention/${randomUlid()}`, reviewer.cookie),
      undefined,
      currentBindings,
    );
    expect(missing.status).toBe(404);
  });

  it("answers, resolves, and protects duplicates and versions", async () => {
    const { context, owner, reviewer } = await contextWithSessions();
    const { attentionId } = await seedAttentionRun(
      context,
      "clarification",
      "Synthetic answer flow",
    );
    const app = appFor(context);
    const currentBindings = bindings(context);
    const ownerCsrf = await csrf(app, currentBindings, owner.cookie);
    const reviewerCsrf = await csrf(app, currentBindings, reviewer.cookie);
    const base = `/api/v1/workspaces/${FIX.workspace}`;

    const answered = await app.request(
      mutation(`${base}/attention/${attentionId}/answer`, "POST", owner.cookie, ownerCsrf, {
        expected_version: 1,
        answer: "Synthetic route answer",
        request_id: "attention-route-answer-1",
      }),
      undefined,
      currentBindings,
    );
    expect(answered.status, await answered.clone().text()).toBe(200);

    const reread = await app.request(
      get(`${base}/attention/${attentionId}`, reviewer.cookie),
      undefined,
      currentBindings,
    );
    expect(reread.status).toBe(200);
    const rereadBody = (await reread.json()) as {
      attention: { state: string; answer: string };
      observations: Array<{ observed_kind: string }>;
    };
    expect(rereadBody.attention.state).toBe("answered");
    expect(rereadBody.attention.answer).toBe("Synthetic route answer");
    expect(rereadBody.observations.map((entry) => entry.observed_kind)).toEqual([
      "requested",
      "answered",
    ]);

    const duplicate = await app.request(
      mutation(`${base}/attention/${attentionId}/answer`, "POST", reviewer.cookie, reviewerCsrf, {
        expected_version: 2,
        answer: "Synthetic route overwrite",
        request_id: "attention-route-answer-2",
      }),
      undefined,
      currentBindings,
    );
    expect(duplicate.status).toBe(409);
    const duplicateBody = (await duplicate.json()) as {
      error: { code: string };
      attention: { answer: string };
    };
    expect(duplicateBody.error.code).toBe("already_answered");
    expect(duplicateBody.attention.answer).toBe("Synthetic route answer");

    const stale = await app.request(
      mutation(`${base}/attention/${attentionId}/resolve`, "POST", owner.cookie, ownerCsrf, {
        expected_version: 1,
        request_id: "attention-route-resolve-stale",
      }),
      undefined,
      currentBindings,
    );
    expect(stale.status).toBe(409);

    const resolved = await app.request(
      mutation(`${base}/attention/${attentionId}/resolve`, "POST", owner.cookie, ownerCsrf, {
        expected_version: 2,
        request_id: "attention-route-resolve-1",
      }),
      undefined,
      currentBindings,
    );
    expect(resolved.status, await resolved.clone().text()).toBe(200);
  });

  it("rejects reviewer answers on owner-only requests and unauthenticated writes", async () => {
    const { context, owner, reviewer } = await contextWithSessions();
    const { attentionId } = await seedAttentionRun(
      context,
      "credential",
      "Synthetic credential need",
    );
    const app = appFor(context);
    const currentBindings = bindings(context);
    const ownerCsrf = await csrf(app, currentBindings, owner.cookie);
    const reviewerCsrf = await csrf(app, currentBindings, reviewer.cookie);
    const base = `/api/v1/workspaces/${FIX.workspace}`;

    const denied = await app.request(
      mutation(`${base}/attention/${attentionId}/answer`, "POST", reviewer.cookie, reviewerCsrf, {
        expected_version: 1,
        answer: "Synthetic reviewer credential answer",
        request_id: "attention-route-cred-denied",
      }),
      undefined,
      currentBindings,
    );
    expect(denied.status).toBe(403);

    const allowed = await app.request(
      mutation(`${base}/attention/${attentionId}/answer`, "POST", owner.cookie, ownerCsrf, {
        expected_version: 1,
        answer: "Synthetic owner credential answer",
        request_id: "attention-route-cred-allowed",
      }),
      undefined,
      currentBindings,
    );
    expect(allowed.status, await allowed.clone().text()).toBe(200);

    const noSession = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/attention`, {
        method: "GET",
        headers: { authorization: "Bearer synthetic-confused" },
      }),
      undefined,
      currentBindings,
    );
    expect(noSession.status).toBe(401);
  });
});
