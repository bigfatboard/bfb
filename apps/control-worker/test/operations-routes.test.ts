// ABOUTME: Exercises X05 operations browser routes across roles and step-up states.
// ABOUTME: Security audit stays Owner-only; recovery and retention need fresh bound proofs.

import { describe, expect, it } from "vitest";

import { FIX, issueStepUpProof, OPS_STEP_UP_ACTIONS, seedSyntheticWorkspace } from "@bfb/domain";

import { parseAuthKeys } from "../src/auth/better-auth.js";
import { handleOperationsApi, type OpsBrowserDeps } from "../src/api/operations.js";
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

function mutation(path: string, cookie: string, csrfToken: string, value: unknown, method = "POST"): Request {
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

describe("operations browser routes", () => {
  it("keeps security audit Owner-only while activity stays role-scoped", async () => {
    const { context, owner, member, reviewer } = await contextWithSessions();
    const { app, currentBindings } = appFor(context);
    const ownerAudit = await app.request(get(`${OPS}/security-audit`, owner.cookie), undefined, currentBindings);
    expect(ownerAudit.status).toBe(200);
    const memberAudit = await app.request(get(`${OPS}/security-audit`, member.cookie), undefined, currentBindings);
    expect(memberAudit.status).toBe(403);
    for (const session of [owner, member, reviewer]) {
      const activity = await app.request(get(`${OPS}/activity`, session.cookie), undefined, currentBindings);
      expect(activity.status).toBe(200);
      const body = (await activity.json()) as { entries: unknown[] };
      expect(Array.isArray(body.entries)).toBe(true);
    }
  });

  it("serves queues, health, and retention reads to owners and members", async () => {
    const { context, owner, member, reviewer } = await contextWithSessions();
    const { app, currentBindings } = appFor(context);
    for (const path of [`${OPS}/queues`, `${OPS}/health`, `${OPS}/retention`]) {
      expect((await app.request(get(path, owner.cookie), undefined, currentBindings)).status).toBe(200);
      expect((await app.request(get(path, member.cookie), undefined, currentBindings)).status).toBe(200);
      expect((await app.request(get(path, reviewer.cookie), undefined, currentBindings)).status).toBe(403);
    }
    const health = (await (
      await app.request(get(`${OPS}/health`, owner.cookie), undefined, currentBindings)
    ).json()) as { health: { schema_version: number; retention: unknown; providers: unknown[] }; migrations: { ok: boolean } };
    expect(health.health.schema_version).toBe(1);
    expect(health.migrations.ok).toBe(true);
  });

  it("changes retention only for Owners with a fresh bound proof", async () => {
    const { context, owner, member } = await contextWithSessions();
    const { app, currentBindings } = appFor(context);
    const ownerCsrf = await csrf(app, currentBindings, owner.cookie);
    const memberCsrf = await csrf(app, currentBindings, member.cookie);
    const memberProof = await proofFor(context, FIX.member, OPS_STEP_UP_ACTIONS.retention, `ops-retention:${FIX.workspace}`);
    const memberDenied = await app.request(
      mutation(`${OPS}/retention`, member.cookie, memberCsrf, {
        request_id: "ops-retention-member-1",
        raw_log_retention_days: 7,
        step_up_proof_id: memberProof,
      }, "PUT"),
      undefined,
      currentBindings,
    );
    expect(memberDenied.status).toBe(403);
    const ownerProof = await proofFor(context, FIX.owner, OPS_STEP_UP_ACTIONS.retention, `ops-retention:${FIX.workspace}`);
    const changed = await app.request(
      mutation(`${OPS}/retention`, owner.cookie, ownerCsrf, {
        request_id: "ops-retention-owner-1",
        raw_log_retention_days: 7,
        step_up_proof_id: ownerProof,
      }, "PUT"),
      undefined,
      currentBindings,
    );
    expect(changed.status).toBe(200);
    const replayed = await app.request(
      mutation(`${OPS}/retention`, owner.cookie, ownerCsrf, {
        request_id: "ops-retention-owner-2",
        raw_log_retention_days: 9,
        step_up_proof_id: ownerProof,
      }, "PUT"),
      undefined,
      currentBindings,
    );
    expect(replayed.status).toBe(403);
    const wrong = await proofFor(context, FIX.owner, OPS_STEP_UP_ACTIONS.recover, `ops-retention:${FIX.workspace}`);
    const mismatched = await app.request(
      mutation(`${OPS}/retention`, owner.cookie, ownerCsrf, {
        request_id: "ops-retention-owner-3",
        raw_log_retention_days: 9,
        step_up_proof_id: wrong,
      }, "PUT"),
      undefined,
      currentBindings,
    );
    expect(mismatched.status).toBe(403);
  });

  it("runs privileged recovery idempotently and gates it to Owners", async () => {
    const { context, owner, member } = await contextWithSessions();
    const { app, currentBindings } = appFor(context);
    await context.db
      .prepare(
        `INSERT INTO semantic_events (workspace_id, event_id, workspace_cursor, kind, payload_json, created_at)
         VALUES (?, '01JOPSRECOVER00000000000001', 11, 'attention.request', '{}', ?)`,
      )
      .run(FIX.workspace, NOW);
    const memberCsrf = await csrf(app, currentBindings, member.cookie);
    const memberProof = await proofFor(context, FIX.member, OPS_STEP_UP_ACTIONS.recover, `ops-recover:retry_notification_dispatch:${FIX.workspace}`);
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
    const firstProof = await proofFor(context, FIX.owner, OPS_STEP_UP_ACTIONS.recover, `ops-recover:retry_notification_dispatch:${FIX.workspace}`);
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
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { result: { replayed: boolean } };
    expect(firstBody.result.replayed).toBe(false);
    const secondProof = await proofFor(context, FIX.owner, OPS_STEP_UP_ACTIONS.recover, `ops-recover:retry_notification_dispatch:${FIX.workspace}`);
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
    expect(second.status).toBe(200);
    expect(((await second.json()) as { result: { replayed: boolean } }).result.replayed).toBe(true);
    const audit = (await (
      await app.request(get(`${OPS}/security-audit`, owner.cookie), undefined, currentBindings)
    ).json()) as { entries: Array<{ action: string; actor_principal_id: string }> };
    expect(audit.entries.some((entry) => entry.action === "ops.recover" && entry.actor_principal_id === FIX.owner)).toBe(
      true,
    );
  });

  it("generates and consents diagnostic bundles through explicit inventory review", async () => {
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
    expect(generated.status).toBe(200);
    const created = ((await generated.json()) as { result: { id: string } }).result;
    const inventory = await app.request(get(`${OPS}/diagnostics/${created.id}`, member.cookie), undefined, currentBindings);
    expect(inventory.status).toBe(200);
    const consentProof = await proofFor(context, FIX.owner, OPS_STEP_UP_ACTIONS.diagnosticUpload, `diagnostic:${created.id}`);
    const consented = await app.request(
      mutation(`${OPS}/diagnostics/${created.id}/consent`, owner.cookie, ownerCsrf, {
        request_id: "ops-diagnostic-consent-1",
        step_up_proof_id: consentProof,
      }),
      undefined,
      currentBindings,
    );
    expect(consented.status).toBe(200);
    expect(((await consented.json()) as { bundle: { state: string } }).bundle.state).toBe("consented");
  });
});
