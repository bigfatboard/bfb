// ABOUTME: Manages authenticated browser realtime sockets with hibernation-safe attachments.
// ABOUTME: Broadcasts compact cursor invalidations only; D1 replay stays the source of truth.

import { createAuthorizationContext, type SqlDatabase } from "@bfb/db";
import { readLedgerHighWater, rejectRunnerRequest, runnerId, runnerObject } from "@bfb/domain";

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

export type BrowserCloseReason = "session_expired" | "session_revoked" | "authorization_revoked";

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

let fallbackConnection = 0;

export class BrowserSockets {
  private readonly db: SqlDatabase;
  private readonly clock: () => string;
  private readonly ids: () => string;
  private lastBroadcast: number | null = null;

  constructor(
    private readonly sockets: (tag: string) => Iterable<RealtimeSocket>,
    deps: BrowserSocketsDeps,
  ) {
    this.db = deps.db;
    this.clock = deps.now ?? (() => new Date().toISOString());
    this.ids =
      deps.newConnectionId ??
      (() => {
        fallbackConnection += 1;
        return `browser-fallback-${Date.parse(this.clock())}-${fallbackConnection}`;
      });
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

  private async highWater(workspaceId: string, humanId: string, epoch: number): Promise<number> {
    const workspace = (await this.db
      .prepare(`SELECT jurisdiction FROM workspaces WHERE id = ?`)
      .get(workspaceId)) as { jurisdiction: string } | undefined;
    if (
      !workspace ||
      (workspace.jurisdiction !== "eu" &&
        workspace.jurisdiction !== "us" &&
        workspace.jurisdiction !== "global")
    ) {
      throw new Error("unknown workspace jurisdiction");
    }
    return readLedgerHighWater(
      this.db,
      createAuthorizationContext({
        workspaceId,
        principalId: humanId,
        authorizationEpoch: epoch,
        jurisdiction: workspace.jurisdiction,
      }),
    );
  }

  private async recheck(
    attachment: BrowserAttachment,
  ): Promise<{ ok: true } | { ok: false; reason: BrowserCloseReason; code: 4401 | 4403 }> {
    const nowMs = Date.parse(this.clock());
    const session = (await this.db
      .prepare(
        `SELECT session.expires_at AS expires_at
         FROM better_auth_sessions AS session
         JOIN humans AS human
           ON human.better_auth_user_id = session.user_id
         WHERE session.id = ? AND human.id = ?`,
      )
      .get(attachment.sessionId, attachment.humanId)) as { expires_at: string } | undefined;
    if (!session) return { ok: false, reason: "session_revoked", code: 4403 };
    if (
      !Number.isFinite(Date.parse(session.expires_at)) ||
      Date.parse(session.expires_at) <= nowMs
    ) {
      return { ok: false, reason: "session_expired", code: 4401 };
    }
    const member = (await this.db
      .prepare(
        `SELECT membership.role AS role, epoch.authorization_epoch AS authorization_epoch
         FROM workspace_members AS membership
         JOIN workspace_authorization_epochs AS epoch
           ON epoch.workspace_id = membership.workspace_id
          AND epoch.human_id = membership.human_id
         WHERE membership.workspace_id = ?
           AND membership.human_id = ?
           AND membership.authorization_epoch = epoch.authorization_epoch
           AND epoch.revoked_at IS NULL`,
      )
      .get(attachment.workspaceId, attachment.humanId)) as
      { role: string; authorization_epoch: number } | undefined;
    if (
      !member ||
      member.authorization_epoch !== attachment.authorizationEpoch ||
      (member.role !== "owner" && member.role !== "member")
    ) {
      return { ok: false, reason: "authorization_revoked", code: 4403 };
    }
    return { ok: true };
  }

  private closeUnauthorized(
    socket: RealtimeSocket,
    attachment: BrowserAttachment,
    reason: BrowserCloseReason,
    code: 4401 | 4403,
  ): void {
    try {
      socket.send(
        JSON.stringify({
          schema_version: 1,
          kind: "browser.realtime.close",
          workspace_id: attachment.workspaceId,
          reason,
        }),
      );
    } catch {
      // D1 or delivery failure cannot preserve an unauthorized socket.
    } finally {
      this.fail(socket, code, "authorization_required");
    }
  }

  /** Validates the handshake, rechecks authority, stores the attachment, and sends ready. */
  async admit(socket: RealtimeSocket, handshake: unknown): Promise<{ connectionId: string }> {
    const parsed = parseHandshake(handshake);
    if (Date.parse(parsed.sessionExpiresAt) <= Date.parse(this.clock())) {
      rejectRunnerRequest();
    }
    const now = this.clock();
    const attachment: BrowserAttachment = {
      ...parsed,
      connectionId: this.ids(),
      subscribedAt: now,
      lastHeartbeatAt: now,
    };
    const verdict = await this.recheck(attachment);
    if (!verdict.ok) rejectRunnerRequest();
    const highWater = await this.highWater(
      attachment.workspaceId,
      attachment.humanId,
      attachment.authorizationEpoch,
    );
    socket.writeAttachment(attachment);
    socket.send(
      JSON.stringify({
        schema_version: 1,
        kind: "browser.realtime.ready",
        workspace_id: attachment.workspaceId,
        connection_id: attachment.connectionId,
        high_water_cursor: highWater,
        server_time: now,
      }),
    );
    if (this.lastBroadcast === null) this.lastBroadcast = highWater;
    return { connectionId: attachment.connectionId };
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
      const verdict = await this.recheck(attachment);
      if (!verdict.ok) {
        this.closeUnauthorized(socket, attachment, verdict.reason, verdict.code);
        return;
      }
      const now = this.clock();
      attachment.lastHeartbeatAt = now;
      socket.writeAttachment(attachment);
      socket.send(
        JSON.stringify({
          schema_version: 1,
          kind: "browser.realtime.alive",
          workspace_id: attachment.workspaceId,
          connection_id: attachment.connectionId,
          server_time: now,
        }),
      );
    } catch {
      this.fail(socket, 1008, "request_rejected");
    }
  }

