// ABOUTME: Exercises mounted view-grant issuance over browser sessions and budgets.
// ABOUTME: Synthetic sessions prove uniform failures, reviewer previews, and hash-only storage.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  artifactHash,
  artifactObjectKey,
  createArtifactCommand,
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
  async function session(userId: string, sessionId: string, token: string, humanId: string, email: string) {
    return seedAuthSession(context, { userId, sessionId, token, humanId, email, now: NOW });
  }
  const owner = await session("view-user", "view-session", "view-token", FIX.owner, "owner@synthetic.test");
  const member = await session(
    "view-member-user",
    "view-member-session",
    "view-member-token",
    FIX.member,
    "member@synthetic.test",
  );
  const reviewer = await session(
    "view-reviewer-user",
    "view-reviewer-session",
    "view-reviewer-token",
    FIX.restricted,
    "restricted@synthetic.test",
  );
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
  async function csrfFor(cookie: string): Promise<string> {
    const response = await app().request(
      new Request(ORIGIN + "/auth/session", { headers: { cookie } }),
      undefined,
      env,
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { csrf_token: string }).csrf_token;
  }
  const prefix = `/api/v1/workspaces/${FIX.workspace}/artifacts`;
  async function post(
    path: string,
    body: unknown,
    sessionPair: { cookie: string; csrf: string } = { cookie: owner.cookie, csrf },
    ip = "192.0.2.81",
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
          "cf-connecting-ip": ip,
        },
        body: method === "GET" ? undefined : JSON.stringify(body),
      }),
      undefined,
      env,
    );
  }
  async function available(format = "html"): Promise<string> {
    const hub = new WorkspaceHub(context.db);
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
        format: format as never,
        role: "review" as never,
        declaredSize: TEXT.byteLength,
        expectedDigest: digest(TEXT),
        grantSecretHash: minted.secretHash,
      },
    });
    if (!created.ok) throw new Error(JSON.stringify(created));
    await redeemUploadGrant(context.db, {
      grantId: created.result.upload_grant.grant_id,
      secret: minted.secret,
      now: NOW,
    });
    const key = artifactObjectKey({
      workspaceId: FIX.workspace,
      role: "review",
      runId: null,
      versionId: created.result.version_id,
      contentHash: digest(TEXT),
    });
    await recordVerifiedUpload(context.db, {
      workspaceId: FIX.workspace,
      versionId: created.result.version_id,
      runId: null,
      role: "review",
      contentHash: digest(TEXT),
      r2Key: key,
      size: TEXT.byteLength,
      now: NOW,
    });
    const finalized = await hub.execute(finalizeArtifactCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      idempotencyKey: randomUlid(),
      input: {
        versionId: created.result.version_id,
        contentHash: digest(TEXT),
        size: TEXT.byteLength,
      },
    });
    if (!finalized.ok) throw new Error(JSON.stringify(finalized));
    return created.result.version_id;
  }
  async function uploading(): Promise<string> {
    const hub = new WorkspaceHub(context.db);
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
    return created.result.version_id;
  }
  async function raw(path: string, init: RequestInit) {
    return app().request(new Request(ORIGIN + path, init), undefined, env);
  }
  return {
    db: context.db,
    post,
    raw,
    prefix,
    available,
    uploading,
    owner: { cookie: owner.cookie, csrf },
    member: { cookie: member.cookie, csrf: await csrfFor(member.cookie) },
    reviewer: { cookie: reviewer.cookie, csrf: await csrfFor(reviewer.cookie) },
  };
}

describe("artifact view grant routes", () => {
  it("issues a one-time grant and returns the secret once", async () => {
    const { db, post, prefix, available } = await fixture();
    const versionId = await available();
    const response = await post(`${prefix}/${versionId}/views`, {});
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = (await response.json()) as Record<string, string>;
    expect(payload.version_id).toBe(versionId);
    expect(payload.content_hash).toBe(digest(TEXT));
    expect(payload.format).toBe("html");
    expect(payload.view_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(payload.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(payload.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect("grant_hash" in payload).toBe(false);
    const stored = JSON.stringify({
      grants: await db.prepare(`SELECT * FROM artifact_view_grants`).all(),
      audit: await db.prepare(`SELECT payload_json FROM artifact_audit_outbox`).all(),
      idempotency: await db.prepare(`SELECT result_json FROM idempotency_records`).all(),
    });
    expect(stored.includes(payload.secret)).toBe(false);
    expect(stored.includes(payload.nonce)).toBe(false);
    const row = (await db
      .prepare(`SELECT grant_hash, view_nonce_hash FROM artifact_view_grants WHERE id = ?`)
      .get(payload.view_id)) as { grant_hash: string; view_nonce_hash: string };
    expect(row.grant_hash).toBe(artifactHash(payload.secret));
    expect(row.view_nonce_hash).toBe(artifactHash(payload.nonce));
    // Reloading mints a fresh grant rather than reissuing the secret.
    const second = (await (await post(`${prefix}/${versionId}/views`, {})).json()) as Record<string, string>;
    expect(second.view_id).not.toBe(payload.view_id);
    expect(second.secret).not.toBe(payload.secret);
  });

  it("lets reviewers open previews but refuses uploading versions and bad inputs", async () => {
    const { post, prefix, available, uploading, reviewer } = await fixture();
    const versionId = await available();
    const preview = await post(`${prefix}/${versionId}/views`, {}, reviewer);
    expect(preview.status).toBe(201);
    const pending = await uploading();
    const uniform = { error: "request_rejected", message: "request rejected" };
    for (const [path, body] of [
      [`${prefix}/${pending}/views`, {}],
      [`${prefix}/01JBFB0N0TAVERS10N0000000/views`, {}],
      [`${prefix}/not-a-version/views`, {}],
      [`${prefix}/${versionId}/views`, { unexpected: true }],
    ] as const) {
      const response = await post(path, body);
      expect(response.status, path).toBe(403);
      expect(await response.json()).toEqual(uniform);
    }
    const getResponse = await post(`${prefix}/${versionId}/views`, {}, undefined, "192.0.2.81", "GET");
    expect(getResponse.status).toBe(403);
    expect(await getResponse.json()).toEqual(uniform);
  });

  it("keeps Bearer [REDACTED] and missing sessions off the view routes", async () => {
    const { raw, prefix, available } = await fixture();
    const versionId = await available();
    const path = `${prefix}/${versionId}/views`;
    const withCredential = await raw(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer v02-synthetic-cli-credential",
      },
      body: JSON.stringify({}),
    });
    expect(withCredential.status).toBe(401);
    expect(await withCredential.json()).toEqual({
      error: "credential_confusion",
      message: expect.any(String),
    });
    const anonymous = await raw(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(anonymous.status).toBe(401);
  });

  it("holds view creation to the durable per-subject attempt budget", async () => {
    const { post, prefix, available, member } = await fixture();
    const versionId = await available();
    const statuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      const response = await post(`${prefix}/${versionId}/views`, {}, member, "192.0.2.99");
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    expect(statuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 201));
    expect(statuses[20]).toBe(403);
    expect(
      await (
        await post(`${prefix}/${versionId}/views`, {}, member, "192.0.2.99")
      ).json(),
    ).toEqual({ error: "request_rejected", message: "request rejected" });
  });
});
