// ABOUTME: Serves same-origin /mcp through Cloudflare Agents createMcpHandler with legacy reject.
// ABOUTME: Authenticates MCP tokens, enforces routing metadata, and creates a fresh server per request.

import { createMcpHandler } from "agents/mcp/server";

import type { SqlDatabase } from "@bfb/db";
import { MCP_PROTOCOL_VERSION, resolveAccessToken, validateMcpRouting } from "@bfb/domain";

import { createBfbMcpServer } from "./server-factory.js";

export interface McpHandlerEnv {
  db: SqlDatabase;
  allowedHostnames: string[];
  appOrigin: string;
  now?: string;
}

export async function handleMcpRequest(
  request: Request,
  env: McpHandlerEnv,
  ctx: ExecutionContext = emptyCtx(),
): Promise<Response> {
  if (request.method === "GET") {
    return json({ error: "legacy_transport", message: "GET+SSE transport rejected" }, 405);
  }

  // Browser cookies never authenticate MCP.
  if (request.headers.get("cookie")) {
    return json({ error: "credential_confusion", message: "cookie cannot auth mcp" }, 401);
  }

  const now = env.now ?? new Date().toISOString();
  let body: {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    name?: string;
    params?: Record<string, unknown> & { name?: string; arguments?: Record<string, unknown> };
  } = {};
  const raw = await request.clone().text();
  try {
    body = raw ? (JSON.parse(raw) as typeof body) : {};
  } catch {
    return json({ error: "schema_invalid", message: "invalid json body" }, 400);
  }

  const routingMethod = request.headers.get("Mcp-Method") ?? body.method ?? null;
  const routingName =
    request.headers.get("Mcp-Name") ??
    body.name ??
    (typeof body.params?.name === "string" ? body.params.name : null);

  try {
    const routingBody: { method?: string; name?: string } = {};
    if (routingMethod) {
      routingBody.method = routingMethod;
    }
    if (routingName) {
      routingBody.name = routingName;
    }
    validateMcpRouting(
      {
        protocolVersion: request.headers.get("MCP-Protocol-Version"),
        method: routingMethod,
        name: routingName,
        sessionId: request.headers.get("Mcp-Session-Id"),
        host: request.headers.get("Host"),
        origin: request.headers.get("Origin"),
      },
      routingBody,
      { allowedHostnames: env.allowedHostnames, appOrigin: env.appOrigin },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "routing_failed";
    const code =
      error instanceof Error && "code" in error
        ? String((error as { code: string }).code)
        : "routing_failed";
    return json({ error: code, message }, 400);
  }

  const method = routingMethod ?? "";
  const needsAuth =
    method === "tools/call" || method === "resources/read" || method === "prompts/get";

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";

  if (needsAuth || token) {
    try {
      const delegation = resolveAccessToken(env.db, token, now);
      const handler = createMcpHandler(
        () =>
          createBfbMcpServer({
            db: env.db,
            delegation,
            now,
          }),
        {
          route: "/mcp",
          legacy: "reject",
          allowedHostnames: env.allowedHostnames,
          corsOptions: {
            origin: env.appOrigin,
          },
          responseMode: "json",
        },
      );
      // Normalize body to JSON-RPC 2026-07-28 with required per-request _meta envelope.
      const baseParams: Record<string, unknown> = {
        ...(body.params ?? (method === "tools/call" ? { name: routingName, arguments: {} } : {})),
      };
      const existingMeta =
        typeof baseParams._meta === "object" && baseParams._meta !== null
          ? (baseParams._meta as Record<string, unknown>)
          : {};
      const rpcBody = {
        jsonrpc: "2.0" as const,
        id: body.id ?? 1,
        method: body.method ?? method,
        params: {
          ...baseParams,
          _meta: {
            ...existingMeta,
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": {
              name: "bfb-test-client",
              version: "0.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      };
      const rpcRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(rpcBody),
      });
      return handler(rpcRequest, { DB: env.db }, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : "auth_failed";
      const code =
        error instanceof Error && "code" in error
          ? String((error as { code: string }).code)
          : "auth_failed";
      return json({ error: code, message }, 401);
    }
  }

  if (method === "tools/list" || method === "server/discover") {
    return json({
      protocolVersion: MCP_PROTOCOL_VERSION,
      tools: [
        { name: "bfb_list_projects" },
        { name: "bfb_list_tasks" },
        { name: "bfb_get_task" },
        { name: "bfb_get_context" },
        { name: "bfb_add_comment" },
        { name: "bfb_report_progress" },
        { name: "bfb_propose_task" },
      ],
    });
  }

  return json({ error: "unauthorized", message: "bearer token required" }, 401);
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

function emptyCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}
