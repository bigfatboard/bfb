// ABOUTME: Jurisdiction-scoped WorkspaceHub Durable Object that serializes workspace mutations.
// ABOUTME: One DO instance per workspace id; domain hub executes against the Worker D1 binding.

import { adaptD1 } from "@bfb/db";
import { DurableObject } from "cloudflare:workers";
import {
  type CommandRequest,
  resolveCommand,
  WorkspaceHub as DomainWorkspaceHub,
} from "@bfb/domain";

import type { ControlBindings } from "./env.js";

/**
 * Cloudflare Durable Object entry for the workspace command kernel.
 * DO single-threading plus the domain FIFO lane serialize concurrent mutations.
 */
export class WorkspaceHub extends DurableObject<ControlBindings> {
  private domainLane: DomainWorkspaceHub | null = null;

  constructor(ctx: DurableObjectState, env: ControlBindings) {
    super(ctx, env);
  }

  private lane(): DomainWorkspaceHub {
    if (!this.domainLane) {
      this.domainLane = new DomainWorkspaceHub(adaptD1(this.env.DB));
    }
    return this.domainLane;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed", message: "WorkspaceHub accepts POST /execute only" },
        { status: 405 },
      );
    }

    let body: { commandName?: string; request?: CommandRequest<unknown> };
    try {
      body = (await request.json()) as typeof body;
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
