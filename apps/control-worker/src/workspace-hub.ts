// ABOUTME: Jurisdiction-scoped WorkspaceHub Durable Object that serializes workspace mutations.
// ABOUTME: One DO instance per workspace id; domain hub executes against the Worker D1 binding.

import { adaptD1 } from "@bfb/db";
import { DurableObject } from "cloudflare:workers";
import {
  type CommandRequest,
  randomUlid,
  resolveCommand,
  WorkspaceHub as DomainWorkspaceHub,
  runnerObject,
  runnerId,
  type RunnerPrincipal,
} from "@bfb/domain";

import type { ControlBindings } from "./env.js";
import {
  BROWSER_REALTIME_PROTOCOL,
  BROWSER_REALTIME_TAG,
  BrowserSockets,
  type RealtimeSocket,
} from "./realtime/browser-sockets.js";
import { RunnerChannels } from "./runner-channels.js";

const MAX_COMMAND_BYTES = 65_536;
const MAX_PRINCIPAL_BYTES = 2048;

function wrapSocket(socket: WebSocket): RealtimeSocket {
  return {
    get readyState() {
      return socket.readyState;
    },
    send: (data: string) => socket.send(data),
    close: (code: number, reason: string) => {
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
    },
    readAttachment: () => socket.deserializeAttachment(),
    writeAttachment: (value: unknown) => socket.serializeAttachment(value),
  };
}

/**
 * Cloudflare Durable Object entry for the workspace command kernel.
 * DO single-threading plus the domain FIFO lane serialize concurrent mutations.
 */
