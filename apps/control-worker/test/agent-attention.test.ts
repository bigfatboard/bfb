// ABOUTME: Exercises fixed attention routes using real request-bound runner possession.
// ABOUTME: Proves fresh private reads, exact explicit recovery, closed inputs and unchanged rate boundaries.

import type { SqlDatabase } from "@bfb/db";
import {
  FIX,
  runnerChallengeTranscript,
  runnerHash,
  type RunnerChallenge,
  answerAttentionCommand,
  resolveAttentionCommand,
} from "@bfb/domain";
import type { AgentAttentionRequest, AgentAttentionResult } from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFixture } from "../../../packages/domain/test/agent-capture-fixture.js";
import { LAUNCH_NOW, success } from "../../../packages/domain/test/launch-fixture.js";
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
    f = await captureFixture(context.db, false);
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
  const request = (id = f.reference().request_id): AgentAttentionRequest => ({
    ...f.bound(id),
    kind: "clarification",
    question: "PRIVATE_HTTP_QUESTION",
    blocking: false,
  });
  const read = (attentionId: string, binding = true, id = f.reference().request_id) => ({
    reference: f.reference(id),
    attention_id: attentionId,
    ...(binding ? { binding: f.binding } : {}),
  });
  async function create(body = request()) {
    const response = await send(await signed("attention-request", body));
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as AgentAttentionResult;
  }
  return {
    ...f,
    context,
    namespace,
    env,
    prefix,
    send,
    signed,
    request,
    read,
    create,
    setDb(db: SqlDatabase) {
      requestDb = db;
    },
  };
}
async function effects(db: SqlDatabase) {
  return db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM attention_requests) requests,
    (SELECT COUNT(*) FROM attention_observations WHERE observed_kind='requested') requested,
    (SELECT COUNT(*) FROM idempotency_records WHERE command_name='attention.request') outcomes`,
    )
    .get();
}

describe("mounted runner attention", () => {
  it("returns current answer and resolution for repeated read ID, including provisional restart shape", async () => {
    const f = await fixture(),
      created = await f.create(),
      body = f.read(created.attention.id, false);
    expect(created.origin).toEqual({
      run_id: f.launch.run_id,
      run_execution_id: f.final.run_execution_id,
      assignment_generation: 1,
    });
    expect(created.authority_binding).toEqual(f.binding);
    const read = async () => {
      const response = await f.send(await f.signed("attention-get", body));
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as AgentAttentionResult;
    };
    expect((await read()).attention.state).toBe("open");
    success(
      await f.human(answerAttentionCommand, {
        attentionId: created.attention.id,
        expectedVersion: 1,
        answer: "PRIVATE_HTTP_ANSWER",
      }),
    );
    expect((await read()).attention).toMatchObject({
      state: "answered",
      answer: "PRIVATE_HTTP_ANSWER",
      resource_version: 2,
    });
    success(
      await f.human(resolveAttentionCommand, {
        attentionId: created.attention.id,
        expectedVersion: 2,
      }),
    );
    expect((await read()).attention.state).toBe("resolved");
    for (const table of ["audit_events", "semantic_events", "outbox_records"]) {
      const rows = JSON.stringify(await f.db.prepare(`SELECT * FROM ${table}`).all());
      expect(rows).not.toContain("PRIVATE_HTTP_QUESTION");
      expect(rows).not.toContain("PRIVATE_HTTP_ANSWER");
    }
  });

  it("recovers an actual committed lost response only by explicit identical retry", async () => {
    const f = await fixture(),
      body = f.request(),
      get = f.namespace.get.bind(f.namespace);
    let lost = false;
    vi.spyOn(f.namespace, "get").mockImplementation((id) => {
      const stub = get(id);
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const message = JSON.parse(String(init?.body)) as { commandName: string };
          const response = await stub.fetch(input, init);
          if (!lost && message.commandName === "attention.request") {
            lost = true;
            throw new Error("private lost attention reply");
          }
          return response;
        },
      } as DurableObjectStub;
    });
    const response = await f.send(await f.signed("attention-request", body));
    expect(response.status).toBe(503);
    expect(lost).toBe(true);
    const before = await effects(f.db);
    expect(before).toEqual({ requests: 1, requested: 1, outcomes: 1 });
    expect((await f.send(await f.signed("attention-request", body))).status).toBe(200);
    expect(
      (await f.send(await f.signed("attention-request", { ...body, question: "changed" }))).status,
    ).toBe(403);
    expect(await effects(f.db)).toEqual(before);
  });

  it.each(["session", "requester", "execution", "result", "lease"])(
    "denies %s before cached creation or binding-omitted read",
    async (fault) => {
      const f = await fixture(),
        body = f.request(),
        created = await f.create(body);
      if (fault === "session")
        await f.db
          .prepare("UPDATE provider_sessions SET state='ended',ended_at=? WHERE id=?")
          .run(LAUNCH_NOW, f.binding.provider_session_id);
      if (fault === "requester")
        await f.db.prepare("DELETE FROM runner_launch_grants WHERE human_id=?").run(FIX.member);
      if (fault === "execution")
        await f.db
          .prepare(
            "UPDATE run_executions SET state='ended',end_reason='process_exit',ended_at=? WHERE id=?",
          )
          .run(LAUNCH_NOW, f.final.run_execution_id);
      if (fault === "result")
        await f.db
          .prepare("UPDATE runs SET result_state='cancelled' WHERE id=?")
          .run(f.launch.run_id);
      if (fault === "lease")
        await f.db
          .prepare("UPDATE checkout_leases SET expires_at=? WHERE execution_id=?")
          .run(LAUNCH_NOW, f.final.run_execution_id);
      expect((await f.send(await f.signed("attention-request", body))).status).toBe(403);
      expect(
        (await f.send(await f.signed("attention-get", f.read(created.attention.id, false)))).status,
      ).toBe(403);
      expect(await effects(f.db)).toEqual({ requests: 1, requested: 1, outcomes: 1 });
    },
  );

  it("classifies actual attention polls above 20 without increasing their 120 ceiling", async () => {
    const f = await fixture(),
      created = await f.create(),
      body = f.read(created.attention.id);
    for (let index = 0; index < 21; index++)
      expect((await f.send(await f.signed("attention-get", body))).status).toBe(200);
    const deps = {
      db: f.db,
      now: LAUNCH_NOW,
      jurisdiction: "eu" as const,
      appOrigin: ORIGIN,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    };
    for (let index = 21; index < 120; index++)
      await guardRunnerTransport(
        new Request(ORIGIN + f.prefix + "/work/attention-get", { method: "POST" }),
        deps,
        FIX.workspace,
        f.runner,
        "work/attention-get",
      );
    expect((await f.send(await f.signed("attention-get", body))).status).toBe(403);
    // Creation retains the mutation class, including identical explicit retries.
    const original = f.request();
    for (let index = 1; index < 20; index++)
      expect((await f.send(await f.signed("attention-request", original))).status).toBe(200);
    expect((await f.send(await f.signed("attention-request", original))).status).toBe(403);
  });

  it("rejects browser credentials and unknown closed fields without attention work", async () => {
    const f = await fixture();
    expect(
      (
        await f.send(
          new Request(ORIGIN + f.prefix + "/work/attention-get", {
            method: "POST",
            headers: { cookie: "browser-session" },
            body: JSON.stringify(f.read(f.task.id)),
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await f.send(await f.signed("attention-request", { ...f.request(), replayCapture: {} })))
        .status,
    ).toBe(403);
    expect(
      (await f.send(await f.signed("attention-get", { ...f.read(f.task.id), binding: null })))
        .status,
    ).toBe(403);
    expect(await effects(f.db)).toEqual({ requests: 0, requested: 0, outcomes: 0 });
  });

  it("keeps a live read infrastructure failure sanitized and retryable", async () => {
    const f = await fixture(),
      created = await f.create(),
      original = f.db;
    const failing: SqlDatabase = {
      prepare(sql) {
        if (/FROM attention_requests/.test(sql)) throw new Error("PRIVATE_D1_FAILURE");
        return original.prepare(sql);
      },
      withTransaction(fn) {
        return original.withTransaction((tx) =>
          fn({
            ...failing,
            prepare(sql) {
              if (/FROM attention_requests/.test(sql)) throw new Error("PRIVATE_D1_FAILURE");
              return tx.prepare(sql);
            },
          }),
        );
      },
    };
    f.setDb(failing);
    const response = await f.send(await f.signed("attention-get", f.read(created.attention.id)));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE_D1_FAILURE");
    f.setDb(original);
    expect(
      (await f.send(await f.signed("attention-get", f.read(created.attention.id)))).status,
    ).toBe(200);
  });
});
