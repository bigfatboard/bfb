// ABOUTME: Exercises mounted artifact review decisions over browser sessions.
// ABOUTME: Synthetic versions prove binding, conflicts, scoping, and timer linkage.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  artifactObjectKey,
  createArtifactCommand,
  createTaskCommand,
  createRunCommand,
  finalizeArtifactCommand,
  FIX,
  mintUploadGrantSecret,
  randomUlid,
  recordVerifiedUpload,
  redeemUploadGrant,
  seedSyntheticWorkspace,
  WorkspaceHub,
} from "@bfb/domain";

import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import { AUTH_TEST_ENV, openAuthTestContext, seedAuthSession } from "./auth-helpers.js";

const NOW = "2026-09-17T12:00:00.000Z";
const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;
const TEXT = new TextEncoder().encode("# synthetic review\n");

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture() {
  const context = openAuthTestContext(NOW);
  await seedSyntheticWorkspace(context.db, NOW, "global");
  async function session(
    userId: string,
    sessionId: string,
    token: string,
    humanId: string,
    email: string,
  ) {
    return seedAuthSession(context, { userId, sessionId, token, humanId, email, now: NOW });
  }
  const owner = await session(
    "review-user",
    "review-session",
    "review-token",
    FIX.owner,
    "owner@synthetic.test",
  );
  const reviewer = await session(
    "review-reviewer-user",
    "review-reviewer-session",
    "review-reviewer-token",
    FIX.restricted,
    "restricted@synthetic.test",
  );
  const env = {
    DB: {},
    ARTIFACTS: {},
    ASSETS: {},
    JOBS: {},
    JOBS_DLQ: {},
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(context.db),
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "global",
    ENVIRONMENT: "local",
  } as unknown as ControlBindings;
  function app() {
    return createControlApp(validateControlEnv(env), {
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
  const authenticated = await app().request(
    new Request(ORIGIN + "/auth/session", { headers: { cookie: owner.cookie } }),
    undefined,
    env,
  );
  expect(authenticated.status).toBe(200);
  const csrf = ((await authenticated.json()) as { csrf_token: string }).csrf_token;
  async function csrfFor(cookie: string): Promise<string> {
    const response = await app().request(
      new Request(ORIGIN + "/auth/session", { headers: { cookie } }),
      undefined,
      env,
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { csrf_token: string }).csrf_token;
  }
  const reviewerCsrf = await csrfFor(reviewer.cookie);
  const prefix = `/api/v1/workspaces/${FIX.workspace}/artifacts`;
  async function request(
    path: string,
    body: unknown,
    sessionPair: { cookie: string; csrf: string } = { cookie: owner.cookie, csrf },
    method = "POST",
  ) {
    return app().request(
      new Request(ORIGIN + path, {
        method,
        headers: {
          cookie: sessionPair.cookie,
          origin: ORIGIN,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          "x-bfb-csrf": sessionPair.csrf,
          "cf-connecting-ip": "192.0.2.83",
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      }),
      undefined,
      env,
    );
  }
  const hub = new WorkspaceHub(context.db);
  async function available(
    label: string,
    runId: string | null = null,
    artifactId: string | null = null,
  ): Promise<{ artifact_id: string; version_id: string; content_hash: string }> {
    const bytes = new TextEncoder().encode(`# synthetic review ${label}\n`);
    const hash = digest(bytes);
    const minted = mintUploadGrantSecret();
    const created = await hub.execute(createArtifactCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      idempotencyKey: randomUlid(),
      input: {
        artifactId,
        runId,
        format: "markdown" as never,
        role: "review" as never,
        declaredSize: bytes.byteLength,
        expectedDigest: hash,
        grantSecretHash: minted.secretHash,
      },
    });
    if (!created.ok) throw new Error(JSON.stringify(created));
    await redeemUploadGrant(context.db, {
      grantId: created.result.upload_grant.grant_id,
      secret: minted.secret,
      now: NOW,
    });
    await recordVerifiedUpload(context.db, {
      workspaceId: FIX.workspace,
      versionId: created.result.version_id,
      runId,
      role: "review",
      contentHash: hash,
      r2Key: artifactObjectKey({
        workspaceId: FIX.workspace,
        role: "review",
        runId,
        versionId: created.result.version_id,
        contentHash: hash,
      }),
      size: bytes.byteLength,
      now: NOW,
    });
    const finalized = await hub.execute(finalizeArtifactCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      idempotencyKey: randomUlid(),
      input: { versionId: created.result.version_id, contentHash: hash, size: bytes.byteLength },
    });
    if (!finalized.ok) throw new Error(JSON.stringify(finalized));
    return {
      artifact_id: created.result.artifact_id,
      version_id: created.result.version_id,
      content_hash: hash,
    };
  }
  async function taskAndRun(projectId = FIX.projectA): Promise<{ taskId: string; runId: string }> {
    const task = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      idempotencyKey: randomUlid(),
      input: { projectId, title: "Synthetic route review task", priority: "P1" as const },
    });
    if (!task.ok) throw new Error(JSON.stringify(task));
    const run = await hub.execute(createRunCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      idempotencyKey: randomUlid(),
      input: {
        taskId: task.result.id,
        expectedTaskVersion: 1,
        agentProfileId: FIX.profileCodex,
        workspacePolicyVersion: 1,
        projectPolicyVersion: 1,
        repositoryConfigVersion: 1,
        agentProfileVersion: 1,
      },
    });
    if (!run.ok) throw new Error(JSON.stringify(run));
    return { taskId: task.result.id, runId: run.result.run.id };
  }
  function reviewBody(
    version: { version_id: string; content_hash: string },
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      version_id: version.version_id,
      expected_content_hash: version.content_hash,
      expected_latest_version_id: version.version_id,
      decision: "approve",
      request_id: `route-${randomUlid()}`,
      ...overrides,
    };
  }
  return { context, prefix, request, available, taskAndRun, reviewBody, reviewerCsrf, reviewer };
}

