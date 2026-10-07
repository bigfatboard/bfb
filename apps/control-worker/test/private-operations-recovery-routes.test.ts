// ABOUTME: Exercises current human retention and atomic stuck-upload recovery through mounted browser routes.
// ABOUTME: Synthetic parent and credential races distinguish committed effects from authorized response delivery.

import type { SqlDatabase } from "@bfb/db";
import {
  createTaskCommand,
  FIX,
  issueStepUpProof,
  randomUlid,
  seedSyntheticWorkspace,
  WorkspaceHub,
} from "@bfb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { success } from "../../../packages/domain/test/launch-fixture.js";
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

const NOW = "2026-10-06T12:00:00.000Z";
const OLD = "2026-08-01T12:00:00.000Z";
const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;
const BASE = `/api/v1/workspaces/${FIX.workspace}/operations`;
const DENIED = { error: "not_found", message: "upload recovery target not found" };
const contexts: AuthTestContext[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  contexts.splice(0).forEach((context) => context.raw.close());
  vi.useRealTimers();
});

type Actor = "owner" | "member" | "reviewer";
type HubEnvelope = {
  commandName: string;
  request: { idempotencyKey: string; authorizationEpoch: number; input: unknown };
};
async function fixture() {
  const context = openAuthTestContext(NOW);
  contexts.push(context);
  const db = context.db;
  await seedSyntheticWorkspace(db, NOW);
  const clock = (await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").get()) as {
    now: string;
  };
  const recoveryNow = clock.now;
  const hub = new WorkspaceHub(db);
  const task = success(
    await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title: "Synthetic recovery work", priority: "P2" },
    }),
  );
  const run = randomUlid();
  await db
    .prepare(
      `INSERT INTO runs (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,created_at)
    VALUES (?,?,?,?,?,?,'open','unknown',?)`,
    )
    .run(FIX.workspace, run, FIX.projectA, task.id, FIX.member, FIX.profileCodex, OLD);
  const calls: HubEnvelope[] = [];
  let beforeHub: (() => Promise<void>) | undefined;
  let afterHub: (() => Promise<void>) | undefined;
  const baseNs = createTestWorkspaceHubNamespace(db);
  const ns = {
    ...baseNs,
    get(id: DurableObjectId) {
      const stub = baseNs.get(id);
      return {
        ...stub,
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          calls.push(JSON.parse(String(init?.body)) as HubEnvelope);
          await beforeHub?.();
          const response = await stub.fetch(input, init);
          await afterHub?.();
          return response;
        },
      } as DurableObjectStub;
    },
    jurisdiction() {
      return ns as DurableObjectNamespace;
    },
  } as unknown as DurableObjectNamespace;
  const bindings = {
    DB: {},
    ARTIFACTS: {},
    ASSETS: {},
    JOBS: {},
    JOBS_DLQ: {},
    OPS_JOBS: {},
    OPS_DLQ: {},
    WORKSPACE_HUB: ns,
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  } as unknown as ControlBindings;
  const app = (database = db, observedAt = NOW) =>
    createControlApp(validateControlEnv(bindings), {
      db: database,
      now: observedAt,
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
    ["reviewer", FIX.reviewer],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `recovery-${actor}-user`,
      sessionId: `recovery-${actor}-session`,
      token: `recovery-${actor}-token`,
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
  const request = async (
    tail: string,
    actor: Actor = "owner",
    body?: Record<string, unknown>,
    database = db,
    headers: Record<string, string> = {},
  ) => {
    const recovery = tail === "/recovery" && body !== undefined;
    const saved = new Date();
    const observedAt = recovery ? recoveryNow : NOW;
    // Keep historical read views unchanged while the action-bound recovery
    // operation and Hub authorizer observe its locally captured SQL time.
    if (recovery) vi.setSystemTime(observedAt);
    try {
      return await app(database, observedAt).request(
        new Request(ORIGIN + BASE + tail, {
          method: body ? "POST" : "GET",
          headers: {
            cookie: actors[actor].cookie,
            ...(body
              ? {
                  "content-type": "application/json",
                  origin: ORIGIN,
                  "sec-fetch-site": "same-origin",
                  "x-bfb-csrf": actors[actor].csrf,
                }
              : {}),
            ...headers,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        undefined,
        bindings,
      );
    } finally {
      if (recovery) vi.setSystemTime(saved);
    }
  };
  const upload = async (
    state: "uploading" | "available" = "uploading",
    runId: string | null = run,
    createdAt = OLD,
    key?: string,
  ) => {
    const artifact = randomUlid(),
      version = randomUlid();
    const r2Key = key ?? `workspaces/${FIX.workspace}/runs/${runId}/logs/${version}.jsonl.zst`;
    await db
      .prepare(
        `INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at)
      VALUES (?,?,?,'log','log',?,?)`,
      )
      .run(FIX.workspace, artifact, runId, FIX.member, createdAt);
    await db
      .prepare(
        `INSERT INTO artifact_versions (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,content_hash,r2_key,created_at,available_at)
      VALUES (?,?,?,?,'log',64,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        version,
        artifact,
        state,
        "f".repeat(64),
        state === "available" ? "f".repeat(64) : null,
        state === "available" ? r2Key : null,
        createdAt,
        state === "available" ? createdAt : null,
      );
    return version;
  };
  const proof = (
    humanId = FIX.owner,
    action = "ops.recover",
    targetId = `ops-recover:resolve_stuck_upload:${FIX.workspace}`,
  ) =>
    issueStepUpProof(
      db,
      humanId,
      {
        action,
        workspaceId: FIX.workspace,
        targetId,
        scopes: [],
        authorizationEpoch: 1,
        expiresAt: new Date(Date.parse(recoveryNow) + 5 * 60_000).toISOString(),
      },
      recoveryNow,
    );
  const body = (
    versionIds: string[],
    proofId: string,
    requestId = "synthetic-recovery-request",
  ) => ({
    request_id: requestId,
    kind: "resolve_stuck_upload",
    target: { version_ids: versionIds },
    step_up_proof_id: proofId,
  });
  const privacy = () =>
    db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, task.id, FIX.member, NOW);
  const rotate = async () => {
    await db
      .prepare(
        "UPDATE workspace_members SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
      )
      .run(FIX.workspace, FIX.owner);
    await db
      .prepare(
        "UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
      )
      .run(FIX.workspace, FIX.owner);
  };
  const restrict = async () => {
    await db
      .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
      .run(FIX.workspace, FIX.projectA);
    await db
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .run(FIX.workspace, FIX.projectA, FIX.owner);
  };
  const demote = async (role = "member") => {
    await db
      .prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.member);
    await db
      .prepare("UPDATE workspace_members SET role=? WHERE workspace_id=? AND human_id=?")
      .run(role, FIX.workspace, FIX.owner);
  };
  const effects = async () => ({
    ledger: (
      (await db
        .prepare("SELECT COUNT(*) AS count FROM ops_recovery_ledger WHERE workspace_id=?")
        .get(FIX.workspace)) as { count: number }
    ).count,
    abandonment: (
      (await db
        .prepare(
          "SELECT COUNT(*) AS count FROM artifact_audit_outbox WHERE workspace_id=? AND action='artifact.abandoned'",
        )
        .get(FIX.workspace)) as { count: number }
    ).count,
  });
  return {
    context,
    db,
    task,
    run,
    recoveryNow,
    calls,
    actors,
    request,
    upload,
    proof,
    body,
    privacy,
    rotate,
    restrict,
    demote,
    effects,
    hookBefore: (change: () => Promise<void>) => {
      beforeHub = change;
    },
    hookAfter: (change: () => Promise<void>) => {
      afterHub = change;
    },
  };
}
function beforeRead(db: SqlDatabase, match: RegExp, change: () => Promise<void>): SqlDatabase {
  let fired = false;
  return {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!match.test(sql)) return statement;
      const invoke = async () => {
        if (!fired) {
          fired = true;
          await change();
        }
      };
      return {
        ...statement,
        async all(...params) {
          await invoke();
          return statement.all(...params);
        },
        async get(...params) {
          await invoke();
          return statement.get(...params);
        },
      };
    },
  };
}

describe("private operations retention browser delivery", () => {
  it("does not admit unauthenticated retention readers or credential substitution", async () => {
    const f = await fixture();
    expect((await f.request("/retention", "owner", undefined, f.db, { cookie: "" })).status).toBe(
      401,
    );
    expect(
      (
        await f.request("/retention", "owner", undefined, f.db, {
          authorization: "Bearer synthetic",
        })
      ).status,
    ).toBe(401);
    expect((await f.request("/retention", "reviewer")).status).toBe(403);
  });
  it.each(["owner", "member"] as const)(
    "retains the response shape and canonical authorized counts for %s",
    async (actor) => {
      const f = await fixture(),
        version = await f.upload("available");
      const response = await f.request("/retention", actor);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        policy: null,
        eligible: { days: 30, examined: 1, eligible: [{ version_id: version, run_id: f.run }] },
      });
    },
  );
  it("omits private logs even for creator and named grantee without revealing counts", async () => {
    const f = await fixture();
    await f.upload("available");
    await f.privacy();
    await f.db
      .prepare(
        "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'edit',?)",
      )
      .run(FIX.workspace, randomUlid(), f.task.id, FIX.owner, NOW);
    for (const actor of ["owner", "member"] as const) {
      const response = await f.request("/retention", actor);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ eligible: { examined: 0, eligible: [] } });
      expect(await f.effects()).toEqual({ ledger: 0, abandonment: 0 });
    }
  });
  it("excludes run-free, dangling and noncanonical keys before counts", async () => {
    const f = await fixture(),
      visible = await f.upload("available");
    await f.upload("available", null);
    await f.upload("available", randomUlid());
    await f.upload(
      "available",
      f.run,
      OLD,
      `workspaces/${FIX.workspace}/runs/${f.run}/logs/wrong-version.jsonl.zst`,
    );
    await f.upload(
      "available",
      f.run,
      OLD,
      `workspaces/${randomUlid()}/runs/${f.run}/logs/foreign.jsonl.zst`,
    );
    const response = await f.request("/retention");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      eligible: { examined: 1, eligible: [{ version_id: visible }] },
    });
  });
  it("returns the policy captured with the candidate cutoff rather than an earlier policy read", async () => {
    const f = await fixture();
    await f.upload("available");
    let changed = false;
    const db: SqlDatabase = {
      ...f.db,
      prepare(sql) {
        const statement = f.db.prepare(sql);
        if (!/FROM retention_policies/.test(sql)) return statement;
        return {
          ...statement,
          async get(...params) {
            const observed = await statement.get(...params);
            if (!changed) {
              changed = true;
              await f.db
                .prepare(
                  `INSERT INTO retention_policies
        (workspace_id,raw_log_retention_days,version,updated_by_human_id,updated_at)
        VALUES (?,90,1,?,?)`,
                )
                .run(FIX.workspace, FIX.owner, NOW);
            }
            return observed;
          },
        };
      },
    };
    const response = await f.request("/retention", "owner", undefined, db);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      policy: null,
      eligible: {
        days: 30,
        cutoff: "2026-09-06T12:00:00.000Z",
        examined: 1,
        eligible: [expect.any(Object)],
      },
    });
  });
  it.each(["epoch", "project", "role"] as const)(
    "checks retained %s authority in the final candidate selection",
    async (loss) => {
      const f = await fixture();
      await f.upload("available");
      const db = beforeRead(f.db, /FROM artifact_versions AS v/, async () => {
        if (loss === "epoch") await f.rotate();
        else if (loss === "project") await f.restrict();
        else await f.demote("reviewer");
      });
      const response = await f.request("/retention", "owner", undefined, db);
      if (loss === "project") {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ eligible: { examined: 0, eligible: [] } });
      } else {
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          error: "not_found",
          message: "operations scope not found",
        });
      }
    },
  );
  it.each(["epoch", "role"] as const)(
    "rechecks %s scope even with no candidate references",
    async (loss) => {
      const f = await fixture();
      const db = beforeRead(f.db, /FROM artifact_versions AS v/, async () => {
        if (loss === "epoch") await f.rotate();
        else await f.demote("reviewer");
      });
      const response = await f.request("/retention", "owner", undefined, db);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "not_found",
        message: "operations scope not found",
      });
    },
  );
});

describe("private operations recovery browser command", () => {
  it("dispatches the exact namespace command and writes one atomic audit rather than a legacy audit", async () => {
    const f = await fixture(),
      version = await f.upload(),
      proof = await f.proof();
    const response = await f.request("/recovery", "owner", f.body([version], proof));
    expect(response.status).toBe(200);
    const delivered = await response.json();
    expect(Object.keys(delivered as object).sort()).toEqual(["ok", "result"]);
    expect(delivered).toMatchObject({
      ok: true,
      result: { kind: "resolve_stuck_upload", replayed: false, detail: { resolved: 1 } },
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({
      commandName: "ops.recovery.resolve_stuck_upload",
      request: { authorizationEpoch: 1, input: { versionIds: [version], stepUpProofId: proof } },
    });
    expect(f.calls[0]!.request.idempotencyKey.length).toBeLessThanOrEqual(128);
    expect(f.calls[0]!.request.idempotencyKey).not.toContain(proof);
    const audit = (await f.db
      .prepare(
        "SELECT action,payload_json FROM audit_events WHERE workspace_id=? AND action LIKE 'ops.%'",
      )
      .all(FIX.workspace)) as Array<{ action: string; payload_json: string }>;
    expect(audit.map((row) => row.action)).toEqual(["ops.recovery.resolve_stuck_upload"]);
    expect(JSON.stringify(audit)).not.toContain(proof);
    expect(await f.effects()).toEqual({ ledger: 1, abandonment: 1 });
  });
  it("requires a fresh proof for same-request target-ledger replay without duplicate effects", async () => {
    const f = await fixture(),
      version = await f.upload();
    for (const replayed of [false, true]) {
      const response = await f.request("/recovery", "owner", f.body([version], await f.proof()));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        result: { replayed, detail: { resolved: 1 } },
      });
    }
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.request.idempotencyKey).not.toBe(f.calls[1]!.request.idempotencyKey);
    expect(await f.effects()).toEqual({ ledger: 1, abandonment: 1 });
  });
  it("rejects a spent identical proof instead of cached security success", async () => {
    const f = await fixture(),
      version = await f.upload(),
      body = f.body([version], await f.proof());
    expect((await f.request("/recovery", "owner", body)).status).toBe(200);
    expect((await f.request("/recovery", "owner", body)).status).toBe(403);
    expect(await f.effects()).toEqual({ ledger: 1, abandonment: 1 });
  });
  it.each(["private", "missing", "nonstuck", "mixed"] as const)(
    "uses one resource denial for %s targets and no effects",
    async (target) => {
      const f = await fixture(),
        version = await f.upload(),
        proof = await f.proof();
      let ids = [version];
      if (target === "private") await f.privacy();
      if (target === "missing") ids = [randomUlid()];
      if (target === "nonstuck") ids = [await f.upload("uploading", f.run, f.recoveryNow)];
      if (target === "mixed") ids.push(randomUlid());
      const response = await f.request("/recovery", "owner", f.body(ids, proof));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(DENIED);
      expect(await f.effects()).toEqual({ ledger: 0, abandonment: 0 });
      expect(
        await f.db
          .prepare("SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id=?")
          .get(proof),
      ).toEqual({ consumed_at: null });
    },
  );
  it("preserves genuine run-free upload recovery under current owner authority", async () => {
    const f = await fixture(),
      version = await f.upload("uploading", null);
    const response = await f.request("/recovery", "owner", f.body([version], await f.proof()));
    expect(response.status).toBe(200);
    expect(await f.effects()).toEqual({ ledger: 1, abandonment: 1 });
  });
  it.each(["recent_expiry", "consumed_future"] as const)(
    "rejects %s grants using the exact V01 grace witness",
    async (grant) => {
      const f = await fixture(),
        version = await f.upload(),
        proof = await f.proof();
      await f.db
        .prepare(
          `INSERT INTO artifact_upload_grants
      (workspace_id,id,version_id,grant_hash,human_id,authorization_epoch,run_id,format,declared_size,expected_digest,expires_at,consumed_at,created_at)
      VALUES (?,?,?,?,?,1,?,'log',64,?,?,?,?)`,
        )
        .run(
          FIX.workspace,
          randomUlid(),
          version,
          "a".repeat(64),
          FIX.member,
          f.run,
          "f".repeat(64),
          new Date(
            Date.parse(f.recoveryNow) + (grant === "recent_expiry" ? -2 : 5) * 60_000,
          ).toISOString(),
          grant === "consumed_future"
            ? new Date(Date.parse(f.recoveryNow) - 10 * 60_000).toISOString()
            : null,
          OLD,
        );
      const response = await f.request("/recovery", "owner", f.body([version], proof));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(DENIED);
      expect(await f.effects()).toEqual({ ledger: 0, abandonment: 0 });
    },
  );
  it("denies a private creator who is also a workspace Owner", async () => {
    const f = await fixture(),
      version = await f.upload();
    await f.privacy();
    await f.db
      .prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.member);
    const response = await f.request(
      "/recovery",
      "member",
      f.body([version], await f.proof(FIX.member)),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(DENIED);
    expect(await f.effects()).toEqual({ ledger: 0, abandonment: 0 });
  });
  it("does not treat foreign-workspace upload identity as an authorized run-free target", async () => {
    const f = await fixture(),
      workspace = randomUlid(),
      artifact = randomUlid(),
      version = randomUlid(),
      proof = await f.proof();
    await f.db
      .prepare(
        "INSERT INTO workspaces (id,slug,jurisdiction,created_at) VALUES (?,'synthetic-foreign','eu',?)",
      )
      .run(workspace, NOW);
    await f.db
      .prepare(
        "INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,NULL,'log','log',?,?)",
      )
      .run(workspace, artifact, FIX.member, OLD);
    await f.db
      .prepare(
        "INSERT INTO artifact_versions (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,created_at) VALUES (?,?,?,'uploading','log',64,?,?)",
      )
      .run(workspace, version, artifact, "f".repeat(64), OLD);
    const response = await f.request("/recovery", "owner", f.body([version], proof));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(DENIED);
    expect(await f.effects()).toEqual({ ledger: 0, abandonment: 0 });
  });
  it.each(["action", "target"] as const)(
    "rejects the wrong proof %s without recovery effects",
    async (mismatch) => {
      const f = await fixture(),
        version = await f.upload();
      const proof = await f.proof(
        FIX.owner,
        mismatch === "action" ? "ops.retention" : "ops.recover",
        mismatch === "target"
          ? `ops-recover:retry_notification_dispatch:${FIX.workspace}`
          : undefined,
      );
      expect((await f.request("/recovery", "owner", f.body([version], proof))).status).toBe(403);
      expect(await f.effects()).toEqual({ ledger: 0, abandonment: 0 });
    },
  );
  it.each(["member", "reviewer"] as const)(
    "denies %s without proof consumption or namespace mutation",
    async (actor) => {
      const f = await fixture(),
        version = await f.upload(),
        proof = await f.proof(actor === "member" ? FIX.member : FIX.reviewer);
      const response = await f.request("/recovery", actor, f.body([version], proof));
      expect(response.status).toBe(403);
      expect(f.calls).toEqual([]);
      expect(await f.effects()).toEqual({ ledger: 0, abandonment: 0 });
    },
  );
  it.each(["request", "duplicate", "unknown_field", "empty", "invalid_id"] as const)(
    "rejects malformed %s input before consuming proof",
    async (invalid) => {
      const f = await fixture(),
        version = await f.upload(),
        proof = await f.proof();
      const body = f.body(
        invalid === "duplicate"
          ? [version, version]
          : invalid === "empty"
            ? []
            : invalid === "invalid_id"
              ? ["not-an-id"]
              : [version],
        proof,
        invalid === "request" ? "bad" : undefined,
      );
      if (invalid === "unknown_field") Object.assign(body.target, { visibility: "private" });
      const response = await f.request("/recovery", "owner", body);
      expect(response.status).toBe(400);
      expect(await f.effects()).toEqual({ ledger: 0, abandonment: 0 });
      expect(
        await f.db
          .prepare("SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id=?")
          .get(proof),
      ).toEqual({ consumed_at: null });
    },
  );
  it.each(["epoch", "project", "private", "role"] as const)(
    "denies %s loss between authenticated admission and Hub command",
    async (loss) => {
      const f = await fixture(),
        version = await f.upload(),
        proof = await f.proof();
      f.hookBefore(async () => {
        if (loss === "epoch") await f.rotate();
        else if (loss === "project") await f.restrict();
        else if (loss === "private") await f.privacy();
        else await f.demote();
      });
      const response = await f.request("/recovery", "owner", f.body([version], proof));
      expect(response.status).not.toBe(200);
      expect(await f.effects()).toEqual({ ledger: 0, abandonment: 0 });
    },
  );
  it.each(["epoch", "project", "private", "role"] as const)(
    "hides committed success after %s loss before browser delivery",
    async (loss) => {
      const f = await fixture(),
        version = await f.upload(),
        proof = await f.proof();
      f.hookAfter(async () => {
        if (loss === "epoch") await f.rotate();
        else if (loss === "project") await f.restrict();
        else if (loss === "private") await f.privacy();
        else await f.demote();
      });
      const response = await f.request("/recovery", "owner", f.body([version], proof));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(DENIED);
      expect(await f.effects()).toEqual({ ledger: 1, abandonment: 1 });
      expect(
        await f.db.prepare("SELECT state FROM artifact_versions WHERE id=?").get(version),
      ).toEqual({ state: "failed" });
    },
  );
  it("rejects unauthenticated and invalid-CSRF recovery before proof or effects", async () => {
    const f = await fixture(),
      version = await f.upload(),
      proof = await f.proof(),
      body = f.body([version], proof);
    expect((await f.request("/recovery", "owner", body, f.db, { cookie: "" })).status).toBe(401);
    expect(
      (await f.request("/recovery", "owner", body, f.db, { "x-bfb-csrf": "invalid" })).status,
    ).toBe(403);
    expect(f.calls).toEqual([]);
    expect(await f.effects()).toEqual({ ledger: 0, abandonment: 0 });
  });
});
