// ABOUTME: Exercises uniform diagnostic quarantine through signed browser sessions and mounted routes.
// ABOUTME: Snapshot presence, private work and proof state cannot permit delivery or diagnostic effects.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTaskCommand,
  FIX,
  issueStepUpProof,
  OPS_STEP_UP_ACTIONS,
  randomUlid,
  seedSyntheticWorkspace,
  WorkspaceHub,
} from "@bfb/domain";

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
const BASE = `/api/v1/workspaces/${FIX.workspace}/operations/diagnostics`;
const UNAVAILABLE = { error: "request_rejected", message: "diagnostic bundles are unavailable" };
type Actor = "owner" | "member" | "reviewer";
const contexts: AuthTestContext[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  contexts.splice(0).forEach((context) => context.raw.close());
  vi.useRealTimers();
});

async function fixture(work: "empty" | "shared" | "private" = "empty") {
  const context = openAuthTestContext(NOW);
  contexts.push(context);
  await seedSyntheticWorkspace(context.db, NOW);
  if (work !== "empty") {
    const task = await new WorkspaceHub(context.db).execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      now: NOW,
      input: { projectId: FIX.projectA, title: "Synthetic diagnostic parent", priority: "P2" },
    });
    if (!task.ok) throw new Error(task.error.code);
    if (work === "private") {
      await context.db
        .prepare(
          "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
        )
        .run(FIX.workspace, task.result.id, FIX.member, NOW);
    }
  }
  const cookies = {} as Record<Actor, string>;
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
    ["reviewer", FIX.reviewer],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `diagnostic-${actor}-user`,
      sessionId: `diagnostic-${actor}-session`,
      token: `diagnostic-${actor}-token`,
      email: `${actor}@synthetic.test`,
      humanId,
      now: NOW,
    });
    cookies[actor] = session.cookie;
  }
  const send = vi.fn(async () => {});
  const bindings = {
    DB: {},
    ARTIFACTS: {},
    ASSETS: {},
    JOBS: {},
    JOBS_DLQ: {},
    OPS_JOBS: { send },
    OPS_DLQ: {},
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(context.db),
    APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  } as unknown as ControlBindings;
  const app = createControlApp(validateControlEnv(bindings), {
    db: context.db,
    now: NOW,
    abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
  const request = (path: string, actor: Actor = "owner", body?: unknown, csrfToken?: string) =>
    app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, {
        headers: {
          cookie: cookies[actor],
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                origin: AUTH_TEST_ENV.APP_ORIGIN,
                "sec-fetch-site": "same-origin",
                ...(csrfToken === undefined ? {} : { "x-bfb-csrf": csrfToken }),
              }),
        },
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      }),
      undefined,
      bindings,
    );
  const session = await request("/auth/session");
  expect(session.status).toBe(200);
  const csrf = ((await session.json()) as { csrf_token: string }).csrf_token;
  return { context, request, csrf, send };
}

async function bundle(context: AuthTestContext, inventory = '{"schema_version":1,"tasks":7}') {
  const id = randomUlid();
  await context.db
    .prepare(
      `INSERT INTO diagnostic_bundles
       (workspace_id,id,created_by_human_id,state,inventory_json,bundle_hash,redaction_status,
        r2_key,created_at,consented_at,uploaded_at,expires_at,last_error)
       VALUES (?,?,?,'pending_consent',?,?,'passed',NULL,?,NULL,NULL,?,NULL)`,
    )
    .run(FIX.workspace, id, FIX.owner, inventory, "a".repeat(64), NOW, "2026-10-08T12:00:00Z");
  return id;
}

async function proof(context: AuthTestContext, action: string, targetId: string) {
  return issueStepUpProof(
    context.db,
    FIX.owner,
    {
      action,
      workspaceId: FIX.workspace,
      targetId,
      scopes: [],
      authorizationEpoch: 1,
      expiresAt: "2026-10-07T12:05:00.000Z",
    },
    NOW,
  );
}

