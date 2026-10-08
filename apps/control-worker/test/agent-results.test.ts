// ABOUTME: Proves fixed result routes with actual byte-bound runner possession and canonical Hub dispatch.
// ABOUTME: Exercises bounded responses, private-safe retries, current closure and separate rate classes.

import type { SqlDatabase } from "@bfb/db";
import { FIX, runnerChallengeTranscript, runnerHash, type RunnerChallenge } from "@bfb/domain";
import type { AgentResultResult } from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resultFixture } from "../../../packages/domain/test/result-fixture.js";
import { LAUNCH_NOW } from "../../../packages/domain/test/launch-fixture.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import { guardRunnerTransport } from "../src/api/runners.js";
import { AUTH_TEST_ENV, openAuthTestContext } from "./auth-helpers.js";

const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());
async function fixture(enabled = true) {
  const context = openAuthTestContext(LAUNCH_NOW),
    f = await resultFixture(context.db, enabled),
    namespace = createTestWorkspaceHubNamespace(context.db);
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
  let requestDb = context.db;
  const prefix = `/runner/workspaces/${FIX.workspace}/runners/${f.runner}`;
  const send = (request: Request) =>
    createControlApp(validateControlEnv(env), {
      db: requestDb,
      now: LAUNCH_NOW,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }).request(request, undefined, env);
  async function signed(action: string, body: unknown, raw?: string) {
    const bytes = raw ?? JSON.stringify(body),
      path = `${prefix}/work/${action}`;
    const response = await send(
      new Request(`${ORIGIN}${prefix}/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purpose: "request",
          token: f.token,
          request: { method: "POST", path, body_sha256: runnerHash(bytes) },
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
      method: "POST",
      headers: { "content-type": "application/json", "x-bfb-runner-proof": proof },
      body: bytes,
    });
  }
  return {
    ...f,
    context,
    namespace,
    env,
    prefix,
    send,
    signed,
    setDb(db: SqlDatabase) {
      requestDb = db;
    },
  };
}
const replay = (original_request: unknown, capture: unknown) => ({
  schema_version: 1,
  command_name: "result.submit",
  original_request,
  capture,
});
async function count(db: SqlDatabase) {
  return db.prepare("SELECT COUNT(*) AS count FROM result_submissions").get();
}

describe("fixed result routes", () => {
  it("allows online submission under denied offline policy with a bounded truthful result", async () => {
    const f = await fixture(false);
    const confirmation = await f.send(
      await f.signed("result-confirmation", f.confirmationRequest()),
    );
    expect(confirmation.status, await confirmation.clone().text()).toBe(200);
    expect(await confirmation.json()).toMatchObject({
      can_submit: true,
      configured_permission: { allow_submit_result: false, max_pending_age_seconds: 0 },
    });
    const request = f.request(),
      response = await f.send(await f.signed("result-submit", request));
    expect(response.status, await response.clone().text()).toBe(200);
    const result = (await response.json()) as AgentResultResult;
    expect(result).toMatchObject({
      version: 1,
      result_state: "submitted",
      task_state: "review",
      origin: {
        run_id: f.launch.run_id,
        run_execution_id: f.final.run_execution_id,
        provider_session_id: f.binding.provider_session_id,
      },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_RESULT");
    expect(await count(f.db)).toEqual({ count: 1 });
    const cached = await f.send(await f.signed("result-submit", request));
    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual(result);
    expect(
      (await f.send(await f.signed("result-submit", { ...request, summary: "changed" }))).status,
    ).toBe(403);
    const fresh = await f.send(await f.signed("result-submit", f.request()));
    expect(fresh.status).toBe(403);
    expect(await fresh.json()).toMatchObject({ error: "invalid_transition" });
  });
  it("replays the original catalog command and result key after a committed lost reply", async () => {
    const f = await fixture(),
      request = f.request(),
      capture = await f.resultCapture(request),
      get = f.namespace.get.bind(f.namespace);
    let lost = false;
    vi.spyOn(f.namespace, "get").mockImplementation((id) => {
      const stub = get(id);
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const command = JSON.parse(String(init?.body)).commandName;
          const response = await stub.fetch(input, init);
          if (!lost && command === "result.submit") {
            lost = true;
            throw Error("private lost result reply");
          }
          return response;
        },
      } as DurableObjectStub;
    });
    const missing = await f.send(await f.signed("result-submit", request));
    expect(missing.status).toBe(503);
    expect(await count(f.db)).toEqual({ count: 1 });
    const recovered = await f.send(await f.signed("result-replay", replay(request, capture)));
    expect(recovered.status, await recovered.clone().text()).toBe(200);
    expect(await count(f.db)).toEqual({ count: 1 });
    expect(
      await f.db
        .prepare("SELECT command_name FROM idempotency_records WHERE command_name='result.submit'")
        .all(),
    ).toEqual([{ command_name: "result.submit" }]);
    for (const table of ["audit_events", "semantic_events", "outbox_records"])
      expect(JSON.stringify(await f.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(
        "PRIVATE_RESULT",
      );
  });
  it.each(["requester", "session", "execution", "lease"])(
    "denies %s closure before recovery of a committed lost outcome",
    async (kind) => {
      const f = await fixture(),
        request = f.request(),
        capture = await f.resultCapture(request),
        get = f.namespace.get.bind(f.namespace);
      let lost = false;
      vi.spyOn(f.namespace, "get").mockImplementation((id) => {
        const stub = get(id);
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const command = JSON.parse(String(init?.body)).commandName;
            const response = await stub.fetch(input, init);
            if (!lost && command === "result.submit") {
              lost = true;
              throw Error("private lost outcome");
            }
            return response;
          },
        } as DurableObjectStub;
      });
      expect((await f.send(await f.signed("result-submit", request))).status).toBe(503);
      if (kind === "requester")
        await f.db.prepare("DELETE FROM runner_launch_grants WHERE human_id=?").run(FIX.member);
      if (kind === "session")
        await f.db
          .prepare("UPDATE provider_sessions SET state='ended',ended_at=? WHERE id=?")
          .run(LAUNCH_NOW, f.binding.provider_session_id);
      if (kind === "execution")
        await f.db
          .prepare(
            "UPDATE run_executions SET state='ended',end_reason='process_exit',ended_at=? WHERE id=?",
          )
          .run(LAUNCH_NOW, f.final.run_execution_id);
      if (kind === "lease")
        await f.db.prepare("UPDATE checkout_leases SET expires_at=?").run(LAUNCH_NOW);
      expect((await f.send(await f.signed("result-replay", replay(request, capture)))).status).toBe(
        403,
      );
      expect(await count(f.db)).toEqual({ count: 1 });
    },
  );
  it.each([32768, 32769])("bounds the actual signed submission body to %i bytes", async (size) => {
    const f = await fixture(),
      request = f.request(),
      json = JSON.stringify(request),
      raw = json + " ".repeat(size - Buffer.byteLength(json));
    expect(Buffer.byteLength(raw)).toBe(size);
    const response = await f.send(await f.signed("result-submit", request, raw));
    expect(response.status, await response.clone().text()).toBe(size === 32768 ? 200 : 403);
    expect(await count(f.db)).toEqual({ count: size === 32768 ? 1 : 0 });
  });
  it("never accepts replay metadata in ordinary submission or permission from another family", async () => {
    const f = await fixture(),
      request = f.request(),
      capture = await f.resultCapture(request);
    expect(
      (await f.send(await f.signed("result-submit", { ...request, replayCapture: capture })))
        .status,
    ).toBe(403);
    expect(
      (
        await f.send(
          await f.signed("result-replay", {
            ...replay(request, capture),
            command_name: "agent_run.comment",
          }),
        )
      ).status,
    ).toBe(403);
    expect(await count(f.db)).toEqual({ count: 0 });
  });
  it("keeps infrastructure failure retryable and denies browser substitution", async () => {
    const f = await fixture(),
      request = f.request();
    const signed = await f.signed("result-submit", request);
    const get = f.namespace.get.bind(f.namespace);
    vi.spyOn(f.namespace, "get").mockImplementation((id) => {
      const stub = get(id);
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          if (JSON.parse(String(init?.body)).commandName === "result.submit")
            throw Error("private Hub database fault");
          return stub.fetch(input, init);
        },
      } as DurableObjectStub;
    });
    const unavailable = await f.send(signed);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("private");
    const browser = await f.send(
      new Request(`${ORIGIN}${f.prefix}/work/result-submit`, {
        method: "POST",
        headers: { cookie: "bfb-session=private", "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
    expect(browser.status).toBe(403);
    expect(await count(f.db)).toEqual({ count: 0 });
  });
  it("classifies result confirmations and their challenge as existing 120/min channel traffic", async () => {
    const f = await fixture();
    for (let index = 0; index < 21; index++)
      expect(
        (await f.send(await f.signed("result-confirmation", f.confirmationRequest()))).status,
      ).toBe(200);
    const deps = {
      db: f.db,
      appOrigin: ORIGIN,
      jurisdiction: "eu" as const,
      workspaceHubNs: f.namespace,
      now: LAUNCH_NOW,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    };
    for (let index = 21; index < 120; index++)
      await guardRunnerTransport(
        new Request(`${ORIGIN}${f.prefix}/work/result-confirmation`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bfb-runner-proof": "synthetic-budget-proof",
          },
        }),
        deps,
        FIX.workspace,
        f.runner,
        "work/result-confirmation",
      );
    await expect(
      guardRunnerTransport(
        new Request(`${ORIGIN}${f.prefix}/work/result-confirmation`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bfb-runner-proof": "synthetic-budget-proof",
          },
        }),
        deps,
        FIX.workspace,
        f.runner,
        "work/result-confirmation",
      ),
    ).rejects.toThrow();
  });
  it.each(["result-submit", "result-replay"])(
    "keeps %s at the existing mutation20 budget",
    async (action) => {
      const f = await fixture(),
        deps = {
          db: f.db,
          appOrigin: ORIGIN,
          jurisdiction: "eu" as const,
          workspaceHubNs: f.namespace,
          now: LAUNCH_NOW,
          abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
        };
      for (let index = 0; index < 20; index++)
        await guardRunnerTransport(
          new Request(`${ORIGIN}${f.prefix}/work/${action}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-bfb-runner-proof": "synthetic-budget-proof",
            },
          }),
          deps,
          FIX.workspace,
          f.runner,
          `work/${action}`,
        );
      await expect(
        guardRunnerTransport(
          new Request(`${ORIGIN}${f.prefix}/work/${action}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-bfb-runner-proof": "synthetic-budget-proof",
            },
          }),
          deps,
          FIX.workspace,
          f.runner,
          `work/${action}`,
        ),
      ).rejects.toThrow();
    },
  );
});
