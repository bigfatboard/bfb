// ABOUTME: Manages authenticated browser realtime sockets with hibernation-safe attachments.
// ABOUTME: Holds new public admissions and retires legacy attachments independently of workspace commands.

import type { SqlDatabase } from "@bfb/db";
import { DomainError, rejectRunnerRequest, runnerId, runnerObject } from "@bfb/domain";

export const BROWSER_REALTIME_TAG = "bfb-browser";
export const BROWSER_REALTIME_PROTOCOL = "bfb.browser.v1";
export const BROWSER_MESSAGE_LIMIT = 8192;
export const BROWSER_HEARTBEAT_MIN_GAP_MS = 10_000;

/** Transport-neutral socket surface shared by hibernating DO sockets and test adapters. */
export interface RealtimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code: number, reason: string): void;
  readAttachment(): unknown;
  writeAttachment(value: unknown): void;
}

export interface BrowserHandshake {
  schema_version: 1;
  workspaceId: string;
  humanId: string;
  authorizationEpoch: number;
  role: string;
  sessionId: string;
  sessionExpiresAt: string;
}

export interface BrowserAttachment extends BrowserHandshake {
  connectionId: string;
  subscribedAt: string;
  lastHeartbeatAt: string;
}

const ATTACHMENT_KEYS = [
  "schema_version",
  "workspaceId",
  "humanId",
  "authorizationEpoch",
  "role",
  "sessionId",
  "sessionExpiresAt",
  "connectionId",
  "subscribedAt",
  "lastHeartbeatAt",
] as const;

const HANDSHAKE_KEYS = [
  "schema_version",
  "workspaceId",
  "humanId",
  "authorizationEpoch",
  "role",
  "sessionId",
  "sessionExpiresAt",
] as const;

function parseAttachment(value: unknown): BrowserAttachment {
  const record = runnerObject(value, [...ATTACHMENT_KEYS]);
  if (record.schema_version !== 1) rejectRunnerRequest();
  const attachment = {
    schema_version: 1 as const,
    workspaceId: runnerId(record.workspaceId),
    humanId: runnerId(record.humanId),
    authorizationEpoch: record.authorizationEpoch,
    role: record.role,
    sessionId: record.sessionId,
    sessionExpiresAt: record.sessionExpiresAt,
    connectionId: runnerId(record.connectionId),
    subscribedAt: record.subscribedAt,
    lastHeartbeatAt: record.lastHeartbeatAt,
  };
  if (
    !Number.isSafeInteger(attachment.authorizationEpoch) ||
    (attachment.authorizationEpoch as number) < 0 ||
    typeof attachment.role !== "string" ||
    typeof attachment.sessionId !== "string" ||
    attachment.sessionId.length < 1 ||
    attachment.sessionId.length > 256 ||
    !Number.isFinite(Date.parse(attachment.sessionExpiresAt as string)) ||
    !Number.isFinite(Date.parse(attachment.subscribedAt as string)) ||
    !Number.isFinite(Date.parse(attachment.lastHeartbeatAt as string))
  ) {
    rejectRunnerRequest();
  }
  return attachment as BrowserAttachment;
}

function parseHandshake(value: unknown): BrowserHandshake {
  const record = runnerObject(value, [...HANDSHAKE_KEYS]);
  if (record.schema_version !== 1) rejectRunnerRequest();
  const handshake = {
    schema_version: 1 as const,
    workspaceId: runnerId(record.workspaceId),
    humanId: runnerId(record.humanId),
    authorizationEpoch: record.authorizationEpoch,
    role: record.role,
    sessionId: record.sessionId,
    sessionExpiresAt: record.sessionExpiresAt,
  };
  if (
    !Number.isSafeInteger(handshake.authorizationEpoch) ||
    (handshake.authorizationEpoch as number) < 0 ||
    (handshake.role !== "owner" && handshake.role !== "member") ||
    typeof handshake.sessionId !== "string" ||
    handshake.sessionId.length < 1 ||
    handshake.sessionId.length > 256 ||
    !Number.isFinite(Date.parse(handshake.sessionExpiresAt as string))
  ) {
    rejectRunnerRequest();
  }
  return handshake as BrowserHandshake;
}

export interface BrowserSocketsDeps {
  db: SqlDatabase;
  now?: () => string;
  newConnectionId?: () => string;
}

export class BrowserSockets {
  private readonly clock: () => string;

