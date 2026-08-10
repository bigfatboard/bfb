// ABOUTME: Dispatches same-origin /mcp requests through X03A routing and shared domain tools.
// ABOUTME: Uses a fresh handler per request without MCP sessions or legacy transports.

import type { SqlDatabase } from "@bfb/db";
import {
  WorkspaceHub,
  MCP_TOOL_NAMES,
  validateMcpRouting,
  assertScope,
  narrowBoundary,
  resolveAccessToken,
  addCommentCommand,
  createTaskCommand,
  getAgentContext,
  getTask,
  listTasks,
  loadPrincipal,
} from "@bfb/domain";

export interface McpHandlerEnv {
  db: SqlDatabase;
  allowedHostnames: string[];
  appOrigin: string;
  now?: string;
}

export async function handleMcpRequest(request: Request, env: McpHandlerEnv): Promise<Response> {
  if (request.method === "GET") {
    return json({ error: "legacy_transport", message: "GET+SSE transport rejected" }, 405);
  }

  const now = env.now ?? new Date().toISOString();
  let body: { method?: string; name?: string; params?: Record<string, unknown> } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "schema_invalid", message: "invalid json body" }, 400);
  }

  try {
    const routing = validateMcpRouting(
      {
        protocolVersion: request.headers.get("MCP-Protocol-Version"),
        method: request.headers.get("Mcp-Method") ?? body.method ?? null,
        name: request.headers.get("Mcp-Name") ?? body.name ?? null,
        sessionId: request.headers.get("Mcp-Session-Id"),
        host: request.headers.get("Host"),
        origin: request.headers.get("Origin"),
      },
      body,
      { allowedHostnames: env.allowedHostnames, appOrigin: env.appOrigin },
    );

    if (routing.method === "server/discover") {
      return json({
        protocolVersion: "2026-07-28",
        transport: "streamable-http",
        tools: MCP_TOOL_NAMES,
      });
    }

    if (routing.method === "tools/list") {
      return json({ tools: MCP_TOOL_NAMES.map((name) => ({ name })) });
    }

    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (request.headers.get("cookie")) {
      return json({ error: "credential_confusion", message: "cookie cannot auth mcp" }, 401);
    }
    const delegation = resolveAccessToken(env.db, token, now);
    const hub = new WorkspaceHub(env.db);
    const principal = loadPrincipal(env.db, delegation.workspaceId, delegation.humanId);

    if (routing.method !== "tools/call" || !routing.name) {
      return json({ error: "unsupported_method", message: routing.method }, 400);
    }

    const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
    switch (routing.name) {
      case "bfb_list_projects": {
        assertScope(delegation, "bfb:read");
        return json({ projects: principal.projectIds });
      }
      case "bfb_list_tasks": {
        assertScope(delegation, "bfb:read");
        return json({ tasks: listTasks(env.db, delegation.workspaceId, principal.projectIds) });
      }
      case "bfb_get_task": {
        assertScope(delegation, "bfb:read");
        const taskId = String(args.task_id ?? "");
        const task = getTask(env.db, delegation.workspaceId, taskId);
        if (!task) {
          return json({ error: "not_found" }, 404);
        }
        narrowBoundary(delegation, task.project_id, task.id);
        return json({ task });
      }
      case "bfb_get_context": {
        assertScope(delegation, "bfb:read");
        const taskId = String(args.task_id ?? "");
        const task = getTask(env.db, delegation.workspaceId, taskId);
        if (!task) {
          return json({ error: "not_found" }, 404);
        }
        narrowBoundary(delegation, task.project_id, task.id);
        return json({ context: getAgentContext(env.db, delegation.workspaceId, taskId) });
      }
      case "bfb_add_comment":
      case "bfb_report_progress": {
        assertScope(delegation, "bfb:task:write");
        const taskId = String(args.task_id ?? "");
        const task = getTask(env.db, delegation.workspaceId, taskId);
        if (!task) {
          return json({ error: "not_found" }, 404);
        }
        narrowBoundary(delegation, task.project_id, task.id);
        const outcome = await hub.execute(addCommentCommand, {
          workspaceId: delegation.workspaceId,
          idempotencyKey: String(args.request_id ?? randomKey()),
          authorizationEpoch: delegation.authorizationEpoch,
          actorHumanId: delegation.humanId,
          actorDelegationId: delegation.delegationId,
          now,
          input: {
            taskId,
            body: String(args.body ?? args.summary ?? ""),
            kind: routing.name === "bfb_report_progress" ? "progress" : "discussion",
          },
        });
        return json(outcome);
      }
      case "bfb_propose_task": {
        assertScope(delegation, "bfb:task:write");
        const projectId = String(args.project_id ?? delegation.projectId ?? "");
        narrowBoundary(delegation, projectId);
        const outcome = await hub.execute(createTaskCommand, {
          workspaceId: delegation.workspaceId,
          idempotencyKey: String(args.request_id ?? randomKey()),
          authorizationEpoch: delegation.authorizationEpoch,
          actorHumanId: delegation.humanId,
          actorDelegationId: delegation.delegationId,
          now,
          input: {
            projectId,
            title: String(args.title ?? ""),
            priority: (args.priority as "P0" | "P1" | "P2" | "P3") ?? "P2",
            actorIsAgent: true,
          },
        });
        return json(outcome);
      }
      default:
        return json({ error: "unknown_tool", message: routing.name }, 400);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "mcp_failed";
    const code =
      error instanceof Error && "code" in error
        ? String((error as { code: string }).code)
        : "mcp_failed";
    return json({ error: code, message }, 400);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-credentials": "false",
    },
  });
}

function randomKey(): string {
  return "req-" + Math.random().toString(36).slice(2);
}
