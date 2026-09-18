// ABOUTME: Exercises mounted X01 preference, endpoint, delivery, and runner pull/ack routes.
// ABOUTME: Browser writes need session CSRF; runner pulls need request-bound possession proofs.

import { describe, expect, it } from "vitest";
import {
  FIX,
  canonicalRunnerKey,
  encodeRunnerToken,
  fanoutNotificationEvent,
  requestAttentionCommand,
  runnerChallengeTranscript,
  runnerHash,
  runnerKeyThumbprint,
  runnerSecret,
  type RunnerChallenge,
  type RunnerTokenClaims,
} from "@bfb/domain";

import {
  launchFixture,
  LAUNCH_NOW,
  success,
} from "../../../packages/domain/test/launch-fixture.js";
import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import { dispatchNotificationOutbox } from "../src/notifications/dispatch.js";
import { AUTH_TEST_ENV, openAuthTestContext, seedAuthSession } from "./auth-helpers.js";

const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;
const NOW = LAUNCH_NOW;

async function fixture() {
  const context = openAuthTestContext(NOW),
    f = await launchFixture(context.db);
  const session = await seedAuthSession(context, {
    humanId: FIX.owner,
    email: "owner@synthetic.test",
  });
  const reviewer = await seedAuthSession(context, {
    userId: "auth-user-x01-reviewer",
    sessionId: "auth-session-x01-reviewer",
    token: "auth-token-x01-reviewer",
    humanId: FIX.restricted,
    email: "restricted@synthetic.test",
  });
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
    JURISDICTION: "eu",
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
  const authed = await app().request(
    new Request(ORIGIN + "/auth/session", { headers: { cookie: session.cookie } }),
    undefined,
    env,
  );
  expect(authed.status).toBe(200);
  const csrf = ((await authed.json()) as { csrf_token: string }).csrf_token;
  const reviewerAuthed = await app().request(
    new Request(ORIGIN + "/auth/session", { headers: { cookie: reviewer.cookie } }),
    undefined,
    env,
  );
  const reviewerCsrf = ((await reviewerAuthed.json()) as { csrf_token: string }).csrf_token;
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", key.publicKey),
    publicKey = await canonicalRunnerKey({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const thumbprint = runnerKeyThumbprint(publicKey),
    secret = runnerSecret();
  const stored = (await context.db
    .prepare(`SELECT claims_json FROM runner_tokens WHERE id = ?`)
    .get(f.principal.tokenId)) as { claims_json: string };
  const claims: RunnerTokenClaims = { ...JSON.parse(stored.claims_json), cnf: { jkt: thumbprint } };
  await context.db
    .prepare(`UPDATE runners SET public_key_json = ?, key_thumbprint = ? WHERE id = ?`)
    .run(JSON.stringify(publicKey), thumbprint, f.runner);
  await context.db
    .prepare(`UPDATE runner_tokens SET claims_json = ?, token_hash = ? WHERE id = ?`)
    .run(JSON.stringify(claims), runnerHash(secret), f.principal.tokenId);
  const token = encodeRunnerToken(claims, secret);
  f.principal.keyThumbprint = thumbprint;
  const nativePrefix = `/runner/workspaces/${FIX.workspace}/runners/${f.runner}`;
  async function signed(action: string, body: unknown) {
    const bytes = JSON.stringify(body),
      path = `${nativePrefix}/${action}`;
    const challengeResponse = await app().request(
      new Request(`${ORIGIN}${nativePrefix}/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purpose: "request",
          token,
          request: { method: "POST", path, body_sha256: runnerHash(bytes) },
        }),
      }),
      undefined,
      env,
    );
    expect(challengeResponse.status, await challengeResponse.clone().text()).toBe(200);
    const challenge = ((await challengeResponse.json()) as { challenge: RunnerChallenge })
      .challenge;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      runnerChallengeTranscript(challenge),
    );
    const proof = Buffer.from(
      JSON.stringify({
        challenge_id: challenge.challenge_id,
        server_nonce: challenge.server_nonce,
        signature: Buffer.from(signature).toString("base64url"),
        token,
      }),
    ).toString("base64url");
    return new Request(ORIGIN + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bfb-runner-proof": proof },
      body: bytes,
    });
  }
  function browserGet(path: string, cookie = session.cookie) {
    return app().request(
      new Request(`${ORIGIN}/api/v1/workspaces/${FIX.workspace}${path}`, { headers: { cookie } }),
      undefined,
      env,
    );
  }
  function browserWrite(
    path: string,
    body: unknown,
    method = "POST",
    cookie = session.cookie,
    csrfToken = csrf,
  ) {
    return app().request(
      new Request(`${ORIGIN}/api/v1/workspaces/${FIX.workspace}${path}`, {
        method,
        headers: {
          cookie,
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "x-bfb-csrf": csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      undefined,
      env,
    );
  }
  return {
    context,
    f,
    app,
    env,
    session,
    reviewer,
    csrf,
    reviewerCsrf,
    signed,
    browserGet,
    browserWrite,
  };
}

describe("notification browser routes", () => {
  it("requires a session and serves defaults", async () => {
    const { browserGet } = await fixture();
    const denied = await browserGet("/notifications/preferences", "session=none");
    expect(denied.status).toBe(401);
    const response = await browserGet("/notifications/preferences");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      overrides: unknown[];
      defaults: Record<string, Record<string, boolean>>;
      endpoints: unknown[];
    };
    expect(body.overrides).toEqual([]);
    expect(body.endpoints).toEqual([]);
    expect(body.defaults.attention).toMatchObject({ browser_push: true, macos: true });
    expect(body.defaults.run_cancelled).toMatchObject({ browser_push: false, macos: false });
  });

  it("stores preferences and validates scope", async () => {
    const { browserGet, browserWrite, reviewer, reviewerCsrf } = await fixture();
    const stored = await browserWrite(
      "/notifications/preferences",
      {
        request_id: "x01-route-pref-1",
        preferences: [
          { channel: "macos", category: "run_cancelled", enabled: true },
          {
            project_id: FIX.projectA,
            channel: "browser_push",
            category: "attention",
            enabled: false,
          },
        ],
      },
      "PUT",
    );
    expect(stored.status, await stored.clone().text()).toBe(200);
    const reread = (await (await browserGet("/notifications/preferences")).json()) as {
      overrides: Array<{ project_id: string; channel: string; category: string; enabled: boolean }>;
    };
    expect(reread.overrides).toHaveLength(2);
    const bad = await browserWrite(
      "/notifications/preferences",
      {
        request_id: "x01-route-pref-2",
        preferences: [{ channel: "carrier_pigeon", category: "attention", enabled: true }],
      },
      "PUT",
    );
    expect(bad.status).toBe(200);
    const badBody = (await bad.json()) as {
      results: Array<{ ok: boolean; error?: { code: string } }>;
    };
    expect(badBody.results[0]?.ok).toBe(false);
    expect(badBody.results[0]?.error?.code).toBe("invalid_argument");
    const foreign = await browserWrite(
      "/notifications/preferences",
      {
        request_id: "x01-route-pref-3",
        preferences: [
          { project_id: FIX.projectB, channel: "macos", category: "attention", enabled: true },
        ],
      },
      "PUT",
      reviewer.cookie,
      reviewerCsrf,
    );
    expect(foreign.status).toBe(200);
    const foreignBody = (await foreign.json()) as {
      results: Array<{ ok: boolean; error?: { code: string } }>;
    };
    expect(foreignBody.results[0]?.ok).toBe(false);
    expect(foreignBody.results[0]?.error?.code).toBe("not_found");
  });

  it("registers, lists, and removes push endpoints", async () => {
    const { browserGet, browserWrite } = await fixture();
    const created = await browserWrite("/notifications/push-endpoints", {
      request_id: "x01-route-endpoint-1",
      endpoint: "https://push.synthetic.test/x01-route",
      p256dh: "B".repeat(87),
      auth: "A".repeat(22),
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const hash = ((await created.json()) as { result: { endpoint_hash: string } }).result
      .endpoint_hash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const listed = (await (await browserGet("/notifications/preferences")).json()) as {
      endpoints: Array<{ endpoint_hash: string }>;
    };
    expect(listed.endpoints.map((entry) => entry.endpoint_hash)).toEqual([hash]);
    const invalid = await browserWrite("/notifications/push-endpoints", {
      request_id: "x01-route-endpoint-2",
      endpoint: "http://push.synthetic.test/plain",
      p256dh: "B".repeat(87),
      auth: "A".repeat(22),
    });
    expect(invalid.status).toBe(400);
    const removed = await browserWrite(
      `/notifications/push-endpoints/${hash}`,
      {
        request_id: "x01-route-endpoint-3",
      },
      "DELETE",
    );
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { result: { removed: boolean } }).result.removed).toBe(true);
    const again = await browserWrite(
      `/notifications/push-endpoints/${hash}`,
      {
        request_id: "x01-route-endpoint-4",
      },
      "DELETE",
    );
    expect(((await again.json()) as { result: { removed: boolean } }).result.removed).toBe(false);
    const deliveries = await browserGet("/notifications/deliveries?limit=10");
    expect(deliveries.status).toBe(200);
    expect(((await deliveries.json()) as { deliveries: unknown[] }).deliveries).toEqual([]);
  });
});

describe("notification runner routes", () => {
  it("rejects unsigned pulls and serves opaque intents after fan-out", async () => {
    const { context, f, app, env, signed } = await fixture();
    const naked = await app().request(
      new Request(
        `${ORIGIN}/runner/workspaces/${FIX.workspace}/runners/${f.runner}/notifications/pull`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      ),
      undefined,
      env,
    );
    expect(naked.status).toBe(403);
    const { claimed } = await f.claim();
    success(
      await f.native(requestAttentionCommand, {
        principal: f.principal,
        runId: claimed.specification.run_id,
        executionId: claimed.specification.run_execution_id,
        assignmentGeneration: claimed.specification.assignment_generation,
        kind: "blocker",
        question: "Synthetic X01 runner pull question",
        blocking: true,
      }),
    );
    const dispatched = await dispatchNotificationOutbox(context.db, async () => {}, NOW);
    expect(dispatched.sent).toBe(1);
    const cursor = (await context.db
      .prepare(
        `SELECT workspace_cursor FROM semantic_events
         WHERE workspace_id = ? AND kind = 'attention.request' ORDER BY workspace_cursor DESC LIMIT 1`,
      )
      .get(FIX.workspace)) as { workspace_cursor: number };
    const fanout = await fanoutNotificationEvent(context.db, {
      workspaceId: FIX.workspace,
      eventCursor: cursor.workspace_cursor,
      eventKind: "attention.request",
      now: NOW,
    });
    expect(fanout.status).toBe("notified");
    const pulled = await app().request(await signed("notifications/pull", {}), undefined, env);
    expect(pulled.status, await pulled.clone().text()).toBe(200);
    const items = ((await pulled.json()) as { deliveries: Array<{ delivery_id: string }> })
      .deliveries;
    expect(items).toHaveLength(1);
    expect(items[0]?.delivery_id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const acked = await app().request(
      await signed("notifications/ack", { delivery_ids: [items[0]?.delivery_id] }),
      undefined,
      env,
    );
    expect(acked.status).toBe(200);
    expect(((await acked.json()) as { acked: number }).acked).toBe(1);
    const empty = await app().request(await signed("notifications/pull", {}), undefined, env);
    expect(((await empty.json()) as { deliveries: unknown[] }).deliveries).toEqual([]);
    const bad = await app().request(
      await signed("notifications/ack", { delivery_ids: ["short"] }),
      undefined,
      env,
    );
    expect(bad.status).toBe(403);
  });
});