  constructor(
    private readonly sockets: (tag: string) => Iterable<RealtimeSocket>,
    deps: BrowserSocketsDeps,
  ) {
    this.clock = deps.now ?? (() => new Date().toISOString());
  }

  /** True when the socket carries a well-formed browser attachment. */
  owns(socket: RealtimeSocket): boolean {
    try {
      parseAttachment(socket.readAttachment());
      return true;
    } catch {
      return false;
    }
  }

  private live(): RealtimeSocket[] {
    return [...this.sockets(BROWSER_REALTIME_TAG)].filter(
      (socket) => socket.readyState === WebSocket.OPEN,
    );
  }

  private fail(socket: RealtimeSocket, code: number, reason: string): void {
    try {
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
    } catch {
      /* Already disconnected. */
    }
  }

  /** Pure admission is retained, but no attachment, source read or ready frame is available. */
  assertAdmission(handshake: unknown): never {
    const parsed = parseHandshake(handshake);
    if (Date.parse(parsed.sessionExpiresAt) <= Date.parse(this.clock())) rejectRunnerRequest();
    throw new DomainError("request_rejected", "event feeds are unavailable");
  }

  async admit(_socket: RealtimeSocket, handshake: unknown): Promise<{ connectionId: string }> {
    return this.assertAdmission(handshake);
  }

  async message(socket: RealtimeSocket, data: string | ArrayBuffer): Promise<void> {
    try {
      if (socket.readyState !== WebSocket.OPEN) return;
      const attachment = parseAttachment(socket.readAttachment());
      if (
        typeof data !== "string" ||
        new TextEncoder().encode(data).byteLength > BROWSER_MESSAGE_LIMIT
      ) {
        rejectRunnerRequest();
      }
      const frame = runnerObject(JSON.parse(data as string), [
        "schema_version",
        "kind",
        "workspace_id",
        "connection_id",
      ]);
      if (
        frame.schema_version !== 1 ||
        frame.kind !== "browser.realtime.heartbeat" ||
        frame.workspace_id !== attachment.workspaceId ||
        frame.connection_id !== attachment.connectionId
      ) {
        rejectRunnerRequest();
      }
      if (
        Date.parse(this.clock()) - Date.parse(attachment.lastHeartbeatAt) <
        BROWSER_HEARTBEAT_MIN_GAP_MS
      ) {
        rejectRunnerRequest();
      }
      this.fail(socket, 1008, "event_feeds_unavailable");
    } catch {
      this.fail(socket, 1008, "request_rejected");
    }
  }

  /** Commands must not reveal their occurrence through browser reads, frames or closes. */
  async afterCommand(): Promise<void> {}

  /** Retires legacy browser attachments independently of workspace commands. */
  async alarm(): Promise<void> {
    for (const socket of this.live()) {
      try {
        const attachment = parseAttachment(socket.readAttachment());
        if (Date.parse(attachment.sessionExpiresAt) <= Date.parse(this.clock())) {
          this.fail(socket, 1008, "event_feeds_unavailable");
        }
      } catch {
        // No deadline can be inferred for a malformed retained attachment.
      }
    }
  }

  /** Earliest retained session expiry; malformed attachments have no inferred deadline. */
  earliestExpiry(): number {
    let expiry = Number.POSITIVE_INFINITY;
    for (const socket of this.live()) {
      try {
        expiry = Math.min(
          expiry,
          Date.parse(parseAttachment(socket.readAttachment()).sessionExpiresAt),
        );
      } catch {
        // A shared runner alarm must not make corruption observable as a close.
      }
    }
    return expiry;
  }

  async schedule(
    setAlarm: (at: number) => Promise<void>,
    deleteAlarm: () => Promise<void>,
  ): Promise<void> {
    let expiry = Number.POSITIVE_INFINITY;
    for (const socket of this.live()) {
      try {
        expiry = Math.min(
          expiry,
          Date.parse(parseAttachment(socket.readAttachment()).sessionExpiresAt),
        );
      } catch {
        // A received frame may reject corruption; scheduling must remain quiet.
      }
    }
    try {
      if (Number.isFinite(expiry)) {
        await setAlarm(Math.max(Date.parse(this.clock()) + 1, expiry));
      } else {
        await deleteAlarm();
      }
    } catch {
      // The held service delivers nothing; timer failure must not become a command hint.
    }
  }
}
