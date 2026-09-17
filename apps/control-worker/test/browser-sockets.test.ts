// ABOUTME: Proves browser socket admit, heartbeat, broadcast, expiry, and eviction behavior.
// ABOUTME: Uses socket doubles plus real D1 reads; native Workerd acceptance rides the E02 harness.

import { describe, expect, it } from "vitest";

import {
  bumpMemberEpoch,
  FIX,
  ingestRunnerEventsCommand,
  randomUlid,
  type RunnerPrincipal,
} from "@bfb/domain";

import {
  BROWSER_REALTIME_TAG,
  BrowserSockets,
  type BrowserHandshake,
  type RealtimeSocket,
} from "../src/realtime/browser-sockets.js";
import { openAuthTestContext } from "./auth-helpers.js";
import { launchFixture } from "../../../packages/domain/test/launch-fixture.js";

const NOW = "2026-09-12T12:00:00.000Z";
const LATER = "2026-09-12T12:00:20.000Z";
const SESSION_EXPIRY = "2026-09-12T13:00:00.000Z";

type FixtureDb = Awaited<ReturnType<typeof launchFixture>>["db"];

interface FakeSocket extends RealtimeSocket {
  sent: string[];
  closed: Array<{ code: number; reason: string }>;
  attachment: unknown;
}

function fakeSocket(attachment: unknown = null): FakeSocket {
  const socket: FakeSocket = {
    readyState: 1,
    sent: [],
    closed: [],
    attachment,
    send(data: string): void {
      socket.sent.push(data);
    },
    close(code: number, reason: string): void {
      socket.closed.push({ code, reason });
      socket.readyState = 3;
    },
    readAttachment(): unknown {
      return socket.attachment;
    },
    writeAttachment(value: unknown): void {
      socket.attachment = value;
    },
  };
  return socket;
}

