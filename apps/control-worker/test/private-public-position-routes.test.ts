// ABOUTME: Exercises the public raw-position quarantine at authenticated Worker boundaries.
// ABOUTME: Keeps internal outcomes intact while checking held feeds, sockets and public mutation receipts.

import { createAuthorizationContext, type SqlDatabase } from "@bfb/db";
import {
  createRunCommand,
  createTaskCommand,
  FIX,
  randomUlid,
  seedSyntheticWorkspace,
  startLaunchCommand,
  WorkspaceHub as DomainWorkspaceHub,
} from "@bfb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace, executeWorkspaceCommand } from "../src/hub-client.js";
import { publicCommandOutcome } from "../src/public-command-outcome.js";
import { handleBrowserRealtimeApi } from "../src/api/realtime.js";
import { BrowserSockets, type RealtimeSocket } from "../src/realtime/browser-sockets.js";
import { createControlApp } from "../src/routes.js";
import { WorkspaceHub } from "../src/workspace-hub.js";
import { LAUNCH_NOW, launchFixture } from "../../../packages/domain/test/launch-fixture.js";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
  type AuthTestContext,
} from "./auth-helpers.js";

const NOW = "2026-10-07T12:00:00.000Z";
const BASE = `/api/v1/workspaces/${FIX.workspace}`;
const HELD = { error: "request_rejected", message: "event feeds are unavailable" };
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
  const sessions = {} as Record<"owner" | "reviewer", { cookie: string; csrf: string }>;
  const queries: string[] = [];
  const db: SqlDatabase = {
    prepare(sql) {
      queries.push(sql);
      return context.db.prepare(sql);
    },
    withTransaction(operation) {
      return context.db.withTransaction(operation);
    },
  };
  let resolvedHub = 0;
  const realHub = createTestWorkspaceHubNamespace(context.db);
  const namespace = {
    ...realHub,
    jurisdiction() {
      return namespace;
    },
    idFromName(name: string) {
      resolvedHub += 1;
      return realHub.idFromName(name);
    },
  } as unknown as DurableObjectNamespace;
  const bindings = {
    DB: {},
    ARTIFACTS: {},
    ASSETS: {},
    JOBS: {},
    JOBS_DLQ: {},
    WORKSPACE_HUB: namespace,
    APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  } as unknown as ControlBindings;
  const app = createControlApp(validateControlEnv(bindings), {
    db,
    now: NOW,
    abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["reviewer", FIX.reviewer],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `positions-${actor}-user`,
      sessionId: `positions-${actor}-session`,
      token: `positions-${actor}-token`,
      email: `${actor}@synthetic.test`,
      humanId,
      now: NOW,
    });
    const response = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/session`, {
        headers: { cookie: session.cookie },
      }),
      undefined,
      bindings,
    );
    expect(response.status).toBe(200);
    sessions[actor] = {
      cookie: session.cookie,
      csrf: ((await response.json()) as { csrf_token: string }).csrf_token,
    };
  }
  const get = (
    path: string,
    actor: "owner" | "reviewer" = "owner",
    headers: Record<string, string> = {},
  ) =>
    app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, {
        headers: { cookie: sessions[actor].cookie, ...headers },
      }),
      undefined,
      bindings,
    );
  const write = (path: string, input: unknown, method: "POST" | "PUT" = "POST") =>
    app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, {
        method,
        headers: {
          cookie: sessions.owner.cookie,
          origin: AUTH_TEST_ENV.APP_ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          "x-bfb-csrf": sessions.owner.csrf,
        },
        body: JSON.stringify(input),
      }),
      undefined,
      bindings,
    );
  queries.length = 0;
  return { context, db, queries, get, write, bindings, sessions, resolvedHub: () => resolvedHub };
}

function socket(attachment: unknown = null) {
  const sent: string[] = [],
    closed: Array<{ code: number; reason: string }> = [];
  let inspected = 0;
  const value: RealtimeSocket = {
    readyState: 1,
    send(frame) {
      sent.push(frame);
    },
    close(code, reason) {
      closed.push({ code, reason });
    },
    readAttachment() {
      inspected += 1;
      return attachment;
    },
    writeAttachment(next) {
      attachment = next;
    },
  };
  return { value, sent, closed, inspected: () => inspected, attachment: () => attachment };
}
const handshake = {
  schema_version: 1 as const,
  workspaceId: FIX.workspace,
  humanId: FIX.owner,
  authorizationEpoch: 1,
  role: "owner",
  sessionId: "positions-owner-session",
  sessionExpiresAt: "2026-10-07T13:00:00.000Z",
};

describe("public raw-position boundaries", () => {
  for (const path of ["/events", "/events/high-water", "/operations/activity"]) {
    it(`holds admitted ${path} before ledger/high-water reads even when empty`, async () => {
      const f = await fixture();
      const response = await f.get(`${BASE}${path}`);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(HELD);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(
        f.queries.some((sql) =>
          /event_ledger|semantic_events|MAX\(.*cursor|workspace_event_cursors/.test(sql),
        ),
      ).toBe(false);
    });
  }
  it("holds measurement sources before resolving a missing run", async () => {
    const f = await fixture();
    const response = await f.get(`${BASE}/runs/${randomUlid()}/measurement-sources`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(HELD);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.queries.some((sql) => /FROM runs|measurement_sources|event_ledger/.test(sql))).toBe(
      false,
    );
  });
  it("preserves pure invalid ledger query errors without high-water reads", async () => {
    const f = await fixture();
    for (const [query, status] of [
      ["after_cursor=nope", 400],
      ["through_cursor=1&after_cursor=2", 409],
      ["limit=0", 409],
      ["limit=101", 409],
    ] as const) {
      expect((await f.get(`${BASE}/events?${query}`)).status).toBe(status);
    }
    expect(f.queries.some((sql) => /event_ledger|MAX\(.*cursor/.test(sql))).toBe(false);
  });
  it("preserves source range admission before missing/private lookup", async () => {
    const f = await fixture();
    for (const query of [
      "limit=0",
      "limit=101",
      "after_cursor=nope",
      "after_cursor=9007199254740992",
      "limit=1&limit=2",
      "unexpected=1",
    ]) {
      expect(
        (await f.get(`${BASE}/runs/${randomUlid()}/measurement-sources?${query}`)).status,
      ).toBe(400);
    }
    expect(f.queries.some((sql) => /FROM runs|measurement_sources/.test(sql))).toBe(false);
  });
  it("preserves credential/role/method admission instead of holding unauthorized callers", async () => {
    const f = await fixture();
    expect((await f.get(`${BASE}/events`, "reviewer")).status).toBe(403);
    expect(
      (await f.get(`${BASE}/events`, "owner", { authorization: "Bearer synthetic" })).status,
    ).toBe(401);
    expect((await f.write(`${BASE}/events`, {})).status).toBe(404);
  });
  it("holds a valid browser upgrade before resolving its Hub namespace", async () => {
    const f = await fixture();
    const response = await handleBrowserRealtimeApi(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/realtime/workspaces/${FIX.workspace}/subscribe`, {
        headers: {
          cookie: f.sessions.owner.cookie,
          upgrade: "websocket",
          "sec-websocket-protocol": "bfb.browser.v1",
          origin: AUTH_TEST_ENV.APP_ORIGIN,
        },
      }),
      {
        db: f.db,
        principal: {
          type: "human",
          humanId: FIX.owner,
          authUserId: "positions-owner-user",
          email: "owner@synthetic.test",
          emailVerified: true,
          displayName: "Synthetic Owner",
          sessionId: "positions-owner-session",
        },
        workspaceId: FIX.workspace,
        now: NOW,
        jurisdiction: "eu",
        appOrigin: AUTH_TEST_ENV.APP_ORIGIN,
        abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
        workspaceHubNs: f.bindings.WORKSPACE_HUB,
        auth: f.context.auth,
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(HELD);
    expect(f.resolvedHub()).toBe(0);
  });
  it("holds DO socket admission before source reads, attachment or ready frame", async () => {
    const f = await fixture(),
      peer = socket();
    const manager = new BrowserSockets(() => [peer.value], {
      db: f.db,
      now: () => NOW,
      newConnectionId: randomUlid,
    });
    await expect(manager.admit(peer.value, handshake)).rejects.toMatchObject({
      code: "request_rejected",
      message: HELD.message,
    });
    expect(f.queries).toEqual([]);
    expect(peer.sent).toEqual([]);
    expect(peer.attachment()).toBeNull();
  });
  it("never inspects, reads, sends or closes browser attachments after a command", async () => {
    const f = await fixture(),
      peer = socket({ malformed: true });
    const manager = new BrowserSockets(() => [peer.value], { db: f.db, now: () => NOW });
    await manager.afterCommand();
    expect(peer.inspected()).toBe(0);
    expect(peer.sent).toEqual([]);
    expect(peer.closed).toEqual([]);
    expect(f.queries).toEqual([]);
  });
  it("retires retained attachments on alarm without source queries or frames", async () => {
    const f = await fixture(),
      peer = socket({
        ...handshake,
        connectionId: randomUlid(),
        subscribedAt: NOW,
        lastHeartbeatAt: NOW,
      });
    const manager = new BrowserSockets(() => [peer.value], { db: f.db, now: () => NOW });
    await manager.alarm();
    expect(peer.closed).toEqual([]);
    await new BrowserSockets(() => [peer.value], {
      db: f.db,
      now: () => "2026-10-07T13:00:00.000Z",
    }).alarm();
    expect(peer.closed).toHaveLength(1);
    expect(peer.sent).toEqual([]);
    expect(f.queries).toEqual([]);
  });
  it("retires a valid heartbeat independently of commands without source queries or frames", async () => {
    const f = await fixture(),
      connectionId = randomUlid(),
      peer = socket({ ...handshake, connectionId, subscribedAt: NOW, lastHeartbeatAt: NOW });
    const manager = new BrowserSockets(() => [peer.value], {
      db: f.db,
      now: () => "2026-10-07T12:00:20.000Z",
    });
    await manager.message(
      peer.value,
      JSON.stringify({
        schema_version: 1,
        kind: "browser.realtime.heartbeat",
        workspace_id: FIX.workspace,
        connection_id: connectionId,
      }),
    );
    expect(peer.closed).toHaveLength(1);
    expect(peer.sent).toEqual([]);
    expect(f.queries).toEqual([]);
  });
  it("returns exact public fresh/cached receipts while retaining business resource versions", async () => {
    const f = await fixture();
    const input = {
      project_id: FIX.projectA,
      title: "Synthetic public receipt",
      priority: "P2",
      request_id: randomUlid(),
    };
    for (const replayed of [false, true]) {
      const response = await f.write(`${BASE}/tasks`, input);
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as {
        result: { resource_version: number };
        replayed: boolean;
      };
      expect(Object.keys(body).sort()).toEqual(["ok", "replayed", "result"]);
      expect(body.replayed).toBe(replayed);
      expect(body.result.resource_version).toBe(1);
    }
  });
  it("applies the same allowlist to every preference-batch outcome", async () => {
    const f = await fixture();
    const input = {
      request_id: randomUlid(),
      preferences: [{ channel: "macos", category: "attention", enabled: false }],
    };
    for (const replayed of [false, true]) {
      const response = await f.write(`${BASE}/notifications/preferences`, input, "PUT");
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as { results: Array<{ replayed: boolean }> };
      expect(body.results).toHaveLength(1);
      expect(Object.keys(body.results[0]!).sort()).toEqual(["ok", "replayed", "result"]);
      expect(body.results[0]!.replayed).toBe(replayed);
    }
  });
  it("holds source pages uniformly for real shared/private/missing parents without run hydration", async () => {
    const f = await fixture(),
      hub = new DomainWorkspaceHub(f.context.db);
    const human = async <I, R>(command: import("@bfb/domain").HubCommand<I, R>, input: I) => {
      const outcome = await hub.execute(command, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.member,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input,
        now: NOW,
      });
      if (!outcome.ok) throw new Error(outcome.error.message);
      return outcome.result;
    };
    const task = await human(createTaskCommand, {
      projectId: FIX.projectA,
      title: "Synthetic held-source parent",
      priority: "P2",
    });
    const created = await human(createRunCommand, {
      taskId: task.id,
      expectedTaskVersion: 1,
      agentProfileId: FIX.profileCodex,
      workspacePolicyVersion: 1,
      projectPolicyVersion: 1,
      repositoryConfigVersion: 1,
      agentProfileVersion: 1,
    });
    for (const privateParent of [false, true]) {
      if (privateParent)
        await f.context.db
          .prepare(
            "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
          )
          .run(FIX.workspace, task.id, FIX.member, NOW);
      f.queries.length = 0;
      for (const id of [created.run.id, randomUlid()]) {
        const response = await f.get(`${BASE}/runs/${id}/measurement-sources`);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual(HELD);
      }
      expect(f.queries.some((sql) => /FROM runs|measurement_sources|event_ledger/.test(sql))).toBe(
        false,
      );
    }
  });
  it("allowlists only top-level outcome fields, preserving nested business cursor/grants and failures", () => {
    const result = {
      resource_version: 7,
      cursor: 123,
      upload_grant: { grant_id: randomUlid(), secret: "synthetic-one-time-grant" },
    };
    const raw = {
      ok: true as const,
      result,
      replayed: true,
      cursor: 987,
      internal_metadata: "synthetic",
    };
    expect(publicCommandOutcome(raw)).toEqual({ ok: true, result, replayed: true });
    expect(publicCommandOutcome(raw).ok && publicCommandOutcome(raw)).not.toHaveProperty("cursor");
    expect(raw.cursor).toBe(987);
    const error = { code: "not_found", message: "task not found" };
    expect(publicCommandOutcome({ ok: false, error, cursor: 999 } as never)).toEqual({
      ok: false,
      error,
    });
  });
  it("retains internal fresh/cache positions and stored receipts while projecting public responses", async () => {
    const f = await fixture(),
      request = {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        now: NOW,
        input: {
          projectId: FIX.projectA,
          title: "Synthetic retained internal receipt",
          priority: "P2" as const,
        },
      };
    const deps = {
      db: f.context.db,
      authorization: createAuthorizationContext({
        workspaceId: FIX.workspace,
        principalId: FIX.owner,
        authorizationEpoch: 1,
        jurisdiction: "eu",
      }),
    };
    const fresh = await executeWorkspaceCommand(deps, createTaskCommand, request);
    const stored = await f.context.db
      .prepare(
        "SELECT result_json FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
      )
      .get(FIX.workspace, request.idempotencyKey);
    const cached = await executeWorkspaceCommand(deps, createTaskCommand, request);
    expect(fresh.ok && cached.ok).toBe(true);
    if (!fresh.ok || !cached.ok) throw new Error("expected actual Hub receipt");
    expect(fresh.cursor).toBeGreaterThan(0);
    expect(cached.cursor).toBe(fresh.cursor);
    expect(publicCommandOutcome(cached)).toEqual({
      ok: true,
      result: fresh.result,
      replayed: true,
    });
    expect(
      await f.context.db
        .prepare(
          "SELECT result_json FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
        )
        .get(FIX.workspace, request.idempotencyKey),
    ).toEqual(stored);
  });
  it("keeps shared runner alarms quiet for malformed browser attachments until a received frame", async () => {
    const f = await fixture(),
      peer = socket({ malformed: true }),
      manager = new BrowserSockets(() => [peer.value], { db: f.db, now: () => NOW });
    expect(manager.earliestExpiry()).toBe(Number.POSITIVE_INFINITY);
    await manager.alarm();
    await manager.schedule(
      async () => {},
      async () => {},
    );
    expect(peer.closed).toEqual([]);
    expect(peer.sent).toEqual([]);
    expect(f.queries).toEqual([]);
    await manager.message(peer.value, "{}");
    expect(peer.closed).toEqual([{ code: 1008, reason: "request_rejected" }]);
  });
  it("holds direct DO admission before accepting a socket or querying D1", async () => {
    const accepted = vi.fn(),
      prepare = vi.fn(() => {
        throw new Error("no D1 admission read");
      });
    const state = {
      acceptWebSocket: accepted,
      getWebSockets: () => [],
      storage: {
        getAlarm: async () => null,
        setAlarm: async () => {},
        deleteAlarm: async () => {},
      },
    } as unknown as DurableObjectState;
    const hub = new WorkspaceHub(state, {
      DB: { prepare, batch: async () => [] },
    } as unknown as ControlBindings);
    const response = await hub.fetch(
      new Request("https://bfb-hub.internal/browser/connect", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": "bfb.browser.v1",
          "x-bfb-browser-principal": JSON.stringify(handshake),
        },
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(HELD);
    expect(accepted).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
  it("keeps internal DO outcomes and runner nudges without command-correlated browser inspection", async () => {
    const browser = {
      readyState: 1,
      deserializeAttachment: vi.fn(() => ({ malformed: true })),
      close: vi.fn(),
      send: vi.fn(),
    };
    const getWebSockets = vi.fn((tag?: string) => (tag === "bfb-browser" ? [browser] : []));
    const existingAlarm = Date.parse("2026-10-07T12:30:00.000Z"),
      setAlarm = vi.fn();
    const state = {
      getWebSockets,
      storage: { getAlarm: async () => existingAlarm, setAlarm, deleteAlarm: vi.fn() },
    } as unknown as DurableObjectState;
    const hub = new WorkspaceHub(state, {
      DB: { batch: async () => [] },
    } as unknown as ControlBindings);
    const afterCommand = vi.fn(async () => {});
    // This transport double isolates scheduling; actual domain effects/receipts are checked above.
    Object.assign(hub, {
      domainLane: {
        execute: async () => ({
          ok: true,
          result: { resource_version: 1 },
          replayed: false,
          cursor: 41,
        }),
      },
      channels: { afterCommand, earliestExpiry: () => Number.POSITIVE_INFINITY },
    });
    const response = await hub.fetch(
      new Request("https://bfb-hub.internal/execute", {
        method: "POST",
        body: JSON.stringify({
          commandName: createTaskCommand.name,
          request: { workspaceId: FIX.workspace, input: {} },
        }),
      }),
    );
    expect(await response.json()).toEqual({
      ok: true,
      result: { resource_version: 1 },
      replayed: false,
      cursor: 41,
    });
    expect(afterCommand).toHaveBeenCalledOnce();
    expect(getWebSockets.mock.calls.some(([tag]) => tag === "bfb-browser")).toBe(false);
    expect(browser.deserializeAttachment).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    expect(browser.send).not.toHaveBeenCalled();
    expect(setAlarm).toHaveBeenCalledWith(existingAlarm);
  });
  it("keeps browser attachments quiet on shared scheduling failure while runner failure stays closed", async () => {
    const browser = {
        readyState: 1,
        deserializeAttachment: vi.fn(() => ({ malformed: true })),
        close: vi.fn(),
        send: vi.fn(),
      },
      runner = { readyState: 1, close: vi.fn() };
    const state = {
      getWebSockets: (tag?: string) =>
        tag === "bfb-browser" ? [browser] : tag === "bfb-runner" ? [runner] : [browser, runner],
      storage: {
        setAlarm: async () => {
          throw new Error("synthetic storage loss");
        },
        deleteAlarm: async () => {
          throw new Error("synthetic storage loss");
        },
      },
    } as unknown as DurableObjectState;
    const hub = new WorkspaceHub(state, {
      DB: { batch: async () => [] },
    } as unknown as ControlBindings);
    Object.assign(hub, { channels: { earliestExpiry: () => Date.parse(NOW) + 1000 } });
    await (hub as unknown as { scheduleAlarms(): Promise<void> }).scheduleAlarms();
    expect(runner.close).toHaveBeenCalledWith(1011, "channel_unavailable");
    expect(browser.close).not.toHaveBeenCalled();
    expect(browser.send).not.toHaveBeenCalled();
    const f = await fixture(),
      peer = socket({
        ...handshake,
        connectionId: randomUlid(),
        subscribedAt: NOW,
        lastHeartbeatAt: NOW,
      });
    await new BrowserSockets(() => [peer.value], { db: f.db, now: () => NOW }).schedule(
      async () => {
        throw new Error("synthetic timer loss");
      },
      async () => {},
    );
    expect(peer.closed).toEqual([]);
    expect(peer.sent).toEqual([]);
    expect(f.queries).toEqual([]);
  });
  for (const withRunner of [false, true]) {
    it(`preserves browser deadline through actual runner afterCommand ${withRunner ? "overwrite" : "deletion"}`, async () => {
      vi.setSystemTime(LAUNCH_NOW);
      const context = openAuthTestContext(LAUNCH_NOW);
      contexts.push(context);
      const f = await launchFixture(context.db);
      if (withRunner) expect((await f.human(startLaunchCommand, f.start)).ok).toBe(true);
      let attachment = {
        schema_version: 1,
        principal: f.principal,
        connectionId: randomUlid(),
        lastHeartbeatAt: LAUNCH_NOW,
        nudgeSequence: 0,
      };
      const runner = {
        readyState: 1,
        deserializeAttachment: () => attachment,
        serializeAttachment: (value: typeof attachment) => {
          attachment = value;
        },
        send: vi.fn(),
        close: vi.fn(),
      };
      const browser = {
        readyState: 1,
        deserializeAttachment: vi.fn(() => ({ malformed: true })),
        send: vi.fn(),
        close: vi.fn(),
      };
      const deadline = Date.parse(LAUNCH_NOW) + 60_000;
      let alarm: number | null = deadline;
      const state = {
        getWebSockets: (tag?: string) =>
          tag === "bfb-runner"
            ? withRunner
              ? [runner]
              : []
            : tag === "bfb-browser"
              ? [browser]
              : [],
        storage: {
          getAlarm: async () => alarm,
          setAlarm: async (at: number) => {
            alarm = at;
          },
          deleteAlarm: async () => {
            alarm = null;
          },
        },
      } as unknown as DurableObjectState;
      const binding = {
        prepare(sql: string) {
          let params: unknown[] = [];
          const statement = {
            bind(...bound: unknown[]) {
              params = bound;
              return statement;
            },
            first: async () => context.db.prepare(sql).get(...params),
            all: async () => ({ results: await context.db.prepare(sql).all(...params) }),
            run: async () => {
              throw new Error("transport composition must not write business rows");
            },
          };
          return statement;
        },
        batch: async () => {
          throw new Error("transport composition must not write business rows");
        },
      } as unknown as D1Database;
      const hub = new WorkspaceHub(state, { DB: binding } as unknown as ControlBindings);
      // Actual RunnerChannels is retained; only business execution is isolated from this scheduling proof.
      Object.assign(hub, {
        domainLane: {
          execute: async () => ({
            ok: true,
            result: { resource_version: 1 },
            replayed: false,
            cursor: 41,
          }),
        },
      });
      const response = await hub.fetch(
        new Request("https://bfb-hub.internal/execute", {
          method: "POST",
          body: JSON.stringify({
            commandName: createTaskCommand.name,
            request: { workspaceId: FIX.workspace, input: {} },
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(alarm).toBe(deadline);
      expect(browser.deserializeAttachment).not.toHaveBeenCalled();
      expect(browser.send).not.toHaveBeenCalled();
      expect(browser.close).not.toHaveBeenCalled();
      expect(runner.close).not.toHaveBeenCalled();
      if (withRunner) expect(runner.send).toHaveBeenCalled();
      const nudges = runner.send.mock.calls.length;
      const pulled = await hub.fetch(
        new Request("https://bfb-hub.internal/runner/pull", {
          method: "POST",
          body: JSON.stringify({ principal: f.principal }),
        }),
      );
      expect(pulled.status).toBe(200);
      expect(await pulled.json()).toMatchObject({
        schema_version: 1,
        workspace_id: FIX.workspace,
        runner_id: f.runner,
        commands: withRunner ? [expect.objectContaining({ command_kind: "launch" })] : [],
      });
      expect(alarm).toBe(deadline);
      expect(runner.send).toHaveBeenCalledTimes(nudges);
      expect(browser.deserializeAttachment).not.toHaveBeenCalled();
      expect(browser.send).not.toHaveBeenCalled();
      expect(browser.close).not.toHaveBeenCalled();
    });
  }
});
