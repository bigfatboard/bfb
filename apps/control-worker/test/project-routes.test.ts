// ABOUTME: Exercises mounted C07 project, grant, policy, config, and profile browser routes.
// ABOUTME: Route tests enforce cookie/CSRF separation, pagination, tenant scope, and bounded bodies.

import { createHash } from "node:crypto";

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

const NOW = "2026-08-12T08:00:00.000Z";

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

function bindings(context?: AuthTestContext): ControlBindings {
  return {
    DB: fakeBinding<D1Database>("db"),
    ARTIFACTS: fakeBinding<R2Bucket>("r2"),
    ASSETS: fakeBinding<Fetcher>("assets"),
    JOBS: fakeBinding<Queue>("jobs"),
    JOBS_DLQ: fakeBinding<Queue>("dlq"),
    WORKSPACE_HUB: context
      ? createTestWorkspaceHubNamespace(context.db)
      : fakeBinding<DurableObjectNamespace>("hub"),
    APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
}

function appFor(context: AuthTestContext) {
  return createControlApp(validateControlEnv(bindings()), {
    db: context.db,
    now: NOW,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
}

async function csrfFor(
  app: ReturnType<typeof appFor>,
  cookie: string,
  currentBindings: ControlBindings,
): Promise<string> {
  const response = await app.request(
    new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/session`, { headers: { cookie } }),
    undefined,
    currentBindings,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { csrf_token: string }).csrf_token;
}

function mutation(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  cookie: string,
  csrf: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(AUTH_TEST_ENV.APP_ORIGIN + path, {
    method,
    headers: {
      cookie,
      "content-type": "application/json",
      origin: AUTH_TEST_ENV.APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-bfb-csrf": csrf,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

async function contextWithSessions() {
  const context = openAuthTestContext();
  await seedSyntheticWorkspace(context.db, NOW);
  const owner = await seedAuthSession(context, {
    userId: "project-owner-user",
    sessionId: "project-owner-session",
    token: "project-owner-token",
    email: "owner@synthetic.test",
    name: "Synthetic Owner",
    humanId: FIX.owner,
  });
  const reviewer = await seedAuthSession(context, {
    userId: "project-reviewer-user",
    sessionId: "project-reviewer-session",
    token: "project-reviewer-token",
    email: "restricted@synthetic.test",
    name: "Synthetic Restricted",
    humanId: FIX.reviewer,
  });
  return { context, owner, reviewer };
}

describe("project browser API", () => {
  it("creates and updates canonical projects with pagination and request bounds", async () => {
    const { context, owner } = await contextWithSessions();
    const app = appFor(context);
    const currentBindings = bindings(context);
    const csrf = await csrfFor(app, owner.cookie, currentBindings);
    const base = `/api/v1/workspaces/${FIX.workspace}`;

    const firstPage = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/projects?limit=1`, {
        headers: { cookie: owner.cookie },
      }),
      undefined,
      currentBindings,
    );
    expect(firstPage.status).toBe(200);
    expect(await firstPage.json()).toMatchObject({ hasMore: true });

    const created = await app.request(
      mutation(`${base}/projects`, "POST", owner.cookie, csrf, {
        name: "Project API",
        slug: "project-api",
        tint: "#ABCDEF",
        access_mode: "restricted",
        repository_host: "github.com",
        hosted_repository_id: "123456789",
        repository_subpath: "packages/api",
        request_id: "project-route-create",
      }),
      undefined,
      currentBindings,
    );
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = (await created.json()) as {
      result: { id: string; repository_subpath: string; resource_version: number };
    };
    expect(createdBody.result.repository_subpath).toBe("packages/api");

    const updated = await app.request(
      mutation(`${base}/projects/${createdBody.result.id}`, "PATCH", owner.cookie, csrf, {
        expected_version: 1,
        tint: "#112233",
        request_id: "project-route-update",
      }),
      undefined,
      currentBindings,
    );
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await updated.json()).toMatchObject({
      result: { tint: "#112233", resource_version: 2 },
    });

    const unsupported = await app.request(
      mutation(`${base}/projects`, "POST", owner.cookie, csrf, {
        name: "Unsafe",
        slug: "unsafe",
        tint: "#112233",
        access_mode: "restricted",
        repository_host: "github.com",
        hosted_repository_id: "987",
        repository_subpath: ".",
        checkout_path: "/Users/synthetic/client",
        request_id: "project-route-unsafe",
      }),
      undefined,
      currentBindings,
    );
    expect(unsupported.status).toBe(400);

    const bearer = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/projects`, {
        headers: { cookie: owner.cookie, authorization: "Bearer synthetic-other-credential" },
      }),
      undefined,
      currentBindings,
    );
    expect(bearer.status).toBe(401);

    const oversized = await app.request(
      mutation(`${base}/projects`, "POST", owner.cookie, csrf, {}, { "content-length": "32769" }),
      undefined,
      currentBindings,
    );
    expect(oversized.status).toBe(413);
  });

  it("hides ungranted projects and applies grant revocation on the next request", async () => {
    const { context, owner, reviewer } = await contextWithSessions();
    const app = appFor(context);
    const currentBindings = bindings(context);
    const ownerCsrf = await csrfFor(app, owner.cookie, currentBindings);
    const reviewerCsrf = await csrfFor(app, reviewer.cookie, currentBindings);
    const base = `/api/v1/workspaces/${FIX.workspace}`;

    const hidden = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/projects/${FIX.projectB}`, {
        headers: { cookie: reviewer.cookie },
      }),
      undefined,
      currentBindings,
    );
    expect(hidden.status).toBe(404);

    const reviewerCreate = await app.request(
      mutation(`${base}/projects`, "POST", reviewer.cookie, reviewerCsrf, {
        name: "Denied",
        slug: "denied",
        tint: "#112233",
        access_mode: "restricted",
        repository_host: "github.com",
        hosted_repository_id: "denied",
        repository_subpath: ".",
        request_id: "reviewer-project-create",
      }),
      undefined,
      currentBindings,
    );
    expect(reviewerCreate.status).toBe(403);

    const granted = await app.request(
      mutation(
        `${base}/projects/${FIX.projectB}/access/${FIX.reviewer}`,
        "PUT",
        owner.cookie,
        ownerCsrf,
        { request_id: "project-route-grant" },
      ),
      undefined,
      currentBindings,
    );
    expect(granted.status, await granted.clone().text()).toBe(200);
    const visible = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/projects/${FIX.projectB}`, {
        headers: { cookie: reviewer.cookie },
      }),
      undefined,
      currentBindings,
    );
    expect(visible.status).toBe(200);

    const revoked = await app.request(
      mutation(
        `${base}/projects/${FIX.projectB}/access/${FIX.reviewer}`,
        "DELETE",
        owner.cookie,
        ownerCsrf,
        { request_id: "project-route-revoke" },
      ),
      undefined,
      currentBindings,
    );
    expect(revoked.status).toBe(200);
    const hiddenAgain = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/projects/${FIX.projectB}`, {
        headers: { cookie: reviewer.cookie },
      }),
      undefined,
      currentBindings,
    );
    expect(hiddenAgain.status).toBe(404);
  });

  it("publishes immutable policy, repository-config, and profile versions", async () => {
    const { context, owner } = await contextWithSessions();
    const app = appFor(context);
    const currentBindings = bindings(context);
    const csrf = await csrfFor(app, owner.cookie, currentBindings);
    const base = `/api/v1/workspaces/${FIX.workspace}`;

    const projectPolicy = await app.request(
      mutation(`${base}/projects/${FIX.projectA}/policy`, "PUT", owner.cookie, csrf, {
        expected_version: 1,
        allowed_providers: ["codex"],
        allow_agent_root_propose: false,
        allow_pass_to_agent: false,
        allow_run_overrides: false,
        request_id: "project-route-policy",
      }),
      undefined,
      currentBindings,
    );
    expect(projectPolicy.status, await projectPolicy.clone().text()).toBe(200);

    const document = {
      allowed_providers: ["codex"],
      allow_agent_root_propose: false,
      allow_pass_to_agent: false,
      allow_run_overrides: false,
    };
    const canonical =
      '{"allow_agent_root_propose":false,"allow_pass_to_agent":false,"allow_run_overrides":false,"allowed_providers":["codex"]}';
    const config = await app.request(
      mutation(`${base}/projects/${FIX.projectA}/repository-config`, "PUT", owner.cookie, csrf, {
        expected_version: 1,
        document,
        content_hash: hash(canonical),
        request_id: "project-route-config",
      }),
      undefined,
      currentBindings,
    );
    expect(config.status, await config.clone().text()).toBe(200);

    const configVersions = await app.request(
      new Request(
        `${AUTH_TEST_ENV.APP_ORIGIN}${base}/projects/${FIX.projectA}/repository-config/versions?limit=1`,
        { headers: { cookie: owner.cookie } },
      ),
      undefined,
      currentBindings,
    );
    expect(await configVersions.json()).toMatchObject({ hasMore: true, nextCursor: 1 });

    const profile = await app.request(
      mutation(`${base}/agent-profiles`, "POST", owner.cookie, csrf, {
        name: "Claude Review",
        provider: "claude",
        model: "claude-sonnet",
        execution_mode: "interactive",
        harness_mode: "restricted",
        request_id: "project-route-profile",
      }),
      undefined,
      currentBindings,
    );
    expect(profile.status, await profile.clone().text()).toBe(200);
    const profileBody = (await profile.json()) as { result: { id: string } };
    const profileUpdate = await app.request(
      mutation(`${base}/agent-profiles/${profileBody.result.id}`, "PATCH", owner.cookie, csrf, {
        expected_version: 1,
        name: "Claude Review",
        provider: "claude",
        model: "claude-opus",
        execution_mode: "headless",
        harness_mode: "restricted",
        request_id: "project-route-profile-update",
      }),
      undefined,
      currentBindings,
    );
    expect(profileUpdate.status).toBe(200);
    const profileVersions = await app.request(
      new Request(
        `${AUTH_TEST_ENV.APP_ORIGIN}${base}/agent-profiles/${profileBody.result.id}/versions`,
        { headers: { cookie: owner.cookie } },
      ),
      undefined,
      currentBindings,
    );
    const responseText = await profileVersions.text();
    expect(profileVersions.status).toBe(200);
    expect(responseText).not.toContain("/Users/");
    expect(responseText).not.toContain("token");
    expect(JSON.parse(responseText)).toMatchObject({ hasMore: false });
  });
});
