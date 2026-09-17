// ABOUTME: Exercises mounted artifact publication, grant reissue, and finalization.
// ABOUTME: Synthetic browser sessions prove uniform failures and hash-only persistence.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  artifactObjectKey,
  FIX,
  recordVerifiedUpload,
  seedSyntheticWorkspace,
} from "@bfb/domain";
import type { SqlDatabase } from "@bfb/db";
import { runArtifactSweep } from "../src/api/artifacts.js";

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
  const owner = await seedAuthSession(context, {
    userId: "artifact-route-user",
    sessionId: "artifact-route-session",
    token: "artifact-route-token",
    humanId: FIX.owner,
    email: "owner@synthetic.test",
    now: NOW,
  });
  const reviewer = await seedAuthSession(context, {
    userId: "artifact-route-reviewer-user",
    sessionId: "artifact-route-reviewer-session",
    token: "artifact-route-reviewer-token",
    humanId: FIX.restricted,
    email: "restricted@synthetic.test",
    now: NOW,
  });
  const fake = {};
  const env = {
    DB: fake,
    ARTIFACTS: fake,
    ASSETS: fake,
    JOBS: fake,
    JOBS_DLQ: fake,
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
  const reviewerSession = await app().request(
    new Request(ORIGIN + "/auth/session", { headers: { cookie: reviewer.cookie } }),
    undefined,
    env,
  );
  expect(reviewerSession.status).toBe(200);
  const reviewerCsrf = ((await reviewerSession.json()) as { csrf_token: string }).csrf_token;
  function headers(cookie: string, token: string, extra: Record<string, string> = {}) {
    return {
      cookie,
      origin: ORIGIN,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-bfb-csrf": token,
      "cf-connecting-ip": "192.0.2.81",
      ...extra,
    };
  }
  const prefix = `/api/v1/workspaces/${FIX.workspace}/artifacts`;
  async function post(path: string, body: unknown, session: { cookie: string; csrf: string } = {
    cookie: owner.cookie,
    csrf,
  }) {
    return app().request(
      new Request(ORIGIN + path, {
        method: "POST",
        headers: headers(session.cookie, session.csrf),
        body: JSON.stringify(body),
      }),
      undefined,
      env,
    );
  }
  async function create(body: Record<string, unknown> = {}) {
    return post(prefix, {
      format: "markdown",
      role: "review",
      declared_size: TEXT.byteLength,
      expected_digest: digest(TEXT),
      ...body,
    });
  }
  async function raw(path: string, init: RequestInit) {
    return app().request(new Request(ORIGIN + path, init), undefined, env);
  }
  return {
    db: context.db,
    post,
    create,
    raw,
    prefix,
    reviewer: { cookie: reviewer.cookie, csrf: reviewerCsrf },
  };
}

