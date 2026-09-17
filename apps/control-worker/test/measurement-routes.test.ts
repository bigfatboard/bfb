// ABOUTME: Exercises mounted A04 measurement reads and human review-timer/browser routes.
// ABOUTME: Route tests enforce session auth, project scope, timer races, and honest empty states.

import { describe, expect, it } from "vitest";

import {
  createAgentProfileCommand,
  createRunCommand,
  createTaskCommand,
  FIX,
  randomUlid,
  reportRepositoryConfigCommand,
  runnerHash,
  seedSyntheticWorkspace,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  WorkspaceHub,
} from "@bfb/domain";

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
    userId: "measurements-owner-user",
    sessionId: "measurements-owner-session",
    token: "measurements-owner-token",
    email: "owner@synthetic.test",
    name: "Synthetic Owner",
    humanId: FIX.owner,
  });
  const reviewer = await seedAuthSession(context, {
    userId: "measurements-reviewer-user",
    sessionId: "measurements-reviewer-session",
    token: "measurements-reviewer-token",
    email: "restricted@synthetic.test",
    name: "Synthetic Restricted",
    humanId: FIX.reviewer,
  });
  return { context, owner, reviewer };
}

/** Seeds one task with one direct run through real hub commands (no runner needed for reads). */
async function seedMeasuredTask(
  context: AuthTestContext,
  projectId: string = FIX.projectA,
): Promise<{ taskId: string; runId: string }> {
  const db = context.db;
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
  const policy = {
    allowedProviders: ["fake"],
    allowAgentRootPropose: false,
    allowPassToAgent: true,
    allowRunOverrides: true,
  };
  await human(updateWorkspacePolicyCommand, { ...policy, expectedVersion: 1 });
  await human(updateProjectPolicyCommand, { ...policy, projectId, expectedVersion: 1 });
  await human(reportRepositoryConfigCommand, {
    projectId,
    expectedVersion: 1,
    document: {},
    contentHash: EMPTY_CONFIG,
  });
  const profile = await human<{ id: string }>(createAgentProfileCommand, {
    name: "Synthetic measurements provider",
    provider: "fake",
    model: "synthetic",
    executionMode: "interactive",
    harnessMode: "restricted",
  });
  const task = await human<{ id: string }>(createTaskCommand, {
    projectId,
    title: "Synthetic measurements route task",
    priority: "P2",
  });
  const created = await human<{ run: { id: string } }>(createRunCommand, {
    taskId: task.id,
    expectedTaskVersion: 1,
    agentProfileId: profile.id,
    agentProfileVersion: 1,
    workspacePolicyVersion: 2,
    projectPolicyVersion: 2,
    repositoryConfigVersion: 2,
  });
  return { taskId: task.id, runId: created.run.id };
}