export class WorkspaceHub extends DurableObject<ControlBindings> {
  private domainLane: DomainWorkspaceHub | null = null;
  private readonly channels: RunnerChannels;
  private readonly browsers: BrowserSockets;
  private transportTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: ControlBindings) {
    super(ctx, env);
    this.channels = new RunnerChannels(ctx, env.DB, () => this.lane());
    this.browsers = new BrowserSockets(
      (tag) => [...ctx.getWebSockets(tag)].map(wrapSocket),
      { db: adaptD1(env.DB), newConnectionId: () => randomUlid() },
    );
  }

  private lane(): DomainWorkspaceHub {
    if (!this.domainLane) {
      this.domainLane = new DomainWorkspaceHub(adaptD1(this.env.DB));
    }
    return this.domainLane;
  }

  override async fetch(request: Request): Promise<Response> {
    return this.serial(() => this.handle(request));
  }

  // Keep channel authorization/attachment and command commit/revocation ordered
  // across external D1 awaits, in addition to the domain command FIFO itself.
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transportTail.then(operation);
    this.transportTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.serial(async () => {
      if (this.browsers.owns(wrapSocket(socket))) {
        await this.browsers.message(wrapSocket(socket), message);
      } else {
        await this.channels.message(socket, message);
      }
      await this.scheduleAlarms();
    });
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    return this.serial(async () => {
      if (!this.browsers.owns(wrapSocket(socket))) await this.channels.closed(socket);
      await this.scheduleAlarms();
    });
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    return this.serial(async () => {
      if (!this.browsers.owns(wrapSocket(socket))) await this.channels.closed(socket);
      await this.scheduleAlarms();
    });
  }

  override async alarm(): Promise<void> {
    return this.serial(async () => {
      await this.channels.alarm();
      await this.browsers.alarm();
      await this.scheduleAlarms();
    });
  }

  /**
   * One shared alarm covers runner expiries and browser session expiries.
   * Either class alone would delete the timer while the other still needs it.
   */
  private async scheduleAlarms(): Promise<void> {
    let expiry = Number.POSITIVE_INFINITY;
    try {
      expiry = Math.min(expiry, this.channels.earliestExpiry(), this.browsers.earliestExpiry());
    } catch {
      // Corrupt attachments are already closed by the expiry readers.
    }
    try {
      if (Number.isFinite(expiry)) {
        await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, expiry));
      } else {
        await this.ctx.storage.deleteAlarm();
      }
    } catch {
      // No live authority may outlast expiry if the persistent timer is lost.
      for (const socket of this.ctx.getWebSockets()) {
        try {
          if (socket.readyState === WebSocket.OPEN) socket.close(1011, "channel_unavailable");
        } catch {
          /* Already disconnected. */
        }
      }
    }
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/browser/connect" && request.method === "GET") {
      try {
        const metadata = request.headers.get("x-bfb-browser-principal");
        if (!metadata || new TextEncoder().encode(metadata).byteLength > MAX_PRINCIPAL_BYTES)
          throw new Error("invalid browser principal metadata");
        if (
          request.headers.get("upgrade") !== "websocket" ||
          request.headers.get("sec-websocket-protocol") !== BROWSER_REALTIME_PROTOCOL
        )
          throw new Error("invalid browser upgrade");
        const handshake = JSON.parse(metadata) as unknown;
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        this.ctx.acceptWebSocket(server, [BROWSER_REALTIME_TAG]);
        try {
          await this.browsers.admit(wrapSocket(server), handshake);
          await this.scheduleAlarms();
        } catch (error) {
          try {
            server.close(1011, "channel_unavailable");
          } catch {
            /* Already disconnected. */
          }
          throw error;
        }
        return new Response(null, {
          status: 101,
          webSocket: client,
          headers: {
            "sec-websocket-protocol": BROWSER_REALTIME_PROTOCOL,
            "cache-control": "no-store",
          },
        });
      } catch {
        return Response.json(
          { error: "request_rejected" },
          { status: 403, headers: { "cache-control": "no-store" } },
        );
      }
    }
    if (path === "/runner/connect" && request.method === "GET") {
      try {
        const metadata = request.headers.get("x-bfb-runner-principal");
        if (!metadata || metadata.length > 8192 || request.headers.get("upgrade") !== "websocket")
          throw new Error("invalid runner channel metadata");
        const response = await this.channels.open(JSON.parse(metadata) as RunnerPrincipal);
        await this.scheduleAlarms();
        return response;
      } catch {
        return Response.json(
          { error: "request_rejected" },
          { status: 403, headers: { "cache-control": "no-store" } },
        );
      }
    }
    if (path === "/runner/pull" && request.method === "POST") {
      try {
        const text = await request.text();
        if (new TextEncoder().encode(text).byteLength > 8192)
          throw new Error("runner pull is too large");
        const body = runnerObject(JSON.parse(text), ["principal", "after"]);
        return await this.channels.pull(
          body.principal as RunnerPrincipal,
          body.after === undefined ? undefined : runnerId(body.after),
        );
      } catch {
        return Response.json(
          { error: "request_rejected" },
          { status: 403, headers: { "cache-control": "no-store" } },
        );
      }
    }
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed", message: "WorkspaceHub accepts POST /execute only" },
        { status: 405 },
      );
    }

    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_COMMAND_BYTES) {
      return Response.json(
        { error: "body_too_large", message: "hub command body exceeds the limit" },
        { status: 413 },
      );
    }

    let body: { commandName?: string; request?: CommandRequest<unknown> };
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_COMMAND_BYTES) {
        return Response.json(
          { error: "body_too_large", message: "hub command body exceeds the limit" },
          { status: 413 },
        );
      }
      body = JSON.parse(text) as typeof body;
    } catch {
      return Response.json(
        { error: "schema_invalid", message: "invalid hub command body" },
        { status: 400 },
      );
    }

    if (!body.commandName || !body.request) {
      return Response.json(
        { error: "schema_invalid", message: "commandName and request are required" },
        { status: 400 },
      );
    }

    const command = resolveCommand(body.commandName);
    if (!command) {
      return Response.json(
        { error: "unknown_command", message: `unknown command ${body.commandName}` },
        { status: 400 },
      );
    }

    try {
      const outcome = await this.lane().execute(command, body.request);
      if (outcome.ok) {
        await this.channels.afterCommand();
        await this.browsers.afterCommand();
        await this.scheduleAlarms();
      }
      return Response.json(outcome);
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: {
            code: "hub_execute_failed",
            message: error instanceof Error ? error.message : "hub execute failed",
          },
        },
        { status: 500 },
      );
    }
  }
}
