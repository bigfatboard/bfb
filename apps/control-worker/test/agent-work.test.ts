// ABOUTME: Exercises mounted local-agent work routes with real request-bound runner possession.
// ABOUTME: Tests credential separation, current cached-read authority and safe retryable infrastructure failures.

import type { SqlDatabase } from "@bfb/db";
import {
  FIX,
  canonicalRunnerKey,
  encodeRunnerToken,
  runnerChallengeTranscript,
  runnerHash,
  runnerKeyThumbprint,
  runnerSecret,
  type RunnerChallenge,
  type RunnerTokenClaims,
} from "@bfb/domain";
import type {
  AgentContextResult,
  AgentWorkRequest,
  AgentSessionBindRequest,
  AgentSessionBindResult,
  AgentBoundRequest,
  AgentCommentRequest,
  AgentCommentResult,
  LaunchFinalRequest,
  CheckoutLeaseObservation,
} from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authorizeLaunchCommand } from "../../../packages/domain/src/launches.js";
import { observeCheckoutLeaseCommand } from "../../../packages/domain/src/checkout-leases.js";
import { randomUlid } from "../../../packages/domain/src/ids.js";
import { addContextCommand } from "../../../packages/domain/src/work-commands.js";
import {
  LAUNCH_NOW,
  launchFixture,
  success,
} from "../../../packages/domain/test/launch-fixture.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import { guardRunnerTransport } from "../src/api/runners.js";
import { AUTH_TEST_ENV, openAuthTestContext } from "./auth-helpers.js";

type SessionAction = "session-bind" | "bound-authority" | "comment";
type Action = "authority" | "context" | "task" | SessionAction;
const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;

