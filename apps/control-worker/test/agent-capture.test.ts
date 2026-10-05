// ABOUTME: Proves fixed confirmation and replay routes with actual runner possession and Hub dispatch.
// ABOUTME: Exercises raw HTTP bounds, private-safe failures, channel budgets and committed-response recovery.

import type { SqlDatabase } from "@bfb/db";
import { FIX, runnerChallengeTranscript, runnerHash, type RunnerChallenge } from "@bfb/domain";
import type { AgentCaptureConfirmationResult, AgentWorkReplayRequest } from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFixture } from "../../../packages/domain/test/agent-capture-fixture.js";
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

async function fixture() {
  const context = openAuthTestContext(LAUNCH_NOW),
    f = await captureFixture(context.db);
  const namespace = createTestWorkspaceHubNamespace(context.db);
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
  const prefix = `/runner/workspaces/${FIX.workspace}/runners/${f.runner}`;
  const send = (request: Request) =>
    createControlApp(validateControlEnv(env), {
      db: context.db,
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
  async function confirmation(request = f.confirmationRequest()) {
    const response = await send(await signed("capture-confirmation", request));
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as AgentCaptureConfirmationResult;
  }
  async function replay(command: AgentWorkReplayRequest["command_name"] = "agent_run.comment") {
    const bound = f.bound();
    const version = (await f.db
      .prepare("SELECT resource_version FROM tasks WHERE id = ?")
      .get(f.task.id)) as { resource_version: number };
    const original =
      command === "agent_run.comment"
        ? { ...bound, body: "Synthetic <>& \u2028 \\u2028 private HTTP body" }
        : command === "agent_run.progress"
          ? { ...bound, summary: "Synthetic fractional progress", percent: 12.5, confidence: 0.75 }
          : command === "agent_run.update"
            ? {
                ...bound,
                expected_version: version.resource_version,
                title: "Synthetic HTTP update",
              }
            : { ...bound, title: "Synthetic HTTP child", parent_task_id: f.task.id };
    return {
      schema_version: 1,
      command_name: command,
      original_request: original,
      capture: await f.capture(command, original, await confirmation()),
    } as AgentWorkReplayRequest;
  }
  return {
    ...f,
    context,
    namespace,
    env,
    prefix,
    signed,
    send,
    confirmation,
    replay,
  };
}
async function effects(db: SqlDatabase) {
  return db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM comments) AS comments,
    (SELECT COUNT(*) FROM agent_work_effects) AS effects,
    (SELECT COUNT(*) FROM idempotency_records WHERE command_name LIKE 'agent_run.%') AS outcomes,
    (SELECT COUNT(*) FROM audit_events WHERE action LIKE 'agent_run.%') AS audits,
    (SELECT SUM(resource_version) FROM tasks) AS task_versions`,
    )
    .get();
}
function failingReads(db: SqlDatabase, pattern: RegExp): SqlDatabase {
  return {
    prepare(sql) {
      if (pattern.test(sql)) throw new Error("synthetic-private-capture-db-failure");
      return db.prepare(sql);
    },
    withTransaction(fn) {
      return db.withTransaction((tx) => fn(failingReads(tx, pattern)));
    },
  };
}

describe("possession-authenticated capture and replay", () => {
  it.each([
    "agent_run.comment",
    "agent_run.update",
    "agent_run.progress",
    "agent_run.proposal",
  ] as const)(
    "dispatches the catalog-resolved original %s and deduplicates with fresh proofs",
    async (command) => {
      const f = await fixture(),
        replay = await f.replay(command);
      const response = await f.send(await f.signed("replay", replay));
      expect(response.status, await response.clone().text()).toBe(200);
      const result = await response.json(),
        before = await effects(f.db);
      const retried = await f.send(await f.signed("replay", replay));
      expect(retried.status, await retried.clone().text()).toBe(200);
      expect(await retried.json()).toEqual(result);
      expect(await effects(f.db)).toEqual(before);
      const stored = await f.db
        .prepare("SELECT command_name FROM idempotency_records WHERE idempotency_key = ?")
        .get(replay.capture.operation.operation_key);
      expect(stored).toEqual({ command_name: command });
    },
  );
  it("keeps original server confirmation time and scope after a fresh possession retry", async () => {
    const f = await fixture(),
      request = f.confirmationRequest();
    const original = await f.confirmation(request),
      before = await effects(f.db);
    vi.setSystemTime(Date.parse(LAUNCH_NOW) + 5_000);
    expect(await f.confirmation(request)).toEqual(original);
    expect(await effects(f.db)).toEqual(before);
  });
  it.each(["capture-confirmation", "replay"])(
    "rejects browser or missing possession credentials for %s",
    async (action) => {
      const f = await fixture(),
        body = action === "replay" ? await f.replay() : f.confirmationRequest();
      const request = await f.signed(action, body);
      const before = await effects(f.db);
      const headers = new Headers(request.headers);
      headers.set("cookie", "synthetic-human-cookie");
      expect((await f.send(new Request(request, { headers }))).status).toBe(403);
      expect(
        (
          await f.send(
            new Request(`${ORIGIN}${f.prefix}/work/${action}`, {
              method: "POST",
              body: JSON.stringify(body),
            }),
          )
        ).status,
      ).toBe(403);
      expect(await effects(f.db)).toEqual(before);
    },
  );
  it("does not accept internal capture fields through an ordinary write route", async () => {
    const f = await fixture(),
      replay = await f.replay(),
      before = await effects(f.db);
    const response = await f.send(
      await f.signed("comment", { ...replay.original_request, replayCapture: replay.capture }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "request_rejected" });
    expect(await effects(f.db)).toEqual(before);
  });
  it("rejects a validly re-signed changed payload under the same operation identity", async () => {
    const f = await fixture(),
      replay = await f.replay();
    expect((await f.send(await f.signed("replay", replay))).status).toBe(200);
    const before = await effects(f.db),
      original = { ...replay.original_request, body: "Synthetic changed private payload" };
    const changed = {
      ...replay,
      original_request: original,
      capture: await f.capture("agent_run.comment", original, replay.capture.confirmation),
    };
    const response = await f.send(await f.signed("replay", changed));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "request_rejected" });
    expect(await effects(f.db)).toEqual(before);
  });
  it("requires current pinned policy before a signed cached replay result", async () => {
    const f = await fixture(),
      replay = await f.replay();
    expect((await f.send(await f.signed("replay", replay))).status).toBe(200);
    await f.advancePolicy("project");
    const before = await effects(f.db),
      response = await f.send(await f.signed("replay", replay));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "policy_rejected" });
    expect(await effects(f.db)).toEqual(before);
  });
  it.each([
    { action: "capture-confirmation", limit: 2048 },
    { action: "replay", limit: 32768 },
  ])(
    "enforces the inclusive $limit-byte actual HTTP bound for $action",
    async ({ action, limit }) => {
      const f = await fixture(),
        body = action === "replay" ? await f.replay() : f.confirmationRequest();
      const encoded = JSON.stringify(body),
        raw = encoded + " ".repeat(limit - Buffer.byteLength(encoded));
      expect((await f.send(await f.signed(action, body, raw))).status).toBe(200);
      const before = await effects(f.db),
        oversized = await f.send(await f.signed(action, body, raw + " "));
      expect(oversized.status).toBe(403);
      expect(await oversized.json()).toMatchObject({ error: "request_rejected" });
      expect(await effects(f.db)).toEqual(before);
    },
  );
  it.each(["percent", "confidence"])(
    "retains raw-number rejection in replay's %s nested original request",
    async (field) => {
      const f = await fixture(),
        replay = await f.replay("agent_run.progress"),
        before = await effects(f.db);
      const raw = JSON.stringify(replay).replace(
        field === "percent" ? '"percent":12.5' : '"confidence":0.75',
        field === "percent" ? '"percent":100.00000000000000001' : '"confidence":1e-324',
      );
      const response = await f.send(await f.signed("replay", replay, raw));
      expect(response.status).toBe(403);
      expect(await effects(f.db)).toEqual(before);
      expect((await f.send(await f.signed("replay", replay))).status).toBe(200);
    },
  );
  it.each(["capture-confirmation", "replay"])(
    "keeps transient Hub faults retryable for %s",
    async (action) => {
      const f = await fixture(),
        body = action === "replay" ? await f.replay() : f.confirmationRequest(),
        get = f.namespace.get.bind(f.namespace);
      const request = await f.signed(action, body),
        before = await effects(f.db);
      vi.spyOn(f.namespace, "get").mockImplementation((id) => {
        const stub = get(id);
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const message = JSON.parse(String(init?.body)) as { commandName: string };
            if (
              message.commandName ===
              (action === "replay" ? "agent_run.comment" : "agent_run.capture_confirmation")
            )
              throw new Error("synthetic-private-capture-hub-failure");
            return stub.fetch(input, init);
          },
        } as DurableObjectStub;
      });
      const response = await f.send(request);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "work_unavailable",
        message: "agent work temporarily unavailable",
      });
      expect(await effects(f.db)).toEqual(before);
    },
  );
  it("does not convert possession-stage D1 infrastructure failure into terminal authority", async () => {
    const f = await fixture(),
      request = await f.signed("capture-confirmation", f.confirmationRequest()),
      before = await effects(f.db);
    f.env.WORKSPACE_HUB = createTestWorkspaceHubNamespace(failingReads(f.db, /FROM runners/u));
    const response = await f.send(request);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "work_unavailable",
      message: "agent work temporarily unavailable",
    });
    expect(await effects(f.db)).toEqual(before);
  });
  it("recovers the original canonical effect after a real post-commit Hub response loss", async () => {
    const f = await fixture(),
      replay = await f.replay(),
      get = f.namespace.get.bind(f.namespace);
    let lost = false;
    vi.spyOn(f.namespace, "get").mockImplementation((id) => {
      const stub = get(id);
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const message = JSON.parse(String(init?.body)) as { commandName: string };
          const response = await stub.fetch(input, init);
          if (!lost && message.commandName === "agent_run.comment") {
            lost = true;
            throw new Error("synthetic-private-response-loss");
          }
          return response;
        },
      } as DurableObjectStub;
    });
    expect((await f.send(await f.signed("replay", replay))).status).toBe(503);
    expect(lost).toBe(true);
    const after = await effects(f.db);
    expect((await f.send(await f.signed("replay", replay))).status).toBe(200);
    expect(await effects(f.db)).toEqual(after);
    await f.db
      .prepare("DELETE FROM runner_launch_grants WHERE runner_id = ? AND human_id = ?")
      .run(f.runner, FIX.member);
    const blocked = await f.send(await f.signed("replay", replay));
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: "revoked" });
    expect(await effects(f.db)).toEqual(after);
  });
  it("does not reset confirmation time after losing the committed Hub response", async () => {
    const f = await fixture(),
      request = f.confirmationRequest(),
      get = f.namespace.get.bind(f.namespace);
    let lost = false;
    vi.spyOn(f.namespace, "get").mockImplementation((id) => {
      const stub = get(id);
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const message = JSON.parse(String(init?.body)) as { commandName: string };
          const response = await stub.fetch(input, init);
          if (!lost && message.commandName === "agent_run.capture_confirmation") {
            lost = true;
            throw new Error("synthetic-private-confirmation-response-loss");
          }
          return response;
        },
      } as DurableObjectStub;
    });
    expect((await f.send(await f.signed("capture-confirmation", request))).status).toBe(503);
    expect(lost).toBe(true);
    const before = await effects(f.db);
    vi.setSystemTime(Date.parse(LAUNCH_NOW) + 5_000);
    expect((await f.confirmation(request)).confirmed_at).toBe(LAUNCH_NOW);
    expect(await effects(f.db)).toEqual(before);
  });
  it.each(["requester", "execution", "session", "lease"])(
    "retains a committed effect but denies %s closure before the first lost-response retry",
    async (closure) => {
      const f = await fixture(),
        replay = await f.replay(),
        get = f.namespace.get.bind(f.namespace);
      let lost = false;
      vi.spyOn(f.namespace, "get").mockImplementation((id) => {
        const stub = get(id);
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const message = JSON.parse(String(init?.body)) as { commandName: string };
            const response = await stub.fetch(input, init);
            if (!lost && message.commandName === "agent_run.comment") {
              lost = true;
              throw new Error("synthetic-private-lost-effect-reply");
            }
            return response;
          },
        } as DurableObjectStub;
      });
      expect((await f.send(await f.signed("replay", replay))).status).toBe(503);
      expect(lost).toBe(true);
      const before = await effects(f.db);
      if (closure === "requester")
        await f.db
          .prepare("DELETE FROM runner_launch_grants WHERE runner_id = ? AND human_id = ?")
          .run(f.runner, FIX.member);
      if (closure === "execution")
        await f.db
          .prepare(
            "UPDATE run_executions SET state = 'ended', end_reason = 'process_exit', ended_at = ? WHERE id = ?",
          )
          .run(LAUNCH_NOW, f.final.run_execution_id);
      if (closure === "session")
        await f.db
          .prepare("UPDATE provider_sessions SET state = 'ended', ended_at = ? WHERE id = ?")
          .run(LAUNCH_NOW, f.binding.provider_session_id);
      if (closure === "lease")
        await f.db
          .prepare("UPDATE checkout_leases SET expires_at = ? WHERE execution_id = ?")
          .run(LAUNCH_NOW, f.final.run_execution_id);
      const response = await f.send(await f.signed("replay", replay));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error:
          closure === "requester"
            ? "revoked"
            : closure === "execution"
              ? "assignment_ended"
              : "capability_closed",
      });
      expect(await effects(f.db)).toEqual(before);
    },
  );
  it("uses authenticated channel and request-challenge budgets for confirmation, not mutation budget", async () => {
    const f = await fixture(),
      request = f.confirmationRequest();
    for (let index = 0; index < 21; index++)
      expect((await f.send(await f.signed("capture-confirmation", request))).status).toBe(200);
    const deps = {
      db: f.db,
      now: LAUNCH_NOW,
      jurisdiction: "eu" as const,
      appOrigin: ORIGIN,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      workspaceHubNs: f.namespace,
    };
    for (let index = 21; index < 120; index++)
      await guardRunnerTransport(
        new Request(`${ORIGIN}${f.prefix}/work/capture-confirmation`, { method: "POST" }),
        deps,
        FIX.workspace,
        f.runner,
        "work/capture-confirmation",
      );
    const overflowRequest = await f.signed("capture-confirmation", request);
    overflowRequest.headers.set("cf-connecting-ip", "192.0.2.121");
    const denied = await f.send(overflowRequest);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "request_rejected" });
  });
  it("retains the mutation ceiling of twenty replay attempts", async () => {
    const f = await fixture(),
      replay = await f.replay();
    for (let index = 0; index < 20; index++)
      expect((await f.send(await f.signed("replay", replay))).status).toBe(200);
    const before = await effects(f.db),
      denied = await f.send(await f.signed("replay", replay));
    expect(denied.status).toBe(403);
    expect(await effects(f.db)).toEqual(before);
  });
});