describe("artifact review routes", () => {
  it("records a review and reports approval on read", async () => {
    const f = await fixture();
    const version = await f.available("route-approve");
    const created = await f.request(
      `${f.prefix}/${version.artifact_id}/reviews`,
      f.reviewBody(version),
    );
    expect(created.status).toBe(201);
    const review = ((await created.json()) as { review: Record<string, unknown> }).review;
    expect(review.version_id).toBe(version.version_id);
    expect(review.content_hash).toBe(version.content_hash);
    const status = await f.request(
      `${f.prefix}/${version.artifact_id}/reviews`,
      undefined,
      undefined,
      "GET",
    );
    expect(status.status).toBe(200);
    const body = (await status.json()) as {
      approved: boolean;
      changes_requested: boolean;
      review_count: number;
      historical_count: number;
      reviews: Array<{ decision: string; historical: boolean; outdated: boolean }>;
    };
    expect(body.approved).toBe(true);
    expect(body.changes_requested).toBe(false);
    expect(body.review_count).toBe(1);
    expect(body.historical_count).toBe(0);
    expect(body.reviews[0]).toMatchObject({
      decision: "approve",
      historical: false,
      outdated: false,
    });
  });

  it("rejects hash mismatch and stale review state with explicit conflicts", async () => {
    const f = await fixture();
    const version = await f.available("route-conflict");
    const mismatch = await f.request(
      `${f.prefix}/${version.artifact_id}/reviews`,
      f.reviewBody(version, { expected_content_hash: digest(TEXT) }),
    );
    expect(mismatch.status).toBe(409);
    expect(((await mismatch.json()) as { error: string }).error).toBe("version_mismatch");
    const second = await f.available("route-conflict-v2", null, version.artifact_id);
    expect(second.artifact_id).toBe(version.artifact_id);
    const stale = await f.request(
      `${f.prefix}/${version.artifact_id}/reviews`,
      f.reviewBody(version),
    );
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe("stale_version");
    const status = await f.request(
      `${f.prefix}/${version.artifact_id}/reviews`,
      undefined,
      undefined,
      "GET",
    );
    expect(((await status.json()) as { approved: boolean }).approved).toBe(false);
  });

  it("returns not found for unknown artifacts and uploading versions", async () => {
    const f = await fixture();
    const missing = await f.request(
      `${f.prefix}/${randomUlid()}/reviews`,
      undefined,
      undefined,
      "GET",
    );
    expect(missing.status).toBe(404);
    const hub = new WorkspaceHub(f.context.db);
    const minted = mintUploadGrantSecret();
    const created = await hub.execute(createArtifactCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      idempotencyKey: randomUlid(),
      input: {
        artifactId: null,
        runId: null,
        format: "markdown" as never,
        role: "review" as never,
        declaredSize: TEXT.byteLength,
        expectedDigest: digest(TEXT),
        grantSecretHash: minted.secretHash,
      },
    });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const review = await f.request(`${f.prefix}/${created.result.artifact_id}/reviews`, {
      version_id: created.result.version_id,
      expected_content_hash: digest(TEXT),
      expected_latest_version_id: created.result.version_id,
      decision: "approve",
      request_id: `route-${randomUlid()}`,
    });
    expect(review.status).toBe(404);
  });

  it("enforces reviewer project scoping on run-bound artifacts", async () => {
    const f = await fixture();
    const scoped = await f.taskAndRun(FIX.projectB);
    const version = await f.available("route-scope", scoped.runId);
    const denied = await f.request(
      `${f.prefix}/${version.artifact_id}/reviews`,
      f.reviewBody(version),
      { cookie: f.reviewer.cookie, csrf: f.reviewerCsrf },
    );
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toBe("forbidden");
  });

  it("links an A04 timer observation and never accepts the run result", async () => {
    const f = await fixture();
    const scoped = await f.taskAndRun(FIX.projectA);
    const version = await f.available("route-timer", scoped.runId);
    const base = `/api/v1/workspaces/${FIX.workspace}`;
    const timer = await f.request(`${base}/tasks/${scoped.taskId}/review-timers`, {
      request_id: `route-${randomUlid()}`,
    });
    expect(timer.status).toBe(200);
    const timerBody = (await timer.json()) as {
      ok: boolean;
      result: { id: string; resource_version: number };
    };
    const observations = await f.request(
      `${base}/tasks/${scoped.taskId}/measurements`,
      undefined,
      undefined,
      "GET",
    );
    expect(observations.status).toBe(200);
    const timers = await f.request(
      `${base}/tasks/${scoped.taskId}/review-timers`,
      undefined,
      undefined,
      "GET",
    );
    expect(timers.status).toBe(200);
    const observation = (await f.context.db
      .prepare(
        `SELECT observation_id FROM review_timer_observations
         WHERE workspace_id = ? AND timer_id = ? AND observed_kind = 'started'`,
      )
      .get(FIX.workspace, timerBody.result.id)) as { observation_id: string };
    const created = await f.request(
      `${f.prefix}/${version.artifact_id}/reviews`,
      f.reviewBody(version, {
        decision: "request_changes",
        comment: "Synthetic route change request",
        review_timer_observation_id: observation.observation_id,
      }),
    );
    expect(created.status).toBe(201);
    const status = (await (
      await f.request(`${f.prefix}/${version.artifact_id}/reviews`, undefined, undefined, "GET")
    ).json()) as {
      approved: boolean;
      changes_requested: boolean;
      linked_submissions: unknown[];
      reviews: Array<{ id: string; review_timer_observation_id: string | null }>;
      review_timers: Record<string, { observation: { observation_id: string } } | null>;
    };
    expect(status.approved).toBe(false);
    expect(status.changes_requested).toBe(true);
    expect(status.linked_submissions).toEqual([]);
    expect(status.reviews[0]?.review_timer_observation_id).toBe(observation.observation_id);
    const timerContext = status.review_timers[status.reviews[0]?.id as string];
    expect(timerContext?.observation.observation_id).toBe(observation.observation_id);
    const results = (await (
      await f.request(`${base}/runs/${scoped.runId}/results`, undefined, undefined, "GET")
    ).json()) as { submissions: unknown[] };
    expect(results.submissions).toEqual([]);
    expect(timerBody.result.id).toBeTruthy();
  });

  it("lists run artifacts with approval state for the review surface", async () => {
    const f = await fixture();
    const scoped = await f.taskAndRun(FIX.projectA);
    const version = await f.available("route-list", scoped.runId);
    const listed = await f.request(
      `${f.prefix}?run_id=${scoped.runId}`,
      undefined,
      undefined,
      "GET",
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      artifacts: Array<{ artifact_id: string; approved: boolean; review_count: number }>;
    };
    expect(body.artifacts.map((entry) => entry.artifact_id)).toContain(version.artifact_id);
    const entry = body.artifacts.find((row) => row.artifact_id === version.artifact_id);
    expect(entry).toMatchObject({ approved: false, review_count: 0 });
    const bad = await f.request(`${f.prefix}?run_id=nope`, undefined, undefined, "GET");
    expect(bad.status).toBe(400);
  });
});
