// ABOUTME: Manages hibernating runner sockets with current-epoch rechecks and persistent expiry alarms.
// ABOUTME: Sends only connection observations and recoverable nudges; D1 remains authority for every command.

export const RUNNER_SOCKET_TAG = "bfb-runner";

import { adaptD1, type SqlDatabase } from "@bfb/db";
import {
  assertCurrentRunnerPrincipal,
  pullRunnerCommands,
  randomUlid,
  rejectRunnerRequest,
  runnerObject,
  runnerId,
  touchRunnerConnectionCommand,
  type RunnerPrincipal,
  type WorkspaceHub as DomainWorkspaceHub,
} from "@bfb/domain";
import { decodeWireDocument, type RunnerChannelMessage } from "@bfb/protocol";

interface Attachment {
  schema_version: 1;
  principal: RunnerPrincipal;
  connectionId: string;
  lastHeartbeatAt: string;
  nudgeSequence: number;
}

export class RunnerChannels {
  private readonly db: SqlDatabase;

  constructor(
    private readonly state: DurableObjectState,
    db: D1Database,
    private readonly lane: () => DomainWorkspaceHub,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.db = adaptD1(db);
  }

  private attachment(socket: WebSocket): Attachment {
    const value = runnerObject(socket.deserializeAttachment(), [
      "schema_version",
      "principal",
      "connectionId",
      "lastHeartbeatAt",
      "nudgeSequence",
    ]);
    if (
      value.schema_version !== 1 ||
      typeof value.connectionId !== "string" ||
      typeof value.lastHeartbeatAt !== "string" ||
      !Number.isSafeInteger(value.nudgeSequence) ||
      Number(value.nudgeSequence) < 0 ||
      !value.principal
    )
      rejectRunnerRequest();
    runnerId(value.connectionId);
    const principal = value.principal as RunnerPrincipal;
    if (
      !Number.isFinite(Date.parse(value.lastHeartbeatAt)) ||
      !Number.isFinite(Date.parse(principal.authExpiresAt))
    )
      rejectRunnerRequest();
    return value as unknown as Attachment;
  }

  private async touch(
    principal: RunnerPrincipal,
    connectionId: string,
    mode: "open" | "heartbeat",
  ): Promise<void> {
    const outcome = await this.lane().execute(touchRunnerConnectionCommand, {
      workspaceId: principal.workspaceId,
      actorRunnerId: principal.runnerId,
      authorizationEpoch: principal.authorizationEpoch,
      now: this.now(),
      idempotencyKey: randomUlid(),
      input: { principal, connectionId, mode },
    });
    if (!outcome.ok) rejectRunnerRequest();
  }