describe("A04 browser measurements API", () => {
  it("reads separated task and run measurements with honest empty states", async () => {
    const { context, owner, reviewer } = await contextWithSessions();
    const { taskId, runId } = await seedMeasuredTask(context);
    const app = appFor(context);
    const currentBindings = bindings(context);
    const base = `/api/v1/workspaces/${FIX.workspace}`;

    const taskResponse = await app.request(
      get(`${base}/tasks/${taskId}/measurements`, owner.cookie),
      undefined,
      currentBindings,
    );
    expect(taskResponse.status, await taskResponse.clone().text()).toBe(200);
    const taskBody = (await taskResponse.json()) as {
      measurements: {
        task_id: string;
        runs: unknown[];
        totals: Record<string, unknown>;
        review: { stopped_total_ms: number; open_ms: number };
        attention: unknown[];
        interventions: { runs: number; restarts: number };
        browser_activity: unknown[];
      };
    };
    expect(taskBody.measurements.task_id).toBe(taskId);
    expect(taskBody.measurements.runs).toHaveLength(1);
    expect(taskBody.measurements.interventions).toMatchObject({ runs: 1, restarts: 0 });
    expect(taskBody.measurements.review).toMatchObject({ stopped_total_ms: 0, open_ms: 0 });

    const runResponse = await app.request(
      get(`${base}/runs/${runId}/measurements`, owner.cookie),
      undefined,
      currentBindings,
    );
    expect(runResponse.status, await runResponse.clone().text()).toBe(200);
    const runBody = (await runResponse.json()) as {
      measurements: {
        run_id: string;
        times: Record<string, unknown>;
        tokens: { catalog_version: string; unavailable_count: number };
        provenance: Record<string, number>;
      };
    };
    expect(runBody.measurements.run_id).toBe(runId);
    expect(runBody.measurements.times.launch_latency_reason).toBe("no launch command for this run");
    expect(runBody.measurements.times.external_wait_ms).toBeNull();
    expect(runBody.measurements.times.idle_ms).toBeNull();
    expect(runBody.measurements.tokens.catalog_version).toBe("2026-09-01");
    expect(runBody.measurements.provenance.ledger_events).toBe(0);

    const reviewerRead = await app.request(
      get(`${base}/tasks/${taskId}/measurements`, reviewer.cookie),
      undefined,
      currentBindings,
    );
    expect(reviewerRead.status).toBe(200);

    const missingTask = await app.request(
      get(`${base}/tasks/${randomUlid()}/measurements`, owner.cookie),
      undefined,
      currentBindings,
    );
    expect(missingTask.status).toBe(404);
    const missingRun = await app.request(
      get(`${base}/runs/${randomUlid()}/measurements`, owner.cookie),
      undefined,
      currentBindings,
    );
    expect(missingRun.status).toBe(404);
  });

  it("hides project-scoped measurements from ungranted reviewers", async () => {
    const { context, owner, reviewer } = await contextWithSessions();
    const { taskId } = await seedMeasuredTask(context, FIX.projectB);
    const app = appFor(context);
    const currentBindings = bindings(context);
    const base = `/api/v1/workspaces/${FIX.workspace}`;

    const ownerRead = await app.request(
      get(`${base}/tasks/${taskId}/measurements`, owner.cookie),
      undefined,
      currentBindings,
    );
    expect(ownerRead.status).toBe(200);
    const reviewerRead = await app.request(
      get(`${base}/tasks/${taskId}/measurements`, reviewer.cookie),
      undefined,
      currentBindings,
    );
    expect(reviewerRead.status).toBe(404);
  });

  it("starts and stops review timers with version races", async () => {
    const { context, owner, reviewer } = await contextWithSessions();
    const { taskId } = await seedMeasuredTask(context);
    const app = appFor(context);
    const currentBindings = bindings(context);
    const ownerCsrf = await csrf(app, currentBindings, owner.cookie);
    const reviewerCsrf = await csrf(app, currentBindings, reviewer.cookie);
    const base = `/api/v1/workspaces/${FIX.workspace}`;

    const started = await app.request(
      mutation(`${base}/tasks/${taskId}/review-timers`, "POST", owner.cookie, ownerCsrf, {
        request_id: "measurements-timer-start-1",
      }),
      undefined,
      currentBindings,
    );
    expect(started.status, await started.clone().text()).toBe(200);
    const startedBody = (await started.json()) as { result: { id: string; state: string } };
    const timerId = startedBody.result.id;
    expect(startedBody.result.state).toBe("open");

    const listed = await app.request(
      get(`${base}/tasks/${taskId}/review-timers`, owner.cookie),
      undefined,
      currentBindings,
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { timers: Array<{ id: string }> };
    expect(listedBody.timers.map((entry) => entry.id)).toContain(timerId);

    const duplicate = await app.request(
      mutation(`${base}/tasks/${taskId}/review-timers`, "POST", owner.cookie, ownerCsrf, {
        request_id: "measurements-timer-start-2",
      }),
      undefined,
      currentBindings,
    );
    expect(duplicate.status).toBe(400);

    const reviewerTimer = await app.request(
      mutation(`${base}/tasks/${taskId}/review-timers`, "POST", reviewer.cookie, reviewerCsrf, {
        request_id: "measurements-timer-start-3",
      }),
      undefined,
      currentBindings,
    );
    expect(reviewerTimer.status).toBe(200);

    const foreignStop = await app.request(
      mutation(`${base}/review-timers/${timerId}/stop`, "POST", reviewer.cookie, reviewerCsrf, {
        expected_version: 1,
        request_id: "measurements-timer-stop-foreign",
      }),
      undefined,
      currentBindings,
    );
    expect(foreignStop.status).toBe(403);

    const stopped = await app.request(
      mutation(`${base}/review-timers/${timerId}/stop`, "POST", owner.cookie, ownerCsrf, {
        expected_version: 1,
        request_id: "measurements-timer-stop-1",
      }),
      undefined,
      currentBindings,
    );
    expect(stopped.status, await stopped.clone().text()).toBe(200);

    const repeated = await app.request(
      mutation(`${base}/review-timers/${timerId}/stop`, "POST", owner.cookie, ownerCsrf, {
        expected_version: 2,
        request_id: "measurements-timer-stop-2",
      }),
      undefined,
      currentBindings,
    );
    expect(repeated.status).toBe(400);

    const unknownStop = await app.request(
      mutation(`${base}/review-timers/${randomUlid()}/stop`, "POST", owner.cookie, ownerCsrf, {
        expected_version: 1,
        request_id: "measurements-timer-stop-3",
      }),
      undefined,
      currentBindings,
    );
    expect(unknownStop.status).toBe(404);
  });

  it("records capped browser activity and surfaces it as estimated", async () => {
    const { context, owner } = await contextWithSessions();
    const { taskId } = await seedMeasuredTask(context);
    const app = appFor(context);
    const currentBindings = bindings(context);
    const ownerCsrf = await csrf(app, currentBindings, owner.cookie);
    const base = `/api/v1/workspaces/${FIX.workspace}`;

    const recorded = await app.request(
      mutation(`${base}/browser-activity`, "POST", owner.cookie, ownerCsrf, {
        task_id: taskId,
        started_at: "2026-08-12T07:00:00.000Z",
        ended_at: "2026-08-12T08:00:00.000Z",
        request_id: "measurements-browser-1",
      }),
      undefined,
      currentBindings,
    );
    expect(recorded.status, await recorded.clone().text()).toBe(200);
    const recordedBody = (await recorded.json()) as {
      result: { capped: boolean; ended_at: string };
    };
    expect(recordedBody.result.capped).toBe(true);
    expect(recordedBody.result.ended_at).toBe("2026-08-12T07:05:00.000Z");

    const reread = await app.request(
      get(`${base}/tasks/${taskId}/measurements`, owner.cookie),
      undefined,
      currentBindings,
    );
    expect(reread.status).toBe(200);
    const rereadBody = (await reread.json()) as {
      measurements: {
        browser_activity: Array<{
          observed_ms: number;
          quality: string;
          capped_observations: number;
        }>;
      };
    };
    expect(rereadBody.measurements.browser_activity).toEqual([
      {
        human_id: expect.any(String),
        observed_ms: 300_000,
        capped_observations: 1,
        quality: "estimated",
      },
    ]);

    const inverted = await app.request(
      mutation(`${base}/browser-activity`, "POST", owner.cookie, ownerCsrf, {
        started_at: "2026-08-12T08:00:00.000Z",
        ended_at: "2026-08-12T07:00:00.000Z",
        request_id: "measurements-browser-2",
      }),
      undefined,
      currentBindings,
    );
    expect(inverted.status).toBe(400);
  });
});
