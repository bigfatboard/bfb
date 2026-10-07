// ABOUTME: Exercises unsupported audit and legacy recovery quarantine through authenticated browser routes.
// ABOUTME: Pure admission remains separate from unavailable target, proof, cache and business-state access.

import type { SqlDatabase } from "@bfb/db";
import {
  createTaskCommand,
  FIX,
  issueStepUpProof,
  OPS_STEP_UP_ACTIONS,
  randomUlid,
  recoveryActionId,
  seedSyntheticWorkspace,
  WorkspaceHub,
} from "@bfb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
  type AuthTestContext,
} from "./auth-helpers.js";

const NOW = "2026-10-07T12:00:00.000Z";
const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;
const BASE = `/api/v1/workspaces/${FIX.workspace}/operations`;
const UNAVAILABLE = { error: "request_rejected", message: "recovery kind is unavailable" };
const CURSOR_DENIED = { error: "invalid_argument", message: "unknown audit cursor" };
const CANARY = "synthetic-quarantined-private-reference";
const KINDS = [
  "retry_notification_dispatch",
  "requeue_github_outbox",
  "clear_recovery_state",
] as const;
type Kind = (typeof KINDS)[number];
type Actor = "owner" | "member";
const contexts: AuthTestContext[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  contexts.splice(0).forEach((context) => context.raw.close());
  vi.useRealTimers();
});

async function fixture() {
  const context = openAuthTestContext(NOW);
  contexts.push(context);
  await seedSyntheticWorkspace(context.db, NOW);
  const bindings = {
    DB: {},
    ARTIFACTS: {},
    ASSETS: {},
    JOBS: {},
    JOBS_DLQ: {},
    OPS_JOBS: { send: vi.fn(async () => {}) },
    OPS_DLQ: {},
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(context.db),
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  } as unknown as ControlBindings;
  const app = (database = context.db) =>
    createControlApp(validateControlEnv(bindings), {
      db: database,
      now: NOW,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      humanAuth: () => ({
        auth: context.auth,
        keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
        abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      }),
    });
  const actors = {} as Record<Actor, { cookie: string; csrf: string }>;
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `quarantine-${actor}-user`,
      sessionId: `quarantine-${actor}-session`,
      token: `quarantine-${actor}-token`,
      email: `${actor}@synthetic.test`,
      humanId,
      now: NOW,
    });
    const response = await app().request(
      new Request(ORIGIN + "/auth/session", { headers: { cookie: session.cookie } }),
      undefined,
      bindings,
    );
    expect(response.status).toBe(200);
    actors[actor] = {
      cookie: session.cookie,
      csrf: ((await response.json()) as { csrf_token: string }).csrf_token,
    };
  }
  const request = (
    tail: string,
    body?: unknown,
    actor: Actor = "owner",
    database = context.db,
    headers: Record<string, string> = {},
  ) =>
    app(database).request(
      new Request(ORIGIN + BASE + tail, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie: actors[actor].cookie,
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                origin: ORIGIN,
                "sec-fetch-site": "same-origin",
                "x-bfb-csrf": actors[actor].csrf,
              }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      undefined,
      bindings,
    );
  const proof = (kind: Kind) =>
    issueStepUpProof(
      context.db,
      FIX.owner,
      {
        action: OPS_STEP_UP_ACTIONS.recover,
        workspaceId: FIX.workspace,
        targetId: `ops-recover:${kind}:${FIX.workspace}`,
        scopes: [],
        authorizationEpoch: 1,
        expiresAt: "2026-10-07T12:05:00.000Z",
      },
      NOW,
    );
  return { context, db: context.db, request, proof, bindings };
}

function body(kind: Kind, target: unknown = {}, proofId = "nonexistent-proof") {
  return { request_id: "quarantine-request-01", kind, target, step_up_proof_id: proofId };
}

