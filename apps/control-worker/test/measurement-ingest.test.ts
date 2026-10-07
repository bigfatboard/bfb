// ABOUTME: Exercises actual signed telemetry requests, capability discovery and held public source pages.
// ABOUTME: Preserves raw numeric boundaries and sanitized infrastructure failures through the mounted Worker.

import type { SqlDatabase } from "@bfb/db";
import { FIX, runnerChallengeTranscript, runnerHash, type RunnerChallenge } from "@bfb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFixture } from "../../../packages/domain/test/agent-capture-fixture.js";
import { LAUNCH_NOW } from "../../../packages/domain/test/launch-fixture.js";
import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import { AUTH_TEST_ENV, openAuthTestContext, seedAuthSession } from "./auth-helpers.js";

const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());

async function fixture() {
  const context = openAuthTestContext(LAUNCH_NOW),
    f = await captureFixture(context.db, false);
  let hubDb = context.db;
  const namespace = createTestWorkspaceHubNamespace({
    prepare: (sql) => hubDb.prepare(sql),
    withTransaction: (fn) => hubDb.withTransaction(fn),
  });
  const env = {
    DB: {},
    ARTIFACTS: {},
    ASSETS: {},
    JOBS: {},
    JOBS_DLQ: {},
    WORKSPACE_HUB: namespace,
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  } as unknown as ControlBindings;
  const send = (request: Request) =>
    createControlApp(validateControlEnv(env), {
      db: context.db,
      now: LAUNCH_NOW,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      humanAuth: () => ({
        auth: context.auth,
        keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
        abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      }),
    }).request(request, undefined, env);
  const prefix = `/runner/workspaces/${FIX.workspace}/runners/${f.runner}/events`;
  async function signed(action: "ingest" | "capabilities", value: unknown = null, raw?: string) {
    const method = action === "capabilities" ? "GET" : "POST",
      path = `${prefix}/${action}`,
      bytes = raw ?? (action === "capabilities" ? "" : JSON.stringify(value));
    const response = await send(
      new Request(`${ORIGIN}/runner/workspaces/${FIX.workspace}/runners/${f.runner}/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purpose: "request",
          token: f.token,
          request: { method, path, body_sha256: runnerHash(bytes) },
        }),
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const challenge = ((await response.json()) as { challenge: RunnerChallenge }).challenge;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      f.key.privateKey,
      runnerChallengeTranscript(challenge),
    );
    const proof = Buffer.from(
      JSON.stringify({
        challenge_id: challenge.challenge_id,
        server_nonce: challenge.server_nonce,
        signature: Buffer.from(signature).toString("base64url"),
        token: f.token,
      }),
    ).toString("base64url");
    return new Request(ORIGIN + path, {
      method,
      headers: {
        "x-bfb-runner-proof": proof,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: bytes } : {}),
    });
  }
  const event = () => ({
    schema_version: 2,
    event_id: f.reference().request_id,
    source_stream_id: f.reference().request_id,
    source_sequence: 1,
    run_execution_id: f.final.run_execution_id,
    assignment_generation: f.final.assignment_generation,
    provider_session_id: f.binding.observed_session_id,
    kind: "progress_reported",
    occurred_at: LAUNCH_NOW,
    capture_origin: "hook_inbox",
    payload: {
      measurement: "tokens",
      usage_id: "PRIVATE_USAGE_SOURCE",
      basis: "turn_delta",
      model: "PRIVATE_MODEL_SOURCE",
      quality: "provider_reported",
      tokens: { input: 7, output: 3, cache_read: null, cache_write: null, reasoning: 1 },
    },
  });
  const effects = () =>
    context.db
      .prepare(
        `SELECT
    (SELECT COUNT(*) FROM event_ledger) AS ledger, (SELECT COUNT(*) FROM token_observations) AS tokens,
    (SELECT COUNT(*) FROM measurement_sources) AS sources, (SELECT COUNT(*) FROM measurement_event_sources) AS aliases`,
      )
      .get();
  return {
    ...f,
    context,
    env,
    prefix,
    send,
    signed,
    event,
    effects,
    setHubDb: (db: SqlDatabase) => {
      hubDb = db;
    },
  };
}

describe("mounted typed measurement telemetry", () => {
  it("discovers exact schema support only with real request-bound possession", async () => {
    const f = await fixture();
    const response = await f.send(await f.signed("capabilities"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schema_version: 1, accepted_event_versions: [1, 2] });
    expect((await f.send(new Request(ORIGIN + f.prefix + "/capabilities"))).status).toBe(403);
    expect(
      (
        await f.send(
          new Request(ORIGIN + f.prefix + "/capabilities", {
            headers: { "x-bfb-runner-proof": Buffer.from("{").toString("base64url") },
          }),
        )
      ).status,
    ).toBe(403);
    expect(await f.effects()).toEqual({ ledger: 0, tokens: 0, sources: 0, aliases: 0 });
  });

  it("accepts more than 20 capability polls under the unchanged channel/challenge budget", async () => {
    const f = await fixture();
    for (let index = 0; index < 21; index++) {
      expect((await f.send(await f.signed("capabilities"))).status).toBe(200);
    }
  });

  it("co-commits signed token telemetry and returns the exact closed ACK", async () => {
    const f = await fixture(),
      event = f.event();
    const response = await f.send(await f.signed("ingest", { schema_version: 1, events: [event] }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      schema_version: 1,
      workspace_id: FIX.workspace,
      dispositions: [
        {
          event_id: event.event_id,
          source_stream_id: event.source_stream_id,
          source_sequence: 1,
          disposition: "accepted",
        },
      ],
    });
    expect(await f.effects()).toEqual({ ledger: 1, tokens: 1, sources: 1, aliases: 1 });
  });

  it.each(["9007199254740991.1", "1e-324"])(
    "retains raw counter %s for per-item rejection and leaves its identity reusable",
    async (lexeme) => {
      const f = await fixture(),
        event = f.event(),
        body = { schema_version: 1, events: [event] },
        raw = JSON.stringify(body).replace('"input":7', `"input":${lexeme}`);
      const response = await f.send(await f.signed("ingest", body, raw));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        dispositions: [{ disposition: "permanently_rejected" }],
      });
      expect(await f.effects()).toEqual({ ledger: 0, tokens: 0, sources: 0, aliases: 0 });
      const corrected = await f.send(await f.signed("ingest", body));
      expect(corrected.status).toBe(200);
      expect(await corrected.json()).toMatchObject({ dispositions: [{ disposition: "accepted" }] });
      expect(await f.effects()).toEqual({ ledger: 1, tokens: 1, sources: 1, aliases: 1 });
    },
  );

  it("returns sanitized retryable failure when the serialized Hub cannot read canonical sources", async () => {
    const f = await fixture(),
      actual = f.context.db;
    function fail(db: SqlDatabase): SqlDatabase {
      return {
        prepare(sql) {
          if (sql.includes("FROM measurement_sources"))
            throw new Error("PRIVATE_SYNTHETIC_DATABASE_FAILURE");
          return db.prepare(sql);
        },
        withTransaction(fn) {
          return db.withTransaction((tx) => fn(fail(tx)));
        },
      };
    }
    f.setHubDb(fail(actual));
    const response = await f.send(
      await f.signed("ingest", { schema_version: 1, events: [f.event()] }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE_SYNTHETIC");
    expect(await f.effects()).toEqual({ ledger: 0, tokens: 0, sources: 0, aliases: 0 });
  });

  it("holds public source pages after admission without changing signed telemetry or pure query errors", async () => {
    const f = await fixture(),
      event = f.event();
    expect(
      (await f.send(await f.signed("ingest", { schema_version: 1, events: [event] }))).status,
    ).toBe(200);
    const session = await seedAuthSession(f.context, {
      humanId: FIX.owner,
      email: "owner@synthetic.test",
    });
    const path = `${ORIGIN}/api/v1/workspaces/${FIX.workspace}/runs/${f.launch.run_id}/measurement-sources`;
    const request = (suffix = "") =>
      f.send(new Request(path + suffix, { headers: { cookie: session.cookie } }));
    const before = await f.effects();
    const held = { error: "request_rejected", message: "event feeds are unavailable" };
    const response = await request("?limit=1");
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = await response.json();
    expect(page).toEqual(held);
    expect(JSON.stringify(page)).not.toContain("PRIVATE_USAGE_SOURCE");
    expect(JSON.stringify(page)).not.toContain("PRIVATE_MODEL_SOURCE");
    expect((await request("?limit=101")).status).toBe(400);
    expect((await request("?limit=1&limit=2")).status).toBe(400);
    await f.db
      .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
      .run(FIX.workspace, FIX.projectA);
    await f.db
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.owner);
    const afterProjectLoss = await request();
    expect(afterProjectLoss.status).toBe(409);
    expect(await afterProjectLoss.json()).toEqual(held);
    expect((await f.send(new Request(path))).status).toBe(401);
    expect(await f.effects()).toEqual(before);
  });
});