async function fixture() {
  const context = openAuthTestContext(LAUNCH_NOW),
    f = await launchFixture(context.db);
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
  const publicKey = await canonicalRunnerKey({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
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
  f.principal.keyThumbprint = thumbprint;
  await context.db
    .prepare(
      `INSERT INTO runner_launch_grants
    (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, f.runner, FIX.member, LAUNCH_NOW);
  const claimed = await f.claim(FIX.member);
  expect(
    success(
      await f.native(authorizeLaunchCommand, {
        principal: f.principal,
        authorization: claimed.final,
      }),
    ),
  ).toMatchObject({ decision: "authorized" });
  const token = encodeRunnerToken(claims, secret);
  const nativePrefix = `/runner/workspaces/${FIX.workspace}/runners/${f.runner}`;
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
  function app() {
    return createControlApp(validateControlEnv(env), {
      db: requestDb,
      now: LAUNCH_NOW,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    });
  }
  const send = (request: Request) => app().request(request, undefined, env);
  function reference(requestId = randomUlid()): AgentWorkRequest {
    return {
      schema_version: 1,
      run_execution_id: claimed.final.run_execution_id,
      assignment_generation: claimed.final.assignment_generation,
      request_id: requestId,
    };
  }
  async function signed(action: Action, body: unknown = reference(), raw?: string) {
    const bytes = raw ?? JSON.stringify(body),
      path = `${nativePrefix}/work/${action}`;
    const response = await send(
      new Request(`${ORIGIN}${nativePrefix}/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purpose: "request",
          token,
          request: { method: "POST", path, body_sha256: runnerHash(bytes) },
        }),
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const challenge = ((await response.json()) as { challenge: RunnerChallenge }).challenge;
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
  return {
    ...f,
    ...claimed,
    context,
    env,
    namespace,
    token,
    nativePrefix,
    reference,
    signed,
    send,
    setRequestDb(db: SqlDatabase) {
      requestDb = db;
    },
  };
}

async function workEffects(db: SqlDatabase) {
  return db
    .prepare(
      `SELECT
    (SELECT COUNT(*) FROM task_context_deliveries) AS deliveries,
    (SELECT COUNT(*) FROM semantic_events WHERE kind LIKE 'agent_run.%') AS events,
    (SELECT COUNT(*) FROM audit_events WHERE action LIKE 'agent_run.%') AS audits,
    (SELECT COUNT(*) FROM idempotency_records WHERE command_name LIKE 'agent_run.%') AS outcomes`,
    )
    .get();
}

function failingReads(db: SqlDatabase, pattern: RegExp): SqlDatabase {
  return {
    prepare(sql) {
      if (pattern.test(sql)) throw new Error("synthetic-private-worker-d1-failure");
      return db.prepare(sql);
    },
    withTransaction(fn) {
      return db.withTransaction((tx) => fn(failingReads(tx, pattern)));
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());

function leaseObservation(final: LaunchFinalRequest): CheckoutLeaseObservation {
  return {
    schema_version: 1,
    run_execution_id: final.run_execution_id,
    assignment_generation: final.assignment_generation,
    fencing_generation: final.fencing_generation,
    sequence: 1,
    observed_at: LAUNCH_NOW,
    operation: "renew",
    supervisor: final.supervisor,
    local_lock_id: final.local_lock_id,
    owned_group_id: 1235,
    owned_group_start_identity: "123456:2000",
    supervisor_state: "verified",
    group_state: "live",
    lock_state: "held",
    descendants_state: "contained",
    recovery_local: false,
  };
}

async function sessionFixture() {
  const f = await fixture();
  success(
    await f.native(observeCheckoutLeaseCommand, {
      principal: f.principal,
      observation: leaseObservation(f.final),
    }),
  );
  const request: AgentSessionBindRequest = {
    reference: f.reference(),
    observation: {
      provider: "fake",
      observed_session_id: "synthetic-worker-conversation",
      observed_at: LAUNCH_NOW,
    },
  };
  const response = await f.send(await f.signed("session-bind", request));
  expect(response.status, await response.clone().text()).toBe(200);
  const result = (await response.json()) as AgentSessionBindResult;
  function bound(requestId = randomUlid()): AgentBoundRequest {
    return { reference: f.reference(requestId), binding: result.binding };
  }
  function comment(
    requestId = randomUlid(),
    body = "Synthetic private worker comment",
  ): AgentCommentRequest {
    return { ...bound(requestId), body };
  }
  function input(action: SessionAction) {
    return action === "session-bind" ? request : action === "bound-authority" ? bound() : comment();
  }
  return { ...f, request, result, bound, comment, input };
}

async function sessionEffects(db: SqlDatabase) {
  return {
    ...((await workEffects(db)) as object),
    ...((await db
      .prepare(
        `SELECT
    (SELECT COUNT(*) FROM comments) AS comments,
    (SELECT COUNT(*) FROM execution_session_bindings) AS bindings,
    (SELECT COUNT(*) FROM provider_sessions) AS sessions,
    (SELECT COUNT(*) FROM agent_work_effects) AS effects`,
      )
      .get()) as object),
  };
}

async function consumeTransportAttempt(f: Awaited<ReturnType<typeof fixture>>, surface: string) {
  return guardRunnerTransport(
    new Request(`${ORIGIN}${f.nativePrefix}/${surface}`, { method: "POST" }),
    {
      db: f.context.db,
      now: LAUNCH_NOW,
      jurisdiction: "eu",
      appOrigin: ORIGIN,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    },
    FIX.workspace,
    f.runner,
    surface,
  );
}

describe("agent authority transport budgets", () => {
  it.each(["authority", "bound-authority"] as const)(
    "accepts more than twenty signed %s polls but keeps the 120-attempt ceiling",
    async (action) => {
      const f = await sessionFixture();
      const body = action === "authority" ? f.reference() : f.bound();
      for (let index = 0; index < 21; index += 1) {
        const response = await f.send(await f.signed(action, body));
        expect(response.status, await response.clone().text()).toBe(200);
      }
      const before = await sessionEffects(f.context.db);
      // Exercise the real remaining guard budget without exhausting the
      // independent request-challenge ceiling before the work-route ceiling.
      for (let index = 21; index < 120; index += 1) {
        await consumeTransportAttempt(f, `work/${action}`);
      }
      const request = await f.signed(action, body);
      request.headers.set("cf-connecting-ip", "192.0.2.121");
      const denied = await f.send(request);
      expect(denied.status, await denied.clone().text()).toBe(403);
      expect(await denied.json()).toEqual({
        error: "request_rejected",
        message: "agent work rejected",
      });
      expect(await sessionEffects(f.context.db)).toEqual(before);
    },
  );

  it.each(["comment", "session-bind", "context", "task"] as const)(
    "retains twenty signed attempts for work/%s",
    async (action) => {
      const f = await sessionFixture();
      const body =
        action === "comment" ? f.comment() : action === "session-bind" ? f.request : f.reference();
      // sessionFixture already consumed the first successful bind attempt.
      for (let index = action === "session-bind" ? 1 : 0; index < 20; index += 1) {
        const response = await f.send(await f.signed(action, body));
        expect(response.status, await response.clone().text()).toBe(200);
      }
      const before = await sessionEffects(f.context.db);
      const denied = await f.send(await f.signed(action, body));
      expect(denied.status, await denied.clone().text()).toBe(403);
      expect(await denied.json()).toEqual({
        error: "request_rejected",
        message: "agent work rejected",
      });
      expect(await sessionEffects(f.context.db)).toEqual(before);
    },
  );

  it("retains twenty token-bootstrap challenges independently of authority polling", async () => {
    const f = await fixture();
    const challenge = () =>
      f.send(
        new Request(`${ORIGIN}${f.nativePrefix}/challenge`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ purpose: "token" }),
        }),
      );
    for (let index = 0; index < 20; index += 1) {
      const response = await challenge();
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const denied = await challenge();
    expect(denied.status, await denied.clone().text()).toBe(403);
    expect(await denied.json()).toEqual({
      error: "request_rejected",
      message: "request rejected",
    });
    expect(
      await f.context.db.prepare("SELECT COUNT(*) AS count FROM runner_challenges").get(),
    ).toEqual({ count: 20 });
  });

  it.each(["token", "authenticate"] as const)(
    "does not enlarge the %s exchange guard",
    async (surface) => {
      const f = await fixture();
      for (let index = 0; index < 20; index += 1) await consumeTransportAttempt(f, surface);
      await expect(consumeTransportAttempt(f, surface)).rejects.toMatchObject({
        code: "request_rejected",
      });
    },
  );

  it.each(["authority", "bound-authority"] as const)(
    "does not admit browser or missing possession credentials to work/%s",
    async (action) => {
      const f = await sessionFixture();
      const body = action === "authority" ? f.reference() : f.bound();
      const before = await sessionEffects(f.context.db);
      for (const header of ["cookie", "origin", "authorization"] as const) {
        const request = await f.signed(action, body);
        request.headers.set(
          header,
          header === "authorization"
            ? `Bearer ${f.token}`
            : header === "origin"
              ? ORIGIN
              : "synthetic-browser-cookie",
        );
        expect((await f.send(request)).status).toBe(403);
      }
      const unsigned = new Request(`${ORIGIN}${f.nativePrefix}/work/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect((await f.send(unsigned)).status).toBe(403);
      expect(await sessionEffects(f.context.db)).toEqual(before);
    },
  );
});

describe("mounted canonical agent binding and comments", () => {
  it("uses one server-normalized binding identity across independently signed caller IDs", async () => {
    const f = await sessionFixture(),
      before = await sessionEffects(f.context.db);
    const repeated = { ...f.request, reference: f.reference() };
    const response = await f.send(await f.signed("session-bind", repeated));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.json()).toEqual(f.result);
    const changed = {
      ...repeated,
      observation: { ...repeated.observation, observed_session_id: "other-conversation" },
    };
    const denied = await f.send(await f.signed("session-bind", changed));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: "session_conflict",
      message: "agent work rejected",
    });
    expect(await sessionEffects(f.context.db)).toEqual(before);
    for (const [table, column] of [
      ["semantic_events", "kind"],
      ["audit_events", "action"],
      ["outbox_records", "kind"],
    ] as const) {
      const receipts = JSON.stringify(
        await f.context.db
          .prepare(`SELECT payload_json FROM ${table} WHERE ${column} = 'agent_run.session_bind'`)
          .all(),
      );
      expect(receipts).not.toContain(f.request.observation.observed_session_id);
      expect(receipts).not.toContain(f.token);
      expect(receipts).not.toContain(f.principal.tokenId);
      expect(receipts).toContain(f.result.binding.provider_session_id);
    }
  });

  it("does not infer a binding from a valid launch or fabricate comment authors", async () => {
    const f = await fixture();
    const request: AgentCommentRequest = {
      reference: f.reference(),
      body: "Unbound comment",
      binding: {
        provider: "fake",
        provider_session_id: randomUlid(),
        observed_session_id: "synthetic-unbound",
      },
    };
    const before = await sessionEffects(f.context.db);
    const response = await f.send(await f.signed("comment", request));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "session_not_bound",
      message: "agent work rejected",
    });
    expect(await sessionEffects(f.context.db)).toEqual(before);
  });

  it("commits a null-human comment with derived provenance and only bounded public receipts", async () => {
    const f = await sessionFixture(),
      request = f.comment();
    const response = await f.send(await f.signed("comment", request));
    expect(response.status, await response.clone().text()).toBe(200);
    const result = (await response.json()) as AgentCommentResult;
    expect(result.origin).toEqual(f.result.origin);
    expect(
      await f.context.db
        .prepare("SELECT body, author_human_id, author_delegation_id FROM comments WHERE id = ?")
        .get(result.id),
    ).toEqual({ body: request.body, author_human_id: null, author_delegation_id: null });
    for (const [table, column] of [
      ["semantic_events", "kind"],
      ["audit_events", "action"],
      ["outbox_records", "kind"],
    ] as const) {
      const receipts = (await f.context.db
        .prepare(`SELECT payload_json FROM ${table} WHERE ${column} = 'agent_run.comment'`)
        .all()) as { payload_json: string }[];
      expect(receipts).toHaveLength(1);
      expect(JSON.parse(receipts[0]!.payload_json).result).toEqual({
        id: result.id,
        kind: "comment.add",
        origin: result.origin,
      });
      expect(receipts[0]!.payload_json).not.toContain(request.body);
      expect(receipts[0]!.payload_json).not.toContain(f.token);
      expect(receipts[0]!.payload_json).not.toContain(f.request.observation.observed_session_id);
    }
  });

  it.each(["session-bind", "bound-authority", "comment"] as const)(
    "rechecks current authority before cached %s outcomes",
    async (action) => {
      for (const state of [
        "requester grant",
        "execution end",
        "terminal result",
        "session end",
        "lease expiry",
      ] as const) {
        const f = await sessionFixture(),
          input = f.input(action);
        const first = await f.send(await f.signed(action, input));
        expect(first.status, await first.clone().text()).toBe(200);
        if (state === "requester grant")
          await f.context.db
            .prepare("UPDATE runner_launch_grants SET revoked_at = ? WHERE human_id = ?")
            .run(LAUNCH_NOW, FIX.member);
        else if (state === "execution end")
          await f.context.db
            .prepare(
              "UPDATE run_executions SET state = 'ended', end_reason = 'process_exit', ended_at = ? WHERE id = ?",
            )
            .run(LAUNCH_NOW, f.final.run_execution_id);
        else if (state === "terminal result")
          await f.context.db
            .prepare("UPDATE runs SET result_state = 'accepted' WHERE id = ?")
            .run(f.launch.run_id);
        else if (state === "session end")
          await f.context.db
            .prepare("UPDATE provider_sessions SET state = 'ended', ended_at = ? WHERE id = ?")
            .run(LAUNCH_NOW, f.result.binding.provider_session_id);
        else
          await f.context.db
            .prepare("UPDATE checkout_leases SET expires_at = ? WHERE execution_id = ?")
            .run(LAUNCH_NOW, f.final.run_execution_id);
        const before = await sessionEffects(f.context.db);
        const response = await f.send(await f.signed(action, input));
        expect(response.status, await response.clone().text()).toBe(403);
        expect(await response.json()).toEqual({
          error:
            state === "requester grant"
              ? "revoked"
              : state === "execution end"
                ? "assignment_ended"
                : "capability_closed",
          message: "agent work rejected",
        });
        expect(await sessionEffects(f.context.db)).toEqual(before);
      }
    },
  );

  it.each(["session-bind", "bound-authority", "comment"] as const)(
    "rejects browser credential substitution for %s",
    async (action) => {
      const f = await sessionFixture(),
        before = await sessionEffects(f.context.db);
      for (const header of ["cookie", "origin", "authorization"]) {
        const request = await f.signed(action, f.input(action));
        request.headers.set(
          header,
          header === "authorization"
            ? `Bearer ${f.token}`
            : header === "origin"
              ? ORIGIN
              : "synthetic-browser-cookie",
        );
        const response = await f.send(request);
        expect(response.status, await response.clone().text()).toBe(403);
      }
      expect(await sessionEffects(f.context.db)).toEqual(before);
    },
  );

  it("requires fresh possession for deduplicated comments and rejects boundary, session and payload collisions", async () => {
    const f = await sessionFixture(),
      input = f.comment(),
      signed = await f.signed("comment", input);
    const unauthorized = await f.send(
      new Request(`${ORIGIN}${f.nativePrefix}/work/comment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    expect(unauthorized.status).toBe(403);
    const tampered = await f.signed("comment", input);
    const substituted = await f.send(
      new Request(tampered.url, {
        method: "POST",
        headers: tampered.headers,
        body: JSON.stringify({ ...input, body: "Substituted after signing" }),
      }),
    );
    expect(substituted.status).toBe(403);
    expect(await f.context.db.prepare("SELECT COUNT(*) AS count FROM comments").get()).toEqual({
      count: 0,
    });
    const first = await f.send(signed.clone());
    expect(first.status).toBe(200);
    const result = await first.json();
    expect((await f.send(signed)).status).toBe(403);
    const repeated = await f.send(await f.signed("comment", input));
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(result);
    const before = await sessionEffects(f.context.db);
    for (const [body, error] of [
      [{ ...input, body: "Different comment" }, "request_rejected"],
      [
        { ...input, binding: { ...input.binding, observed_session_id: "other-session" } },
        "session_conflict",
      ],
      [
        { ...input, reference: { ...input.reference, assignment_generation: 2 } },
        "boundary_escape",
      ],
      [
        { ...input, reference: { ...input.reference, run_execution_id: randomUlid() } },
        "boundary_escape",
      ],
      [{ ...input, task_id: FIX.taskDelegable }, "request_rejected"],
      [
        { ...input, principal: f.principal, url: "https://untrusted.example.test" },
        "request_rejected",
      ],
      [
        { ...input, reference: { ...input.reference, actor_human_id: FIX.owner } },
        "request_rejected",
      ],
    ] as const) {
      const response = await f.send(await f.signed("comment", body));
      expect(response.status, await response.clone().text()).toBe(403);
      expect(await response.json()).toEqual({ error, message: "agent work rejected" });
    }
    expect(await sessionEffects(f.context.db)).toEqual(before);
  });

  it("accepts a maximum escaped comment at the exact envelope cap and rejects one byte over without effects", async () => {
    const f = await sessionFixture();
    const body = Array.from('<>&"\\\u2028\u2029'.repeat(400)).slice(0, 2048).join("");
    const input = f.comment(randomUlid(), body),
      encoded = JSON.stringify(input);
    const raw = encoded + " ".repeat(16384 - Buffer.byteLength(encoded));
    expect(Buffer.byteLength(raw)).toBe(16384);
    const response = await f.send(await f.signed("comment", input, raw));
    expect(response.status, await response.clone().text()).toBe(200);
    const result = (await response.json()) as AgentCommentResult;
    expect(
      await f.context.db.prepare("SELECT body FROM comments WHERE id = ?").get(result.id),
    ).toEqual({ body });
    const before = await sessionEffects(f.context.db);
    const oversized = await f.send(await f.signed("comment", input, raw + " "));
    expect(oversized.status).toBe(403);
    expect(await oversized.json()).toEqual({
      error: "request_rejected",
      message: "agent work rejected",
    });
    for (const [text, error] of [
      ["x".repeat(2049), "request_rejected"],
      ["   ", "invalid_argument"],
      ["bad\u0001body", "invalid_argument"],
    ]) {
      const rejected = await f.send(await f.signed("comment", f.comment(randomUlid(), text)));
      expect(rejected.status, await rejected.clone().text()).toBe(403);
      expect(await rejected.json()).toEqual({ error, message: "agent work rejected" });
    }
    expect(await sessionEffects(f.context.db)).toEqual(before);
  });

  it.each(["session-bind", "bound-authority", "comment"] as const)(
    "keeps a Hub outage for %s retryable without declaring revocation",
    async (action) => {
      const f = await sessionFixture(),
        request = await f.signed(action, f.input(action)),
        before = await sessionEffects(f.context.db),
        get = f.namespace.get.bind(f.namespace);
      const expectedCommand =
        action === "session-bind"
          ? "agent_run.session_bind"
          : action === "bound-authority"
            ? "agent_run.bound_authority"
            : "agent_run.comment";
      let injected = false;
      vi.spyOn(f.namespace, "get").mockImplementation((id: DurableObjectId) => {
        const stub = get(id);
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const body = JSON.parse(String(init?.body)) as { commandName: string };
            if (body.commandName === expectedCommand) {
              injected = true;
              throw new Error("synthetic-private-hub-failure");
            }
            return stub.fetch(input, init);
          },
        } as DurableObjectStub;
      });
      const response = await f.send(request);
      expect(injected).toBe(true);
      expect(response.status, await response.clone().text()).toBe(503);
      expect(await response.json()).toEqual({
        error: "work_unavailable",
        message: "agent work temporarily unavailable",
      });
      expect(await sessionEffects(f.context.db)).toEqual(before);
    },
  );

  it("recovers a canonical binding after losing its committed response without creating a second session", async () => {
    const f = await fixture();
    success(
      await f.native(observeCheckoutLeaseCommand, {
        principal: f.principal,
        observation: leaseObservation(f.final),
      }),
    );
    const input: AgentSessionBindRequest = {
      reference: f.reference(),
      observation: {
        provider: "fake",
        observed_session_id: "synthetic-lost-binding",
        observed_at: LAUNCH_NOW,
      },
    };
    const get = f.namespace.get.bind(f.namespace);
    let loseResponse = true,
      committed = false;
    vi.spyOn(f.namespace, "get").mockImplementation((id: DurableObjectId) => {
      const stub = get(id);
      return {
        async fetch(request: RequestInfo | URL, init?: RequestInit) {
          const body = JSON.parse(String(init?.body)) as { commandName: string };
          const response = await stub.fetch(request, init);
          if (loseResponse && body.commandName === "agent_run.session_bind") {
            expect(response.status).toBe(200);
            expect(
              await f.context.db
                .prepare("SELECT COUNT(*) AS count FROM execution_session_bindings")
                .get(),
            ).toEqual({ count: 1 });
            committed = true;
            loseResponse = false;
            throw new Error("synthetic-private-lost-binding-response");
          }
          return response;
        },
      } as DurableObjectStub;
    });
    const lost = await f.send(await f.signed("session-bind", input));
    expect(committed).toBe(true);
    expect(lost.status).toBe(503);
    expect(await lost.json()).toEqual({
      error: "work_unavailable",
      message: "agent work temporarily unavailable",
    });
    const persisted = (await f.context.db
      .prepare("SELECT provider_session_id FROM execution_session_bindings")
      .get()) as { provider_session_id: string };
    const before = await sessionEffects(f.context.db);
    const repeated = await f.send(
      await f.signed("session-bind", { ...input, reference: f.reference() }),
    );
    expect(repeated.status, await repeated.clone().text()).toBe(200);
    expect(await repeated.json()).toEqual({
      binding: {
        provider: "fake",
        observed_session_id: input.observation.observed_session_id,
        provider_session_id: persisted.provider_session_id,
      },
      observed_at: LAUNCH_NOW,
      confirmed_at: LAUNCH_NOW,
      origin: {
        run_id: f.launch.run_id,
        run_execution_id: f.final.run_execution_id,
        assignment_generation: 1,
        provider_session_id: persisted.provider_session_id,
      },
    });
    expect(await sessionEffects(f.context.db)).toEqual(before);
    await f.context.db
      .prepare("UPDATE checkout_leases SET expires_at = ? WHERE execution_id = ?")
      .run(LAUNCH_NOW, f.final.run_execution_id);
    const denied = await f.send(await f.signed("session-bind", input));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: "capability_closed",
      message: "agent work rejected",
    });
    expect(await sessionEffects(f.context.db)).toEqual(before);
  });

  it.each(["recover", "requester revoke", "execution end", "session end", "lease expiry"] as const)(
    "preserves the committed comment after response loss with %s before retry",
    async (disposition) => {
      const f = await sessionFixture(),
        input = f.comment("response-lost-after-commit"),
        get = f.namespace.get.bind(f.namespace);
      let loseResponse = true,
        committed = false;
      vi.spyOn(f.namespace, "get").mockImplementation((id: DurableObjectId) => {
        const stub = get(id);
        return {
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const body = JSON.parse(String(init?.body)) as { commandName: string };
            const response = await stub.fetch(request, init);
            if (loseResponse && body.commandName === "agent_run.comment") {
              expect(response.status).toBe(200);
              expect(
                await f.context.db
                  .prepare("SELECT COUNT(*) AS count FROM agent_work_effects")
                  .get(),
              ).toEqual({ count: 1 });
              committed = true;
              loseResponse = false;
              throw new Error("synthetic-private-lost-committed-response");
            }
            return response;
          },
        } as DurableObjectStub;
      });
      const lost = await f.send(await f.signed("comment", input));
      expect(committed).toBe(true);
      expect(lost.status).toBe(503);
      expect(await lost.json()).toEqual({
        error: "work_unavailable",
        message: "agent work temporarily unavailable",
      });
      const persisted = (await f.context.db
        .prepare("SELECT comment_id FROM agent_work_effects")
        .get()) as { comment_id: string };
      const before = await sessionEffects(f.context.db);
      if (disposition !== "recover") {
        if (disposition === "requester revoke")
          await f.context.db
            .prepare("UPDATE runner_launch_grants SET revoked_at = ? WHERE human_id = ?")
            .run(LAUNCH_NOW, FIX.member);
        else if (disposition === "execution end")
          await f.context.db
            .prepare(
              "UPDATE run_executions SET state = 'ended', end_reason = 'process_exit', ended_at = ? WHERE id = ?",
            )
            .run(LAUNCH_NOW, f.final.run_execution_id);
        else if (disposition === "session end")
          await f.context.db
            .prepare("UPDATE provider_sessions SET state = 'ended', ended_at = ? WHERE id = ?")
            .run(LAUNCH_NOW, f.result.binding.provider_session_id);
        else
          await f.context.db
            .prepare("UPDATE checkout_leases SET expires_at = ? WHERE execution_id = ?")
            .run(LAUNCH_NOW, f.final.run_execution_id);
        const denied = await f.send(await f.signed("comment", input));
        expect(denied.status, await denied.clone().text()).toBe(403);
        const outcome = await denied.json();
        expect(outcome).toEqual({
          error:
            disposition === "requester revoke"
              ? "revoked"
              : disposition === "execution end"
                ? "assignment_ended"
                : "capability_closed",
          message: "agent work rejected",
        });
        expect(JSON.stringify(outcome)).not.toContain(persisted.comment_id);
        expect(JSON.stringify(outcome)).not.toContain(input.body);
        expect(await sessionEffects(f.context.db)).toEqual(before);
        // The failed delivery is not evidence of a rejected/no-effect mutation.
        expect(
          await f.context.db
            .prepare("SELECT COUNT(*) AS count FROM comments WHERE id = ?")
            .get(persisted.comment_id),
        ).toEqual({ count: 1 });
        return;
      }
      const repeated = await f.send(await f.signed("comment", input));
      expect(repeated.status, await repeated.clone().text()).toBe(200);
      expect(await repeated.json()).toEqual({ id: persisted.comment_id, origin: f.result.origin });
      expect(await sessionEffects(f.context.db)).toEqual(before);
      await f.context.db
        .prepare("UPDATE runner_launch_grants SET revoked_at = ? WHERE human_id = ?")
        .run(LAUNCH_NOW, FIX.member);
      const denied = await f.send(await f.signed("comment", input));
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "revoked", message: "agent work rejected" });
      expect(await sessionEffects(f.context.db)).toEqual(before);
    },
  );

  it("keeps a current binding database fault retryable after valid possession", async () => {
    const f = await sessionFixture(),
      request = await f.signed("comment", f.comment()),
      before = await sessionEffects(f.context.db),
      prepare = f.context.db.prepare.bind(f.context.db);
    let injected = false;
    vi.spyOn(f.context.db, "prepare").mockImplementation((sql) => {
      if (sql.includes("FROM execution_session_bindings binding")) {
        injected = true;
        throw new Error("synthetic-private-binding-d1-failure");
      }
      return prepare(sql);
    });
    const response = await f.send(request);
    expect(injected).toBe(true);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "work_unavailable",
      message: "agent work temporarily unavailable",
    });
    expect(await sessionEffects(f.context.db)).toEqual(before);
  });
});

