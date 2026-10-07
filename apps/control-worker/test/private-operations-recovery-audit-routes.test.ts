// ABOUTME: Exercises strict stuck-upload recovery audit receipts through authenticated browser routes.
// ABOUTME: Current shared target lineage, ordered ledger witnesses and scope races fence historical delivery.

import { createHash } from "node:crypto";
import type { SqlDatabase } from "@bfb/db";
import { FIX, issueStepUpProof, randomUlid, seedSyntheticWorkspace } from "@bfb/domain";
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

const NOW = "2026-10-06T12:00:00.000Z";
const OLD = "2026-08-01T12:00:00.000Z";
const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;
const BASE = `/api/v1/workspaces/${FIX.workspace}/operations`;
const ACTION = "ops.recovery.resolve_stuck_upload";
const KIND = "resolve_stuck_upload";
const CANARY = "synthetic-recovery-audit-canary";
const SCOPE_DENIED = { error: "not_found", message: "operations scope not found" };
const CURSOR_DENIED = { error: "invalid_argument", message: "unknown audit cursor" };
const contexts: AuthTestContext[] = [];
type Actor = "owner" | "member" | "reviewer";
type Receipt = {
  actor: { humanId: string; authorizationEpoch: number };
  input: { version_ids: string[] };
  result: { action_id: string; kind: string; replayed: boolean; resolved: number };
};
type Page = {
  ok: true;
  entries: Array<{
    audit_id: string;
    action: string;
    actor_principal_id: string;
    created_at: string;
    payload: unknown;
  }>;
  has_more: boolean;
  next_cursor: string | null;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  contexts.splice(0).forEach((context) => context.raw.close());
  vi.useRealTimers();
});

