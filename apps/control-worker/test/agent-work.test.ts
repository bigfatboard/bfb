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
import type { AgentContextResult, AgentWorkRequest } from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authorizeLaunchCommand } from "../../../packages/domain/src/launches.js";
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
import { AUTH_TEST_ENV, openAuthTestContext } from "./auth-helpers.js";

type Action = "authority" | "context" | "task";
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