function durableState(context: AuthTestContext) {
  return Object.fromEntries(
    [
      "diagnostic_bundles",
      "passkey_step_up_proofs",
      "audit_events",
      "semantic_events",
      "outbox_records",
      "idempotency_records",
      "workspace_cursors",
    ].map((table) => [table, context.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

async function unavailable(response: Response) {
  expect(response.status).toBe(409);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(UNAVAILABLE);
}

describe("mounted diagnostic snapshot quarantine", () => {
  it.each(["empty", "shared", "private"] as const)(
    "denies list and absent detail equally in a %s workspace",
    async (work) => {
      const f = await fixture(work);
      for (const actor of ["owner", "member"] as const) {
        await unavailable(await f.request(BASE, actor));
        await unavailable(await f.request(`${BASE}/${randomUlid()}`, actor));
      }
    },
  );

  it.each(['{"schema_version":1,"tasks":7}', '"unsupported historical inventory"'])(
    "denies existing detail without interpreting stored inventory %s",
    async (inventory) => {
      const f = await fixture();
      const id = await bundle(f.context, inventory);
      const before = durableState(f.context);
      await unavailable(await f.request(`${BASE}/${id}`, "member"));
      expect(durableState(f.context)).toEqual(before);
    },
  );

  it("rejects generation without consuming its valid proof or creating durable receipts", async () => {
    const f = await fixture("private");
    const id = await proof(
      f.context,
      OPS_STEP_UP_ACTIONS.diagnosticGenerate,
      `diagnostic:generate:${FIX.workspace}`,
    );
    const before = durableState(f.context);
    await unavailable(
      await f.request(
        BASE,
        "owner",
        { request_id: "diagnostic-generate-held", step_up_proof_id: id },
        f.csrf,
      ),
    );
    expect(durableState(f.context)).toEqual(before);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("denies consent for known and missing bundles without proof, state or enqueue effects", async () => {
    const f = await fixture();
    const id = await bundle(f.context);
    const proofId = await proof(
      f.context,
      OPS_STEP_UP_ACTIONS.diagnosticUpload,
      `diagnostic:${id}`,
    );
    const before = durableState(f.context);
    for (const target of [id, randomUlid()]) {
      await unavailable(
        await f.request(
          `${BASE}/${target}/consent`,
          "owner",
          { request_id: `diagnostic-consent-${target}`, step_up_proof_id: proofId },
          f.csrf,
        ),
      );
    }
    expect(durableState(f.context)).toEqual(before);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("selects no bundle, proof, inventory or cache to choose the unavailable response", async () => {
    const f = await fixture();
    const id = await bundle(f.context, '{"schema_version":2,"tasks":91}');
    const reads = vi.spyOn(f.context.db, "prepare");
    const body = { request_id: "diagnostic-no-lookups", step_up_proof_id: randomUlid() };
    const responses = [
      await f.request(BASE),
      await f.request(`${BASE}/${id}`),
      await f.request(BASE, "owner", body, f.csrf),
      await f.request(`${BASE}/${id}/consent`, "owner", body, f.csrf),
    ];
    const selected = reads.mock.calls.map(([sql]) => sql);
    for (const response of responses) await unavailable(response);
    expect(
      selected.filter((sql) =>
        /diagnostic_bundles|passkey_step_up_proofs|idempotency_records|task_privacy|FROM tasks\b/i.test(
          sql,
        ),
      ),
    ).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("preserves role, CSRF and structural admission rather than treating them as availability", async () => {
    const f = await fixture();
    expect((await f.request(BASE, "reviewer")).status).toBe(403);
    const body = { request_id: "diagnostic-admission", step_up_proof_id: randomUlid() };
    const memberSession = await f.request("/auth/session", "member");
    const memberCsrf = ((await memberSession.json()) as { csrf_token: string }).csrf_token;
    expect((await f.request(BASE, "member", body, memberCsrf)).status).toBe(403);
    expect((await f.request(BASE, "owner", body)).status).toBe(403);
    for (const invalid of [
      { step_up_proof_id: body.step_up_proof_id },
      { request_id: body.request_id },
      { ...body, unknown: true },
    ]) {
      expect((await f.request(BASE, "owner", invalid, f.csrf)).status).toBe(400);
    }
    expect((await f.request(`${BASE}/invalid/consent`, "owner", body, f.csrf)).status).toBe(400);
  });
});
