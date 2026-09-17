// ABOUTME: Exercises A03 result submission and review browser routes end to end.
// ABOUTME: Route tests enforce role scope, idempotency, stale versions, and outdated flags.

import { describe, expect, it } from "vitest";

import { FIX, seedSyntheticWorkspace } from "@bfb/domain";

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
const COMMIT = "a".repeat(40);

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

async function contextWithSessions() {
  const context = openAuthTestContext();
  await seedSyntheticWorkspace(context.db, NOW);
  const owner = await seedAuthSession(context, {
    userId: "result-owner-user",
    sessionId: "result-owner-session",
    token: "result-owner-token",
    email: "owner@synthetic.test",
    name: "Synthetic Owner",
    humanId: FIX.owner,
  });
  const member = await seedAuthSession(context, {
    userId: "result-member-user",
    sessionId: "result-member-session",
    token: "result-member-token",
    email: "member@synthetic.test",
    name: "Synthetic Member",
    humanId: FIX.member,
  });
  const reviewer = await seedAuthSession(context, {
    userId: "result-reviewer-user",
    sessionId: "result-reviewer-session",
    token: "result-reviewer-token",
    email: "restricted@synthetic.test",
    name: "Synthetic Restricted",
    humanId: FIX.reviewer,
  });
  return { context, owner, member, reviewer };
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
  method: "POST" | "PATCH",
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

async function createTaskAndRun(
  app: ReturnType<typeof appFor>,
  currentBindings: ControlBindings,
  base: string,
  cookie: string,
  csrfToken: string,
  key: string,
): Promise<{ taskId: string; runId: string }> {
  const created = await app.request(
    mutation(`${base}/tasks`, "POST", cookie, csrfToken, {
      project_id: FIX.projectA,
      title: `Synthetic result route task ${key}`,
      priority: "P1",
      request_id: `result-route-task-${key}`,
    }),
    undefined,
    currentBindings,
  );
  expect(created.status, await created.clone().text()).toBe(200);
  const taskId = ((await created.json()) as { result: { id: string } }).result.id;
  const run = await app.request(
    mutation(`${base}/tasks/${taskId}/runs`, "POST", cookie, csrfToken, {
      expected_task_version: 1,
      agent_profile_id: FIX.profileCodex,
      workspace_policy_version: 1,
      project_policy_version: 1,
      repository_config_version: 1,
      agent_profile_version: 1,
      request_id: `result-route-run-${key}`,
    }),
    undefined,
    currentBindings,
  );
  expect(run.status, await run.clone().text()).toBe(200);
  const runId = ((await run.json()) as { result: { run: { id: string } } }).result.run.id;
  return { taskId, runId };
}

describe("A03 result browser API", () => {
  it("submits, reviews, and lists results with role and idempotency rules", async () => {
    const { context, owner, reviewer } = await contextWithSessions();
    const app = appFor(context);
    const currentBindings = bindings(context);
    const ownerCsrf = await csrf(app, currentBindings, owner.cookie);
    const reviewerCsrf = await csrf(app, currentBindings, reviewer.cookie);
    const base = `/api/v1/workspaces/${FIX.workspace}`;
    const { taskId, runId } = await createTaskAndRun(
      app,
      currentBindings,
      base,
      owner.cookie,
      ownerCsrf,
      "cycle",
    );

    const submit = await app.request(
      mutation(`${base}/runs/${runId}/results`, "POST", owner.cookie, ownerCsrf, {
        summary: "Synthetic route result",
        limitations: "Synthetic route limitation",
        evidence_refs: [{ kind: "comment", ref: "synthetic-route-comment" }],
        git_branch: "main",
        git_commit: COMMIT,
        git_dirty: false,
        request_id: "result-route-submit-1",
      }),
      undefined,
      currentBindings,
    );
    expect(submit.status, await submit.clone().text()).toBe(200);
    const first = (
      (await submit.json()) as {
        result: {
          submission: { id: string; version: number };
          runVersion: number;
          taskVersion: number;
        };
      }
    ).result;
    expect(first.submission.version).toBe(1);

    const retry = await app.request(
      mutation(`${base}/runs/${runId}/results`, "POST", owner.cookie, ownerCsrf, {
        summary: "Synthetic route result",
        request_id: "result-route-submit-1",
      }),
      undefined,
      currentBindings,
    );
    expect(retry.status).toBe(200);
    const retried = (await retry.json()) as {
      ok: boolean;
      replayed: boolean;
      result: { submission: { id: string } };
    };
    expect(retried.replayed).toBe(true);
    expect(retried.result.submission.id).toBe(first.submission.id);

    const reviewerSubmit = await app.request(
      mutation(`${base}/runs/${runId}/results`, "POST", reviewer.cookie, reviewerCsrf, {
        summary: "Reviewer route submission",
        request_id: "result-route-reviewer-submit",
      }),
      undefined,
      currentBindings,
    );
    expect(reviewerSubmit.status).toBe(403);

    const taskInReview = await app.request(
      get(`${base}/tasks/${taskId}`, owner.cookie),
      undefined,
      currentBindings,
    );
    expect(taskInReview.status).toBe(200);
    expect(((await taskInReview.json()) as { task: { state: string } }).task.state).toBe("review");

    const reviewerAccept = await app.request(
      mutation(`${base}/runs/${runId}/review`, "POST", reviewer.cookie, reviewerCsrf, {
        decision: "accept",
        submission_id: first.submission.id,
        expected_run_version: first.runVersion,
        expected_task_version: first.taskVersion,
        request_id: "result-route-reviewer-accept",
      }),
      undefined,
      currentBindings,
    );
    expect(reviewerAccept.status).toBe(403);

    const changes = await app.request(
      mutation(`${base}/runs/${runId}/review`, "POST", reviewer.cookie, reviewerCsrf, {
        decision: "request_changes",
        submission_id: first.submission.id,
        expected_run_version: first.runVersion,
        expected_task_version: first.taskVersion,
        comment: "Synthetic route change request",
        request_id: "result-route-changes",
      }),
      undefined,
      currentBindings,
    );
    expect(changes.status, await changes.clone().text()).toBe(200);

    const second = await app.request(
      mutation(`${base}/runs/${runId}/results`, "POST", owner.cookie, ownerCsrf, {
        summary: "Synthetic route result two",
        request_id: "result-route-submit-2",
      }),
      undefined,
      currentBindings,
    );
    expect(second.status, await second.clone().text()).toBe(200);
    const secondBody = (
      (await second.json()) as {
        result: {
          submission: { id: string; version: number };
          runVersion: number;
          taskVersion: number;
        };
      }
    ).result;
    expect(secondBody.submission.version).toBe(2);

    const listed = await app.request(
      get(`${base}/runs/${runId}/results`, owner.cookie),
      undefined,
      currentBindings,
    );
    expect(listed.status).toBe(200);
    const submissions = (
      (await listed.json()) as {
        submissions: Array<{ version: number; outdated: boolean; outdated_reasons: string[] }>;
      }
    ).submissions;
    expect(submissions.map((entry) => entry.version)).toEqual([2, 1]);
    expect(submissions[1]).toMatchObject({ outdated: true, outdated_reasons: ["superseded"] });
    expect(submissions[0]).toMatchObject({ outdated: false, outdated_reasons: [] });

    const stale = await app.request(
      mutation(`${base}/runs/${runId}/review`, "POST", owner.cookie, ownerCsrf, {
        decision: "accept",
        submission_id: secondBody.submission.id,
        expected_run_version: secondBody.runVersion - 1,
        expected_task_version: secondBody.taskVersion,
        request_id: "result-route-stale",
      }),
      undefined,
      currentBindings,
    );
    expect(stale.status).toBe(409);

    const accepted = await app.request(
      mutation(`${base}/runs/${runId}/review`, "POST", owner.cookie, ownerCsrf, {
        decision: "accept",
        submission_id: secondBody.submission.id,
        expected_run_version: secondBody.runVersion,
        expected_task_version: secondBody.taskVersion,
        request_id: "result-route-accept",
      }),
      undefined,
      currentBindings,
    );
    expect(accepted.status, await accepted.clone().text()).toBe(200);

    const taskDone = await app.request(
      get(`${base}/tasks/${taskId}`, owner.cookie),
      undefined,
      currentBindings,
    );
    expect(((await taskDone.json()) as { task: { state: string } }).task.state).toBe("done");

    const smuggled = await app.request(
      mutation(`${base}/runs/${runId}/results`, "POST", owner.cookie, ownerCsrf, {
        summary: "Smuggled",
        local_path: "/private/synthetic",
        request_id: "result-route-smuggled",
      }),
      undefined,
      currentBindings,
    );
    expect(smuggled.status).toBe(400);
  });

  it("fails and cancels runs without moving the task", async () => {
    const { context, owner, member } = await contextWithSessions();
    const app = appFor(context);
    const currentBindings = bindings(context);
    const ownerCsrf = await csrf(app, currentBindings, owner.cookie);
    const memberCsrf = await csrf(app, currentBindings, member.cookie);
    const base = `/api/v1/workspaces/${FIX.workspace}`;
    const { taskId, runId } = await createTaskAndRun(
      app,
      currentBindings,
      base,
      owner.cookie,
      ownerCsrf,
      "close",
    );

    const failed = await app.request(
      mutation(`${base}/runs/${runId}/failure`, "POST", member.cookie, memberCsrf, {
        expected_run_version: 1,
        request_id: "result-route-fail",
      }),
      undefined,
      currentBindings,
    );
    expect(failed.status, await failed.clone().text()).toBe(200);
    const taskAfter = await app.request(
      get(`${base}/tasks/${taskId}`, owner.cookie),
      undefined,
      currentBindings,
    );
    expect(((await taskAfter.json()) as { task: { state: string } }).task.state).toBe("active");

    const again = await app.request(
      mutation(`${base}/runs/${runId}/cancellation`, "POST", owner.cookie, ownerCsrf, {
        expected_run_version: 2,
        request_id: "result-route-cancel-terminal",
      }),
      undefined,
      currentBindings,
    );
    expect(again.status).toBe(400);
  });
});