describe("mounted local-agent work transport", () => {
  it("returns item-aligned committed delivery IDs on independently signed retries without leaking credentials", async () => {
    const f = await fixture(),
      body = "Synthetic agent context canary";
    for (const [audience, text] of [
      ["agent", body],
      ["both", "Synthetic shared context"],
      ["human", "Synthetic human-only canary"],
    ] as const) {
      success(
        await f.human(addContextCommand, {
          taskId: f.task.id,
          kind: "brief",
          audience,
          body: text,
        }),
      );
    }
    const request = f.reference();
    const first = await f.send(await f.signed("context", request));
    expect(first.status, await first.clone().text()).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
    const result = (await first.json()) as AgentContextResult;
    expect(result.context.map((item) => item.body)).toEqual([body, "Synthetic shared context"]);
    expect(result.deliveries).toHaveLength(2);
    expect(result).not.toHaveProperty("delivery");
    const repeated = await f.send(await f.signed("context", request));
    expect(repeated.status, await repeated.clone().text()).toBe(200);
    expect(await repeated.json()).toEqual(result);
    expect(
      await f.context.db
        .prepare(
          `SELECT id, context_version, content_hash, delivered_at, run_id
      FROM task_context_deliveries WHERE task_id = ? ORDER BY context_version`,
        )
        .all(f.task.id),
    ).toEqual(result.deliveries);
    expect(await workEffects(f.context.db)).toEqual({
      deliveries: 2,
      events: 1,
      audits: 1,
      outcomes: 1,
    });
    for (const [table, column] of [
      ["audit_events", "action"],
      ["semantic_events", "kind"],
      ["outbox_records", "kind"],
    ] as const) {
      const rows = JSON.stringify(
        await f.context.db
          .prepare(`SELECT payload_json FROM ${table} WHERE ${column} = 'agent_run.context'`)
          .all(),
      );
      expect(rows).not.toContain(body);
      expect(rows).not.toContain("Synthetic human-only canary");
      expect(rows).not.toContain(f.token);
      expect(rows).not.toContain(f.principal.tokenId);
      expect(rows).toContain(result.deliveries[0]!.id);
    }
  });

  it.each(["authority", "context", "task"] as const)(
    "denies a cached %s reply after current execution/grant/result/lease closure",
    async (action) => {
      for (const state of [
        "requester grant",
        "execution ended",
        "terminal result",
        "lease expired",
      ] as const) {
        const f = await fixture(),
          body = f.reference();
        const first = await f.send(await f.signed(action, body));
        expect(first.status, await first.clone().text()).toBe(200);
        const expected =
          state === "requester grant"
            ? "revoked"
            : state === "execution ended"
              ? "assignment_ended"
              : "capability_closed";
        if (state === "requester grant") {
          await f.context.db
            .prepare(`UPDATE runner_launch_grants SET revoked_at = ? WHERE human_id = ?`)
            .run(LAUNCH_NOW, FIX.member);
        } else if (state === "execution ended") {
          await f.context.db
            .prepare(
              `UPDATE run_executions SET state = 'ended', end_reason = 'process_exit', ended_at = ? WHERE id = ?`,
            )
            .run(LAUNCH_NOW, f.final.run_execution_id);
        } else if (state === "terminal result") {
          await f.context.db
            .prepare(`UPDATE runs SET result_state = 'accepted' WHERE id = ?`)
            .run(f.launch.run_id);
        } else {
          await f.context.db
            .prepare(`UPDATE checkout_leases SET expires_at = ? WHERE execution_id = ?`)
            .run(LAUNCH_NOW, f.final.run_execution_id);
        }
        const before = await workEffects(f.context.db);
        const repeated = await f.send(await f.signed(action, body));
        expect(repeated.status, await repeated.clone().text()).toBe(403);
        expect(await repeated.json()).toEqual({ error: expected, message: "agent work rejected" });
        expect(await workEffects(f.context.db)).toEqual(before);
      }
    },
  );

  it.each(["cookie", "origin", "authorization"] as const)(
    "rejects %s credentials even alongside a valid runner proof",
    async (header) => {
      const f = await fixture(),
        request = await f.signed("context");
      request.headers.set(
        header,
        header === "authorization"
          ? `Bearer ${f.token}`
          : header === "origin"
            ? ORIGIN
            : "synthetic-browser-cookie",
      );
      const response = await f.send(request);
      expect(response.status).toBe(403);
      expect(await workEffects(f.context.db)).toEqual({
        deliveries: 0,
        events: 0,
        audits: 0,
        outcomes: 0,
      });
    },
  );

  it("rejects missing/reused possession, wrong generation, foreign executions and boundary/proxy fields", async () => {
    const f = await fixture();
    const unsigned = new Request(`${ORIGIN}${f.nativePrefix}/work/context`, {
      method: "POST",
      body: JSON.stringify(f.reference()),
    });
    expect((await f.send(unsigned)).status).toBe(403);
    const signed = await f.signed("context");
    expect((await f.send(signed.clone())).status).toBe(200);
    expect((await f.send(signed)).status).toBe(403);
    const before = await workEffects(f.context.db);
    for (const [body, expected] of [
      [{ ...f.reference(), assignment_generation: 2 }, "boundary_escape"],
      [{ ...f.reference(), run_execution_id: randomUlid() }, "boundary_escape"],
      [{ ...f.reference(), task_id: FIX.taskDelegable }, "request_rejected"],
      [
        {
          ...f.reference(),
          method: "POST",
          url: "https://untrusted.example.test",
          provider_pid: 1234,
        },
        "request_rejected",
      ],
    ] as const) {
      const response = await f.send(await f.signed("context", body));
      expect(response.status, await response.clone().text()).toBe(403);
      expect(await response.json()).toEqual({ error: expected, message: "agent work rejected" });
    }
    expect(await workEffects(f.context.db)).toEqual(before);
  });

  it.each(["malformed", "oversized"] as const)(
    "rejects %s work input without creating domain effects",
    async (kind) => {
      const f = await fixture();
      const raw =
        kind === "malformed"
          ? "{"
          : JSON.stringify({ ...f.reference(), padding: "x".repeat(2048) });
      const response = await f.send(await f.signed("context", {}, raw));
      expect(response.status, await response.clone().text()).toBe(403);
      expect(await response.json()).toEqual({
        error: "request_rejected",
        message: "agent work rejected",
      });
      expect(await workEffects(f.context.db)).toEqual({
        deliveries: 0,
        events: 0,
        audits: 0,
        outcomes: 0,
      });
    },
  );

  it("keeps escaped oversized context rejection atomic through the mounted route", async () => {
    const f = await fixture();
    success(
      await f.human(addContextCommand, {
        taskId: f.task.id,
        kind: "brief",
        audience: "agent",
        body: "<>&\u2028\u2029".repeat(2100),
      }),
    );
    const response = await f.send(await f.signed("context"));
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await response.json()).toEqual({
      error: "request_rejected",
      message: "agent work rejected",
    });
    expect(await workEffects(f.context.db)).toEqual({
      deliveries: 0,
      events: 0,
      audits: 0,
      outcomes: 0,
    });
  });

  it.each(["runner.request.authenticate", "agent_run.context"] as const)(
    "keeps a Hub outage at %s retryable and sanitized",
    async (failedCommand) => {
      const f = await fixture(),
        request = await f.signed("context");
      const get = f.namespace.get.bind(f.namespace);
      let injected = false;
      vi.spyOn(f.namespace, "get").mockImplementation((id: DurableObjectId) => {
        const stub = get(id);
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const body = JSON.parse(String(init?.body)) as { commandName: string };
            if (body.commandName === failedCommand) {
              injected = true;
              throw new Error("synthetic-private-hub-failure");
            }
            return stub.fetch(input, init);
          },
        } as DurableObjectStub;
      });
      const response = await f.send(request);
      expect(injected).toBe(true);
      expect(response.status, await response.clone().text()).toBe(503);
      expect(await response.json()).toEqual({
        error: "work_unavailable",
        message: "agent work temporarily unavailable",
      });
      expect(await workEffects(f.context.db)).toEqual({
        deliveries: 0,
        events: 0,
        audits: 0,
        outcomes: 0,
      });
    },
  );

  it("keeps a pre-possession D1 outage retryable without disclosing driver text", async () => {
    const f = await fixture(),
      request = await f.signed("context");
    f.setRequestDb(failingReads(f.context.db, /FROM workspaces WHERE/u));
    const response = await f.send(request);
    expect(response.status, await response.clone().text()).toBe(503);
    expect(await response.json()).toEqual({
      error: "work_unavailable",
      message: "agent work temporarily unavailable",
    });
    expect(await workEffects(f.context.db)).toEqual({
      deliveries: 0,
      events: 0,
      audits: 0,
      outcomes: 0,
    });
  });

  it("keeps a D1 requester-grant read failure retryable after valid runner possession", async () => {
    const f = await fixture(),
      request = await f.signed("context");
    const prepare = f.context.db.prepare.bind(f.context.db);
    let injected = false;
    vi.spyOn(f.context.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes("FROM workspace_members AS membership")) return statement;
      return {
        ...statement,
        async get(...params: unknown[]) {
          if (params.includes(FIX.member)) {
            injected = true;
            throw new Error("synthetic-private-requester-d1-failure");
          }
          return statement.get(...params);
        },
      };
    });
    const response = await f.send(request);
    expect(injected).toBe(true);
    expect(response.status, await response.clone().text()).toBe(503);
    expect(await response.json()).toEqual({
      error: "work_unavailable",
      message: "agent work temporarily unavailable",
    });
    expect(await workEffects(f.context.db)).toEqual({
      deliveries: 0,
      events: 0,
      audits: 0,
      outcomes: 0,
    });
  });
});
