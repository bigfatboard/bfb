// ABOUTME: Exercises scoped operations queue and health totals through authenticated browser routes.
// ABOUTME: Exact shared source lineage and final retained observer authority fence hydrated aggregates.

import { createHash } from "node:crypto";
import type { SqlDatabase } from "@bfb/db";
import { FIX, randomUlid } from "@bfb/domain";
import { launchFixture } from "../../../packages/domain/test/launch-fixture.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createControlApp } from "../src/routes.js";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
  type AuthTestContext,
} from "./auth-helpers.js";

const NOW = "2026-10-06T12:00:00.000Z";
const OLD = "2026-08-01T12:00:00.000Z";
const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;
const BASE = `/api/v1/workspaces/${FIX.workspace}/operations`;
const SCOPE_DENIED = { error: "not_found", message: "operations scope not found" };
const EMPTY = {
  notifications: { pending: 0, dead_lettered: 0, failed: 0 },
  github_outbox: { pending: 0, dispatched_stale: 0, dlq: 0 },
  ops_recovery: { applied: 0, failed: 0 },
};
type Route = "queues" | "health";
type Actor = "owner" | "member" | "reviewer";
type QueueState = typeof EMPTY;
type Envelope = {
  ok: boolean;
  queues?: QueueState;
  stuck_uploads?: Array<{ version_id: string }>;
  stuck_launches?: Array<{ command_id: string }>;
  health?: {
    schema_version: number;
    checked_at: string;
    queues: QueueState;
    uploads: { stuck: Array<{ version_id: string }> };
    launches: { stuck: Array<{ command_id: string }> };
    retention: { eligible_chunks: number };
    tokens: { expiring_runner_tokens: number; active_api_bindings: number };
    providers: unknown[];
  };
  migrations?: { ok: boolean; missing: string[] };
};
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
  const db = context.db;
  const f = await launchFixture(db, { taskCreatorHumanId: FIX.member });
  const { launch, claimed } = await f.claim();
  const run = launch.run_id;
  const bindings = {
    DB: {},
    ARTIFACTS: {},
    ASSETS: {},
    JOBS: {},
    JOBS_DLQ: {},
    OPS_JOBS: {},
    OPS_DLQ: {},
    WORKSPACE_HUB: {},
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  } as unknown as ControlBindings;
  const app = (database = db) =>
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
  const cookies = {} as Record<Actor, string>;
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
    ["reviewer", FIX.reviewer],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `aggregate-${actor}-user`,
      sessionId: `aggregate-${actor}-session`,
      token: `aggregate-${actor}-token`,
      email: `${actor}@synthetic.test`,
      humanId,
      now: NOW,
    });
    cookies[actor] = session.cookie;
  }
  const request = (route: Route, actor: Actor = "owner", database = db, cookie = cookies[actor]) =>
    app(database).request(
      new Request(`${ORIGIN}${BASE}/${route}`, { headers: { cookie } }),
      undefined,
      bindings,
    );
  let cursor = 100;
  const event = async (
    kind = "result.fail",
    payload: unknown = { input: { runId: run }, result: { runResultState: "failed" } },
  ) => {
    const value = ++cursor;
    await db
      .prepare(
        `INSERT INTO semantic_events (workspace_id,event_id,workspace_cursor,kind,payload_json,created_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        randomUlid(),
        value,
        kind,
        typeof payload === "string" ? payload : JSON.stringify(payload),
        OLD,
      );
    return value;
  };
  const delivery = async (
    options: {
      category?: string;
      kind?: string;
      payload?: unknown;
      state?: string;
      recipient?: string;
      eventKind?: string;
    } = {},
  ) => {
    const kind = options.kind ?? "result.fail";
    const selectedCursor = await event(kind, options.payload);
    const id = randomUlid();
    await db
      .prepare(
        `INSERT INTO notification_deliveries
      (workspace_id,delivery_id,channel,human_id,event_cursor,event_kind,category,state,created_at,updated_at)
      VALUES (?,?,'browser_push',?,?,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        id,
        options.recipient ?? FIX.member,
        selectedCursor,
        options.eventKind ?? kind,
        options.category ?? "run_failed",
        options.state ?? "pending",
        OLD,
        OLD,
      );
    return { id, cursor: selectedCursor };
  };
  const version = async (state = "failed", runId: string | null = run, log = false) => {
    const id = randomUlid(),
      artifact = randomUlid();
    await db
      .prepare(
        `INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,?,'log',?,?,?)`,
      )
      .run(FIX.workspace, artifact, runId, log ? "log" : "review", FIX.member, OLD);
    await db
      .prepare(
        `INSERT INTO artifact_versions (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,content_hash,r2_key,created_at,available_at)
      VALUES (?,?,?,?,'log',3,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        id,
        artifact,
        state,
        "a".repeat(64),
        state === "available" ? "a".repeat(64) : null,
        state === "available"
          ? `workspaces/${FIX.workspace}/runs/${runId}/logs/${id}.jsonl.zst`
          : null,
        OLD,
        state === "available" ? OLD : null,
      );
    return id;
  };
  const ledger = async (kind: string, target: unknown, result: unknown, state = "applied") => {
    const targetJson = typeof target === "string" ? target : JSON.stringify(target);
    const id = `ops:${kind}:${createHash("sha256").update(targetJson).digest("hex").slice(0, 32)}`;
    await db
      .prepare(
        `INSERT INTO ops_recovery_ledger (workspace_id,action_id,kind,target_json,state,attempt_count,result_json,created_by_human_id,created_at,updated_at)
      VALUES (?,?,?,?,?,1,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        id,
        kind,
        targetJson,
        state,
        typeof result === "string" ? result : JSON.stringify(result),
        FIX.member,
        OLD,
        OLD,
      );
    return id;
  };
  let githubReady = false;
  const github = async (
    options: {
      event?: string;
      action?: string | null;
      effect?: unknown;
      state?: string;
      evidence?: boolean;
      dlqKind?: string;
      dlqDelivery?: string;
    } = {},
  ) => {
    if (!githubReady) {
      await db
        .prepare(
          `INSERT INTO github_app_installations
        (workspace_id,installation_id,app_id,app_slug,account_id,account_login,account_type,status,permissions_json,events_json,created_at,updated_at,resource_version)
        VALUES (?,'1234','1','synthetic','2','synthetic','Organization','active','{}','[]',?,?,1)`,
        )
        .run(FIX.workspace, OLD, OLD);
      await db
        .prepare(
          `INSERT INTO github_repository_links
        (workspace_id,id,repository_id,installation_id,project_id,full_name,default_branch,link_state,created_at,resource_version)
        VALUES (?,?,'9876','1234',?,'synthetic/repo','main','active',?,1)`,
        )
        .run(FIX.workspace, randomUlid(), FIX.projectA, OLD);
      githubReady = true;
    }
    if (options.evidence !== false) {
      for (const [kind, ref] of [
        ["branch", "refs/heads/main"],
        ["commit", "synthetic-commit"],
      ]) {
        await db
          .prepare(
            `INSERT OR IGNORE INTO github_evidence
          (workspace_id,id,project_id,task_id,repository_id,kind,ref,version_token,state_json,observed_by,observed_at,resource_version)
          VALUES (?,?,?,?,'9876',?,?,'newer-evidence-version','{}','github',?,1)`,
          )
          .run(FIX.workspace, randomUlid(), FIX.projectA, f.task.id, kind, ref, OLD);
      }
    }
    const effect = options.effect ?? {
      event: "push",
      action: null,
      installationId: "1234",
      repositoryId: "9876",
      occurredAt: OLD,
      ref: "refs/heads/main",
      version: "synthetic-commit",
      detail: {},
    };
    const outbox = randomUlid(),
      deliveryId = randomUlid();
    await db
      .prepare(
        `INSERT INTO github_webhook_deliveries
      (workspace_id,delivery_id,event,action,installation_id,repository_id,effect_json,state,received_at)
      VALUES (?,?,?,?,?,?,?,'received',?)`,
      )
      .run(
        FIX.workspace,
        deliveryId,
        options.event ?? "push",
        options.action === undefined ? null : options.action,
        "1234",
        options.event === "installation" ? null : "9876",
        typeof effect === "string" ? effect : JSON.stringify(effect),
        OLD,
      );
    await db
      .prepare(
        `INSERT INTO github_integration_outbox
      (workspace_id,outbox_id,delivery_id,kind,state,attempts,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,'github.reconcile',?,0,?,?,?)`,
      )
      .run(FIX.workspace, outbox, deliveryId, options.state ?? "pending", OLD, OLD, OLD);
    if (options.state === "dlq")
      await db
        .prepare(
          `INSERT INTO github_dlq (workspace_id,outbox_id,delivery_id,kind,error,attempts,created_at)
      VALUES (?,?,?,?,'synthetic',1,?)`,
        )
        .run(
          FIX.workspace,
          outbox,
          options.dlqDelivery ?? deliveryId,
          options.dlqKind ?? "github.reconcile",
          OLD,
        );
    return outbox;
  };
  const privacy = () =>
    db
      .prepare(
        `INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)`,
      )
      .run(FIX.workspace, f.task.id, FIX.member, NOW);
  const revokeProject = (human = FIX.owner) =>
    db
      .prepare(`UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?`)
      .run(FIX.workspace, FIX.projectA)
      .then(() =>
        db
          .prepare(
            `DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?`,
          )
          .run(FIX.workspace, FIX.projectA, human),
      );
  const populate = async () => {
    const notification = await delivery();
    await delivery({ state: "dead_lettered" });
    await delivery({ state: "failed" });
    const outbox = await github();
    await github({ state: "dispatched" });
    await github({ state: "dlq" });
    const failed = await version();
    await ledger("resolve_stuck_upload", { version_ids: [failed] }, { resolved: 1 });
    await ledger(
      "retry_notification_dispatch",
      { cursors: [notification.cursor, notification.cursor] },
      { redispatched_from: notification.cursor - 1, cursors: 2 },
    );
    await ledger("requeue_github_outbox", { outbox_ids: [outbox, outbox] }, { requeued: 2 });
    const upload = await version("uploading");
    const retained = await version("available", run, true);
    return { upload, retained, failed, notification, outbox };
  };
  const attention = async () => {
    const id = randomUlid();
    await db
      .prepare(
        `INSERT INTO attention_requests
      (workspace_id,id,project_id,task_id,run_id,run_execution_id,assignment_generation,kind,required_role,question,blocking,state,requested_at,resource_version)
      VALUES (?,?,?,?,?,?,?,'clarification','reviewer','Synthetic answered history',0,'answered',?,2)`,
      )
      .run(
        FIX.workspace,
        id,
        FIX.projectA,
        f.task.id,
        run,
        claimed.specification.run_execution_id,
        claimed.specification.assignment_generation,
        OLD,
      );
    return id;
  };
  const submission = async () => {
    const id = randomUlid();
    await db
      .prepare(
        `INSERT INTO result_submissions
      (workspace_id,id,run_id,version,summary,evidence_refs_json,config_snapshot_id,config_hash,submitted_by_kind,submitted_by_id,submitted_at)
      VALUES (?,?,?,1,'Synthetic result','[]',?,?,'human',?,?)`,
      )
      .run(
        FIX.workspace,
        id,
        run,
        claimed.specification.config_snapshot_id,
        claimed.specification.config_snapshot_hash,
        FIX.member,
        OLD,
      );
    return id;
  };
  return {
    db,
    f,
    run,
    launch,
    request,
    cookies,
    delivery,
    event,
    version,
    ledger,
    github,
    privacy,
    revokeProject,
    populate,
    attention,
    submission,
  };
}

/** Mutates after an actual awaited hydration result, without replacing domain selection. */
function afterHydration(db: SqlDatabase, route: Route, change: () => Promise<unknown>) {
  let fired = false;
  const wrapped: SqlDatabase = {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      const selected =
        route === "queues"
          ? /SELECT launch\.id AS command_id/.test(sql)
          : /SELECT revision, inventory_json, received_at FROM runner_inventories/.test(sql);
      if (!selected) return statement;
      const mutate = async () => {
        if (!fired) {
          fired = true;
          await change();
        }
      };
      return {
        ...statement,
        async all(...params) {
          const rows = await statement.all(...params);
          await mutate();
          return rows;
        },
        async get(...params) {
          const row = await statement.get(...params);
          await mutate();
          return row;
        },
      };
    },
  };
  return { db: wrapped, fired: () => fired };
}
function queues(body: Envelope) {
  return body.health?.queues ?? body.queues;
}
function uploads(body: Envelope) {
  return body.health?.uploads.stuck ?? body.stuck_uploads;
}
function launches(body: Envelope) {
  return body.health?.launches.stuck ?? body.stuck_launches;
}
async function rotateEpoch(db: SqlDatabase) {
  await db
    .prepare(
      `UPDATE workspace_members SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?`,
    )
    .run(FIX.workspace, FIX.owner);
  await db
    .prepare(
      `UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?`,
    )
    .run(FIX.workspace, FIX.owner);
}

