// ABOUTME: Exercises mounted E01 ingest and replay routes with real sessions and device signatures.
// ABOUTME: Browser replay is read-only; runner batches authenticate through request-bound possession.

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

import {
  launchFixture,
  LAUNCH_NOW,
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
  const reviewer = await seedAuthSession(context, {
    userId: "auth-user-e01-reviewer",
    sessionId: "auth-session-e01-reviewer",
    token: "auth-token-e01-reviewer",
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
  function browserGet(path: string, cookie = session.cookie, extra: Record<string, string> = {}) {
    return app().request(
      new Request(`${ORIGIN}/api/v1/workspaces/${FIX.workspace}${path}`, {
        headers: { cookie, ...extra },
      }),
      undefined,
      env,
    );
  }
  function browserPost(path: string, body: unknown, method = "POST") {
    return app().request(
      new Request(`${ORIGIN}/api/v1/workspaces/${FIX.workspace}${path}`, {
        method,
        headers: {
          cookie: session.cookie,
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "x-bfb-csrf": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      undefined,
      env,
    );
  }
  const send = (request: Request) => app().request(request, undefined, env);
  async function startAndClaim() {
    const started = await browserPost("/launches", f.start);
    expect(started.status, await started.clone().text()).toBe(201);
    const { launch_id: launchId } = (await started.json()) as { launch_id: string };
    const claimed = await send(
      await signed("launch/claim", {
        schema_version: 1,
        launch_id: launchId,
        runner_id: f.runner,
        idempotency_key: randomUlid(),
        claimed_at: LAUNCH_NOW,
      }),
    );
    expect(claimed.status, await claimed.clone().text()).toBe(200);
    const result = (await claimed.json()) as {
      state: string;
      claim: { specification: { run_execution_id: string; assignment_generation: number } };
    };
    expect(result.state).toBe("claimed");
    return result.claim.specification;
  }
  return { ...f, context, env, app, browserGet, browserPost, signed, send, csrf, reviewer, startAndClaim };
}

function batch(executionId: string, generation: number, stream: string, from: number, kinds: string[]) {
  return {
    schema_version: 1,
    events: kinds.map((kind, index) => ({
      schema_version: 1,
      event_id: randomUlid(),
      source_stream_id: stream,
      source_sequence: from + index,
      run_execution_id: executionId,
      assignment_generation: generation,
      kind,
      occurred_at: LAUNCH_NOW,
      capture_origin: "runner_observed",
      payload: {},
    })),
  };
}

describe("event ingest and replay routes", () => {
  it("ingests runner batches with per-event dispositions and replays them in the browser", async () => {
    const f = await fixture();
    const { run_execution_id: executionId, assignment_generation: generation } =
      await f.startAndClaim();
    const stream = randomUlid();
    const first = await f.send(
      await f.signed("events/ingest", batch(executionId, generation, stream, 1, ["heartbeat", "turn_started"])),
    );
    expect(first.status, await first.clone().text()).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const committed = (await first.json()) as {
      schema_version: number;
      workspace_id: string;
      high_water_cursor: number;
      dispositions: Array<{ disposition: string }>;
    };
    expect(committed).toMatchObject({ schema_version: 1, workspace_id: FIX.workspace });
    expect(committed.dispositions.map((entry) => entry.disposition)).toEqual([
      "accepted",
      "accepted",
    ]);

    const resend = await f.send(
      await f.signed(
        "events/ingest",
        batch(executionId, generation, stream, 1, ["heartbeat", "turn_started"]),
      ),
    );
    expect(resend.status).toBe(200);
    // Fresh ULIDs with reused stream sequences are stream conflicts, not silent merges.
    expect(
      ((await resend.json()) as typeof committed).dispositions.map((entry) => entry.disposition),
    ).toEqual(["permanently_rejected", "permanently_rejected"]);

    const replay = await f.browserGet("/events");
    expect(replay.status, await replay.clone().text()).toBe(200);
    const body = (await replay.json()) as {
      schema_version: number;
      high_water_cursor: number;
      events: Array<{ workspace_cursor: number; kind: string; actor: unknown; source: unknown }>;
      has_more: boolean;
    };
    expect(body.high_water_cursor).toBe(committed.high_water_cursor);
    expect(body.events.map((entry) => entry.kind)).toEqual(["heartbeat", "turn_started"]);
    expect(body.has_more).toBe(false);
    expect(body.events[0]).toMatchObject({
      actor: { type: "runner", id: f.runner },
      source: { type: "runner", id: f.runner, provider: "fake" },
    });
    expect(body.events[0]?.workspace_cursor).toBeLessThan(body.events[1]?.workspace_cursor ?? 0);

    const water = await f.browserGet("/events/high-water");
    expect(water.status).toBe(200);
    expect(await water.json()).toMatchObject({
      schema_version: 1,
      high_water_cursor: committed.high_water_cursor,
    });
    const page = await f.browserGet(
      `/events?after_cursor=${body.events[0]?.workspace_cursor}&through_cursor=${body.high_water_cursor}&limit=1`,
    );
    expect(page.status).toBe(200);
    expect(((await page.json()) as typeof body).events.map((entry) => entry.kind)).toEqual([
      "turn_started",
    ]);
  });

  it("returns poison dispositions per event and rejects transport violations uniformly", async () => {
    const f = await fixture();
    const { run_execution_id: executionId, assignment_generation: generation } =
      await f.startAndClaim();
    const stream = randomUlid();
    const mixed = await f.send(
      await f.signed("events/ingest", {
        schema_version: 1,
        events: [
          {
            schema_version: 1,
            event_id: randomUlid(),
            source_stream_id: stream,
            source_sequence: 1,
            run_execution_id: executionId,
            assignment_generation: generation,
            kind: "heartbeat",
            occurred_at: LAUNCH_NOW,
            capture_origin: "runner_observed",
            payload: {},
          },
          {
            schema_version: 1,
            event_id: randomUlid(),
            source_stream_id: stream,
            source_sequence: 2,
            run_execution_id: randomUlid(),
            assignment_generation: generation,
            kind: "heartbeat",
            occurred_at: LAUNCH_NOW,
            capture_origin: "runner_observed",
            payload: {},
          },
        ],
      }),
    );
    expect(mixed.status).toBe(200);
    const result = (await mixed.json()) as {
      dispositions: Array<{ disposition: string; diagnostic?: { code: string } }>;
    };
    expect(result.dispositions.map((entry) => entry.disposition)).toEqual([
      "accepted",
      "permanently_rejected",
    ]);
    expect(result.dispositions[1]?.diagnostic?.code).toBe("unknown_execution");

    expect(
      (await f.send(await f.signed("events/ingest", { schema_version: 1, events: [] }))).status,
    ).toBe(403);
    expect(
      (
        await f.send(
          await f.signed("events/ingest", {
            schema_version: 1,
            events: Array.from({ length: 26 }, (_, index) => ({
              schema_version: 1,
              event_id: randomUlid(),
              source_stream_id: stream,
              source_sequence: 10 + index,
              run_execution_id: executionId,
              assignment_generation: generation,
              kind: "heartbeat",
              occurred_at: LAUNCH_NOW,
              capture_origin: "runner_observed",
              payload: {},
            })),
          }),
        )
      ).status,
    ).toBe(403);
    expect((await f.send(await f.signed("events/ingest", [1, 2, 3], "[1,2,3]"))).status).toBe(403);
  });

  it("keeps browser replay read-only and fenced to workspace members", async () => {
    const f = await fixture();
    await f.startAndClaim();
    const before = (await f.browserGet("/events/high-water").then((response) => response.json())) as {
      high_water_cursor: number;
    };
    const posted = await f.browserPost("/events", {});
    expect([404, 403]).toContain(posted.status);
    const deleted = await f.browserPost("/events", {}, "DELETE");
    expect([404, 403]).toContain(deleted.status);
    const after = (await f.browserGet("/events/high-water").then((response) => response.json())) as {
      high_water_cursor: number;
    };
    expect(after.high_water_cursor).toBe(before.high_water_cursor);

    const reviewer = await f.browserGet("/events", f.reviewer.cookie);
    expect(reviewer.status).toBe(403);
    const anonymous = await f.browserGet("/events", "");
    expect(anonymous.status).toBe(401);
    const badRange = await f.browserGet("/events?after_cursor=nope");
    expect(badRange.status).toBe(400);
  });
});