function actionId(ids: string[]) {
  return `ops:${KIND}:${createHash("sha256")
    .update(JSON.stringify({ version_ids: ids }))
    .digest("hex")
    .slice(0, 32)}`;
}
function receipt(ids: string[], replayed = false, actorHumanId = FIX.owner, epoch = 1): Receipt {
  return {
    actor: { humanId: actorHumanId, authorizationEpoch: epoch },
    input: { version_ids: ids },
    result: { action_id: actionId(ids), kind: KIND, replayed, resolved: ids.length },
  };
}
function outward(value: Receipt) {
  return { ...value, input: { version_ids: "[redacted]" } };
}
async function fixture() {
  const context = openAuthTestContext(NOW);
  contexts.push(context);
  const db = context.db;
  await seedSyntheticWorkspace(db, NOW);
  const task = randomUlid(),
    run = randomUlid();
  await db
    .prepare(
      `INSERT INTO tasks (workspace_id,id,project_id,title,state,priority,next_owner_type,punchline,created_by_human_id,created_at)
    VALUES (?,?,?,'Synthetic recovery audit work','ready','P2','unassigned','Synthetic recovery audit work',?,?)`,
    )
    .run(FIX.workspace, task, FIX.projectA, FIX.member, OLD);
  await db
    .prepare(
      `INSERT INTO runs (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,created_at)
    VALUES (?,?,?,?,?,?,'open','unknown',?)`,
    )
    .run(FIX.workspace, run, FIX.projectA, task, FIX.member, FIX.profileCodex, OLD);
  const calls: Array<{ commandName: string; request: Record<string, unknown> }> = [];
  const ns = createTestWorkspaceHubNamespace(db),
    baseGet = ns.get.bind(ns);
  Object.assign(ns, {
    get(id: DurableObjectId) {
      const stub = baseGet(id);
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          calls.push(JSON.parse(String(init?.body)));
          return stub.fetch(input, init);
        },
      } as DurableObjectStub;
    },
  });
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
  const app = (database = db, observedNow = NOW) =>
    createControlApp(validateControlEnv(bindings), {
      db: database,
      now: observedNow,
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
      userId: `recovery-audit-${actor}-user`,
      sessionId: `recovery-audit-${actor}-session`,
      token: `recovery-audit-${actor}-token`,
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
    query = "",
    actor: Actor = "owner",
    database = db,
    headers: Record<string, string> = {},
  ) =>
    app(database).request(
      new Request(ORIGIN + BASE + "/security-audit" + query, {
        headers: { cookie: actors[actor].cookie, ...headers },
      }),
      undefined,
      bindings,
    );
  const upload = async (
    runId: string | null = run,
    state: "uploading" | "failed" | "available" = "failed",
    id = randomUlid(),
  ) => {
    const artifact = randomUlid();
    await db
      .prepare(
        `INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,?,'markdown','review',?,?)`,
      )
      .run(FIX.workspace, artifact, runId, FIX.member, OLD);
    await db
      .prepare(
        `INSERT INTO artifact_versions (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,content_hash,r2_key,created_at,available_at)
      VALUES (?,?,?,?,'markdown',3,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        id,
        artifact,
        state,
        "a".repeat(64),
        state === "available" ? "a".repeat(64) : null,
        state === "available"
          ? `workspaces/${FIX.workspace}/artifacts/sha256/${"a".repeat(64)}`
          : null,
        OLD,
        state === "available" ? OLD : null,
      );
    return id;
  };
  const ledger = async (
    ids: string[],
    options: {
      target?: unknown;
      result?: unknown;
      targetJson?: string;
      resultJson?: string;
      id?: string;
      kind?: string;
      state?: string;
      creator?: string;
      createdAt?: string;
      updatedAt?: string;
      attempts?: number;
    } = {},
  ) => {
    const id = options.id ?? actionId(ids),
      target = options.target ?? { version_ids: ids },
      result = options.result ?? { resolved: ids.length };
    await db
      .prepare(
        `INSERT INTO ops_recovery_ledger (workspace_id,action_id,kind,target_json,state,attempt_count,result_json,created_by_human_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(workspace_id,action_id) DO UPDATE SET kind=excluded.kind,
           target_json=excluded.target_json,state=excluded.state,attempt_count=excluded.attempt_count,
           result_json=excluded.result_json,created_by_human_id=excluded.created_by_human_id,
           created_at=excluded.created_at,updated_at=excluded.updated_at`,
      )
      .run(
        FIX.workspace,
        id,
        options.kind ?? KIND,
        options.targetJson ?? JSON.stringify(target),
        options.state ?? "applied",
        options.attempts ?? 1,
        options.resultJson ?? JSON.stringify(result),
        options.creator ?? FIX.owner,
        options.createdAt ?? OLD,
        options.updatedAt ?? OLD,
      );
    return id;
  };
  const audit = async (
    value: unknown,
    options: { id?: string; action?: string; actor?: string; createdAt?: string } = {},
  ) => {
    const id = options.id ?? randomUlid();
    await db
      .prepare(
        "INSERT INTO audit_events (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        FIX.workspace,
        id,
        options.actor ?? FIX.owner,
        options.action ?? ACTION,
        typeof value === "string" ? value : JSON.stringify(value),
        options.createdAt ?? OLD,
      );
    return id;
  };
  const history = async (ids?: string[]) => {
    const versionIds = ids ?? [await upload()];
    await ledger(versionIds);
    const value = receipt(versionIds),
      id = await audit(value);
    return { ids: versionIds, value, id };
  };
  // Actual recovery proofs use live time without moving the historical read corpus.
  const { operationNow } = (await db
    .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS operationNow")
    .get()) as { operationNow: string };
  const recover = async (
    ids: string[],
    actor: Actor = "owner",
    requestId = "synthetic-recovery-audit-request",
  ) => {
    const humanId = actor === "owner" ? FIX.owner : actor === "member" ? FIX.member : FIX.reviewer;
    const previousNow = new Date();
    // The Hub authorizer replaces request time with Date; preserve the same retry instant.
    vi.setSystemTime(operationNow);
    try {
      const proofId = await issueStepUpProof(
        db,
        humanId,
        {
          action: "ops.recover",
          workspaceId: FIX.workspace,
          targetId: `ops-recover:${KIND}:${FIX.workspace}`,
          scopes: [],
          authorizationEpoch: 1,
          expiresAt: new Date(Date.parse(operationNow) + 5 * 60_000).toISOString(),
        },
        operationNow,
      );
      const response = await app(db, operationNow).request(
        new Request(ORIGIN + BASE + "/recovery", {
          method: "POST",
          headers: {
            cookie: actors[actor].cookie,
            "content-type": "application/json",
            origin: ORIGIN,
            "sec-fetch-site": "same-origin",
            "x-bfb-csrf": actors[actor].csrf,
          },
          body: JSON.stringify({
            kind: KIND,
            target: { version_ids: ids },
            request_id: requestId,
            step_up_proof_id: proofId,
          }),
        }),
        undefined,
        bindings,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: true;
        result: { action_id: string; replayed: boolean; detail: { resolved: number } };
      };
      expect(body).toMatchObject({
        ok: true,
        result: { action_id: actionId(ids), detail: { resolved: ids.length } },
      });
      return body.result;
    } finally {
      vi.setSystemTime(previousNow);
    }
  };
  const privacy = () =>
    db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, task, FIX.member, NOW);
  const grant = () =>
    db
      .prepare(
        "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'edit',?)",
      )
      .run(FIX.workspace, randomUlid(), task, FIX.owner, NOW);
  const promote = () =>
    db
      .prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.member);
  const demote = async () => {
    await promote();
    await db
      .prepare("UPDATE workspace_members SET role='member' WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.owner);
  };
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
  const revoke = () =>
    db
      .prepare(
        "UPDATE workspace_authorization_epochs SET revoked_at=? WHERE workspace_id=? AND human_id=?",
      )
      .run(NOW, FIX.workspace, FIX.owner);
  const restrict = async () => {
    await db
      .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
      .run(FIX.workspace, FIX.projectA);
    await db
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .run(FIX.workspace, FIX.projectA, FIX.owner);
  };
  const positionAt = async (auditId: string, limit = 1) => {
    let after = "";
    for (let count = 0; count < 100; count++) {
      const result = await page(await request(`?limit=${limit}${after}`));
      if (result.entries.at(-1)?.audit_id === auditId) {
        expect(result.has_more).toBe(true);
        return result.next_cursor!;
      }
      if (result.next_cursor === null) throw new Error("audit anchor has no continuation");
      after = `&after=${result.next_cursor}`;
    }
    throw new Error("audit anchor was not found in bounded traversal");
  };
  return {
    db,
    task,
    run,
    calls,
    operationNow,
    request,
    upload,
    ledger,
    audit,
    history,
    recover,
    privacy,
    grant,
    promote,
    demote,
    rotate,
    revoke,
    restrict,
    positionAt,
  };
}
function beforeAuditRead(db: SqlDatabase, change: () => Promise<unknown>): SqlDatabase {
  let fired = false;
  return {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!/audit_events/i.test(sql)) return statement;
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
async function page(response: Response): Promise<Page> {
  expect(response.status).toBe(200);
  const result = (await response.json()) as Page;
  if (result.has_more) {
    expect(result.next_cursor).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(result.next_cursor!, "base64url").toString("base64url")).toBe(
      result.next_cursor,
    );
  } else expect(result.next_cursor).toBeNull();
  return result;
}
async function cursorDenied(response: Response) {
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual(CURSOR_DENIED);
}

describe("stuck-upload recovery audit browser delivery", () => {
  it("delivers a real Hub original and fresh-proof retry without expanding version IDs", async () => {
    const f = await fixture(),
      ids = [await f.upload(f.run, "uploading"), await f.upload(null, "uploading")];
    expect((await f.recover(ids)).replayed).toBe(false);
    await f.promote();
    expect((await f.recover(ids, "member")).replayed).toBe(true);
    const result = await page(await f.request());
    expect(result.entries.map((e) => e.payload)).toEqual([
      outward(receipt(ids)),
      outward(receipt(ids, true, FIX.member)),
    ]);
    expect(result.entries.map((e) => e.action)).toEqual([ACTION, ACTION]);
    expect(result.has_more).toBe(false);
    expect(f.calls.map((c) => c.commandName)).toEqual([ACTION, ACTION]);
    expect(JSON.stringify(result)).not.toContain(ids[0]);
    expect(JSON.stringify(result)).not.toContain("stepUpProofId");
    expect(
      await f.db
        .prepare("SELECT COUNT(*) AS count FROM artifact_audit_outbox WHERE workspace_id=?")
        .get(FIX.workspace),
    ).toEqual({ count: 2 });
  });
  it("delivers a legitimate old-ledger retry without an original audit counterpart or attempt-one restriction", async () => {
    const f = await fixture(),
      ids = [await f.upload()];
    await f.ledger(ids, { creator: FIX.member, attempts: 7 });
    expect((await f.recover(ids)).replayed).toBe(true);
    const result = await page(await f.request());
    expect(result.entries.map((e) => e.payload)).toEqual([outward(receipt(ids, true))]);
    expect(result.entries[0]?.created_at).toBe(f.operationNow);
  });
  it("retains the historical positive actor epoch without fabricating current epoch or proof provenance", async () => {
    const f = await fixture(),
      s = await f.history();
    const value = receipt(s.ids, true, FIX.member, 17),
      id = await f.audit(value, { actor: FIX.member, createdAt: NOW });
    const position = await f.positionAt(s.id);
    expect((await page(await f.request(`?limit=1&after=${position}`))).entries).toEqual([
      {
        audit_id: id,
        actor_principal_id: FIX.member,
        action: ACTION,
        created_at: NOW,
        payload: outward(value),
      },
    ]);
  });
  it.each([
    ["equal fractional precision", "2026-10-06T12:00:00.1Z", "2026-10-06T12:00:00.100000Z", true],
    [
      "later microsecond after whole second",
      "2026-10-06T12:00:00Z",
      "2026-10-06T12:00:00.000001Z",
      true,
    ],
    [
      "earlier whole second before microsecond",
      "2026-10-06T12:00:00.000001Z",
      "2026-10-06T12:00:00Z",
      false,
    ],
  ] as const)(
    "compares retry UTC instants for %s without relying on lexical precision",
    async (_label, createdAt, auditAt, visible) => {
      const f = await fixture(),
        ids = [await f.upload()];
      await f.ledger(ids, { createdAt, updatedAt: createdAt });
      const id = await f.audit(receipt(ids, true), { createdAt: auditAt });
      expect((await page(await f.request())).entries.map((entry) => entry.audit_id)).toEqual(
        visible ? [id] : [],
      );
      if (!visible) await cursorDenied(await f.request(`?after=${id}`));
    },
  );
  it.each(["owner", "creator", "grantee"] as const)(
    "omits a private recovery receipt for the %s without changing history",
    async (kind) => {
      const f = await fixture();
      await f.history();
      await f.privacy();
      if (kind === "creator") await f.promote();
      if (kind === "grantee") await f.grant();
      expect(
        await page(await f.request("?limit=1", kind === "creator" ? "member" : "owner")),
      ).toEqual({ ok: true, entries: [], has_more: false, next_cursor: null });
      expect(
        await f.db
          .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id=?")
          .get(FIX.workspace),
      ).toEqual({ count: 1 });
    },
  );
  it("omits an entire mixed private/run-free target list rather than exposing a partial count", async () => {
    const f = await fixture();
    await f.history([await f.upload(), await f.upload(null)]);
    await f.privacy();
    expect(await page(await f.request())).toEqual({
      ok: true,
      entries: [],
      has_more: false,
      next_cursor: null,
    });
  });
  it("filters older hidden receipts before LIMIT plus one and has_more", async () => {
    const f = await fixture();
    await f.history();
    await f.privacy();
    const a = await f.history([await f.upload(null)]),
      b = await f.history([await f.upload(null)]);
    const first = await page(await f.request("?limit=1"));
    expect(first.entries.map((e) => e.audit_id)).toEqual([a.id]);
    expect(first.has_more).toBe(true);
    const second = await page(await f.request(`?limit=1&after=${first.next_cursor}`));
    expect(second.entries.map((e) => e.audit_id)).toEqual([b.id]);
    expect(second.has_more).toBe(false);
  });
  it.each(["missing", "hidden"] as const)(
    "uses the same unknown cursor denial for a %s recovery anchor",
    async (kind) => {
      const f = await fixture();
      let id = randomUlid();
      if (kind === "hidden") {
        const source = await f.history();
        await f.history([await f.upload(null)]);
        id = await f.positionAt(source.id);
        await f.privacy();
      }
      await cursorDenied(await f.request(`?limit=1&after=${id}`));
    },
  );
  it.each(["privacy", "restrict"] as const)(
    "remasks recovery targets after current %s loss at final selection",
    async (change) => {
      const f = await fixture();
      await f.history();
      expect(await page(await f.request("", "owner", beforeAuditRead(f.db, f[change])))).toEqual({
        ok: true,
        entries: [],
        has_more: false,
        next_cursor: null,
      });
    },
  );
  for (const state of ["empty", "nonempty", "hidden-only"] as const) {
    it.each(["rotate", "revoke", "demote"] as const)(
      `denies current %s loss for ${state} pages before anchor validation`,
      async (change) => {
        const f = await fixture();
        const source = await f.history();
        await f.history([await f.upload()]);
        const position = await f.positionAt(source.id);
        if (state === "empty")
          await f.db
            .prepare(
              "DELETE FROM audit_events WHERE workspace_id=? AND action!='ops.audit_position.issue'",
            )
            .run(FIX.workspace);
        if (state === "hidden-only") await f.privacy();
        const response = await f.request(
          `?limit=1&after=${position}`,
          "owner",
          beforeAuditRead(f.db, f[change]),
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual(SCOPE_DENIED);
      },
    );
  }
  it.each(["member", "reviewer"] as const)("preserves static %s role denial", async (actor) => {
    const f = await fixture();
    await f.history();
    expect((await f.request("", actor)).status).toBe(403);
  });
  it("requires browser authentication and rejects bearer substitution", async () => {
    const f = await fixture();
    expect((await f.request("", "owner", f.db, { cookie: "" })).status).toBe(401);
    expect(
      (await f.request("", "owner", f.db, { authorization: "Bearer synthetic-not-browser" }))
        .status,
    ).toBe(401);
  });
  it("does not reapply upload age or grant liveness to currently failed history", async () => {
    const f = await fixture(),
      s = await f.history();
    await f.db
      .prepare(
        `INSERT INTO artifact_upload_grants (workspace_id,id,version_id,grant_hash,human_id,authorization_epoch,run_id,format,declared_size,expected_digest,expires_at,created_at) VALUES (?,?,?,?,?,1,?,'markdown',3,?,?,?)`,
      )
      .run(
        FIX.workspace,
        randomUlid(),
        s.ids[0],
        "b".repeat(64),
        FIX.member,
        f.run,
        "a".repeat(64),
        "2026-10-06T12:05:00.000Z",
        NOW,
      );
    expect((await page(await f.request())).entries[0]?.audit_id).toBe(s.id);
  });
  it.each(["run-free", "dangling-run", "missing-version", "nonfailed", "mixed-missing"] as const)(
    "resolves the complete %s target history",
    async (kind) => {
      const f = await fixture();
      const ids =
        kind === "missing-version"
          ? [randomUlid()]
          : [
              await f.upload(
                kind === "run-free" ? null : kind === "dangling-run" ? randomUlid() : f.run,
                kind === "nonfailed" ? "available" : "failed",
              ),
            ];
      if (kind === "mixed-missing") ids.push(randomUlid());
      const s = await f.history(ids),
        result = await page(await f.request());
      expect(result.entries.map((e) => e.audit_id)).toEqual(kind === "run-free" ? [s.id] : []);
    },
  );
  const chronologyCases = [
    ["whole second before fraction", "2026-10-06T12:00:00Z", "2026-10-06T12:00:00.1Z", false],
    [
      "microsecond across fractional precision",
      "2026-10-06T12:00:00.1Z",
      "2026-10-06T12:00:00.100001Z",
      false,
    ],
    [
      "equal instant with insertion-order tie",
      "2026-10-06T12:00:00.1Z",
      "2026-10-06T12:00:00.100000Z",
      false,
    ],
    ["unsupported legacy mixed fraction", "2026-10-06T12:00:00Z", "2026-10-06T12:00:00.1Z", true],
    [
      "unsupported equal legacy instant",
      "2026-10-06T12:00:00.1Z",
      "2026-10-06T12:00:00.100000Z",
      true,
    ],
  ] as const;
  for (const boundary of ["page", "anchor"] as const) {
    it.each(chronologyCases)(
      `keeps supported UTC chronology and omits %s at the ${boundary} boundary`,
      async (_label, earlierAt, laterAt, legacy) => {
        const f = await fixture();
        const earlierIds = [await f.upload()];
        await f.ledger(earlierIds, { createdAt: earlierAt, updatedAt: earlierAt });
        const earlierId = await f.audit(receipt(earlierIds), { createdAt: earlierAt });
        let laterId: string;
        if (legacy) {
          laterId = await f.audit(
            { kind: "synthetic_legacy", title: CANARY },
            { action: "ops.recover", createdAt: laterAt },
          );
        } else {
          const laterIds = [await f.upload()];
          await f.ledger(laterIds, { createdAt: laterAt, updatedAt: laterAt });
          laterId = await f.audit(receipt(laterIds), { createdAt: laterAt });
        }
        const first = await page(await f.request("?limit=1"));
        expect(first.entries.map((entry) => [entry.audit_id, entry.created_at])).toEqual([
          [earlierId, earlierAt],
        ]);
        expect(first.has_more).toBe(!legacy);
        if (legacy) {
          expect(first.next_cursor).toBeNull();
          await cursorDenied(await f.request(`?limit=1&after=${laterId}`));
          return;
        }
        const next = await page(await f.request(`?limit=1&after=${first.next_cursor}`));
        expect(next.entries.map((entry) => [entry.audit_id, entry.created_at])).toEqual(
          legacy ? [] : [[laterId, laterAt]],
        );
        expect(next.has_more).toBe(false);
        expect(next.next_cursor).toBeNull();
      },
    );
  }
  it("retains chronological insertion order at equal timestamps rather than audit ID ordering", async () => {
    const f = await fixture(),
      ids = [await f.upload()];
    await f.ledger(ids);
    const high = "7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
      low = "00000000000000000000000000";
    await f.audit(receipt(ids), { id: high });
    await f.audit(receipt(ids, true), { id: low });
    expect((await page(await f.request())).entries.map((e) => e.audit_id)).toEqual([high, low]);
    const position = await f.positionAt(high);
    expect((await page(await f.request(`?limit=1&after=${position}`))).entries[0]?.audit_id).toBe(
      low,
    );
  });
  it.each([
    "Ops.recovery.resolve_stuck_upload",
    "OPS.RECOVERY.RESOLVE_STUCK_UPLOAD",
    "ops.recovery.other",
  ])("quarantines unsupported recovery action %s before pagination", async (action) => {
    const f = await fixture(),
      ids = [await f.upload()];
    await f.ledger(ids);
    await f.audit(receipt(ids), { action });
    const id = await f.audit(receipt(ids));
    expect((await page(await f.request("?limit=1"))).entries[0]?.audit_id).toBe(id);
  });

  const badReceipts: Array<[string, (r: Receipt) => unknown]> = [
    ["serialized actor", (r) => ({ ...r, actor: JSON.stringify(r.actor) })],
    ["serialized input", (r) => ({ ...r, input: JSON.stringify(r.input) })],
    ["serialized result", (r) => ({ ...r, result: JSON.stringify(r.result) })],
    ["extra envelope key", (r) => ({ ...r, private_id: CANARY })],
    ["extra actor key", (r) => ({ ...r, actor: { ...r.actor, systemId: FIX.owner } })],
    ["extra input key", (r) => ({ ...r, input: { ...r.input, step_up_proof_id: CANARY } })],
    ["extra result key", (r) => ({ ...r, result: { ...r.result, private_id: CANARY } })],
    [
      "duplicate envelope key",
      (r) => JSON.stringify(r).replace('{"actor":', '{"actor":{},"actor":'),
    ],
    [
      "duplicate nested actor key",
      (r) =>
        JSON.stringify(r).replace(
          '"authorizationEpoch":1',
          '"authorizationEpoch":1,"authorizationEpoch":1',
        ),
    ],
    [
      "duplicate result key",
      (r) => JSON.stringify(r).replace('"resolved":1', '"resolved":1,"resolved":1'),
    ],
    [
      "duplicate input key",
      (r) => JSON.stringify(r).replace('"version_ids":', '"version_ids":[],"version_ids":'),
    ],
    [
      "unsafe historical epoch",
      (r) => ({ ...r, actor: { ...r.actor, authorizationEpoch: Number.MAX_SAFE_INTEGER + 1 } }),
    ],
    ["zero historical epoch", (r) => ({ ...r, actor: { ...r.actor, authorizationEpoch: 0 } })],
    ["string historical epoch", (r) => ({ ...r, actor: { ...r.actor, authorizationEpoch: "1" } })],
    ["boolean resolved count", (r) => ({ ...r, result: { ...r.result, resolved: true } })],
    ["string resolved count", (r) => ({ ...r, result: { ...r.result, resolved: "1" } })],
    ["string replay flag", (r) => ({ ...r, result: { ...r.result, replayed: "false" } })],
    ["wrong kind", (r) => ({ ...r, result: { ...r.result, kind: "clear_recovery_state" } })],
    ["wrong resolved count", (r) => ({ ...r, result: { ...r.result, resolved: 0 } })],
    ["scalar input array", (r) => ({ ...r, input: { version_ids: r.input.version_ids[0] } })],
    [
      "serialized input array",
      (r) => ({ ...r, input: { version_ids: JSON.stringify(r.input.version_ids) } }),
    ],
    [
      "duplicate target",
      (r) => ({ ...r, input: { version_ids: [...r.input.version_ids, ...r.input.version_ids] } }),
    ],
    [
      "NUL-suffixed actor ULID",
      (r) => ({ ...r, actor: { ...r.actor, humanId: `${r.actor.humanId}\u0000${CANARY}` } }),
    ],
    [
      "NUL-suffixed action ID",
      (r) => ({ ...r, result: { ...r.result, action_id: `${r.result.action_id}\u0000${CANARY}` } }),
    ],
    [
      "uppercase action hash",
      (r) => ({ ...r, result: { ...r.result, action_id: r.result.action_id.toUpperCase() } }),
    ],
  ];
  it.each(badReceipts)(
    "omits a strict receipt with %s before page and anchor delivery",
    async (_label, bad) => {
      const f = await fixture(),
        ids = [await f.upload()];
      await f.ledger(ids);
      const hidden = await f.audit(receipt(ids));
      const valid = await f.audit(receipt(ids, true), { createdAt: NOW });
      const position = await f.positionAt(hidden);
      const malformed = bad(receipt(ids));
      await f.db
        .prepare("UPDATE audit_events SET payload_json=? WHERE workspace_id=? AND audit_id=?")
        .run(
          typeof malformed === "string" ? malformed : JSON.stringify(malformed),
          FIX.workspace,
          hidden,
        );
      const result = await page(await f.request("?limit=1"));
      expect(result.entries.map((e) => e.audit_id)).toEqual([valid]);
      expect(result.has_more).toBe(false);
      await cursorDenied(await f.request(`?limit=1&after=${position}`));
    },
  );
  const badLedgers: Array<
    [
      string,
      (ids: string[]) => {
        target?: unknown;
        result?: unknown;
        targetJson?: string;
        resultJson?: string;
        state?: string;
        kind?: string;
        createdAt?: string;
        updatedAt?: string;
      },
    ]
  > = [
    [
      "duplicate target object key",
      (ids) => ({ targetJson: `{"version_ids":[],"version_ids":${JSON.stringify(ids)}}` }),
    ],
    [
      "duplicate ledger result key",
      (ids) => ({ resultJson: `{"resolved":${ids.length},"resolved":${ids.length}}` }),
    ],
    ["serialized target", (ids) => ({ target: JSON.stringify({ version_ids: ids }) })],
    ["serialized target array", (ids) => ({ target: { version_ids: JSON.stringify(ids) } })],
    ["scalar target array", (ids) => ({ target: { version_ids: ids[0] } })],
    ["extra target key", (ids) => ({ target: { version_ids: ids, private_id: CANARY } })],
    ["duplicate targets", (ids) => ({ target: { version_ids: [...ids, ...ids] } })],
    ["empty targets", () => ({ target: { version_ids: [] } })],
    ["serialized result", (ids) => ({ result: JSON.stringify({ resolved: ids.length }) })],
    ["extra result key", (ids) => ({ result: { resolved: ids.length, private_id: CANARY } })],
    ["boolean ledger count", () => ({ result: { resolved: true } })],
    ["string ledger count", () => ({ result: { resolved: "1" } })],
    ["wrong ledger count", () => ({ result: { resolved: 0 } })],
    ["failed ledger", () => ({ state: "failed" })],
    ["wrong ledger kind", () => ({ kind: "retry_notification_dispatch" })],
    ["NUL-suffixed ledger UTC", () => ({ createdAt: `${OLD}\u0000${CANARY}` })],
    ["NUL-suffixed ledger update UTC", () => ({ updatedAt: `${OLD}\u0000${CANARY}` })],
  ];
  it.each(badLedgers)(
    "omits %s ledger sources before counts and anchor delivery",
    async (_label, bad) => {
      const f = await fixture(),
        ids = [await f.upload()];
      await f.ledger(ids);
      const id = await f.audit(receipt(ids));
      const tail = await f.history([await f.upload(null)]);
      const position = await f.positionAt(id);
      await f.ledger(ids, bad(ids));
      const result = await page(await f.request("?limit=1"));
      expect(result.entries.map((entry) => entry.audit_id)).toEqual([tail.id]);
      expect(result.has_more).toBe(false);
      await cursorDenied(await f.request(`?limit=1&after=${position}`));
    },
  );
  it("requires exact preserved ledger target order", async () => {
    const f = await fixture(),
      ids = [await f.upload(), await f.upload(null)];
    await f.ledger(ids);
    const id = await f.audit(receipt(ids));
    const tail = await f.history([await f.upload(null)]);
    const position = await f.positionAt(id);
    await f.ledger(ids, { target: { version_ids: [...ids].reverse() } });
    expect((await page(await f.request())).entries.map((entry) => entry.audit_id)).toEqual([
      tail.id,
    ]);
    await cursorDenied(await f.request(`?limit=1&after=${position}`));
  });
  it("omits a receipt without its applied ledger source", async () => {
    const f = await fixture(),
      ids = [await f.upload()];
    await f.ledger(ids);
    const id = await f.audit(receipt(ids));
    const tail = await f.history([await f.upload(null)]);
    const position = await f.positionAt(id);
    await f.db
      .prepare("DELETE FROM ops_recovery_ledger WHERE workspace_id=? AND action_id=?")
      .run(FIX.workspace, actionId(ids));
    expect((await page(await f.request())).entries.map((entry) => entry.audit_id)).toEqual([
      tail.id,
    ]);
    await cursorDenied(await f.request(`?limit=1&after=${position}`));
  });
  it.each([0, 51])("rejects a complete source array with %s failed targets", async (count) => {
    const f = await fixture(),
      ids: string[] = [];
    for (let index = 0; index < count; index++) ids.push(await f.upload(null));
    const s = await f.history(ids);
    expect(await page(await f.request())).toEqual({
      ok: true,
      entries: [],
      has_more: false,
      next_cursor: null,
    });
    await cursorDenied(await f.request(`?after=${s.id}`));
  });
  it.each(["ledger action ID", "failed version ULID"] as const)(
    "rejects a genuine NUL-suffixed %s source rather than relying on a missing-source denial",
    async (kind) => {
      const f = await fixture();
      const ids = [
        await f.upload(
          f.run,
          "failed",
          kind === "failed version ULID" ? `${randomUlid()}\u0000${CANARY}` : randomUlid(),
        ),
      ];
      const value = receipt(ids);
      if (kind === "ledger action ID") value.result.action_id += `\u0000${CANARY}`;
      await f.ledger(ids, { id: value.result.action_id });
      const id = await f.audit(value);
      expect(await page(await f.request())).toEqual({
        ok: true,
        entries: [],
        has_more: false,
        next_cursor: null,
      });
      await cursorDenied(await f.request(`?after=${id}`));
    },
  );
  it("omits a genuinely foreign failed version rather than using a bare-ID lookup", async () => {
    const f = await fixture(),
      workspace = randomUlid(),
      artifact = randomUlid(),
      version = randomUlid();
    await f.db
      .prepare(
        "INSERT INTO workspaces (id,slug,jurisdiction,created_at,resource_version) VALUES (?,'foreign-recovery-audit','eu',?,1)",
      )
      .run(workspace, OLD);
    await f.db
      .prepare(
        "INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,NULL,'markdown','review',?,?)",
      )
      .run(workspace, artifact, FIX.member, OLD);
    await f.db
      .prepare(
        "INSERT INTO artifact_versions (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,created_at) VALUES (?,?,?,'failed','markdown',3,?,?)",
      )
      .run(workspace, version, artifact, "a".repeat(64), OLD);
    const s = await f.history([version]);
    expect(await page(await f.request())).toEqual({
      ok: true,
      entries: [],
      has_more: false,
      next_cursor: null,
    });
    await cursorDenied(await f.request(`?after=${s.id}`));
  });
  it.each([
    "original actor mismatch",
    "original time mismatch",
    "retry before creation",
    "row actor mismatch",
    "NUL audit ID",
    "NUL audit UTC",
  ] as const)("omits %s receipts", async (kind) => {
    const f = await fixture(),
      ids = [await f.upload()];
    await f.ledger(ids, { createdAt: kind === "retry before creation" ? NOW : OLD });
    const value = receipt(
      ids,
      kind === "retry before creation",
      kind === "original actor mismatch" ? FIX.member : FIX.owner,
    );
    const id = await f.audit(value, {
      actor:
        kind === "original actor mismatch"
          ? FIX.member
          : kind === "row actor mismatch"
            ? FIX.member
            : FIX.owner,
      createdAt:
        kind === "original time mismatch"
          ? NOW
          : kind === "NUL audit UTC"
            ? `${OLD}\u0000${CANARY}`
            : OLD,
      ...(kind === "NUL audit ID" ? { id: `${randomUlid()}\u0000${CANARY}` } : {}),
    });
    expect(await page(await f.request())).toEqual({
      ok: true,
      entries: [],
      has_more: false,
      next_cursor: null,
    });
    await cursorDenied(await f.request(`?after=${encodeURIComponent(id)}`));
  });
});