async function fixture() {
  const context = openAuthTestContext(NOW);
  const launched = await launchFixture(context.db);
  const claimed = await launched.claim();
  const bound = {
    executionId: claimed.claimed.specification.run_execution_id,
    generation: claimed.claimed.specification.assignment_generation,
  };
  for (const [humanId, userId, sessionId] of [
    [FIX.owner, "auth-owner-e02", "session-owner-e02"],
    [FIX.member, "auth-member-e02", "session-member-e02"],
  ] as const) {
    context.raw
      .prepare(
        `INSERT INTO better_auth_users (id, name, email, email_verified, image, created_at, updated_at)
         VALUES (?, ?, ?, 1, NULL, ?, ?)`,
      )
      .run(userId, `E02 ${humanId}`, `${userId}@synthetic.test`, NOW, NOW);
    context.raw
      .prepare(
        `INSERT INTO better_auth_sessions
         (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(sessionId, SESSION_EXPIRY, `token-${sessionId}`, NOW, NOW, userId);
    context.raw
      .prepare(`UPDATE humans SET better_auth_user_id = ? WHERE id = ?`)
      .run(userId, humanId);
  }
  const stream = randomUlid();
  let sequence = 0;
  async function commit(
    kinds: string[],
    extra: Record<string, unknown> = {},
    principal: RunnerPrincipal = launched.principal,
  ): Promise<number> {
    const events = kinds.map((kind) => {
      sequence += 1;
      return {
        schema_version: 1,
        event_id: randomUlid(),
        source_stream_id: stream,
        source_sequence: sequence,
        run_execution_id: bound.executionId,
        assignment_generation: bound.generation,
        kind,
        occurred_at: NOW,
        capture_origin: "runner_observed",
        payload: {},
        ...extra,
      };
    });
    const outcome = await launched.hub.execute(ingestRunnerEventsCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorRunnerId: principal.runnerId,
      authorizationEpoch: principal.authorizationEpoch,
      now: NOW,
      input: { principal, events },
    });
    if (!outcome.ok) throw new Error(outcome.error.code);
    return outcome.result.high_water_cursor;
  }
  return { context, db: launched.db, commit, principal: launched.principal };
}

function handshake(
  humanId: string,
  sessionId: string,
  extra: Partial<BrowserHandshake> = {},
): BrowserHandshake {
  return {
    schema_version: 1,
    workspaceId: FIX.workspace,
    humanId,
    authorizationEpoch: 1,
    role: "owner",
    sessionId,
    sessionExpiresAt: SESSION_EXPIRY,
    ...extra,
  };
}

let connection = 0;

function manager(db: FixtureDb, sockets: FakeSocket[], now = NOW) {
  return new BrowserSockets((tag) => (tag === BROWSER_REALTIME_TAG ? sockets : []), {
    db,
    now: () => now,
    newConnectionId: () => {
      connection += 1;
      return `01K0000000000000000E02${String(connection).padStart(4, "0")}`;
    },
  });
}

function kinds(socket: FakeSocket): unknown[] {
  return socket.sent.map((raw) => (JSON.parse(raw) as { kind: string }).kind);
}

describe("browser realtime sockets", () => {
  it("admits with ready high-water and keeps secrets out of the attachment", async () => {
    const f = await fixture();
    const water = await f.commit(["heartbeat"]);
    const socket = fakeSocket();
    const sockets = manager(f.db, [socket]);
    const { connectionId } = await sockets.admit(socket, handshake(FIX.owner, "session-owner-e02"));
    expect(connectionId).toMatch(/^01K/);
    expect(socket.sent.map((raw) => JSON.parse(raw))).toEqual([
      {
        schema_version: 1,
        kind: "browser.realtime.ready",
        workspace_id: FIX.workspace,
        connection_id: connectionId,
        high_water_cursor: water,
        server_time: NOW,
      },
    ]);
    const stored = JSON.stringify(socket.attachment);
    expect(stored).not.toContain("token-session-owner-e02");
    expect(stored).not.toContain("cookie");
    expect(stored).not.toContain("bearer");
    expect(stored).not.toContain("secret");
    expect(socket.attachment).toMatchObject({
      workspaceId: FIX.workspace,
      humanId: FIX.owner,
      authorizationEpoch: 1,
      sessionExpiresAt: SESSION_EXPIRY,
    });
  });

  it("rejects expired sessions and unknown handshakes without a socket", async () => {
    const f = await fixture();
    const sockets = manager(f.db, []);
    await expect(
      sockets.admit(
        fakeSocket(),
        handshake(FIX.owner, "session-owner-e02", { sessionExpiresAt: NOW }),
      ),
    ).rejects.toThrow();
    await expect(
      sockets.admit(fakeSocket(), { schema_version: 1, workspaceId: FIX.workspace }),
    ).rejects.toThrow();
    await expect(
      sockets.admit(fakeSocket(), handshake(FIX.owner, "session-owner-e02", { role: "reviewer" })),
    ).rejects.toThrow();
  });

  it("rejects heartbeats that arrive too frequently", async () => {
    const f = await fixture();
    const socket = fakeSocket();
    const sockets = manager(f.db, [socket]);
    const { connectionId } = await sockets.admit(socket, handshake(FIX.owner, "session-owner-e02"));
    await sockets.message(
      socket,
      JSON.stringify({
        schema_version: 1,
        kind: "browser.realtime.heartbeat",
        workspace_id: FIX.workspace,
        connection_id: connectionId,
      }),
    );
    expect(socket.closed.map((entry) => entry.code)).toEqual([1008]);
  });

  it("rechecks authorization on heartbeat and answers liveness after the gap", async () => {
    const f = await fixture();
    const socket = fakeSocket();
    const early = manager(f.db, [socket], NOW);
    const { connectionId } = await early.admit(socket, handshake(FIX.owner, "session-owner-e02"));
    const late = manager(f.db, [socket], LATER);
    await late.message(
      socket,
      JSON.stringify({
        schema_version: 1,
        kind: "browser.realtime.heartbeat",
        workspace_id: FIX.workspace,
        connection_id: connectionId,
      }),
    );
    expect(kinds(socket)).toEqual(["browser.realtime.ready", "browser.realtime.alive"]);
    await late.message(
      socket,
      JSON.stringify({
        schema_version: 1,
        kind: "browser.realtime.heartbeat",
        workspace_id: "01K00000000000000000000099",
        connection_id: connectionId,
      }),
    );
    expect(socket.closed.map((entry) => entry.code)).toEqual([1008]);
  });

  it("broadcasts compact cursor invalidations only when the ledger advances", async () => {
    const f = await fixture();
    await f.commit(["heartbeat"]);
    const owner = fakeSocket();
    const member = fakeSocket();
    const sockets = manager(f.db, [owner, member]);
    await sockets.admit(owner, handshake(FIX.owner, "session-owner-e02"));
    await sockets.admit(member, handshake(FIX.member, "session-member-e02", { role: "member" }));
    await sockets.afterCommand();
    expect(owner.sent).toHaveLength(1);
    const water = await f.commit(["turn_started"]);
    await sockets.afterCommand();
    for (const socket of [owner, member]) {
      const last = JSON.parse(socket.sent[socket.sent.length - 1] as string) as Record<
        string,
        unknown
      >;
      expect(last).toEqual({
        schema_version: 1,
        kind: "event.committed",
        workspace_id: FIX.workspace,
        high_water_cursor: water,
      });
    }
    await sockets.afterCommand();
    expect(owner.sent.filter((raw) => raw.includes("event.committed"))).toHaveLength(1);
  });

  it("closes only the expired socket and keeps the survivor subscribed", async () => {
    const f = await fixture();
    const owner = fakeSocket();
    const member = fakeSocket();
    const sockets = manager(f.db, [owner, member]);
    await sockets.admit(owner, handshake(FIX.owner, "session-owner-e02"));
    await sockets.admit(member, handshake(FIX.member, "session-member-e02", { role: "member" }));
    await f.db
      .prepare(`UPDATE better_auth_sessions SET expires_at = ? WHERE id = ?`)
      .run(NOW, "session-owner-e02");
    await f.commit(["heartbeat"]);
    await sockets.afterCommand();
    expect(owner.closed.map((entry) => entry.code)).toEqual([4401]);
    expect(JSON.parse(owner.sent[owner.sent.length - 1] as string)).toMatchObject({
      kind: "browser.realtime.close",
      reason: "session_expired",
    });
    expect(member.closed).toEqual([]);
    expect(kinds(member).pop()).toBe("event.committed");
  });

  it("closes sockets whose membership epoch changed without disturbing others", async () => {
    const f = await fixture();
    const owner = fakeSocket();
    const member = fakeSocket();
    const sockets = manager(f.db, [owner, member]);
    await sockets.admit(owner, handshake(FIX.owner, "session-owner-e02"));
    await sockets.admit(member, handshake(FIX.member, "session-member-e02", { role: "member" }));
    await bumpMemberEpoch(f.db, FIX.workspace, FIX.owner);
    await sockets.alarm();
    expect(owner.closed.map((entry) => entry.code)).toEqual([4403]);
    expect(JSON.parse(owner.sent[owner.sent.length - 1] as string)).toMatchObject({
      kind: "browser.realtime.close",
      reason: "authorization_revoked",
    });
    expect(member.closed).toEqual([]);
  });

  it("recovers identity after eviction without bearer material", async () => {
    const f = await fixture();
    const socket = fakeSocket();
    await manager(f.db, [socket]).admit(socket, handshake(FIX.owner, "session-owner-e02"));
    // Eviction drops the manager; hibernation restores the serialized attachment.
    const restored = fakeSocket(JSON.parse(JSON.stringify(socket.attachment)));
    const next = manager(f.db, [restored], LATER);
    expect(next.owns(restored)).toBe(true);
    await next.message(
      restored,
      JSON.stringify({
        schema_version: 1,
        kind: "browser.realtime.heartbeat",
        workspace_id: FIX.workspace,
        connection_id: (restored.attachment as { connectionId: string }).connectionId,
      }),
    );
    expect(kinds(restored)).toEqual(["browser.realtime.alive"]);
  });

  it("never reflects hostile event strings in invalidations", async () => {
    const f = await fixture();
    const socket = fakeSocket();
    const sockets = manager(f.db, [socket]);
    await sockets.admit(socket, handshake(FIX.owner, "session-owner-e02"));
    await f.commit(["heartbeat"], {
      provider_session_id: "<script>alert(document.cookie)</script>",
    });
    await sockets.afterCommand();
    expect(socket.sent.join("\n")).not.toContain("<script>");
    expect(socket.sent.join("\n")).not.toContain("alert(");
  });

  it("schedules the earliest session expiry and fails closed without a timer", async () => {
    const f = await fixture();
    const socket = fakeSocket();
    const sockets = manager(f.db, [socket]);
    await sockets.admit(socket, handshake(FIX.owner, "session-owner-e02"));
    const alarms: number[] = [];
    let deleted = 0;
    await sockets.schedule(
      async (at: number) => {
        alarms.push(at);
      },
      async () => {
        deleted += 1;
      },
    );
    expect(alarms).toEqual([Date.parse(SESSION_EXPIRY)]);
    expect(deleted).toBe(0);
    await manager(f.db, []).schedule(
      async () => {
        throw new Error("unreachable");
      },
      async () => {
        deleted += 1;
      },
    );
    expect(deleted).toBe(1);
    const failing = manager(f.db, [socket]);
    await failing.schedule(
      async () => {
        throw new Error("synthetic alarm loss");
      },
      async () => {
        throw new Error("unreachable");
      },
    );
    expect(socket.closed.map((entry) => entry.code).pop()).toBe(1011);
  });
});
