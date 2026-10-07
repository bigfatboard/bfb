// ABOUTME: Exercises X05 operations browser routes across roles and step-up states.
// ABOUTME: Security audit stays Owner-only; retention needs proofs and unsupported recovery remains unavailable.

import { describe, expect, it } from "vitest";

import {
  FIX,
  issueStepUpProof,
  OPS_STEP_UP_ACTIONS,
  randomUlid,
  seedSyntheticWorkspace,
} from "@bfb/domain";

import { LAUNCH_NOW, launchFixture } from "../../../packages/domain/test/launch-fixture.js";

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

const NOW = "2026-09-18T12:00:00.000Z";

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

function bindings(context: AuthTestContext): ControlBindings {
  return {
    DB: fakeBinding<D1Database>("db"),
    ARTIFACTS: fakeBinding<R2Bucket>("r2"),
    ASSETS: fakeBinding<Fetcher>("assets"),
    JOBS: fakeBinding<Queue>("jobs"),
    JOBS_DLQ: fakeBinding<Queue>("dlq"),
    OPS_JOBS: fakeBinding<Queue>("ops"),
    OPS_DLQ: fakeBinding<Queue>("ops-dlq"),
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(context.db),
    APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
}

function appFor(context: AuthTestContext) {
  const currentBindings = bindings(context);
  const app = createControlApp(validateControlEnv(currentBindings), {
    db: context.db,
    now: NOW,
    abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
  return { app, currentBindings };
}

async function contextWithSessions() {
  const context = openAuthTestContext();
  await seedSyntheticWorkspace(context.db, NOW);
  const owner = await seedAuthSession(context, {
    userId: "ops-owner-user",
    sessionId: "ops-owner-session",
    token: "ops-owner-token",
    email: "owner@synthetic.test",
    name: "Synthetic Owner",
    humanId: FIX.owner,
  });
  const member = await seedAuthSession(context, {
    userId: "ops-member-user",
    sessionId: "ops-member-session",
    token: "ops-member-token",
    email: "member@synthetic.test",
    name: "Synthetic Member",
    humanId: FIX.member,
  });
  const reviewer = await seedAuthSession(context, {
    userId: "ops-reviewer-user",
    sessionId: "ops-reviewer-session",
    token: "ops-reviewer-token",
    email: "restricted@synthetic.test",
    name: "Synthetic Restricted",
    humanId: FIX.reviewer,
  });
  return { context, owner, member, reviewer };
}

async function csrf(
  app: { request: (request: Request, a: unknown, b: ControlBindings) => Promise<Response> },
  currentBindings: ControlBindings,
  cookie: string,
): Promise<string> {
  const response = await app.request(
    new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/session`, { headers: { cookie } }),
    undefined,
    currentBindings,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { csrf_token: string }).csrf_token;
}

function get(path: string, cookie: string): Request {
  return new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, { headers: { cookie } });
}

function mutation(
  path: string,
  cookie: string,
  csrfToken: string,
  value: unknown,
  method: "POST" | "PUT" = "POST",
): Request {
  return new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, {
    method,
    headers: {
      cookie,
      "content-type": "application/json",
      origin: AUTH_TEST_ENV.APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-bfb-csrf": csrfToken,
    },
    body: JSON.stringify(value),
  });
}

async function proofFor(
  context: AuthTestContext,
  humanId: string,
  action: string,
  targetId: string,
): Promise<string> {
  return issueStepUpProof(
    context.db,
    humanId,
    {
      action,
      workspaceId: FIX.workspace,
      targetId,
      scopes: [],
      authorizationEpoch: 1,
      expiresAt: new Date(Date.parse(NOW) + 5 * 60_000).toISOString(),
    },
    NOW,
  );
}

const OPS = `/api/v1/workspaces/${FIX.workspace}/operations`;

async function activityContextWithSession() {
  const context = openAuthTestContext(LAUNCH_NOW);
  const f = await launchFixture(context.db, { taskCreatorHumanId: FIX.member });
  const { launch, claimed } = await f.claim();
  // A bounded historical ledger fixture uses the genuine synthetic assignment;
  // these route tests certify read delivery, not live runner ingest.
  await context.db
    .prepare(
      `INSERT INTO event_ledger
     (workspace_id, event_id, workspace_cursor, source_stream_id, source_sequence,
      run_execution_id, assignment_generation, project_id, task_id, run_id,
      actor_type, actor_id, source_type, source_id, source_provider, capture_origin,
      kind, occurred_at, received_at, payload_json)
     VALUES (?, ?, 100, ?, 1, ?, ?, ?, ?, ?, 'runner', ?, 'runner', ?, 'fake',
             'runner_observed', 'heartbeat', ?, ?, '{}')`,
    )
    .run(
      FIX.workspace,
      randomUlid(),
      randomUlid(),
      claimed.specification.run_execution_id,
      claimed.specification.assignment_generation,
      FIX.projectA,
      f.task.id,
      launch.run_id,
      f.runner,
      f.runner,
      LAUNCH_NOW,
      LAUNCH_NOW,
    );
  const owner = await seedAuthSession(context, {
    humanId: FIX.owner,
    email: "owner@synthetic.test",
    now: LAUNCH_NOW,
  });
  return { context, f, launch, owner };
}

describe("operations browser routes", () => {
  it("does not expose private activity or stuck launch IDs to the workspace owner", async () => {
    const { context, f, launch, owner } = await activityContextWithSession();
    try {
      const { app, currentBindings } = appFor(context);
      const initial = await app.request(
        get(`${OPS}/activity`, owner.cookie),
        undefined,
        currentBindings,
      );
      expect(initial.status).toBe(409);
      expect(await initial.json()).toEqual({
        error: "request_rejected",
        message: "event feeds are unavailable",
      });
      await context.db
        .prepare(
          "INSERT INTO task_privacy (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(FIX.workspace, f.task.id, FIX.member, NOW);
      const activity = await app.request(
        get(`${OPS}/activity?limit=1`, owner.cookie),
        undefined,
        currentBindings,
      );
      expect(activity.status).toBe(409);
      expect(await activity.json()).toEqual({
        error: "request_rejected",
        message: "event feeds are unavailable",
      });
      for (const tail of ["queues", "health"]) {
        const response = await app.request(
          get(`${OPS}/${tail}`, owner.cookie),
          undefined,
          currentBindings,
        );
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).not.toContain(launch.launch_id);
        expect(body).not.toContain(f.task.id);
      }
    } finally {
      context.raw.close();
    }
  });

  it("holds activity before source selection after authenticated route admission", async () => {
    const { context, owner } = await activityContextWithSession();
    try {
      const db = context.db;
      let fired = false;
      context.db = {
        ...db,
        prepare(sql) {
          const statement = db.prepare(sql);
          if (!/FROM event_ledger/.test(sql)) return statement;
          return {
            ...statement,
            async all(...params) {
              if (!fired) {
                fired = true;
                await db
                  .prepare(
                    "UPDATE projects SET access_mode = 'restricted' WHERE workspace_id = ? AND id = ?",
                  )
                  .run(FIX.workspace, FIX.projectA);
                await db
                  .prepare(
                    "DELETE FROM project_access WHERE workspace_id = ? AND project_id = ? AND human_id = ?",
                  )
                  .run(FIX.workspace, FIX.projectA, FIX.owner);
              }
              return statement.all(...params);
            },
          };
        },
      };
      const { app, currentBindings } = appFor(context);
      const response = await app.request(
        get(`${OPS}/activity`, owner.cookie),
        undefined,
        currentBindings,
      );
      expect(response.status).toBe(409);
      expect(fired).toBe(false);
      expect(await response.json()).toEqual({
        error: "request_rejected",
        message: "event feeds are unavailable",
      });
    } finally {
      context.raw.close();
    }
  });

  it("keeps security audit Owner-only while activity stays role-scoped", async () => {
    const { context, owner, member, reviewer } = await contextWithSessions();
    const { app, currentBindings } = appFor(context);
    const ownerAudit = await app.request(
      get(`${OPS}/security-audit`, owner.cookie),
      undefined,
      currentBindings,
    );
    expect(ownerAudit.status).toBe(200);
    const memberAudit = await app.request(
      get(`${OPS}/security-audit`, member.cookie),
      undefined,
      currentBindings,
    );
    expect(memberAudit.status).toBe(403);
    for (const session of [owner, member, reviewer]) {
      const activity = await app.request(
        get(`${OPS}/activity`, session.cookie),
        undefined,
        currentBindings,
      );
      expect(activity.status).toBe(409);
      expect(await activity.json()).toEqual({
        error: "request_rejected",
        message: "event feeds are unavailable",
      });
      expect(activity.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("serves queues, health, and retention reads to owners and members", async () => {
    const { context, owner, member, reviewer } = await contextWithSessions();
    const { app, currentBindings } = appFor(context);
    for (const path of [`${OPS}/queues`, `${OPS}/health`, `${OPS}/retention`]) {
      expect((await app.request(get(path, owner.cookie), undefined, currentBindings)).status).toBe(
        200,
      );
      expect((await app.request(get(path, member.cookie), undefined, currentBindings)).status).toBe(
        200,
      );
      expect(
        (await app.request(get(path, reviewer.cookie), undefined, currentBindings)).status,
      ).toBe(403);
    }
    const health = (await (
      await app.request(get(`${OPS}/health`, owner.cookie), undefined, currentBindings)
    ).json()) as {
      health: { schema_version: number; retention: unknown; providers: unknown[] };
      migrations: { ok: boolean };
    };
    expect(health.health.schema_version).toBe(1);
    expect(health.migrations.ok).toBe(true);
  });

  it("changes retention only for Owners with a fresh bound proof", async () => {
    const { context, owner, member } = await contextWithSessions();
    const { app, currentBindings } = appFor(context);
    const ownerCsrf = await csrf(app, currentBindings, owner.cookie);
    const memberCsrf = await csrf(app, currentBindings, member.cookie);
    const memberProof = await proofFor(
      context,
      FIX.member,
      OPS_STEP_UP_ACTIONS.retention,
      `ops-retention:${FIX.workspace}`,
    );
    const memberDenied = await app.request(
      mutation(
        `${OPS}/retention`,
        member.cookie,
        memberCsrf,
        {
          request_id: "ops-retention-member-1",
          raw_log_retention_days: 7,
          step_up_proof_id: memberProof,
        },
        "PUT",
      ),
      undefined,
      currentBindings,
    );
    expect(memberDenied.status).toBe(403);
    const ownerProof = await proofFor(
      context,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.retention,
      `ops-retention:${FIX.workspace}`,
    );
    const changed = await app.request(
      mutation(
        `${OPS}/retention`,
        owner.cookie,
        ownerCsrf,
        {
          request_id: "ops-retention-owner-1",
          raw_log_retention_days: 7,
          step_up_proof_id: ownerProof,
        },
        "PUT",
      ),
      undefined,
      currentBindings,
    );
    expect(changed.status).toBe(200);
    const replayed = await app.request(
      mutation(
        `${OPS}/retention`,
        owner.cookie,
        ownerCsrf,
        {
          request_id: "ops-retention-owner-2",
          raw_log_retention_days: 9,
          step_up_proof_id: ownerProof,
        },
        "PUT",
      ),
      undefined,
      currentBindings,
    );
    expect(replayed.status).toBe(403);
    const wrong = await proofFor(
      context,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.recover,
      `ops-retention:${FIX.workspace}`,
    );
    const mismatched = await app.request(
      mutation(
        `${OPS}/retention`,
        owner.cookie,
        ownerCsrf,
        {
          request_id: "ops-retention-owner-3",
          raw_log_retention_days: 9,
          step_up_proof_id: wrong,
        },
        "PUT",
      ),
      undefined,
      currentBindings,
    );
    expect(mismatched.status).toBe(403);
  });

  it("holds legacy recovery without consuming proofs and retains Owner admission", async () => {
    const { context, owner, member } = await contextWithSessions();
    const { app, currentBindings } = appFor(context);
    await context.db
      .prepare(
        `INSERT INTO semantic_events (workspace_id, event_id, workspace_cursor, kind, payload_json, created_at)
         VALUES (?, '01JOPSRECOVER00000000000001', 11, 'attention.request', '{}', ?)`,
      )
      .run(FIX.workspace, NOW);
    const memberCsrf = await csrf(app, currentBindings, member.cookie);
    const memberProof = await proofFor(
      context,
      FIX.member,
      OPS_STEP_UP_ACTIONS.recover,
      `ops-recover:retry_notification_dispatch:${FIX.workspace}`,
    );
    const memberDenied = await app.request(
      mutation(`${OPS}/recovery`, member.cookie, memberCsrf, {
        request_id: "ops-recovery-member-1",
        kind: "retry_notification_dispatch",
        target: { cursors: [11] },
        step_up_proof_id: memberProof,
      }),
      undefined,
      currentBindings,
    );
    expect(memberDenied.status).toBe(403);
    const ownerCsrf = await csrf(app, currentBindings, owner.cookie);
    const firstProof = await proofFor(
      context,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.recover,
      `ops-recover:retry_notification_dispatch:${FIX.workspace}`,
    );
    const first = await app.request(
      mutation(`${OPS}/recovery`, owner.cookie, ownerCsrf, {
        request_id: "ops-recovery-owner-1",
        kind: "retry_notification_dispatch",
        target: { cursors: [11] },
        step_up_proof_id: firstProof,
      }),
      undefined,
      currentBindings,
    );
    const unavailable = { error: "request_rejected", message: "recovery kind is unavailable" };
    expect(first.status).toBe(409);
    expect(await first.json()).toEqual(unavailable);
    const secondProof = await proofFor(
      context,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.recover,
      `ops-recover:retry_notification_dispatch:${FIX.workspace}`,
    );
    const second = await app.request(
      mutation(`${OPS}/recovery`, owner.cookie, ownerCsrf, {
        request_id: "ops-recovery-owner-2",
        kind: "retry_notification_dispatch",
        target: { cursors: [11] },
        step_up_proof_id: secondProof,
      }),
      undefined,
      currentBindings,
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual(unavailable);
    const proofs = await context.db
      .prepare("SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id IN (?,?)")
      .all(firstProof, secondProof);
    expect(proofs).toEqual([{ consumed_at: null }, { consumed_at: null }]);
    const audit = (await (
      await app.request(get(`${OPS}/security-audit`, owner.cookie), undefined, currentBindings)
    ).json()) as { entries: Array<{ action: string; actor_principal_id: string }> };
    expect(
      audit.entries.some(
        (entry) => entry.action === "ops.recover" && entry.actor_principal_id === FIX.owner,
      ),
    ).toBe(false);
  });

  it("holds repeated legacy requests without replay receipts", async () => {
    const { context, owner } = await contextWithSessions();
    const { app, currentBindings } = appFor(context);
    await context.db
      .prepare(
        `INSERT INTO semantic_events (workspace_id, event_id, workspace_cursor, kind, payload_json, created_at)
         VALUES (?, '01JOPSREPLAY00000000000001', 21, 'attention.request', '{}', ?)`,
      )
      .run(FIX.workspace, NOW);
    const ownerCsrf = await csrf(app, currentBindings, owner.cookie);
    const targetId = `ops-recover:retry_notification_dispatch:${FIX.workspace}`;
    const body = {
      request_id: "ops-recovery-same-request-id",
      kind: "retry_notification_dispatch",
      target: { cursors: [21] },
    };
    const firstProof = await proofFor(context, FIX.owner, OPS_STEP_UP_ACTIONS.recover, targetId);
    const first = await app.request(
      mutation(`${OPS}/recovery`, owner.cookie, ownerCsrf, {
        ...body,
        step_up_proof_id: firstProof,
      }),
      undefined,
      currentBindings,
    );
    expect(first.status).toBe(409);
    expect(await first.json()).toEqual({
      error: "request_rejected",
      message: "recovery kind is unavailable",
    });
    const secondProof = await proofFor(context, FIX.owner, OPS_STEP_UP_ACTIONS.recover, targetId);
    const second = await app.request(
      mutation(`${OPS}/recovery`, owner.cookie, ownerCsrf, {
        ...body,
        step_up_proof_id: secondProof,
      }),
      undefined,
      currentBindings,
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: "request_rejected",
      message: "recovery kind is unavailable",
    });
    const rows = (await context.db
      .prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND action = 'ops.recover'`,
      )
      .get(FIX.workspace)) as { count: number };
    expect(rows.count).toBe(0);
  });

  it("holds admitted long request IDs uniformly across legacy targets", async () => {
    const { context, owner } = await contextWithSessions();
    const { app, currentBindings } = appFor(context);
    await context.db
      .prepare(
        `INSERT INTO semantic_events (workspace_id, event_id, workspace_cursor, kind, payload_json, created_at)
         VALUES (?, '01JOPSLONGID00000000000001', 31, 'attention.request', '{}', ?),
                (?, '01JOPSLONGID00000000000002', 32, 'attention.request', '{}', ?)`,
      )
      .run(FIX.workspace, NOW, FIX.workspace, NOW);
    const ownerCsrf = await csrf(app, currentBindings, owner.cookie);
    const targetId = `ops-recover:retry_notification_dispatch:${FIX.workspace}`;
    const requestId = `ops-recovery-${"r".repeat(115)}`;
    expect(requestId.length).toBe(128);
    for (const cursors of [[31], [32]]) {
      const proof = await proofFor(context, FIX.owner, OPS_STEP_UP_ACTIONS.recover, targetId);
      const response = await app.request(
        mutation(`${OPS}/recovery`, owner.cookie, ownerCsrf, {
          request_id: requestId,
          kind: "retry_notification_dispatch",
          target: { cursors },
          step_up_proof_id: proof,
        }),
        undefined,
        currentBindings,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "request_rejected",
        message: "recovery kind is unavailable",
      });
    }
  });

  it("keeps diagnostic inventory and consent uniformly unavailable without proof effects", async () => {
    const { context, owner, member } = await contextWithSessions();
    const { app, currentBindings } = appFor(context);
    const ownerCsrf = await csrf(app, currentBindings, owner.cookie);
    const generateProof = await proofFor(
      context,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.diagnosticGenerate,
      `diagnostic:generate:${FIX.workspace}`,
    );
    const generated = await app.request(
      mutation(`${OPS}/diagnostics`, owner.cookie, ownerCsrf, {
        request_id: "ops-diagnostic-generate-1",
        step_up_proof_id: generateProof,
      }),
      undefined,
      currentBindings,
    );
    const denied = { error: "request_rejected", message: "diagnostic bundles are unavailable" };
    expect(generated.status).toBe(409);
    expect(await generated.json()).toEqual(denied);
    const bundleId = randomUlid();
    await context.db
      .prepare(
        `INSERT INTO diagnostic_bundles
         (workspace_id,id,created_by_human_id,state,inventory_json,bundle_hash,
          redaction_status,created_at,expires_at)
         VALUES (?,?,?,'pending_consent','{}',?,'passed',?,?)`,
      )
      .run(FIX.workspace, bundleId, FIX.owner, "a".repeat(64), NOW, "2026-09-19T12:00:00Z");
    const inventory = await app.request(
      get(`${OPS}/diagnostics/${bundleId}`, member.cookie),
      undefined,
      currentBindings,
    );
    expect(inventory.status).toBe(409);
    expect(await inventory.json()).toEqual(denied);
    const consentProof = await proofFor(
      context,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.diagnosticUpload,
      `diagnostic:${bundleId}`,
    );
    const consented = await app.request(
      mutation(`${OPS}/diagnostics/${bundleId}/consent`, owner.cookie, ownerCsrf, {
        request_id: "ops-diagnostic-consent-1",
        step_up_proof_id: consentProof,
      }),
      undefined,
      currentBindings,
    );
    expect(consented.status).toBe(409);
    expect(await consented.json()).toEqual(denied);
    expect(
      await context.db
        .prepare("SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id IN (?,?)")
        .all(generateProof, consentProof),
    ).toEqual([{ consumed_at: null }, { consumed_at: null }]);
    expect(
      await context.db
        .prepare("SELECT state FROM diagnostic_bundles WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, bundleId),
    ).toEqual({ state: "pending_consent" });
    context.raw.close();
  });
});
