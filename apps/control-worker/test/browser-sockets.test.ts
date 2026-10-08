// ABOUTME: Exercises retained browser socket admission, attachment and heartbeat codecs.
// ABOUTME: Public feeds stay unavailable while legacy attachments retire without source reads or command nudges.

import type { SqlDatabase } from "@bfb/db";
import { FIX, randomUlid } from "@bfb/domain";
import { describe, expect, it } from "vitest";

import {
  BROWSER_REALTIME_TAG,
  BrowserSockets,
  type BrowserHandshake,
  type RealtimeSocket,
} from "../src/realtime/browser-sockets.js";

const NOW = "2026-09-12T12:00:00.000Z";
const LATER = "2026-09-12T12:00:20.000Z";
const EXPIRY = "2026-09-12T13:00:00.000Z";
const handshake: BrowserHandshake = {
  schema_version: 1,
  workspaceId: FIX.workspace,
  humanId: FIX.owner,
  authorizationEpoch: 1,
  role: "owner",
  sessionId: "synthetic-retained-session",
  sessionExpiresAt: EXPIRY,
};
const noDatabase = {
  prepare() {
    throw new Error("browser retirement must not read D1");
  },
  withTransaction() {
    throw new Error("browser retirement must not write D1");
  },
} as SqlDatabase;

function peer(attachment: unknown) {
  const closed: Array<{ code: number; reason: string }> = [],
    sent: string[] = [];
  const socket: RealtimeSocket = {
    readyState: 1,
    send(frame) {
      sent.push(frame);
    },
    close(code, reason) {
      closed.push({ code, reason });
    },
    readAttachment() {
      return attachment;
    },
    writeAttachment() {
      throw new Error("no new attachment");
    },
  };
  return { socket, closed, sent };
}
function retained() {
  return { ...handshake, connectionId: randomUlid(), subscribedAt: NOW, lastHeartbeatAt: NOW };
}
function manager(socket: RealtimeSocket, now = NOW) {
  return new BrowserSockets((tag) => (tag === BROWSER_REALTIME_TAG ? [socket] : []), {
    db: noDatabase,
    now: () => now,
  });
}

describe("held browser sockets and retained codecs", () => {
  it("preserves malformed/expired admission before the uniform availability denial", async () => {
    const p = peer(null),
      sockets = manager(p.socket);
    for (const input of [
      { schema_version: 1 },
      { ...handshake, role: "reviewer" },
      { ...handshake, sessionExpiresAt: NOW },
    ]) {
      await expect(sockets.admit(p.socket, input)).rejects.toMatchObject({
        code: "request_rejected",
        message: "request rejected",
      });
    }
    await expect(sockets.admit(p.socket, handshake)).rejects.toMatchObject({
      code: "request_rejected",
      message: "event feeds are unavailable",
    });
    expect(p.sent).toEqual([]);
    expect(p.closed).toEqual([]);
  });
  it("recognizes retained hibernation attachments and rejects corrupt identity", () => {
    const p = peer(retained()),
      sockets = manager(p.socket);
    expect(sockets.owns(p.socket)).toBe(true);
    expect(sockets.owns(peer({ malformed: true }).socket)).toBe(false);
    expect(sockets.owns(peer({ ...retained(), connectionId: "invalid" }).socket)).toBe(false);
  });
  it("retains heartbeat envelope and minimum-gap admission without emitting liveness", async () => {
    const attachment = retained();
    for (const [now, frame, reason] of [
      [
        NOW,
        {
          schema_version: 1,
          kind: "browser.realtime.heartbeat",
          workspace_id: FIX.workspace,
          connection_id: attachment.connectionId,
        },
        "request_rejected",
      ],
      [
        LATER,
        {
          schema_version: 1,
          kind: "browser.realtime.heartbeat",
          workspace_id: FIX.workspace,
          connection_id: randomUlid(),
        },
        "request_rejected",
      ],
      [
        LATER,
        {
          schema_version: 1,
          kind: "browser.realtime.heartbeat",
          workspace_id: FIX.workspace,
          connection_id: attachment.connectionId,
        },
        "event_feeds_unavailable",
      ],
    ] as const) {
      const p = peer(attachment);
      await manager(p.socket, now).message(p.socket, JSON.stringify(frame));
      expect(p.closed).toEqual([{ code: 1008, reason }]);
      expect(p.sent).toEqual([]);
    }
  });
  it("keeps early shared alarms and malformed deadlines quiet, retiring only due sessions", async () => {
    const valid = peer(retained()),
      corrupt = peer({ malformed: true });
    await manager(valid.socket).alarm();
    await manager(corrupt.socket).alarm();
    expect(valid.closed).toEqual([]);
    expect(corrupt.closed).toEqual([]);
    expect(manager(corrupt.socket).earliestExpiry()).toBe(Number.POSITIVE_INFINITY);
    await manager(valid.socket, EXPIRY).alarm();
    expect(valid.closed).toEqual([{ code: 1008, reason: "event_feeds_unavailable" }]);
    await manager(corrupt.socket).message(corrupt.socket, "{}");
    expect(corrupt.closed).toEqual([{ code: 1008, reason: "request_rejected" }]);
    expect(valid.sent).toEqual([]);
    expect(corrupt.sent).toEqual([]);
  });
  it("preserves expiry scheduling and quiet timer loss for retained sockets", async () => {
    const p = peer(retained()),
      sockets = manager(p.socket),
      alarms: number[] = [];
    await sockets.schedule(
      async (at) => {
        alarms.push(at);
      },
      async () => {
        throw new Error("unreachable");
      },
    );
    expect(alarms).toEqual([Date.parse(EXPIRY)]);
    await sockets.schedule(
      async () => {
        throw new Error("synthetic alarm loss");
      },
      async () => {},
    );
    expect(p.closed).toEqual([]);
    let deleted = false;
    await new BrowserSockets(() => [], { db: noDatabase }).schedule(
      async () => {},
      async () => {
        deleted = true;
      },
    );
    expect(deleted).toBe(true);
  });
});