describe.each(["queues", "health"] as const)("scoped mounted operations %s", (route) => {
  it("preserves the shared wire and counts each exact supported source once", async () => {
    const f = await fixture(),
      source = await f.populate();
    const response = await f.request(route);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope;
    expect(queues(body)).toEqual({
      notifications: { pending: 1, dead_lettered: 1, failed: 1 },
      github_outbox: { pending: 1, dispatched_stale: 1, dlq: 1 },
      ops_recovery: { applied: 3, failed: 0 },
    });
    expect(uploads(body)?.map((row) => row.version_id)).toEqual([source.upload]);
    expect(launches(body)?.map((row) => row.command_id)).toEqual([f.launch.launch_id]);
    if (route === "health") {
      expect(body.health).toMatchObject({
        schema_version: 1,
        checked_at: NOW,
        retention: { eligible_chunks: 1 },
        tokens: { expiring_runner_tokens: 1, active_api_bindings: 0 },
      });
      expect(body.migrations).toEqual({ ok: true, missing: [] });
    } else
      expect(Object.keys(body).sort()).toEqual(["ok", "queues", "stuck_launches", "stuck_uploads"]);
  });

  for (const actor of ["owner", "member"] as const)
    it(`omits private sources even for ${actor === "member" ? "their creator" : "an Owner edit grantee"}`, async () => {
      const f = await fixture();
      await f.populate();
      await f.privacy();
      if (actor === "owner")
        await f.db
          .prepare(
            `INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,permission,authorization_epoch,created_at) VALUES (?,?,?,?,'edit',1,?)`,
          )
          .run(FIX.workspace, randomUlid(), f.f.task.id, FIX.owner, NOW);
      const response = await f.request(route, actor);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Envelope;
      expect(queues(body)).toEqual(EMPTY);
      expect(uploads(body)).toEqual([]);
      expect(launches(body)).toEqual([]);
      if (route === "health") expect(body.health?.retention.eligible_chunks).toBe(0);
    });

  it("omits project-hidden sources without denying the whole route", async () => {
    const f = await fixture();
    await f.populate();
    await f.revokeProject();
    const response = await f.request(route);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope;
    expect(queues(body)).toEqual(EMPTY);
    expect(uploads(body)).toEqual([]);
    expect(launches(body)).toEqual([]);
  });

  for (const change of ["private", "project"] as const)
    it(`remasks totals and work together after late ${change} loss during hydration`, async () => {
      const f = await fixture();
      await f.populate();
      const boundary = afterHydration(f.db, route, () =>
        change === "private" ? f.privacy() : f.revokeProject(),
      );
      const response = await f.request(route, "owner", boundary.db);
      expect(response.status).toBe(200);
      expect(boundary.fired()).toBe(true);
      const body = (await response.json()) as Envelope;
      expect(queues(body)).toEqual(EMPTY);
      expect(uploads(body)).toEqual([]);
      expect(launches(body)).toEqual([]);
      if (route === "health") expect(body.health?.retention.eligible_chunks).toBe(0);
    });

  for (const change of ["notification", "github", "recovery"] as const)
    it(`reselects ${change} source validity after awaited hydration`, async () => {
      const f = await fixture();
      const source = await f.populate();
      const boundary = afterHydration(f.db, route, async () => {
        if (change === "notification")
          return f.db
            .prepare(
              `UPDATE semantic_events SET payload_json=? WHERE workspace_id=? AND workspace_cursor=?`,
            )
            .run(
              JSON.stringify({
                input: { runId: randomUlid() },
                result: { runResultState: "failed" },
              }),
              FIX.workspace,
              source.notification.cursor,
            );
        if (change === "github")
          return f.db
            .prepare(
              `UPDATE github_webhook_deliveries SET action='unsupported' WHERE workspace_id=? AND delivery_id=(SELECT delivery_id FROM github_integration_outbox WHERE workspace_id=? AND outbox_id=?)`,
            )
            .run(FIX.workspace, FIX.workspace, source.outbox);
        return f.db
          .prepare(
            `UPDATE ops_recovery_ledger SET result_json='{"resolved":2}' WHERE workspace_id=? AND kind='resolve_stuck_upload'`,
          )
          .run(FIX.workspace);
      });
      const response = await f.request(route, "owner", boundary.db);
      expect(response.status).toBe(200);
      expect(boundary.fired()).toBe(true);
      const body = (await response.json()) as Envelope;
      expect(queues(body)).toEqual({
        notifications: { pending: change === "notification" ? 0 : 1, dead_lettered: 1, failed: 1 },
        github_outbox: { pending: change === "github" ? 0 : 1, dispatched_stale: 1, dlq: 1 },
        ops_recovery: { applied: 2, failed: 0 },
      });
    });

  for (const empty of [false, true])
    for (const change of ["epoch", "role", "revoked"] as const)
      it(`denies late ${change} loss after hydration with ${empty ? "empty" : "populated"} sources`, async () => {
        const f = await fixture();
        if (empty)
          await f.db
            .prepare(`UPDATE launch_commands SET state='started' WHERE workspace_id=? AND id=?`)
            .run(FIX.workspace, f.launch.launch_id);
        else await f.populate();
        const boundary = afterHydration(f.db, route, async () => {
          if (change === "epoch") return rotateEpoch(f.db);
          if (change === "revoked")
            return f.db
              .prepare(
                `UPDATE workspace_authorization_epochs SET revoked_at=? WHERE workspace_id=? AND human_id=?`,
              )
              .run(NOW, FIX.workspace, FIX.owner);
          await f.db
            .prepare(
              `UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND human_id=?`,
            )
            .run(FIX.workspace, FIX.member);
          return f.db
            .prepare(
              `UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?`,
            )
            .run(FIX.workspace, FIX.owner);
        });
        const response = await f.request(route, "owner", boundary.db);
        expect(boundary.fired()).toBe(true);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual(SCOPE_DENIED);
      });

  it("counts historical notifications for another removed recipient with disabled preference", async () => {
    const f = await fixture();
    const id = await f.attention();
    await f.delivery({
      category: "attention",
      kind: "attention.request",
      payload: { input: {}, result: { id, state: "open" } },
    });
    await f.db
      .prepare(`DELETE FROM project_access WHERE workspace_id=? AND human_id=?`)
      .run(FIX.workspace, FIX.member);
    await f.db
      .prepare(`DELETE FROM workspace_members WHERE workspace_id=? AND human_id=?`)
      .run(FIX.workspace, FIX.member);
    await f.db
      .prepare(`INSERT INTO notification_preferences VALUES (?,?,?,'browser_push','attention',0,?)`)
      .run(FIX.workspace, FIX.member, FIX.projectA, NOW);
    const response = await f.request(route);
    expect(response.status).toBe(200);
    expect(queues((await response.json()) as Envelope)?.notifications.pending).toBe(1);
  });

  for (const category of [
    "attention",
    "launch_blocked",
    "result_submitted",
    "result_changes_requested",
    "result_accepted",
    "run_failed",
    "run_cancelled",
  ] as const)
    it(`counts exact ${category} retained child history`, async () => {
      const f = await fixture();
      let kind: string = "result.fail",
        payload: unknown = { input: { runId: f.run }, result: { runResultState: "failed" } };
      if (category === "attention") {
        kind = "attention.request";
        payload = { input: {}, result: { id: await f.attention(), state: "open" } };
      }
      if (category === "launch_blocked") {
        kind = "launch.authorize";
        payload = {
          input: { launchId: f.launch.launch_id },
          result: {
            launch_id: f.launch.launch_id,
            decision: "rejected",
            rejection: { code: "launch_expired" },
          },
        };
      }
      if (category === "result_submitted") {
        kind = "result.submit";
        payload = {
          input: { runId: f.run },
          result: {
            taskState: "review",
            submission: { id: await f.submission(), run_id: f.run, version: 1 },
          },
        };
      }
      if (category === "result_changes_requested" || category === "result_accepted") {
        kind = category === "result_accepted" ? "result.accept" : "result.request_changes";
        payload = {
          input: { runId: f.run, submissionId: await f.submission() },
          result: {
            runResultState: category === "result_accepted" ? "accepted" : "changes_requested",
          },
        };
      }
      if (category === "run_cancelled") {
        kind = "result.cancel";
        payload = { input: { runId: f.run }, result: { runResultState: "cancelled" } };
      }
      await f.delivery({ category, kind, payload });
      const response = await f.request(route);
      expect(response.status).toBe(200);
      expect(queues((await response.json()) as Envelope)?.notifications.pending).toBe(1);
    });

  for (const invalid of [
    "fallback",
    "event-kind",
    "category",
    "serialized",
    "duplicate",
    "nul",
    "wrong-state",
  ] as const)
    it(`excludes notification source with ${invalid} instead of guessing lineage`, async () => {
      const f = await fixture();
      const payload = { input: { runId: f.run }, result: { runResultState: "failed" } };
      await f.delivery({
        ...(invalid === "event-kind" ? { eventKind: "result.cancel" } : {}),
        ...(invalid === "category" ? { category: "run_cancelled" } : {}),
        payload:
          invalid === "fallback"
            ? {
                input: { runId: randomUlid() },
                result: { runResultState: "failed", run_id: f.run },
              }
            : invalid === "serialized"
              ? { input: JSON.stringify(payload.input), result: payload.result }
              : invalid === "duplicate"
                ? `{"input":{"runId":"${f.run}","runId":"${f.run}"},"result":{"runResultState":"failed"}}`
                : invalid === "nul"
                  ? { input: { runId: f.run + "\0synthetic" }, result: payload.result }
                  : invalid === "wrong-state"
                    ? { input: payload.input, result: { runResultState: "cancelled" } }
                    : payload,
      });
      const response = await f.request(route);
      expect(response.status).toBe(200);
      expect(queues((await response.json()) as Envelope)).toEqual(EMPTY);
    });

  for (const invalid of [
    "unsupported",
    "event-mismatch",
    "action-mismatch",
    "serialized",
    "duplicate",
    "nul",
    "wrong-installation",
    "dlq-kind",
    "dlq-delivery",
  ] as const)
    it(`excludes GitHub ${invalid} source from pending and DLQ totals`, async () => {
      const f = await fixture();
      const effect = {
        event: "push",
        action: null,
        installationId: "1234",
        repositoryId: "9876",
        occurredAt: OLD,
        ref: "refs/heads/main",
        version: "synthetic-commit",
        detail: {},
      };
      await f.github({
        state: invalid.startsWith("dlq") ? "dlq" : "pending",
        ...(invalid === "unsupported"
          ? {
              event: "installation_repositories",
              effect: { ...effect, event: "installation_repositories" },
            }
          : invalid === "event-mismatch"
            ? { event: "issues" }
            : invalid === "action-mismatch"
              ? { action: "opened" }
              : invalid === "serialized"
                ? { effect: JSON.stringify(JSON.stringify(effect)) }
                : invalid === "duplicate"
                  ? {
                      effect: JSON.stringify(effect).replace(
                        '"repositoryId":"9876"',
                        '"repositoryId":"9876","repositoryId":"9876"',
                      ),
                    }
                  : invalid === "nul"
                    ? { effect: { ...effect, repositoryId: "9876\0synthetic" } }
                    : invalid === "wrong-installation"
                      ? { effect: { ...effect, installationId: "5678" } }
                      : invalid === "dlq-kind"
                        ? { dlqKind: "unrecognized" }
                        : { dlqDelivery: randomUlid() }),
      });
      const response = await f.request(route);
      expect(response.status).toBe(200);
      expect(queues((await response.json()) as Envelope)).toEqual(EMPTY);
    });

  it("retains project-only queued GitHub work without requiring evidence or latest version equality", async () => {
    const f = await fixture();
    await f.github({ evidence: false });
    const response = await f.request(route);
    expect(response.status).toBe(200);
    expect(queues((await response.json()) as Envelope)?.github_outbox.pending).toBe(1);
  });
  for (const status of ["pending", "suspended", "revoked"] as const)
    it(`counts pure installation lifecycle history for a ${status} installation`, async () => {
      const f = await fixture();
      await f.github({
        event: "installation",
        action: "deleted",
        evidence: false,
        effect: {
          event: "installation",
          action: "deleted",
          installationId: "1234",
          repositoryId: null,
          occurredAt: OLD,
          ref: null,
          version: null,
          detail: {},
        },
      });
      await f.db
        .prepare(
          `UPDATE github_app_installations SET status=? WHERE workspace_id=? AND installation_id='1234'`,
        )
        .run(status, FIX.workspace);
      const response = await f.request(route);
      expect(response.status).toBe(200);
      expect(queues((await response.json()) as Envelope)?.github_outbox.pending).toBe(1);
    });

  for (const invalid of [
    "failed",
    "cleared",
    "mixed-hidden",
    "mixed-missing",
    "count",
    "serialized",
    "duplicate",
    "empty",
  ] as const)
    it(`excludes ${invalid} applied recovery history without partial counts`, async () => {
      const f = await fixture();
      const version = await f.version();
      let ids = [version];
      if (invalid === "mixed-hidden") {
        const hiddenTask = randomUlid(),
          hiddenRun = randomUlid();
        await f.db
          .prepare(
            `INSERT INTO tasks (workspace_id,id,project_id,title,state,priority,next_owner_type,punchline,created_by_human_id,created_at)
          VALUES (?,?,?,'Synthetic hidden recovery work','ready','P2','unassigned','Synthetic hidden recovery work',?,?)`,
          )
          .run(FIX.workspace, hiddenTask, FIX.projectA, FIX.member, OLD);
        await f.db
          .prepare(
            `INSERT INTO runs (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,created_at)
          VALUES (?,?,?,?,?,?,'open','unknown',?)`,
          )
          .run(
            FIX.workspace,
            hiddenRun,
            FIX.projectA,
            hiddenTask,
            FIX.member,
            FIX.profileCodex,
            OLD,
          );
        await f.db
          .prepare(
            `INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)`,
          )
          .run(FIX.workspace, hiddenTask, FIX.member, NOW);
        const hidden = await f.version("failed", hiddenRun);
        ids.push(hidden);
      }
      if (invalid === "mixed-missing") ids.push(randomUlid());
      if (invalid === "empty") ids = [];
      const target = { version_ids: ids };
      await f.ledger(
        invalid === "cleared" ? "clear_recovery_state" : "resolve_stuck_upload",
        invalid === "cleared"
          ? { action_ids: ["synthetic-cleared"] }
          : invalid === "serialized"
            ? JSON.stringify(JSON.stringify(target))
            : invalid === "duplicate"
              ? `{"version_ids":["${version}"],"version_ids":["${version}"]}`
              : target,
        invalid === "cleared" ? { cleared: 1 } : { resolved: invalid === "count" ? 2 : ids.length },
        invalid === "failed" ? "failed" : "applied",
      );
      const response = await f.request(route);
      expect(response.status).toBe(200);
      expect(queues((await response.json()) as Envelope)).toEqual(EMPTY);
    });

  it("allows shared run-free failed upload history but does not invent a task association", async () => {
    const f = await fixture();
    const version = await f.version("failed", null);
    await f.ledger("resolve_stuck_upload", { version_ids: [version] }, { resolved: 1 });
    await f.privacy();
    const response = await f.request(route);
    expect(response.status).toBe(200);
    expect(queues((await response.json()) as Envelope)?.ops_recovery.applied).toBe(1);
  });
  it("requires the designated cookie and preserves reviewer denial", async () => {
    const f = await fixture();
    expect((await f.request(route, "reviewer")).status).toBe(403);
    expect((await f.request(route, "owner", f.db, "")).status).toBe(401);
  });
});

it("selects health token counts after provider hydration rather than returning an earlier token count", async () => {
  const f = await fixture();
  const boundary = afterHydration(f.db, "health", () =>
    f.db
      .prepare(`UPDATE runner_tokens SET revoked_at=? WHERE workspace_id=? AND id=?`)
      .run(NOW, FIX.workspace, f.f.principal.tokenId),
  );
  const response = await f.request("health", "owner", boundary.db);
  expect(response.status).toBe(200);
  expect(boundary.fired()).toBe(true);
  expect(((await response.json()) as Envelope).health?.tokens).toEqual({
    expiring_runner_tokens: 0,
    active_api_bindings: 0,
  });
});
