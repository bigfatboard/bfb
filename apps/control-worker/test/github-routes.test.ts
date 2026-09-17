// ABOUTME: Exercises X04 webhook HMAC ordering and Owner management routes.
// ABOUTME: Invalid signatures fail before parsing; every mutation needs Owner step-up.

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { FIX, seedSyntheticWorkspace, WorkspaceHub } from "@bfb/domain";
import { createProjectCommand } from "@bfb/domain";
import { issueStepUpProof } from "@bfb/domain";

import { parseAuthKeys } from "../src/auth/better-auth.js";
import { consumeGitHubQueueMessage, type GitHubQueueHandle } from "../src/api/github.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
  type AuthTestContext,
} from "./auth-helpers.js";

const NOW = "2026-09-18T12:00:00.000Z";
const SECRET = "x04-route-test-webhook-secret-0123456789abcdef";
const INSTALLATION = "12345678";
const REPOSITORY = "87654321";

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

interface CapturingQueue {
  sent: unknown[];
  send(message: unknown): Promise<void>;
}

function capturingQueue(): CapturingQueue {
  const queue: CapturingQueue = {
    sent: [],
    async send(message: unknown): Promise<void> {
      queue.sent.push(message);
    },
  };
  return queue;
}

function bindings(context: AuthTestContext, queue: CapturingQueue): ControlBindings {
  return {
    DB: fakeBinding<D1Database>("db"),
    ARTIFACTS: fakeBinding<R2Bucket>("r2"),
    ASSETS: fakeBinding<Fetcher>("assets"),
    JOBS: queue as unknown as Queue,
    JOBS_DLQ: fakeBinding<Queue>("dlq"),
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(context.db),
    APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
    ...( { GITHUB_WEBHOOK_SECRET: SECRET } as Record<string, string>),
  };
}