function durableState(context: AuthTestContext) {
  return Object.fromEntries(
    [
      "passkey_step_up_proofs",
      "notification_dispatch_state",
      "github_integration_outbox",
      "github_webhook_deliveries",
      "ops_recovery_ledger",
      "audit_events",
      "semantic_events",
      "idempotency_records",
      "outbox_records",
      "workspace_cursors",
    ].map((table) => [table, context.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

async function unavailable(response: Response) {
  expect(response.status).toBe(409);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(UNAVAILABLE);
}

async function seedKnownTarget(db: SqlDatabase, kind: Kind) {
  if (kind === "retry_notification_dispatch") {
    await db
      .prepare(
        `INSERT INTO semantic_events (workspace_id,event_id,workspace_cursor,kind,payload_json,created_at)
      VALUES (?,?,7,'attention.request','{}',?)`,
      )
      .run(FIX.workspace, randomUlid(), NOW);
    await db
      .prepare(
        "INSERT INTO notification_dispatch_state (workspace_id,last_cursor,updated_at) VALUES (?,99,?)",
      )
      .run(FIX.workspace, NOW);
    return { cursors: [7] };
  }
  if (kind === "requeue_github_outbox") {
    const id = "synthetic-held-outbox";
    await db
      .prepare(
        `INSERT INTO github_webhook_deliveries
      (workspace_id,delivery_id,event,effect_json,state,received_at) VALUES (?,?,'push','{}','received',?)`,
      )
      .run(FIX.workspace, id, NOW);
    await db
      .prepare(
        `INSERT INTO github_integration_outbox
      (workspace_id,outbox_id,delivery_id,kind,state,attempts,next_attempt_at,last_error,created_at,updated_at)
      VALUES (?,?,?,'github.reconcile','dlq',5,?,'synthetic failure',?,?)`,
      )
      .run(FIX.workspace, id, id, NOW, NOW, NOW);
    return { outbox_ids: [id] };
  }
  const id = "ops:synthetic-held-ledger";
  await db
    .prepare(
      `INSERT INTO ops_recovery_ledger
    (workspace_id,action_id,kind,target_json,state,attempt_count,result_json,created_by_human_id,created_at,updated_at)
    VALUES (?,?,'retry_notification_dispatch','{"cursors":[7]}','applied',1,'{"cursors":1,"redispatched_from":6}',?,?,?)`,
    )
    .run(FIX.workspace, id, FIX.owner, NOW, NOW);
  return { action_ids: [id] };
}

describe("mounted unsupported operations quarantine", () => {
  it.each(KINDS)(
    "holds %s without consuming its proof or changing existing business state",
    async (kind) => {
      const f = await fixture();
      const target = await seedKnownTarget(f.db, kind);
      const proof = await f.proof(kind);
      const before = durableState(f.context);
      await unavailable(await f.request("/recovery", body(kind, target, proof)));
      expect(durableState(f.context)).toEqual(before);
      expect(f.bindings.OPS_JOBS.send).not.toHaveBeenCalled();
    },
  );

  it.each(KINDS)(
    "does not interpret absent targets or missing/expired/consumed proofs for %s",
    async (kind) => {
      const f = await fixture();
      const valid = await f.proof(kind);
      const expired = await f.proof(kind);
      const consumed = await f.proof(kind);
      await f.db
        .prepare("UPDATE passkey_step_up_proofs SET expires_at=? WHERE proof_id=?")
        .run("2026-10-07T11:00:00Z", expired);
      await f.db
        .prepare("UPDATE passkey_step_up_proofs SET consumed_at=? WHERE proof_id=?")
        .run(NOW, consumed);
      const before = durableState(f.context);
      for (const proof of ["missing-proof", expired, consumed, valid]) {
        await unavailable(await f.request("/recovery", body(kind, { unknown: CANARY }, proof)));
      }
      expect(durableState(f.context)).toEqual(before);
    },
  );

  it("does not parse retained applied outcomes or distinguish a repeated request", async () => {
    const f = await fixture();
    const kind = "retry_notification_dispatch";
    const target = { cursors: [7] };
    const action = recoveryActionId(kind, target);
    await f.db
      .prepare(
        `INSERT INTO ops_recovery_ledger
      (workspace_id,action_id,kind,target_json,state,attempt_count,result_json,created_by_human_id,created_at,updated_at)
      VALUES (?,?,?,?,'applied',3,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        action,
        kind,
        JSON.stringify(target),
        JSON.stringify({ ref: CANARY }),
        FIX.owner,
        NOW,
        NOW,
      );
    const proofs = [await f.proof(kind), await f.proof(kind)];
    const before = durableState(f.context);
    for (const proof of proofs)
      await unavailable(await f.request("/recovery", body(kind, target, proof)));
    expect(durableState(f.context)).toEqual(before);
  });

  it("holds equally when current private work exists without using its identifiers", async () => {
    const f = await fixture();
    const outcome = await new WorkspaceHub(f.db).execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title: CANARY, priority: "P2" },
    });
    if (!outcome.ok) throw new Error(outcome.error.code);
    await f.db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, outcome.result.id, FIX.member, NOW);
    const before = durableState(f.context);
    for (const kind of KINDS)
      await unavailable(await f.request("/recovery", body(kind, { ref: outcome.result.id })));
    expect(durableState(f.context)).toEqual(before);
  });

  it("denies before preparing any proof, target, ledger, cache or business receipt query", async () => {
    const f = await fixture();
    const queries: string[] = [];
    const database: SqlDatabase = {
      ...f.db,
      prepare(sql) {
        if (
          /passkey_step_up_proofs|ops_recovery_ledger|notification_dispatch_state|github_integration_outbox|idempotency_records|semantic_events|audit_events/.test(
            sql,
          )
        ) {
          queries.push(sql);
          throw new Error("synthetic forbidden recovery access");
        }
        return f.db.prepare(sql);
      },
    };
    for (const kind of KINDS)
      await unavailable(await f.request("/recovery", body(kind), "owner", database));
    expect(queries).toEqual([]);
  });

  it("retains current Owner and CSRF admission before the unavailable answer", async () => {
    const f = await fixture();
    expect((await f.request("/recovery", body(KINDS[0]), "member")).status).toBe(403);
    expect(
      (await f.request("/recovery", body(KINDS[0]), "owner", f.db, { "x-bfb-csrf": "" })).status,
    ).toBe(403);
    await f.db
      .prepare(
        "UPDATE workspace_authorization_epochs SET revoked_at=? WHERE workspace_id=? AND human_id=?",
      )
      .run(NOW, FIX.workspace, FIX.owner);
    expect((await f.request("/recovery", body(KINDS[0]))).status).toBe(403);
  });

  it("retains closed-body, kind, target-object, request-ID and nonempty proof admission", async () => {
    const f = await fixture();
    const valid = body(KINDS[0]);
    const malformed = [
      { ...valid, unsupported: true },
      { ...valid, kind: "unknown_kind" },
      { ...valid, target: [] },
      { ...valid, request_id: "" },
      { ...valid, step_up_proof_id: "" },
    ];
    for (const value of malformed) expect((await f.request("/recovery", value)).status).toBe(400);
    await unavailable(await f.request("/recovery", valid));
  });

  it("retains method and abuse-budget admission without business effects", async () => {
    const f = await fixture();
    expect((await f.request("/recovery")).status).toBe(405);
    expect((await f.request("/recovery", { ...body(KINDS[0]), step_up_proof_id: "" })).status).toBe(
      400,
    );
    const buckets = f.context.raw
      .prepare("SELECT COUNT(*) AS count FROM rate_limit_buckets")
      .get() as { count: number };
    expect(buckets.count).toBeGreaterThan(0);
    await f.db.prepare("UPDATE rate_limit_buckets SET count=100").run();
    const before = durableState(f.context);
    const response = await f.request("/recovery", body(KINDS[0]));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "request_rejected",
      message: "request rejected",
    });
    expect(durableState(f.context)).toEqual(before);
  });

  it.each(["ops.recover", "workspace.synthetic-action"])(
    "omits unsupported %s before pages and treats its anchor as unknown",
    async (action) => {
      const f = await fixture();
      const id = randomUlid();
      await f.db
        .prepare(
          `INSERT INTO audit_events (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at)
      VALUES (?,?,?,?,?,?)`,
        )
        .run(FIX.workspace, id, FIX.owner, action, JSON.stringify({ version_id: CANARY }), NOW);
      const before = durableState(f.context);
      const page = await f.request("/security-audit?limit=1");
      expect(page.status).toBe(200);
      expect(await page.json()).toEqual({ ok: true, entries: [], has_more: false });
      for (const cursor of [id, randomUlid()]) {
        const response = await f.request(`/security-audit?after=${cursor}`);
        expect(response.status).toBe(400);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual(CURSOR_DENIED);
      }
      expect(durableState(f.context)).toEqual(before);
    },
  );
});