  /**
   * Rechecks every browser socket after a committed workspace command and
   * broadcasts the new high-water cursor when the ledger advanced. Called in
   * the same transport FIFO as the command commit. One hub instance serves
   * one workspace, so one high-water read fans out to every survivor.
   */
  async afterCommand(): Promise<void> {
    const survivors: Array<{ socket: RealtimeSocket; attachment: BrowserAttachment }> = [];
    for (const socket of this.live()) {
      let attachment: BrowserAttachment;
      try {
        attachment = parseAttachment(socket.readAttachment());
      } catch {
        this.fail(socket, 1008, "request_rejected");
        continue;
      }
      const verdict = await this.recheck(attachment);
      if (!verdict.ok) {
        this.closeUnauthorized(socket, attachment, verdict.reason, verdict.code);
        continue;
      }
      survivors.push({ socket, attachment });
    }
    if (survivors.length === 0) return;
    const first = survivors[0] as { socket: RealtimeSocket; attachment: BrowserAttachment };
    try {
      const highWater = await this.highWater(
        first.attachment.workspaceId,
        first.attachment.humanId,
        first.attachment.authorizationEpoch,
      );
      if (this.lastBroadcast === null) {
        this.lastBroadcast = highWater;
      } else if (highWater > this.lastBroadcast) {
        this.lastBroadcast = highWater;
        for (const { socket, attachment } of survivors) {
          socket.send(
            JSON.stringify({
              schema_version: 1,
              kind: "event.committed",
              workspace_id: attachment.workspaceId,
              high_water_cursor: highWater,
            }),
          );
        }
      }
    } catch {
      // The business command already committed; fail the ephemeral channel,
      // not its durable outcome. Reconnect replays from D1.
      for (const { socket } of survivors) this.fail(socket, 1011, "channel_unavailable");
    }
  }

  /** Rechecks every browser socket on the persistent expiry alarm. */
  async alarm(): Promise<void> {
    for (const socket of this.live()) {
      let attachment: BrowserAttachment;
      try {
        attachment = parseAttachment(socket.readAttachment());
      } catch {
        this.fail(socket, 1008, "request_rejected");
        continue;
      }
      const verdict = await this.recheck(attachment);
      if (!verdict.ok) this.closeUnauthorized(socket, attachment, verdict.reason, verdict.code);
    }
  }

  /** Earliest attached session expiry over live sockets; closes corrupt attachments. */
  earliestExpiry(): number {
    let expiry = Number.POSITIVE_INFINITY;
    for (const socket of this.live()) {
      try {
        expiry = Math.min(
          expiry,
          Date.parse(parseAttachment(socket.readAttachment()).sessionExpiresAt),
        );
      } catch {
        this.fail(socket, 1008, "request_rejected");
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
        this.fail(socket, 1008, "request_rejected");
      }
    }
    try {
      if (Number.isFinite(expiry)) {
        await setAlarm(Math.max(Date.parse(this.clock()) + 1, expiry));
      } else {
        await deleteAlarm();
      }
    } catch {
      // No live authority may outlast expiry if the persistent timer is lost.
      for (const socket of this.live()) this.fail(socket, 1011, "channel_unavailable");
    }
  }
}
