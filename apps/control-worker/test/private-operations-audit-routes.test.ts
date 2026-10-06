// ABOUTME: Exercises canonical artifact security-audit delivery through authenticated browser routes.
// ABOUTME: Synthetic lineage, pagination and credential races fence receipts without rewriting history.

import type { SqlDatabase } from "@bfb/db";
import { ARTIFACT_RECOVERY_SYSTEM_ID, FIX, randomUlid, seedSyntheticWorkspace } from "@bfb/domain";
import { ARTIFACT_AUDIT_ACTIONS } from "../../../packages/domain/src/artifact-maintenance.js";
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
const PATH = `/api/v1/workspaces/${FIX.workspace}/operations/security-audit`;
const SCOPE_DENIED = { error: "not_found", message: "operations scope not found" };
const CURSOR_DENIED = { error: "invalid_argument", message: "unknown audit cursor" };
const CANARY = "synthetic-artifact-audit-prose-canary";
const contexts: AuthTestContext[] = [];
type Action = (typeof ARTIFACT_AUDIT_ACTIONS)[number];
type Actor = "owner" | "member" | "reviewer";
type Projection = {
  schema_version: 1;
  outbox_id: string;
  version_id: string | null;
  grant_id: string | null;
  source_action: string;
  occurred_at: string;
};
type Entry = {
  audit_id: string;
  actor_principal_id: string;
  action: string;
  created_at: string;
  payload: unknown;
};
type Page = { ok: true; entries: Entry[]; has_more: boolean };

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
  await seedSyntheticWorkspace(db, NOW);
  const task = randomUlid(),
    run = randomUlid();
  // These parent fixtures have no command receipts, so an empty page really has no audit rows.
  await db
    .prepare(
      `INSERT INTO tasks (workspace_id,id,project_id,title,state,priority,next_owner_type,punchline,created_by_human_id,created_at)
    VALUES (?,?,?,'Synthetic audit work','ready','P2','unassigned','Synthetic audit work',?,?)`,
    )
    .run(FIX.workspace, task, FIX.projectA, FIX.member, OLD);
  await db
    .prepare(
      `INSERT INTO runs (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,created_at)
    VALUES (?,?,?,?,?,?,'open','unknown',?)`,
    )
    .run(FIX.workspace, run, FIX.projectA, task, FIX.member, FIX.profileCodex, OLD);
  const ns = createTestWorkspaceHubNamespace(db);
  const calls: Array<{ commandName: string; request: { actorSystemId: string; input: unknown } }> =
    [];
  const baseGet = ns.get.bind(ns);
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
    cookies[actor] = (
      await seedAuthSession(context, {
        userId: `audit-${actor}-user`,
        sessionId: `audit-${actor}-session`,
        token: `audit-${actor}-token`,
        email: `${actor}@synthetic.test`,
        humanId,
        now: NOW,
      })
    ).cookie;
  }
  const request = (
    query = "",
    actor: Actor = "owner",
    database = db,
    headers: Record<string, string> = {},
  ) =>
    app(database).request(
      new Request(ORIGIN + PATH + query, { headers: { cookie: cookies[actor], ...headers } }),
      undefined,
      bindings,
    );
  const audit = async (
    id: string,
    action: string,
    payload: unknown,
    actor = ARTIFACT_RECOVERY_SYSTEM_ID,
    createdAt = NOW,
  ) => {
    await db
      .prepare(
        "INSERT INTO audit_events (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        FIX.workspace,
        id,
        actor,
        action,
        typeof payload === "string" ? payload : JSON.stringify(payload),
        createdAt,
      );
  };
  const source = async (
    action: Action = "artifact.finalized",
    options: {
      runId?: string | null;
      grantKind?: "upload" | "view" | "none";
      grantRunId?: string | null;
      grantVersionId?: string;
      versionId?: string | null;
      dispatched?: boolean;
      outboxId?: string;
      sourceAt?: string;
      state?: "available" | "retained" | "failed";
    } = {},
  ) => {
    const artifact = randomUlid(),
      version = randomUlid();
    const runId = options.runId === undefined ? run : options.runId;
    const state = options.state ?? "available";
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
        version,
        artifact,
        state,
        "a".repeat(64),
        state === "failed" ? null : "a".repeat(64),
        state === "failed"
          ? null
          : `workspaces/${FIX.workspace}/artifacts/sha256/${"a".repeat(64)}`,
        OLD,
        state === "failed" ? null : OLD,
      );
    const kind =
      options.grantKind ??
      (action.startsWith("artifact.view_")
        ? "view"
        : ["artifact.finalized", "artifact.abandoned", "artifact.review_recorded"].includes(action)
          ? "none"
          : "upload");
    const grantId = kind === "none" ? null : randomUlid();
    if (kind === "upload") {
      await db
        .prepare(
          `INSERT INTO artifact_upload_grants (workspace_id,id,version_id,grant_hash,human_id,authorization_epoch,run_id,format,declared_size,expected_digest,expires_at,consumed_at,created_at)
        VALUES (?,?,?,?,?,1,?,'markdown',3,?,?,?,?)`,
        )
        .run(
          FIX.workspace,
          grantId,
          options.grantVersionId ?? version,
          randomUlid().padEnd(64, "0"),
          FIX.member,
          options.grantRunId === undefined ? runId : options.grantRunId,
          "a".repeat(64),
          OLD,
          OLD,
          OLD,
        );
    } else if (kind === "view") {
      await db
        .prepare(
          `INSERT INTO artifact_view_grants (workspace_id,id,version_id,grant_hash,view_nonce_hash,human_id,session_hash,authorization_epoch,content_hash,expires_at,consumed_at,created_at)
        VALUES (?,?,?,?,?,?,?,1,?,?,?,?)`,
        )
        .run(
          FIX.workspace,
          grantId,
          options.grantVersionId ?? version,
          randomUlid().padEnd(64, "0"),
          "b".repeat(64),
          FIX.member,
          "c".repeat(64),
          "a".repeat(64),
          OLD,
          OLD,
          OLD,
        );
    }
    const outboxId = options.outboxId ?? randomUlid();
    const versionId = options.versionId === undefined ? version : options.versionId;
    const sourceAt = options.sourceAt ?? OLD;
    const dispatched = options.dispatched ?? true;
    await db
      .prepare(
        `INSERT INTO artifact_audit_outbox (workspace_id,id,version_id,grant_id,action,payload_json,created_at,dispatched_at)
      VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        outboxId,
        versionId,
        grantId,
        action,
        JSON.stringify({ title: CANARY, arbitrary_id: CANARY }),
        sourceAt,
        dispatched ? null : NOW,
      );
    const projection: Projection = {
      schema_version: 1,
      outbox_id: outboxId,
      version_id: versionId,
      grant_id: grantId,
      source_action: action,
      occurred_at: sourceAt,
    };
    let wrapperId: string | undefined;
    if (dispatched) {
      const response = await ns
        .jurisdiction("eu")
        .get(ns.idFromName(FIX.workspace))
        .fetch("https://bfb-hub.internal/execute", {
          method: "POST",
          body: JSON.stringify({
            commandName: "artifact.dispatch_audit",
            request: {
              workspaceId: FIX.workspace,
              actorSystemId: ARTIFACT_RECOVERY_SYSTEM_ID,
              authorizationEpoch: 1,
              idempotencyKey: randomUlid(),
              input: { outboxId },
            },
          }),
        });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, result: projection });
      wrapperId = (
        (await db
          .prepare(
            `SELECT audit_id FROM audit_events WHERE workspace_id=? AND action='artifact.dispatch_audit' AND json_extract(payload_json,'$.input.outbox_id')=?`,
          )
          .get(FIX.workspace, outboxId)) as { audit_id: string }
      ).audit_id;
    }
    return { artifact, version, outboxId, grantId, wrapperId, projection };
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
  const demote = async () => {
    await db
      .prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.member);
    await db
      .prepare("UPDATE workspace_members SET role='member' WHERE workspace_id=? AND human_id=?")
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
  return {
    db,
    context,
    task,
    run,
    calls,
    request,
    audit,
    source,
    privacy,
    grant,
    rotate,
    revoke,
    demote,
    restrict,
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
function wrapper(projection: Projection) {
  return {
    actor: { systemId: ARTIFACT_RECOVERY_SYSTEM_ID, authorizationEpoch: 1 },
    input: { outbox_id: projection.outbox_id },
    result: projection,
  };
}
async function page(response: Response): Promise<Page> {
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
}
async function denied(response: Response, status: number, body: Record<string, string>) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(body);
}

describe("canonical artifact audit browser delivery", () => {
  it.each(ARTIFACT_AUDIT_ACTIONS)(
    "delivers %s direct and real catalog-dispatched wrapper receipts",
    async (action) => {
      const f = await fixture(),
        s = await f.source(action);
      const result = await page(await f.request());
      expect(result).toEqual({
        ok: true,
        has_more: false,
        entries: [
          {
            audit_id: s.outboxId,
            actor_principal_id: ARTIFACT_RECOVERY_SYSTEM_ID,
            action,
            created_at: NOW,
            payload: s.projection,
          },
          {
            audit_id: s.wrapperId,
            actor_principal_id: ARTIFACT_RECOVERY_SYSTEM_ID,
            action: "artifact.dispatch_audit",
            created_at: NOW,
            payload: wrapper(s.projection),
          },
        ],
      });
      expect(f.calls).toMatchObject([
        {
          commandName: "artifact.dispatch_audit",
          request: { actorSystemId: ARTIFACT_RECOVERY_SYSTEM_ID, input: { outboxId: s.outboxId } },
        },
      ]);
      expect(JSON.stringify(result)).not.toContain(CANARY);
    },
  );

  it.each(ARTIFACT_AUDIT_ACTIONS)(
    "omits both %s receipts for a private task without changing stored history",
    async (action) => {
      const f = await fixture();
      await f.source(action);
      await f.privacy();
      expect(await page(await f.request("?limit=1"))).toEqual({
        ok: true,
        entries: [],
        has_more: false,
      });
      expect(
        await f.db
          .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id=?")
          .get(FIX.workspace),
      ).toEqual({ count: 2 });
    },
  );

  it("does not give the private creator an Owner override", async () => {
    const f = await fixture();
    await f.source();
    await f.privacy();
    await f.db
      .prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.member);
    expect(await page(await f.request("", "member"))).toEqual({
      ok: true,
      entries: [],
      has_more: false,
    });
  });
  it("does not give a named private edit grantee an audit override", async () => {
    const f = await fixture();
    await f.source();
    await f.privacy();
    await f.grant();
    expect(await page(await f.request())).toEqual({ ok: true, entries: [], has_more: false });
  });
  it.each(["member", "reviewer"] as const)("retains static %s role denial", async (actor) => {
    const f = await fixture();
    await f.source();
    expect((await f.request("", actor)).status).toBe(403);
  });
  it("requires a browser cookie and rejects bearer credential substitution", async () => {
    const f = await fixture();
    expect((await f.request("", "owner", f.db, { cookie: "" })).status).toBe(401);
    expect(
      (await f.request("", "owner", f.db, { authorization: "Bearer synthetic-not-browser" }))
        .status,
    ).toBe(401);
    expect(await page(await f.request())).toEqual({ ok: true, entries: [], has_more: false });
  });

  for (const state of ["nonempty", "empty", "private-only"] as const) {
    it.each(["rotate", "revoke", "demote"] as const)(
      `rechecks current %s at the final selection for ${state} pages before cursor validation`,
      async (change) => {
        const f = await fixture();
        if (state !== "empty") await f.source();
        if (state === "private-only") await f.privacy();
        const racing = beforeAuditRead(f.db, f[change]);
        await denied(
          await f.request("?after=synthetic-missing-cursor", "owner", racing),
          404,
          SCOPE_DENIED,
        );
      },
    );
  }
  for (const state of ["nonempty", "empty"] as const) {
    it.each(["rotate", "revoke", "demote"] as const)(
      `denies current %s loss on an unanchored ${state} page`,
      async (change) => {
        const f = await fixture();
        if (state === "nonempty") await f.source();
        await denied(
          await f.request("", "owner", beforeAuditRead(f.db, f[change])),
          404,
          SCOPE_DENIED,
        );
      },
    );
  }
  it("rechecks project access after principal hydration before returning receipts", async () => {
    const f = await fixture();
    await f.source();
    expect(await page(await f.request("", "owner", beforeAuditRead(f.db, f.restrict)))).toEqual({
      ok: true,
      entries: [],
      has_more: false,
    });
  });
  it("rechecks private parent creation after principal hydration before returning receipts", async () => {
    const f = await fixture();
    await f.source();
    expect(await page(await f.request("", "owner", beforeAuditRead(f.db, f.privacy)))).toEqual({
      ok: true,
      entries: [],
      has_more: false,
    });
  });

  it("filters hidden receipts before LIMIT and has_more without consuming a visible slot", async () => {
    const f = await fixture();
    await f.source();
    await f.privacy();
    const a = await f.source("artifact.finalized", { runId: null }),
      b = await f.source("artifact.abandoned", { runId: null });
    let after = "";
    const ids: string[] = [];
    for (const id of [a.outboxId, a.wrapperId!, b.outboxId, b.wrapperId!]) {
      const result = await page(await f.request(`?limit=1${after}`));
      expect(result.entries.map((entry) => entry.audit_id)).toEqual([id]);
      ids.push(id);
      expect(result.has_more).toBe(ids.length < 4);
      after = `&after=${id}`;
    }
    expect(await page(await f.request(`?limit=1${after}`))).toEqual({
      ok: true,
      entries: [],
      has_more: false,
    });
  });
  it("preserves insertion order for equal timestamps rather than lexical audit IDs", async () => {
    const f = await fixture();
    const high = await f.source("artifact.finalized", { outboxId: "7ZZZZZZZZZZZZZZZZZZZZZZZZZ" });
    const low = await f.source("artifact.finalized", { outboxId: "00000000000000000000000000" });
    expect((await page(await f.request())).entries.map((entry) => entry.audit_id)).toEqual([
      high.outboxId,
      high.wrapperId,
      low.outboxId,
      low.wrapperId,
    ]);
    expect(
      (await page(await f.request(`?after=${high.wrapperId}&limit=1`))).entries[0]?.audit_id,
    ).toBe(low.outboxId);
  });

  it.each(["missing", "private", "foreign", "malformed", "unsupported"] as const)(
    "uses the same cursor denial for a %s anchor",
    async (kind) => {
      const f = await fixture();
      let anchor = randomUlid();
      if (kind === "private") {
        anchor = (await f.source()).outboxId;
        await f.privacy();
      }
      if (kind === "malformed") {
        const s = await f.source("artifact.finalized", { dispatched: false });
        await f.audit(anchor, "artifact.dispatch_audit", {
          ...wrapper(s.projection),
          extra_id: CANARY,
        });
      }
      if (kind === "unsupported")
        await f.audit(anchor, "artifact.create_version", { version_id: CANARY });
      if (kind === "foreign") {
        const ws = randomUlid();
        await f.db
          .prepare(
            "INSERT INTO workspaces (id,slug,jurisdiction,created_at,resource_version) VALUES (?,'foreign-audit','eu',?,1)",
          )
          .run(ws, NOW);
        await f.db
          .prepare(
            "INSERT INTO audit_events (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,'unrelated.audit','{}',?)",
          )
          .run(ws, anchor, FIX.owner, NOW);
      }
      await denied(await f.request(`?after=${anchor}`), 400, CURSOR_DENIED);
    },
  );
  it("denies a formerly visible anchor privatized immediately before the final selection", async () => {
    const f = await fixture(),
      s = await f.source();
    await denied(
      await f.request(`?after=${s.outboxId}`, "owner", beforeAuditRead(f.db, f.privacy)),
      400,
      CURSOR_DENIED,
    );
  });

  it.each([
    "artifact.create_version",
    "artifact.agent_finalize",
    "Artifact.finalized",
    "ARTIFACT.dispatch_audit",
  ])("quarantines unsupported artifact receipt %s before pagination", async (action) => {
    const f = await fixture();
    await f.audit(randomUlid(), action, { version_id: CANARY });
    const s = await f.source();
    expect((await page(await f.request("?limit=1"))).entries[0]?.audit_id).toBe(s.outboxId);
  });
  it("keeps unrelated audit families on the existing sanitizer without interpreting payload IDs", async () => {
    const f = await fixture(),
      id = randomUlid();
    await f.audit(
      id,
      "unrelated.audit",
      { version_id: "synthetic-opaque-reference", title: CANARY },
      FIX.owner,
    );
    expect(await page(await f.request())).toEqual({
      ok: true,
      has_more: false,
      entries: [
        {
          audit_id: id,
          actor_principal_id: FIX.owner,
          action: "unrelated.audit",
          created_at: NOW,
          payload: { version_id: "synthetic-opaque-reference" },
        },
      ],
    });
  });

  it("rebuilds a direct receipt from canonical source metadata instead of historical JSON", async () => {
    const f = await fixture(),
      s = await f.source("artifact.finalized", { dispatched: false });
    await f.audit(s.outboxId, "artifact.finalized", {
      schema_version: 99,
      outbox_id: CANARY,
      version_id: CANARY,
      title: CANARY,
    });
    const result = await page(await f.request());
    expect(result.entries[0]?.payload).toEqual(s.projection);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
  for (const boundary of ["page", "anchor"] as const) {
    it.each(["source UTC", "outbox ULID"] as const)(
      `rejects a NUL-suffixed canonical %s at the ${boundary} boundary`,
      async (kind) => {
        const f = await fixture();
        // Historical source rows retain real version/run/task lineage. Only the
        // typed field carries the synthetic suffix; arbitrary JSON is not the source.
        const corrupted = await f.source("artifact.finalized", {
          dispatched: false,
          ...(kind === "source UTC"
            ? { sourceAt: `${OLD}\u0000${CANARY}` }
            : { outboxId: `${randomUlid()}\u0000${CANARY}` }),
        });
        await f.audit(corrupted.outboxId, "artifact.finalized", corrupted.projection);
        const wrapperId = randomUlid();
        await f.audit(wrapperId, "artifact.dispatch_audit", wrapper(corrupted.projection));
        if (boundary === "anchor") {
          for (const id of [corrupted.outboxId, wrapperId]) {
            await denied(await f.request(`?after=${encodeURIComponent(id)}`), 400, CURSOR_DENIED);
          }
          return;
        }
        const visible = await f.source();
        const first = await page(await f.request("?limit=1"));
        expect(first.entries.map((entry) => entry.audit_id)).toEqual([visible.outboxId]);
        expect(first.has_more).toBe(true);
        const second = await page(await f.request(`?limit=1&after=${visible.outboxId}`));
        expect(second.entries.map((entry) => entry.audit_id)).toEqual([visible.wrapperId]);
        expect(second.has_more).toBe(false);
        expect(JSON.stringify(await page(await f.request()))).not.toContain(CANARY);
        expect(
          await f.db
            .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id=?")
            .get(FIX.workspace),
        ).toEqual({ count: 4 });
      },
    );
  }
  it.each(["row actor", "dispatch time"] as const)(
    "requires exact direct receipt %s before granting a wrapper counterpart",
    async (kind) => {
      const f = await fixture(),
        s = await f.source("artifact.finalized", { dispatched: false });
      await f.audit(
        s.outboxId,
        "artifact.finalized",
        s.projection,
        kind === "row actor" ? FIX.owner : ARTIFACT_RECOVERY_SYSTEM_ID,
        kind === "dispatch time" ? OLD : NOW,
      );
      await f.audit(randomUlid(), "artifact.dispatch_audit", wrapper(s.projection));
      expect(await page(await f.request())).toEqual({ ok: true, entries: [], has_more: false });
      await denied(await f.request(`?after=${s.outboxId}`), 400, CURSOR_DENIED);
    },
  );
  it("requires the canonical direct counterpart before delivering a strict wrapper", async () => {
    const f = await fixture(),
      s = await f.source("artifact.finalized", { dispatched: false });
    await f.audit(randomUlid(), "artifact.dispatch_audit", wrapper(s.projection));
    expect(await page(await f.request())).toEqual({ ok: true, entries: [], has_more: false });
  });

  const malformedWrappers: Array<[string, (p: Projection) => unknown]> = [
    [
      "serialized actor object",
      (p) => ({ ...wrapper(p), actor: JSON.stringify(wrapper(p).actor) }),
    ],
    [
      "serialized input object",
      (p) => ({ ...wrapper(p), input: JSON.stringify(wrapper(p).input) }),
    ],
    ["serialized result object", (p) => ({ ...wrapper(p), result: JSON.stringify(p) })],
    ["extra envelope field", (p) => ({ ...wrapper(p), extra_id: CANARY })],
    [
      "extra actor field",
      (p) => ({ ...wrapper(p), actor: { ...wrapper(p).actor, humanId: FIX.owner } }),
    ],
    [
      "extra input field",
      (p) => ({ ...wrapper(p), input: { ...wrapper(p).input, private_id: CANARY } }),
    ],
    ["extra result field", (p) => ({ ...wrapper(p), result: { ...p, private_id: CANARY } })],
    [
      "wrong system actor",
      (p) => ({ ...wrapper(p), actor: { systemId: FIX.owner, authorizationEpoch: 1 } }),
    ],
    [
      "wrong actor epoch",
      (p) => ({
        ...wrapper(p),
        actor: { systemId: ARTIFACT_RECOVERY_SYSTEM_ID, authorizationEpoch: 2 },
      }),
    ],
    [
      "input result identity mismatch",
      (p) => ({ ...wrapper(p), input: { outbox_id: randomUlid() } }),
    ],
    [
      "wrong source action",
      (p) => ({ ...wrapper(p), result: { ...p, source_action: "artifact.abandoned" } }),
    ],
    [
      "wrong source version",
      (p) => ({ ...wrapper(p), result: { ...p, version_id: randomUlid() } }),
    ],
    ["wrong source time", (p) => ({ ...wrapper(p), result: { ...p, occurred_at: NOW } })],
    [
      "duplicate envelope key",
      (p) => JSON.stringify(wrapper(p)).replace('{"actor":', '{"actor":{},"actor":'),
    ],
    [
      "duplicate nested result key",
      (p) =>
        JSON.stringify(wrapper(p)).replace(
          '"schema_version":1',
          '"schema_version":1,"schema_version":1',
        ),
    ],
    ["scalar envelope", () => "42"],
  ];
  it.each(malformedWrappers)("omits a wrapper with %s before LIMIT", async (_label, malformed) => {
    const f = await fixture(),
      s = await f.source();
    const id = randomUlid();
    await f.audit(id, "artifact.dispatch_audit", malformed(s.projection));
    const result = await page(await f.request());
    expect(result.entries.map((entry) => entry.audit_id)).toEqual([s.outboxId, s.wrapperId]);
    expect(result.has_more).toBe(false);
    await denied(await f.request(`?after=${id}`), 400, CURSOR_DENIED);
  });
  it("filters older malformed wrappers before LIMIT plus one and has_more", async () => {
    const f = await fixture(),
      s = await f.source("artifact.finalized", { dispatched: false });
    for (const [, malformed] of malformedWrappers) {
      await f.audit(randomUlid(), "artifact.dispatch_audit", malformed(s.projection));
    }
    await f.audit(s.outboxId, "artifact.finalized", s.projection);
    const wrapperId = randomUlid();
    await f.audit(wrapperId, "artifact.dispatch_audit", wrapper(s.projection));
    const first = await page(await f.request("?limit=1"));
    expect(first.entries.map((entry) => entry.audit_id)).toEqual([s.outboxId]);
    expect(first.has_more).toBe(true);
    const second = await page(await f.request(`?limit=1&after=${s.outboxId}`));
    expect(second.entries.map((entry) => entry.audit_id)).toEqual([wrapperId]);
    expect(second.has_more).toBe(false);
  });
  it.each(["row actor", "dispatch time"] as const)("requires exact wrapper %s", async (kind) => {
    const f = await fixture(),
      s = await f.source(),
      id = randomUlid();
    await f.audit(
      id,
      "artifact.dispatch_audit",
      wrapper(s.projection),
      kind === "row actor" ? FIX.owner : ARTIFACT_RECOVERY_SYSTEM_ID,
      kind === "dispatch time" ? OLD : NOW,
    );
    expect((await page(await f.request())).entries.map((entry) => entry.audit_id)).toEqual([
      s.outboxId,
      s.wrapperId,
    ]);
  });

  it.each(["genuinely run-free", "retained", "failed"] as const)(
    "preserves authorized %s source history",
    async (kind) => {
      const f = await fixture();
      const s = await f.source(
        "artifact.abandoned",
        kind === "genuinely run-free" ? { runId: null } : { state: kind },
      );
      expect((await page(await f.request())).entries.map((entry) => entry.audit_id)).toEqual([
        s.outboxId,
        s.wrapperId,
      ]);
    },
  );
  it.each(["dangling run", "missing version", "null version"] as const)(
    "omits %s lineage rather than granting workspace fallback",
    async (kind) => {
      const f = await fixture();
      await f.source(
        "artifact.finalized",
        kind === "dangling run"
          ? { runId: randomUlid() }
          : { versionId: kind === "null version" ? null : randomUlid() },
      );
      expect(await page(await f.request())).toEqual({ ok: true, entries: [], has_more: false });
    },
  );
  it.each([
    ["upload action with view grant", "artifact.grant_issued", { grantKind: "view" }],
    ["view action with upload grant", "artifact.view_issued", { grantKind: "upload" }],
    ["grant-free action with a grant", "artifact.finalized", { grantKind: "upload" }],
    ["upload action without a grant", "artifact.grant_issued", { grantKind: "none" }],
    ["upload wrong run", "artifact.grant_consumed", { grantRunId: FIX.runDelegable }],
    ["upload null run mismatch", "artifact.upload_verified", { grantRunId: null }],
    [
      "run-free upload nonnull run mismatch",
      "artifact.grant_reissued",
      { runId: null, grantRunId: FIX.runDelegable },
    ],
    ["upload wrong version", "artifact.grant_issued", { grantVersionId: FIX.taskProposed }],
  ] as const)("omits %s before page counts", async (_label, action, options) => {
    const f = await fixture();
    await f.source(action, options);
    expect(await page(await f.request())).toEqual({ ok: true, entries: [], has_more: false });
  });
});
