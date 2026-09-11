// ABOUTME: Jurisdiction-scoped WorkspaceHub Durable Object that serializes workspace mutations.
// ABOUTME: One DO instance per workspace id; domain hub executes against the Worker D1 binding.

import { adaptD1 } from "@bfb/db";
import { DurableObject } from "cloudflare:workers";
import {
  type CommandRequest,
  resolveCommand,
  WorkspaceHub as DomainWorkspaceHub,
  runnerObject,
  runnerId,
  type RunnerPrincipal,
} from "@bfb/domain";

import type { ControlBindings } from "./env.js";
import { RunnerChannels } from "./runner-channels.js";

const MAX_COMMAND_BYTES = 65_536;

/**
 * Cloudflare Durable Object entry for the workspace command kernel.
 * DO single-threading plus the domain FIFO lane serialize concurrent mutations.
 */
export class WorkspaceHub extends DurableObject<ControlBindings> {
  private domainLane: DomainWorkspaceHub | null = null;
  private readonly channels: RunnerChannels;
  private transportTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: ControlBindings) {
    super(ctx, env);
    this.channels = new RunnerChannels(ctx, env.DB, () => this.lane());
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
    return this.serial(() => this.channels.message(socket, message));
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    return this.serial(() => this.channels.closed(socket));
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    return this.serial(() => this.channels.closed(socket));
  }

  override async alarm(): Promise<void> {
    return this.serial(() => this.channels.alarm());
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/runner/connect" && request.method === "GET") {
      try {
        const metadata = request.headers.get("x-bfb-runner-principal");
        if (!metadata || metadata.length > 8192 || request.headers.get("upgrade") !== "websocket")
          throw new Error("invalid runner channel metadata");
        return await this.channels.open(JSON.parse(metadata) as RunnerPrincipal);
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
      if (outcome.ok) await this.channels.afterCommand();
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
