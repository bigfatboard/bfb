// ABOUTME: Exercises mounted launch routes with real browser sessions and request-bound device signatures.
// ABOUTME: Recreated Worker routers share durable abuse budgets and never persist raw wake capabilities.

import { describe, expect, it } from "vitest";
import {
  FIX,
  canonicalRunnerKey,
  encodeRunnerToken,
  randomUlid,
  runnerChallengeTranscript,
  runnerHash,
  runnerKeyThumbprint,
  runnerSecret,
  type RunnerChallenge,
  type RunnerTokenClaims,
} from "@bfb/domain";
import type { LaunchClaimResult } from "@bfb/protocol";

import {
  launchFixture,
  LAUNCH_NOW,
  SYNTHETIC_DIGEST,
} from "../../../packages/domain/test/launch-fixture.js";
import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import { AUTH_TEST_ENV, openAuthTestContext, seedAuthSession } from "./auth-helpers.js";

const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;

async function fixture() {
  const context = openAuthTestContext(LAUNCH_NOW),
    f = await launchFixture(context.db);
  const session = await seedAuthSession(context, {
    humanId: FIX.owner,
    email: "owner@synthetic.test",
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
      now: LAUNCH_NOW,
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
  const nativePrefix = `/runner/workspaces/${FIX.workspace}/runners/${f.runner}`;
  async function browser(
    action: string,
    body: unknown,
    headers: Record<string, string> = {},
    raw?: string,
  ) {
    return app().request(
      new Request(`${ORIGIN}/api/v1/workspaces/${FIX.workspace}/${action}`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "x-bfb-csrf": csrf,
          "content-type": "application/json",
          ...headers,
        },
        body: raw ?? JSON.stringify(body),
      }),
      undefined,
      env,
    );
  }
  async function signed(action: string, body: unknown, raw?: string) {
    const bytes = raw ?? JSON.stringify(body),
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
  const send = (request: Request) => app().request(request, undefined, env);
  return { ...f, context, env, app, browser, signed, send, token, nativePrefix };
}

describe("launch browser and native routes", () => {
  it("starts, wakes, claims and authorizes through mounted browser and possession routes", async () => {
    const f = await fixture();
    const start = await f.browser("launches", f.start);
    expect(start.status, await start.clone().text()).toBe(201);
    const launch = (await start.json()) as { launch_id: string };
    const wake = await f.browser("launches/wake", {
      schema_version: 1,
      launch_id: launch.launch_id,
    });
    expect(wake.status, await wake.clone().text()).toBe(201);
    const intent = (await wake.json()) as { intent_id: string };
    expect(wake.headers.get("cache-control")).toBe("no-store");
    expect(
      (
        await f.send(
          await f.signed("wake/redeem", { schema_version: 1, wake_intent_id: intent.intent_id }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.send(
          await f.signed("wake/redeem", { schema_version: 1, wake_intent_id: intent.intent_id }),
        )
      ).status,
    ).toBe(403);
    const claimRequest = {
      schema_version: 1,
      launch_id: launch.launch_id,
      runner_id: f.runner,
      idempotency_key: randomUlid(),
      claimed_at: LAUNCH_NOW,
    };
    const claim = await f.send(await f.signed("launch/claim", claimRequest));
    expect(claim.status, await claim.clone().text()).toBe(200);
    const result = (await claim.json()) as { state: string; claim: LaunchClaimResult };
    expect(result.state).toBe("claimed");
    const { specification: spec, snapshot } = result.claim;
    const reconcileRequest = await f.signed("launch/reconcile", claimRequest);
    const reconciliation = await f.send(reconcileRequest.clone());
    expect(reconciliation.status, await reconciliation.clone().text()).toBe(200);
    expect(reconciliation.headers.get("cache-control")).toBe("no-store");
    expect(await reconciliation.json()).toMatchObject({
      launch_id: spec.launch_id,
      run_execution_id: spec.run_execution_id,
      reservation_state: "reserved",
      fencing_generation: result.claim.fencing_generation,
    });
    expect((await f.send(reconcileRequest)).status).toBe(403);
    expect(
      (
        await f.send(
          await f.signed("launch/reconcile", {
            ...claimRequest,
            idempotency_key: randomUlid(),
          }),
        )
      ).status,
    ).toBe(403);
    const auth = await f.send(
      await f.signed("launch/authorize", {
        schema_version: 1,
        launch_id: spec.launch_id,
        run_execution_id: spec.run_execution_id,
        assignment_generation: spec.assignment_generation,
        fencing_generation: result.claim.fencing_generation,
        config_snapshot_id: spec.config_snapshot_id,
        config_snapshot_hash: spec.config_snapshot_hash,
        repository_config_hash: snapshot.repository_config_hash,
        physical_worktree_hash: snapshot.physical_worktree_hash,
        supervisor: { pid: 1234, start_identity: "123456:1", executable_hash: SYNTHETIC_DIGEST },
        local_lock_id: randomUlid(),
      }),
    );
    expect(auth.status, await auth.clone().text()).toBe(200);
    expect(await auth.json()).toMatchObject({ decision: "authorized" });
    for (const table of [
      "launch_wake_intents",
      "audit_events",
      "semantic_events",
      "outbox_records",
      "idempotency_records",
      "rate_limit_buckets",
    ]) {
      const rows = JSON.stringify(await f.context.db.prepare(`SELECT * FROM ${table}`).all());
      expect(rows).not.toContain(intent.intent_id);
      expect(rows).not.toContain(f.token);
    }
  });

  it("keeps browser and runner credentials separate and prevents CSRF Start", async () => {
    const f = await fixture();
    expect(
      (await f.browser("launches", f.start, { authorization: `Bearer ${f.token}` })).status,
    ).toBe(401);
    expect((await f.browser("launches", f.start, { "x-bfb-csrf": "invalid" })).status).toBe(403);
    expect(
      (await f.browser("launches", f.start, { origin: "https://untrusted.example" })).status,
    ).toBe(403);
    const signed = await f.signed("launch/claim", {});
    signed.headers.set("cookie", "synthetic-cookie");
    expect((await f.send(signed)).status).toBe(403);
    expect(
      await f.context.db.prepare(`SELECT COUNT(*) AS count FROM launch_commands`).get(),
    ).toEqual({ count: 0 });
  });

  it("rejects duplicate keys, shell fields, numeric loss and bounded-body violations uniformly", async () => {
    const f = await fixture();
    const valid = JSON.stringify(f.start);
    const requests = [
      valid.slice(0, -1) + ',"task_id":"' + f.task.id + '"}',
      valid.replace('"expected_task_version":1', '"expected_task_version":1.0000000000000001'),
      JSON.stringify({ ...f.start, argv: ["synthetic"] }),
      " ".repeat(16_385) + valid,
    ];
    for (const raw of requests) {
      const response = await f.browser("launches", undefined, {}, raw);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "request_rejected",
        message: "request rejected",
      });
    }
    expect(
      await f.context.db.prepare(`SELECT COUNT(*) AS count FROM launch_commands`).get(),
    ).toEqual({ count: 0 });
  });

  it("shares wake/control abuse limits across new Worker routers without keying on capability values", async () => {
    const f = await fixture();
    const start = await f.browser("launches", f.start),
      launch = (await start.json()) as { launch_id: string };
    for (let index = 0; index < 19; index++)
      expect(
        (await f.browser("launches/wake", { schema_version: 1, launch_id: launch.launch_id }))
          .status,
      ).toBe(201);
    const exhausted = await f.browser("run-controls", {
      schema_version: 1,
      idempotency_key: randomUlid(),
      runner_id: f.runner,
      run_execution_id: randomUlid(),
      assignment_generation: 1,
      action: "cancel",
    });
    expect(exhausted.status).toBe(403);
    expect(await exhausted.json()).toEqual({
      error: "request_rejected",
      message: "request rejected",
    });
    expect(
      await f.context.db.prepare(`SELECT COUNT(*) AS count FROM launch_wake_intents`).get(),
    ).toEqual({ count: 19 });
    expect(await f.context.db.prepare(`SELECT COUNT(*) AS count FROM run_controls`).get()).toEqual({
      count: 0,
    });
  });
});