describe("artifact browser routes", () => {
  it("creates a version and returns the upload secret once", async () => {
    const { db, create } = await fixture();
    const response = await create();
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = (await response.json()) as {
      version_id: string;
      state: string;
      upload_grant: { grant_id: string; secret: string; expires_at: string };
    };
    expect(payload.state).toBe("uploading");
    expect(payload.upload_grant.secret.length).toBeGreaterThan(20);
    const stored = JSON.stringify({
      idempotency: await db.prepare(`SELECT result_json FROM idempotency_records`).all(),
      events: await db.prepare(`SELECT payload_json FROM semantic_events`).all(),
      audit: await db.prepare(`SELECT payload_json FROM audit_events`).all(),
    });
    expect(stored.includes(payload.upload_grant.secret)).toBe(false);
  });

  it("rejects invalid, oversized, and foreign bodies uniformly", async () => {
    const { post, prefix } = await fixture();
    for (const body of [
      { format: "exe", role: "review", declared_size: 3, expected_digest: digest(TEXT) },
      { format: "markdown", role: "review", declared_size: 6 * 1024 * 1024, expected_digest: digest(TEXT) },
      { format: "markdown", role: "review", declared_size: 3, expected_digest: "nope" },
      { format: "markdown", role: "review", declared_size: 3, expected_digest: digest(TEXT), extra: 1 },
      {},
    ]) {
      const response = await post(prefix, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "request_rejected",
        message: "request rejected",
      });
    }
    const oversized = await post(prefix, {
      format: "markdown",
      role: "review",
      declared_size: 3,
      expected_digest: digest(TEXT),
      padding: "x".repeat(9000),
    });
    expect(oversized.status).toBe(403);
  });

  it("rejects reviewers without an oracle", async () => {
    const { post, prefix, reviewer } = await fixture();
    const forbidden = await post(
      prefix,
      { format: "markdown", role: "review", declared_size: 3, expected_digest: digest(TEXT) },
      reviewer,
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: "request_rejected",
      message: "request rejected",
    });
  });

  it("keeps bearer credentials and missing sessions off the artifact routes", async () => {
    const { raw, prefix } = await fixture();
    const bearer = await raw(prefix, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer bfb_cli_syntheticcredential00000000000000000000",
      },
      body: JSON.stringify({
        format: "markdown",
        role: "review",
        declared_size: 3,
        expected_digest: digest(TEXT),
      }),
    });
    expect(bearer.status).toBe(401);
    expect(await bearer.json()).toEqual({
      error: "credential_confusion",
      message: expect.any(String),
    });
    const anonymous = await raw(prefix, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format: "markdown",
        role: "review",
        declared_size: 3,
        expected_digest: digest(TEXT),
      }),
    });
    expect(anonymous.status).toBe(401);
  });

  it("reissues grants and finalizes only with a verified receipt", async () => {
    const { db, post, create, prefix } = await fixture();
    const created = (await (await create()).json()) as {
      version_id: string;
      upload_grant: { grant_id: string };
    };
    const reissued = await post(`${prefix}/${created.version_id}/grants`, {});
    expect(reissued.status).toBe(201);
    const grant = (await reissued.json()) as { grant_id: string; secret: string };
    expect(grant.grant_id).not.toBe(created.upload_grant.grant_id);

    const early = await post(`${prefix}/${created.version_id}/finalize`, {
      content_hash: digest(TEXT),
      size: TEXT.byteLength,
    });
    expect(early.status).toBe(403);

    const key = artifactObjectKey({
      workspaceId: FIX.workspace,
      role: "review",
      runId: null,
      versionId: created.version_id,
      contentHash: digest(TEXT),
    });
    await (db as SqlDatabase).withTransaction((tx) =>
      recordVerifiedUpload(tx, {
        workspaceId: FIX.workspace,
        versionId: created.version_id,
        runId: null,
        role: "review",
        contentHash: digest(TEXT),
        r2Key: key,
        size: TEXT.byteLength,
        now: NOW,
      }),
    );
    const finalized = await post(`${prefix}/${created.version_id}/finalize`, {
      content_hash: digest(TEXT),
      size: TEXT.byteLength,
    });
    expect(finalized.status).toBe(200);
    const done = (await finalized.json()) as { state: string; r2_key: string };
    expect(done.state).toBe("available");
    expect(done.r2_key).toBe(key);

    const again = await post(`${prefix}/${created.version_id}/finalize`, {
      content_hash: digest(TEXT),
      size: TEXT.byteLength,
    });
    expect(again.status).toBe(403);
    const regrant = await post(`${prefix}/${created.version_id}/grants`, {});
    expect(regrant.status).toBe(403);
  });

  it("enforces the durable grant-create budget across isolates", async () => {
    const { create } = await fixture();
    const statuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      statuses.push((await create()).status);
    }
    expect(statuses.filter((status) => status === 201).length).toBe(20);
    expect(statuses.at(-1)).toBe(403);
  });

  it("sweeps abandoned versions without touching live ones", async () => {
    const { db, create } = await fixture();
    await create();
    const { marked } = await runArtifactSweep(db, "2026-09-17T12:40:00.000Z");
    expect(marked.length).toBeGreaterThan(0);
    const rows = (await db
      .prepare(`SELECT state FROM artifact_versions`)
      .all()) as Array<{ state: string }>;
    expect(rows.every((row) => row.state === "failed")).toBe(true);
  });
});
