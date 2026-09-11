// ABOUTME: Exercises mounted browser approval and native runner possession routes end to end.
// ABOUTME: Cookie/CSRF separation, bounded bodies, durable rate limits, and redaction fail closed.

import { describe, expect, it } from "vitest";

import {
  FIX,
  issueStepUpProof,
  seedSyntheticWorkspace,
  canonicalRunnerKey,
  randomUlid,
  runnerEnrollmentTarget,
  runnerChallengeTranscript,
  runnerHash,
  type RunnerChallenge,
} from "@bfb/domain";

import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import { AUTH_TEST_ENV, openAuthTestContext, seedAuthSession } from "./auth-helpers.js";

const NOW = "2026-09-11T20:00:00.000Z";
const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;

async function fixture() {
  const context = openAuthTestContext(NOW);
  await seedSyntheticWorkspace(context.db, NOW);
  const session = await seedAuthSession(context, {
    humanId: FIX.owner,
    email: "owner@synthetic.test",
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
  const authenticated = await app().request(
    new Request(ORIGIN + "/auth/session", { headers: { cookie: session.cookie } }),
    undefined,
    env,
  );
  expect(authenticated.status).toBe(200);
  const csrf = ((await authenticated.json()) as { csrf_token: string }).csrf_token;
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
  const enrollment = {
    runnerId: randomUlid(),
    deviceLabel: "API Synthetic Mac",
    publicKey: await canonicalRunnerKey({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }),
    projectIds: [FIX.projectA],
  };
  const path = `/api/v1/workspaces/${FIX.workspace}/runners`;
  const nativePath = `/runner/workspaces/${FIX.workspace}/runners/${enrollment.runnerId}`;
  async function browser(body: unknown, headers?: Record<string, string>) {
    return app().request(
      new Request(ORIGIN + path, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          origin: ORIGIN,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          "x-bfb-csrf": csrf,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
      undefined,
      env,
    );
  }
  const input = {
    runner_id: enrollment.runnerId,
    device_label: enrollment.deviceLabel,
    public_key: enrollment.publicKey,
    project_ids: enrollment.projectIds,
  };
  async function enroll() {
    const proof = await issueStepUpProof(
      context.db,
      FIX.owner,
      {
        action: "runner.enroll",
        workspaceId: FIX.workspace,
        targetId: runnerEnrollmentTarget(enrollment),
        scopes: [],
        authorizationEpoch: 1,
        expiresAt: "2026-09-11T20:05:00.000Z",
      },
      NOW,
    );
    const response = await browser({ ...input, step_up_proof_id: proof });
    expect(response.status, await response.clone().text()).toBe(201);
    return response;
  }
  async function native(action: string, body: unknown, headers: Record<string, string> = {}) {
    return app().request(
      new Request(`${ORIGIN}${nativePath}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      undefined,
      env,
    );
  }
  async function challenge(body: unknown = { purpose: "token" }) {
    const response = await native("challenge", body);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return ((await response.json()) as { challenge: RunnerChallenge }).challenge;
  }
  async function proof(challenge: RunnerChallenge) {
    const bytes = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      runnerChallengeTranscript(challenge),
    );
    return {
      challenge_id: challenge.challenge_id,
      server_nonce: challenge.server_nonce,
      signature: Buffer.from(bytes).toString("base64url"),
    };
  }
  return {
    context,
    env,
    app,
    session,
    browser,
    input,
    enroll,
    native,
    nativePath,
    challenge,
    proof,
    enrollment,
  };
}

describe("C06 browser and native runner routes", () => {
  it("requires browser identity, CSRF and fresh action-bound passkey proof for approval", async () => {
    const f = await fixture();
    for (const headers of [
      { cookie: "" },
      { "x-bfb-csrf": "stolen" },
      { origin: "https://attacker.test" },
      { authorization: "Bearer bfb_runner_wrong" },
    ]) {
      const response = await f.browser(f.input, headers);
      expect([401, 403]).toContain(response.status);
    }
    const sessionOnly = await f.browser(f.input);
    expect(sessionOnly.status).toBe(403);
    expect(await sessionOnly.json()).toEqual({
      error: "request_rejected",
      message: "request rejected",
    });
    expect(f.context.raw.prepare(`SELECT COUNT(*) AS count FROM runners`).get()).toEqual({
      count: 0,
    });
    await f.enroll();
    const rows = f.context.raw.prepare(`SELECT owner_human_id FROM runners`).all();
    expect(rows).toEqual([{ owner_human_id: FIX.owner }]);
    const replay = await f.browser(f.input);
    expect(replay.status).toBe(403);
  });

  it("completes native token issuance and request-bound authentication without a browser cookie", async () => {
    const f = await fixture();
    await f.enroll();
    const challenge = await f.challenge();
    const proof = await f.proof(challenge);
    const response = await f.native("token", proof);
    expect(response.status, await response.clone().text()).toBe(200);
    const { token } = (await response.json()) as { token: string };
    expect(token).toMatch(/^bfb_runner_/);
    expect((await f.native("token", proof)).status).toBe(403);
    const binding = {
      method: "POST",
      path: `${f.nativePath}/authenticate`,
      body_sha256: runnerHash(""),
    };
    const authProof = await f.proof(
      await f.challenge({ purpose: "request", token, request: binding }),
    );
    const authenticated = await f.native("authenticate", { ...authProof, token });
    expect(authenticated.status, await authenticated.clone().text()).toBe(200);
    expect(await authenticated.json()).toMatchObject({
      principal: { kind: "runner", runnerId: f.enrollment.runnerId, workspaceId: FIX.workspace },
    });
    expect((await f.native("authenticate", { ...authProof, token })).status).toBe(403);
    for (const table of [
      "runner_challenges",
      "runner_tokens",
      "semantic_events",
      "audit_events",
      "outbox_records",
      "idempotency_records",
      "rate_limit_buckets",
    ]) {
      const dump = JSON.stringify(f.context.raw.prepare(`SELECT * FROM ${table}`).all());
      for (const secret of [
        token,
        proof.server_nonce,
        proof.signature,
        authProof.server_nonce,
        authProof.signature,
      ])
        expect(dump).not.toContain(secret);
    }
  });

  it("rejects credential confusion, injected fields, oversize bodies, and unknown proofs uniformly", async () => {
    const f = await fixture();
    await f.enroll();
    for (const headers of [
      { cookie: f.session.cookie },
      { origin: ORIGIN },
      { authorization: "Bearer mcp_synthetic" },
    ]) {
      const response = await f.native("challenge", { purpose: "token" }, headers);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "request_rejected",
        message: "request rejected",
      });
    }
    for (const body of [
      { purpose: "token", private_key: "secret" },
      { purpose: "token", path: "/Users/synthetic" },
      { purpose: "token", credentials: "x".repeat(9000) },
      { purpose: "token", request: {} },
    ]) {
      expect((await f.native("challenge", body)).status).toBe(403);
    }
    expect(
      (
        await f.native("token", {
          challenge_id: randomUlid(),
          server_nonce: "x".repeat(43),
          signature: "x".repeat(86),
        })
      ).status,
    ).toBe(403);
    expect(f.context.raw.prepare(`SELECT COUNT(*) AS count FROM runner_challenges`).get()).toEqual({
      count: 0,
    });
  });

  it("shares rate limits between fresh app instances and excludes raw network identity from buckets", async () => {
    const f = await fixture();
    await f.enroll();
    for (let index = 0; index < 20; index += 1) {
      const response = await f.native(
        "challenge",
        { purpose: "token" },
        { "cf-connecting-ip": "192.0.2.119" },
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const response = await f.native(
      "challenge",
      { purpose: "token" },
      { "cf-connecting-ip": "192.0.2.119" },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "request_rejected",
      message: "request rejected",
    });
    expect(
      (await f.native("challenge", { purpose: "token" }, { "cf-connecting-ip": "192.0.2.120" }))
        .status,
    ).toBe(403);
    const buckets = JSON.stringify(f.context.raw.prepare(`SELECT * FROM rate_limit_buckets`).all());
    expect(buckets).not.toContain("192.0.2.");
    expect(buckets).not.toContain(f.enrollment.runnerId);
  });
});
