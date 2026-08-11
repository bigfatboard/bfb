// ABOUTME: Routes workspace mutations through the jurisdiction-scoped WorkspaceHub DO when bound.
// ABOUTME: Falls back to a process-local FIFO lane only when the DO namespace is unavailable (unit tests).

import type { SqlDatabase } from "@bfb/db";
import {
  type CommandOutcome,
  type CommandRequest,
  type HubCommand,
  resolveCommand,
  workspaceHub,
} from "@bfb/domain";

export interface HubClientDeps {
  db: SqlDatabase;
  workspaceId: string;
  /** Cloudflare WORKSPACE_HUB binding, or a test double with idFromName/get. */
  workspaceHubNs?: DurableObjectNamespace | undefined;
}

function isDurableObjectNamespace(
  value: DurableObjectNamespace | undefined,
): value is DurableObjectNamespace {
  if (!value || typeof value !== "object") {
    return false;
  }
  const ns = value as DurableObjectNamespace;
  return typeof ns.idFromName === "function" && typeof ns.get === "function";
}

/**
 * Executes a domain command on the workspace command lane.
 * Prefer Durable Object serialization (one instance per workspace id); local FIFO is test-only fallback.
 */
export async function executeWorkspaceCommand<TInput, TResult>(
  deps: HubClientDeps,
  command: HubCommand<TInput, TResult>,
  request: CommandRequest<TInput>,
): Promise<CommandOutcome<TResult>> {
  if (request.workspaceId !== deps.workspaceId) {
    return {
      ok: false,
      error: {
        code: "workspace_mismatch",
        message: "command workspace does not match hub jurisdiction scope",
      },
    };
  }

  if (isDurableObjectNamespace(deps.workspaceHubNs)) {
    try {
      const id = deps.workspaceHubNs.idFromName(deps.workspaceId);
      const stub = deps.workspaceHubNs.get(id);
      const response = await stub.fetch("https://bfb-hub.internal/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandName: command.name,
          request,
        }),
      });
      const body = (await response.json()) as CommandOutcome<TResult> & {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        return {
          ok: false,
          error: {
            code: typeof body.error === "string" ? body.error : "hub_rpc_failed",
            message:
              typeof body.message === "string"
                ? body.message
                : `hub DO returned ${response.status}`,
          },
        };
      }
      return body as CommandOutcome<TResult>;
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "hub_rpc_failed",
          message: error instanceof Error ? error.message : "hub DO call failed",
        },
      };
    }
  }

  // Unit-test fallback when env.WORKSPACE_HUB is a non-DO synthetic binding.
  return workspaceHub(deps.db, deps.workspaceId).execute(command, request);
}

/** Builds an in-memory DO namespace that serializes via one Domain WorkspaceHub per workspace. */
export function createTestWorkspaceHubNamespace(db: SqlDatabase): DurableObjectNamespace {
  const lanes = new Map<string, ReturnType<typeof workspaceHub>>();

  const ns = {
    idFromName(name: string) {
      return {
        name,
        toString() {
          return name;
        },
      } as DurableObjectId;
    },
    idFromString(id: string) {
      return {
        name: id,
        toString() {
          return id;
        },
      } as DurableObjectId;
    },
    newUniqueId() {
      throw new Error("newUniqueId is not used for workspace hubs");
    },
    getByName(name: string) {
      return ns.get(ns.idFromName(name));
    },
    get(id: DurableObjectId) {
      const workspaceId = String(id);
      return {
        async fetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          const raw = init?.body;
          const text =
            typeof raw === "string"
              ? raw
              : raw instanceof ArrayBuffer
                ? new TextDecoder().decode(raw)
                : raw
                  ? await new Response(raw).text()
                  : "{}";
          const body = JSON.parse(text) as {
            commandName: string;
            request: CommandRequest<unknown>;
          };
          const command = resolveCommand(body.commandName);
          if (!command) {
            return Response.json(
              { error: "unknown_command", message: body.commandName },
              { status: 400 },
            );
          }
          let lane = lanes.get(workspaceId);
          if (!lane) {
            lane = workspaceHub(db, workspaceId);
            lanes.set(workspaceId, lane);
          }
          const outcome = await lane.execute(command, body.request);
          return Response.json(outcome);
        },
      } as DurableObjectStub;
    },
    jurisdiction() {
      return ns as DurableObjectNamespace;
    },
  };
  return ns as unknown as DurableObjectNamespace;
}