function appFor(context: AuthTestContext, queue: CapturingQueue) {
  const currentBindings = bindings(context, queue);
  const app = createControlApp(validateControlEnv(currentBindings), {
    db: context.db,
    now: NOW,
    abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
  return { app, currentBindings };
}

async function contextWithSessions() {
  const context = openAuthTestContext();
  await seedSyntheticWorkspace(context.db, NOW);
  const owner = await seedAuthSession(context, {
    userId: "github-owner-user",
    sessionId: "github-owner-session",
    token: "github-owner-token",
    email: "owner@synthetic.test",
    name: "Synthetic Owner",
    humanId: FIX.owner,
  });
  const member = await seedAuthSession(context, {
    userId: "github-member-user",
    sessionId: "github-member-session",
    token: "github-member-token",
    email: "member@synthetic.test",
    name: "Synthetic Member",
    humanId: FIX.member,
  });
  const reviewer = await seedAuthSession(context, {
    userId: "github-reviewer-user",
    sessionId: "github-reviewer-session",
    token: "github-reviewer-token",
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

function mutation(path: string, cookie: string, csrfToken: string, value: unknown): Request {
  return new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, {
    method: "POST",
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

function sign(body: Uint8Array, secret: string = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function webhook(body: Uint8Array, event: string, delivery: string, signature: string | null): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": delivery,
  };
  if (signature !== null) {
    headers["x-hub-signature-256"] = signature;
  }
  return new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/webhooks/github`, {
    method: "POST",
    headers,
    body: body as unknown as BodyInit,
  });
}

function pushPayload(sha: string): Record<string, unknown> {
  return {
    ref: "refs/heads/main",
    head_commit: { id: sha, timestamp: NOW },
    repository: { id: Number(REPOSITORY), full_name: "synthetic-org/synthetic-repo" },
    installation: { id: Number(INSTALLATION), account: { login: "synthetic-org", type: "Organization" } },
  };
}

async function proofFor(
  context: AuthTestContext,
  humanId: string,
  action: string,
  targetId: string,
): Promise<string> {
  return issueStepUpProof(
    context.db,
    humanId,
    {
      action,
      workspaceId: FIX.workspace,
      targetId,
      scopes: [],
      authorizationEpoch: 1,
      expiresAt: new Date(Date.parse(NOW) + 5 * 60 * 1000).toISOString(),
    },
    NOW,
  );
}

async function createGitHubProject(context: AuthTestContext): Promise<string> {
  const outcome = await new WorkspaceHub(context.db).execute(createProjectCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey: `github-route-project-${Date.now()}`,
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    now: NOW,
    input: {
      name: "Synthetic GitHub Route",
      slug: `github-route-${Math.floor(Math.random() * 1_000_000)}`,
      tint: "#3B82F6",
      accessMode: "workspace",
      repositoryHost: "github.com",
      hostedRepositoryId: REPOSITORY,
      repositorySubpath: ".",
    },
  });
  if (!outcome.ok) {
    throw new Error(`project setup failed: ${JSON.stringify(outcome)}`);
  }
  return outcome.result.id;
}

describe("X04 github webhook route", () => {
  it("rejects bad signatures before parsing and accepts valid deliveries", async () => {
    const { context } = await contextWithSessions();
    const queue = capturingQueue();
    const { app, currentBindings } = appFor(context, queue);
    const send = (request: Request) => app.request(request, undefined, currentBindings);

    // Invalid JSON with a bad signature: 401, never a parse error.
    const garbage = new TextEncoder().encode("{invalid-json");
    const forged = await send(webhook(garbage, "push", "delivery-forge-1", sign(garbage, "wrong")));
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: "webhook_signature_invalid", message: "webhook signature is invalid" });

    // Missing signature: 401.
    const unsigned = await send(webhook(garbage, "push", "delivery-forge-2", null));
    expect(unsigned.status).toBe(401);

    // Valid signature but invalid JSON: 400 parse failure, not a signature error.
    const badJson = await send(webhook(garbage, "push", "delivery-forge-3", sign(garbage)));
    expect(badJson.status).toBe(400);

    // Browser cookies cannot authenticate webhook routes.
    const cookie = await send(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/webhooks/github`, {
        method: "POST",
        headers: { cookie: "bfb_session=synthetic" },
        body: JSON.stringify(pushPayload("a".repeat(40))),
      }),
    );
    expect(cookie.status).toBe(401);

    // Valid delivery for an unknown installation: 404, nothing committed.
    const raw = new TextEncoder().encode(JSON.stringify(pushPayload("a".repeat(40))));
    const unknown = await send(webhook(raw, "push", "delivery-unknown-1", sign(raw)));
    expect(unknown.status).toBe(404);
    const rows = (await context.db
      .prepare(`SELECT COUNT(*) AS count FROM github_webhook_deliveries`)
      .get()) as { count: number };
    expect(rows.count).toBe(0);
    expect(queue.sent).toHaveLength(0);
  });
});

describe("X04 github management routes", () => {
  it("installs, activates, maps, and removes behind Owner step-up", async () => {
    const { context, owner, member, reviewer } = await contextWithSessions();
    const queue = capturingQueue();
    const { app, currentBindings } = appFor(context, queue);
    const send = (request: Request) => app.request(request, undefined, currentBindings);
    const base = `/api/v1/workspaces/${FIX.workspace}/github`;
    const ownerCsrf = await csrf(app, currentBindings, owner.cookie);
    const memberCsrf = await csrf(app, currentBindings, member.cookie);
    const post = (path: string, cookie: string, csrfToken: string, value: unknown) =>
      send(mutation(`${base}${path}`, cookie, csrfToken, value));

    // Member cannot install.
    const memberProof = await proofFor(context, FIX.member, "github.install", `github-installation:${INSTALLATION}`);
    const denied = await post("/installations", member.cookie, memberCsrf, {
      request_id: "github-route-install-denied",
      installation_id: INSTALLATION,
      app_id: "999000",
      app_slug: "synthetic-app",
      account_id: "555666",
      account_login: "synthetic-org",
      account_type: "Organization",
      permissions: { metadata: "read" },
      events: ["push"],
      step_up_proof_id: memberProof,
    });
    expect(denied.status).toBe(403);

    // Owner installs.
    const ownerProof = await proofFor(context, FIX.owner, "github.install", `github-installation:${INSTALLATION}`);
    const installed = await post("/installations", owner.cookie, ownerCsrf, {
      request_id: "github-route-install-1",
      installation_id: INSTALLATION,
      app_id: "999000",
      app_slug: "synthetic-app",
      account_id: "555666",
      account_login: "synthetic-org",
      account_type: "Organization",
      permissions: { metadata: "read", pull_requests: "read" },
      events: ["push", "installation"],
      step_up_proof_id: ownerProof,
    });
    expect(installed.status, await installed.clone().text()).toBe(200);

    // Mapping before activation fails closed.
    const projectId = await createGitHubProject(context);
    const mapProof = await proofFor(context, FIX.owner, "github.repository.map", `github-link:${REPOSITORY}`);
    const early = await post("/repository-links", owner.cookie, ownerCsrf, {
      request_id: "github-route-map-early",
      installation_id: INSTALLATION,
      repository_id: REPOSITORY,
      project_id: projectId,
      full_name: "synthetic-org/synthetic-repo",
      default_branch: "main",
      step_up_proof_id: mapProof,
    });
    expect(early.status).toBe(409);

    // Activate through the installation.created webhook, then map.
    const created = {
      action: "created",
      installation: { id: Number(INSTALLATION), account: { login: "synthetic-org", type: "Organization" }, updated_at: NOW },
    };
    const createdRaw = new TextEncoder().encode(JSON.stringify(created));
    const activateResponse = await send(webhook(createdRaw, "installation", "delivery-route-activate", sign(createdRaw)));
    expect(activateResponse.status, await activateResponse.clone().text()).toBe(202);
    expect(queue.sent).toHaveLength(1);
    const queued = queue.sent[0] as Record<string, unknown>;
    expect(Object.keys(queued).sort()).toEqual([
      "attempt",
      "delivery_id",
      "kind",
      "outbox_id",
      "schema_version",
      "workspace_id",
    ]);
    // Drive the queued installation.created message: lifecycle reconcile
    // needs no installation token and flips pending to active.
    let minted = 0;
    const handle: GitHubQueueHandle & { acked: boolean; retried: boolean } = {
      body: queued,
      acked: false,
      retried: false,
      ack() {
        handle.acked = true;
      },
      retry() {
        handle.retried = true;
      },
    };
    await consumeGitHubQueueMessage(handle, {
      db: context.db,
      now: NOW,
      jurisdiction: "eu",
      appOrigin: AUTH_TEST_ENV.APP_ORIGIN,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      workspaceHubNs: createTestWorkspaceHubNamespace(context.db),
      client: {
        async mintInstallationToken() {
          minted += 1;
          throw new Error("tokens are not minted for lifecycle events");
        },
        async fetchRepository() {
          throw new Error("rest is not read for lifecycle events");
        },
      },
    });
    expect(handle.acked).toBe(true);
    expect(handle.retried).toBe(false);
    expect(minted).toBe(0);

    const mapProof2 = await proofFor(context, FIX.owner, "github.repository.map", `github-link:${REPOSITORY}`);
    const mapped = await post("/repository-links", owner.cookie, ownerCsrf, {
      request_id: "github-route-map-1",
      installation_id: INSTALLATION,
      repository_id: REPOSITORY,
      project_id: projectId,
      full_name: "synthetic-org/synthetic-repo",
      default_branch: "main",
      step_up_proof_id: mapProof2,
    });
    expect(mapped.status, await mapped.clone().text()).toBe(200);

    // Status is visible to owners and members, not reviewers.
    const status = await send(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/status`, { headers: { cookie: owner.cookie } }),
      undefined,
      currentBindings,
    );
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as {
      installations: Array<{ status: string }>;
      links: Array<{ project_id: string }>;
    };
    expect(statusBody.installations[0]?.status).toBe("active");
    expect(statusBody.links[0]?.project_id).toBe(projectId);
    const reviewerStatus = await send(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${base}/status`, { headers: { cookie: reviewer.cookie } }),
      undefined,
      currentBindings,
    );
    expect(reviewerStatus.status).toBe(403);

    // Evidence links are role-gated (no step-up): a member links a
    // runner-observed commit while a reviewer is rejected.
    const evidence = await post("/evidence/links", member.cookie, memberCsrf, {
      request_id: "github-route-evidence-1",
      project_id: projectId,
      repository_id: REPOSITORY,
      kind: "commit",
      ref: "a".repeat(40),
      version_token: "a".repeat(40),
      observed_by: "runner",
    });
    expect(evidence.status, await evidence.clone().text()).toBe(200);
    const reviewerCsrf = await csrf(app, currentBindings, reviewer.cookie);
    const reviewerLink = await post("/evidence/links", reviewer.cookie, reviewerCsrf, {
      request_id: "github-route-evidence-2",
      project_id: projectId,
      repository_id: REPOSITORY,
      kind: "commit",
      ref: "b".repeat(40),
      version_token: "b".repeat(40),
      observed_by: "runner",
    });
    expect(reviewerLink.status).toBe(403);

    const verified = await post("/evidence/verification", member.cookie, memberCsrf, {
      refs: [{ kind: "github", ref: `github:${REPOSITORY}:commit:${"a".repeat(40)}` }],
    });
    expect(verified.status).toBe(200);

    // Remove revokes behind step-up; a second remove fails.
    const removeProof = await proofFor(context, FIX.owner, "github.remove", `github-installation:${INSTALLATION}`);
    const removed = await post(`/installations/${INSTALLATION}/remove`, owner.cookie, ownerCsrf, {
      request_id: "github-route-remove-1",
      step_up_proof_id: removeProof,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const removeProof2 = await proofFor(context, FIX.owner, "github.remove", `github-installation:${INSTALLATION}`);
    const removedAgain = await post(`/installations/${INSTALLATION}/remove`, owner.cookie, ownerCsrf, {
      request_id: "github-route-remove-2",
      step_up_proof_id: removeProof2,
    });
    expect(removedAgain.status).toBe(409);
  });
});