  async open(principal: RunnerPrincipal): Promise<Response> {
    const current = await assertCurrentRunnerPrincipal(this.db, principal, this.now());
    if (
      this.state
        .getWebSockets(RUNNER_SOCKET_TAG)
        .filter((socket) => socket.readyState === WebSocket.OPEN).length >= 64
    )
      rejectRunnerRequest();
    const connectionId = randomUlid();
    await this.touch(current, connectionId, "open");
    for (const previous of this.state.getWebSockets(`runner:${current.runnerId}`))
      this.close(previous, 4000, "connection_replaced");
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server, [RUNNER_SOCKET_TAG, `runner:${current.runnerId}`]);
    const attachment: Attachment = {
      schema_version: 1,
      principal: current,
      connectionId,
      lastHeartbeatAt: this.now(),
      nudgeSequence: 0,
    };
    try {
      server.serializeAttachment(attachment);
      this.send(server, attachment, "runner.channel.ready");
      await this.schedule();
    } catch (error) {
      this.close(server, 1011, "channel_unavailable");
      throw error;
    }
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "bfb.runner.v1", "cache-control": "no-store" },
    });
  }

  async pull(principal: RunnerPrincipal, after?: string): Promise<Response> {
    const result = await pullRunnerCommands(this.db, principal, this.now(), after);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  }

  private send(
    socket: WebSocket,
    attachment: Attachment,
    kind: "runner.channel.ready" | "runner.channel.alive" | "runner.commands.available",
  ): void {
    const message: RunnerChannelMessage = {
      schema_version: 1,
      kind,
      workspace_id: attachment.principal.workspaceId,
      runner_id: attachment.principal.runnerId,
      connection_id: attachment.connectionId,
    };
    if (kind !== "runner.commands.available") {
      message.token_epoch = attachment.principal.tokenEpoch;
      message.auth_expires_at = attachment.principal.authExpiresAt;
      message.server_time = this.now();
      message.project_ids = attachment.principal.projectIds;
    }
    socket.send(JSON.stringify(message));
  }

  private close(socket: WebSocket, code: number, reason: string): void {
    try {
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
    } catch {
      /* Already disconnected. */
    }
  }

  private async closeUnauthorized(socket: WebSocket, attachment: Attachment): Promise<void> {
    const principal = attachment.principal;
    try {
      const signal = await this.db
        .prepare(
          `SELECT id AS signal_id, workspace_id, runner_id, authorization_epoch, grant_epoch, token_epoch, reason, removed_human_id, created_at FROM runner_channel_signals WHERE workspace_id = ? AND runner_id = ? AND (authorization_epoch > ? OR grant_epoch > ? OR token_epoch > ?) ORDER BY authorization_epoch DESC, grant_epoch DESC, token_epoch DESC, id DESC LIMIT 1`,
        )
        .get(
          principal.workspaceId,
          principal.runnerId,
          principal.authorizationEpoch,
          principal.grantEpoch,
          principal.tokenEpoch,
        );
      if (signal) {
        socket.send(JSON.stringify({ schema_version: 1, kind: "runner.channel.close", ...signal }));
      }
    } catch {
      // D1 or signal delivery failure cannot preserve an unauthorized socket.
    } finally {
      this.close(
        socket,
        Date.parse(principal.authExpiresAt) <= Date.parse(this.now()) ? 4401 : 4403,
        "authorization_required",
      );
    }
  }

  async message(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      if (socket.readyState !== WebSocket.OPEN) return;
      const attachment = this.attachment(socket);
      if (typeof message !== "string" || new TextEncoder().encode(message).byteLength > 8192)
        rejectRunnerRequest();
      const decoded = decodeWireDocument<RunnerChannelMessage>(
        "runner-channel-message",
        new TextEncoder().encode(message),
      );
      if (
        !decoded.ok ||
        decoded.value.kind !== "runner.channel.heartbeat" ||
        decoded.value.workspace_id !== attachment.principal.workspaceId ||
        decoded.value.runner_id !== attachment.principal.runnerId ||
        decoded.value.connection_id !== attachment.connectionId
      )
        rejectRunnerRequest();
      if (Date.parse(this.now()) - Date.parse(attachment.lastHeartbeatAt) < 10_000)
        rejectRunnerRequest();
      try {
        attachment.principal = await assertCurrentRunnerPrincipal(
          this.db,
          attachment.principal,
          this.now(),
        );
        await this.touch(attachment.principal, attachment.connectionId, "heartbeat");
      } catch {
        await this.closeUnauthorized(socket, attachment);
        return;
      }
      attachment.lastHeartbeatAt = this.now();
      socket.serializeAttachment(attachment);
      this.send(socket, attachment, "runner.channel.alive");
      await this.schedule();
    } catch {
      this.close(socket, 1008, "request_rejected");
    }
  }

  /** Called in the same transport FIFO after every committed workspace command. */
  async afterCommand(): Promise<void> {
    for (const socket of this.state.getWebSockets(RUNNER_SOCKET_TAG)) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      let attachment: Attachment;
      try {
        attachment = this.attachment(socket);
      } catch {
        this.close(socket, 1008, "request_rejected");
        continue;
      }
      try {
        await assertCurrentRunnerPrincipal(this.db, attachment.principal, this.now());
      } catch {
        await this.closeUnauthorized(socket, attachment);
        continue;
      }
      try {
        const pending = (await this.db
          .prepare(
            `SELECT COALESCE(MAX(rowid), 0) AS sequence FROM runner_command_references WHERE workspace_id = ? AND runner_id = ? AND resolved_at IS NULL`,
          )
          .get(attachment.principal.workspaceId, attachment.principal.runnerId)) as {
          sequence: number;
        };
        // This attachment watermark suppresses redundant nudges only. It is not
        // durable delivery or event acknowledgement, and never deletes a record.
        if (pending.sequence !== attachment.nudgeSequence) {
          attachment.nudgeSequence = pending.sequence;
          socket.serializeAttachment(attachment);
          this.send(socket, attachment, "runner.commands.available");
        }
      } catch {
        // The business command already committed; fail the ephemeral channel,
        // not its durable outcome. Reconnect will recover by authenticated pull.
        this.close(socket, 1011, "channel_unavailable");
      }
    }
    await this.schedule();
  }

  async alarm(): Promise<void> {
    await this.afterCommand();
  }

  /** Earliest attached runner expiry over live runner sockets; closes corrupt attachments. */
  earliestExpiry(): number {
    let expiry = Number.POSITIVE_INFINITY;
    for (const socket of this.state.getWebSockets(RUNNER_SOCKET_TAG)) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        expiry = Math.min(expiry, Date.parse(this.attachment(socket).principal.authExpiresAt));
      } catch {
        this.close(socket, 1008, "request_rejected");
      }
    }
    return expiry;
  }

  async schedule(): Promise<void> {
    const expiry = this.earliestExpiry();
    try {
      if (Number.isFinite(expiry))
        await this.state.storage.setAlarm(Math.max(Date.parse(this.now()) + 1, expiry));
      else await this.state.storage.deleteAlarm();
    } catch {
      // No live authority may outlast expiry if the persistent timer is lost.
      for (const socket of this.state.getWebSockets(RUNNER_SOCKET_TAG))
        this.close(socket, 1011, "channel_unavailable");
    }
  }

  async closed(socket: WebSocket): Promise<void> {
    this.close(socket, 1000, "closed");
    await this.schedule();
  }
}
