// ABOUTME: Exercises mounted C08 task, context, run, execution, and session browser routes.
// ABOUTME: Route tests enforce CSRF, bounded bodies, role scope, and project-hidden reads.

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
    userId: "work-owner-user",
    sessionId: "work-owner-session",
    token: "work-owner-token",
    email: "owner@synthetic.test",
    name: "Synthetic Owner",
    humanId: FIX.owner,
  });
  const reviewer = await seedAuthSession(context, {
    userId: "work-reviewer-user",
    sessionId: "work-reviewer-session",
    token: "work-reviewer-token",
    email: "restricted@synthetic.test",
    name: "Synthetic Restricted",
    humanId: FIX.reviewer,
  });
  return { context, owner, reviewer };
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
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, {
    method,
    headers: {
      cookie,
      "content-type": "application/json",
      origin: AUTH_TEST_ENV.APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-bfb-csrf": csrfToken,
      ...extraHeaders,
    },
    body: JSON.stringify(value),
  });
}

describe("C08 browser work API", () => {
  it("bounds task and context APIs and hides unauthorized projects", async () => {
    const { context, owner, reviewer } = await contextWithSessions();
    const app = appFor(context);
    const currentBindings = bindings(context);
    const ownerCsrf = await csrf(app, currentBindings, owner.cookie);
    const reviewerCsrf = await csrf(app, currentBindings, reviewer.cookie);
    const base = `/api/v1/workspaces/${FIX.workspace}`;

    const created = await app.request(
      mutation(`${base}/tasks`, "POST", owner.cookie, ownerCsrf, {
        project_id: FIX.projectB,
        title: "Private task",
        priority: "P1",
        next_owner_type: "human",
        next_owner_id: FIX.owner,
        next_action_reason: "Owner review",
        request_id: "work-route-create-private",
      }),
      undefined,
      currentBindings,
    );
    expect(created.status, await created.clone().text()).toBe(200);
    const taskId = ((await created.json()) as { result: { id: string } }).result.id;

    const reviewerRead = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/tasks/${taskId}`, {
        headers: { cookie: reviewer.cookie },
      }),
      undefined,
      currentBindings,
    );
    expect(reviewerRead.status).toBe(404);
    const reviewerCreate = await app.request(
      mutation(`${base}/tasks`, "POST", reviewer.cookie, reviewerCsrf, {
        project_id: FIX.projectA,
        title: "Reviewer mutation",
        request_id: "work-route-reviewer-create",
      }),
      undefined,
      currentBindings,
    );
    expect(reviewerCreate.status).toBe(403);

    const unsupported = await app.request(
      mutation(`${base}/tasks`, "POST", owner.cookie, ownerCsrf, {
        project_id: FIX.projectA,
        title: "Unsupported",
        local_checkout_path: "/private/synthetic",
        request_id: "work-route-unsupported",
      }),
      undefined,
      currentBindings,
    );
    expect(unsupported.status).toBe(400);
    const oversized = await app.request(
      mutation(`${base}/tasks`, "POST", owner.cookie, ownerCsrf, {}, { "content-length": "32769" }),
      undefined,
      currentBindings,
    );
    expect(oversized.status).toBe(413);

    for (const [requestId, audience, text] of [
      ["work-context-human", "human", "Human-only note"],
      ["work-context-agent", "agent", "Agent constraint"],
    ] as const) {
      const response = await app.request(
        mutation(`${base}/tasks/${taskId}/context`, "POST", owner.cookie, ownerCsrf, {
          kind: audience === "agent" ? "constraint" : "note",
          audience,
          body: text,
          request_id: requestId,
        }),
        undefined,
        currentBindings,
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const agentView = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/tasks/${taskId}/context?audience=agent`, {
        headers: { cookie: owner.cookie },
      }),
      undefined,
      currentBindings,
    );
    const agentText = await agentView.text();
    expect(agentView.status).toBe(200);
    expect(agentText).toContain("Agent constraint");
    expect(agentText).not.toContain("Human-only note");
    const invalidView = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/tasks/${taskId}/context?audience=secret`, {
        headers: { cookie: owner.cookie },
      }),
      undefined,
      currentBindings,
    );
    expect(invalidView.status).toBe(400);

    const dependencyTask = await app.request(
      mutation(`${base}/tasks`, "POST", owner.cookie, ownerCsrf, {
        project_id: FIX.projectB,
        title: "Dependency task",
        request_id: "work-route-dependency-task",
      }),
      undefined,
      currentBindings,
    );
    expect(dependencyTask.status, await dependencyTask.clone().text()).toBe(200);
    const dependencyTaskId = ((await dependencyTask.json()) as { result: { id: string } }).result
      .id;
    const dependencyMutation = await app.request(
      mutation(`${base}/tasks/${taskId}/dependencies`, "POST", owner.cookie, ownerCsrf, {
        depends_on_task_id: dependencyTaskId,
        request_id: "work-route-dependency",
      }),
      undefined,
      currentBindings,
    );
    expect(dependencyMutation.status, await dependencyMutation.clone().text()).toBe(200);
    const dependencies = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/tasks/${taskId}/dependencies?limit=1`, {
        headers: { cookie: owner.cookie },
      }),
      undefined,
      currentBindings,
    );
    expect(await dependencies.json()).toMatchObject({
      dependencies: [{ depends_on_task_id: dependencyTaskId, title: "Dependency task" }],
      limit: 1,
      has_more: false,
    });

    const linkMutation = await app.request(
      mutation(`${base}/tasks/${taskId}/links`, "POST", owner.cookie, ownerCsrf, {
        kind: "github",
        url: "https://github.com/qdis/bfb/pull/3",
        label: "PR 3",
        request_id: "work-route-link",
      }),
      undefined,
      currentBindings,
    );
    expect(linkMutation.status, await linkMutation.clone().text()).toBe(200);
    const links = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/tasks/${taskId}/links?limit=1`, {
        headers: { cookie: owner.cookie },
      }),
      undefined,
      currentBindings,
    );
    expect(await links.json()).toMatchObject({
      links: [{ kind: "github", label: "PR 3" }],
      limit: 1,
      has_more: false,
    });
  });

  it("creates run, execution, and provider-session records without inferring a result", async () => {
    const { context, owner } = await contextWithSessions();
    const app = appFor(context);
    const currentBindings = bindings(context);
    const ownerCsrf = await csrf(app, currentBindings, owner.cookie);
    const base = `/api/v1/workspaces/${FIX.workspace}`;
    const created = await app.request(
      mutation(`${base}/tasks`, "POST", owner.cookie, ownerCsrf, {
        project_id: FIX.projectA,
        title: "Run through browser",
        priority: "P1",
        next_owner_type: "agent_profile",
        next_owner_id: FIX.profileCodex,
        request_id: "work-route-run-task",
      }),
      undefined,
      currentBindings,
    );
    const taskId = ((await created.json()) as { result: { id: string } }).result.id;
    const runResponse = await app.request(
      mutation(`${base}/tasks/${taskId}/runs`, "POST", owner.cookie, ownerCsrf, {
        expected_task_version: 1,
        agent_profile_id: FIX.profileCodex,
        workspace_policy_version: 1,
        project_policy_version: 1,
        repository_config_version: 1,
        agent_profile_version: 1,
        request_id: "work-route-run-create",
      }),
      undefined,
      currentBindings,
    );
    expect(runResponse.status, await runResponse.clone().text()).toBe(200);
    const runId = ((await runResponse.json()) as { result: { run: { id: string } } }).result.run.id;
    const snapshotResponse = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/runs/${runId}/snapshot`, {
        headers: { cookie: owner.cookie },
      }),
      undefined,
      currentBindings,
    );
    expect(snapshotResponse.status).toBe(200);
    expect(await snapshotResponse.json()).toMatchObject({
      snapshot: {
        run_id: runId,
        workspace_policy_version: 1,
        project_policy_version: 1,
        repository_config_version: 1,
        agent_profile_version: 1,
      },
    });
    const executionResponse = await app.request(
      mutation(`${base}/runs/${runId}/executions`, "POST", owner.cookie, ownerCsrf, {
        request_id: "work-route-execution-create",
      }),
      undefined,
      currentBindings,
    );
    expect(executionResponse.status, await executionResponse.clone().text()).toBe(200);
    const executionId = ((await executionResponse.json()) as { result: { id: string } }).result.id;
    for (const [requestId, expectedVersion, state] of [
      ["work-route-execution-launch", 1, "launching"],
      ["work-route-execution-attach", 2, "attached"],
    ] as const) {
      const response = await app.request(
        mutation(
          `${base}/runs/${runId}/executions/${executionId}`,
          "PATCH",
          owner.cookie,
          ownerCsrf,
          {
            expected_version: expectedVersion,
            state,
            request_id: requestId,
          },
        ),
        undefined,
        currentBindings,
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const session = await app.request(
      mutation(
        `${base}/runs/${runId}/executions/${executionId}/sessions`,
        "POST",
        owner.cookie,
        ownerCsrf,
        {
          provider: "codex",
          requested_session_id: "browser-requested-session",
          request_id: "work-route-provider-session",
        },
      ),
      undefined,
      currentBindings,
    );
    expect(session.status, await session.clone().text()).toBe(200);
    const sessionId = ((await session.json()) as { result: { id: string } }).result.id;
    for (const [path, key, expectedId] of [
      [`${base}/tasks/${taskId}/runs?limit=1`, "runs", runId],
      [`${base}/runs/${runId}/executions?limit=1`, "executions", executionId],
      [`${base}/runs/${runId}/sessions?limit=1`, "sessions", sessionId],
    ] as const) {
      const response = await app.request(
        new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, {
          headers: { cookie: owner.cookie },
        }),
        undefined,
        currentBindings,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const value = (await response.json()) as Record<string, Array<{ id: string }>>;
      expect(value[key]?.map((item) => item.id)).toEqual([expectedId]);
    }
    const ended = await app.request(
      mutation(
        `${base}/runs/${runId}/executions/${executionId}`,
        "PATCH",
        owner.cookie,
        ownerCsrf,
        {
          expected_version: 3,
          state: "ended",
          end_reason: "process_exit",
          request_id: "work-route-execution-end",
        },
      ),
      undefined,
      currentBindings,
    );
    expect(ended.status, await ended.clone().text()).toBe(200);
    const run = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/runs/${runId}`, {
        headers: { cookie: owner.cookie },
      }),
      undefined,
      currentBindings,
    );
    const runBody = (await run.json()) as { run: { result_state: string } };
    expect(runBody.run.result_state).toBe("open");
    const task = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/tasks/${taskId}`, {
        headers: { cookie: owner.cookie },
      }),
      undefined,
      currentBindings,
    );
    expect((await task.json()) as unknown).toMatchObject({ task: { state: "active" } });
  });
});
