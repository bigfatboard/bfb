// ABOUTME: Serves authenticated stateless MCP through the pinned Cloudflare Agents SDK.
// ABOUTME: The SDK receives the original request so protocol routing errors cannot be masked.

import { createHmac } from "node:crypto";

import { createMcpHandler } from "agents/mcp/server";

import type { SqlDatabase } from "@bfb/db";
import {
  abuseBucketKey,
  consumeAbuseBudget,
  mcpResource,
  resolveAccessToken,
  type ActiveDelegation,
} from "@bfb/domain";

import type { Jurisdiction } from "../env.js";
import { createBfbMcpServer } from "./server-factory.js";

export interface McpHandlerEnv {
  db: SqlDatabase;
  allowedHostnames: string[];
  appOrigin: string;
  abuseSecret: string;
  jurisdiction: Jurisdiction;
  now?: string;
  workspaceHubNs?: DurableObjectNamespace | undefined;
}

const BODY_LIMIT = 65_536;
const MCP_WINDOW_SECONDS = 300;
const MCP_POLICY = {
  attemptLimit: 600,
  pollLimit: 600,
  windowSeconds: MCP_WINDOW_SECONDS,
  maxBodyBytes: BODY_LIMIT,
} as const;

export async function handleMcpRequest(
  request: Request,
  env: McpHandlerEnv,
  _ctx: ExecutionContext = emptyCtx(),
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return preflight(request, env);
  }
  const host = new URL(request.url).hostname;
  const origin = request.headers.get("origin");
  if (
    !host ||
    !env.allowedHostnames.includes(host) ||
    (origin !== null && origin !== env.appOrigin)
  ) {
    return new Response(null, { status: 403 });
  }
  if (request.headers.get("cookie")) {
    return unauthorized(env, "credential_confusion");
  }
  const bodyBytes = await boundedBodyBytes(request);
  if (bodyBytes === null) {
    return jsonRpcError(null, -32600, "Request body exceeds the MCP limit", 413);
  }
  if (!(await consumeMcpBudget(request, env, bodyBytes))) {
    return Response.json(
      { error: "request_rejected", message: "request rejected" },
      { status: 429 },
    );
  }

  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~-]{16,512})$/u.exec(authorization);
  if (!match) {
    return unauthorized(env);
  }

  const token = match[1]!;
  const now = env.now ?? new Date().toISOString();
  const resource = mcpResource(env.appOrigin);
  let delegation: ActiveDelegation;
  try {
    delegation = await resolveAccessToken(env.db, token, now, resource);
  } catch {
    return unauthorized(env);
  }
  if (request.method === "POST") {
    const routingError = validateRoutingHeaders(request);
    if (routingError) {
      return routingError;
    }
  }
  const handler = createMcpHandler(
    () =>
      createBfbMcpServer({
        db: env.db,
        delegation,
        now,
        jurisdiction: env.jurisdiction,
        workspaceHubNs: env.workspaceHubNs,
      }),
    {
      route: "/mcp",
      legacy: "reject",
      allowedHostnames: env.allowedHostnames,
      allowedOriginHostnames: [new URL(env.appOrigin).hostname],
      corsOptions: {
        origin: env.appOrigin,
        methods: "OPTIONS, POST",
        headers: "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
      },
      responseMode: "auto",
    },
  );
  return handler.fetch(request, {
    authInfo: {
      token,
      clientId: delegation.clientId,
      scopes: [...delegation.scopes],
      resource: new URL(resource),
    },
  });
}

function validateRoutingHeaders(request: Request): Response | null {
  if (request.headers.has("mcp-session-id")) {
    return jsonRpcError(null, -32600, "Mcp-Session-Id is not supported", 400);
  }
  const method = request.headers.get("mcp-method");
  if (
    (method === "tools/call" || method === "resources/read" || method === "prompts/get") &&
    !request.headers.has("mcp-name")
  ) {
    return jsonRpcError(null, -32600, `Mcp-Name is required for ${method}`, 400);
  }
  return null;
}

async function boundedBodyBytes(request: Request): Promise<number | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > BODY_LIMIT)) {
    return null;
  }
  if (request.body === null) {
    return 0;
  }
  const bodyBytes = (await request.clone().arrayBuffer()).byteLength;
  return bodyBytes <= BODY_LIMIT ? bodyBytes : null;
}

async function consumeMcpBudget(
  request: Request,
  env: McpHandlerEnv,
  bodyBytes: number,
): Promise<boolean> {
  const nowMs = Date.parse(env.now ?? new Date().toISOString());
  if (!Number.isFinite(nowMs) || env.abuseSecret.length < 32) {
    return false;
  }
  const now = new Date(nowMs).toISOString();
  const ip = (request.headers.get("cf-connecting-ip") ?? "unavailable").slice(0, 64);
  const ipHashSeed = createHmac("sha256", env.abuseSecret).update(`bfb-mcp-ip:${ip}`).digest("hex");
  try {
    const decision = await consumeAbuseBudget(
      env.db,
      {
        bucketKey: abuseBucketKey({ ipHashSeed, subject: "/mcp", surface: "remote-mcp" }),
        activity: "attempt",
        bodyBytes,
        now,
        expiresAt: new Date(nowMs + MCP_WINDOW_SECONDS * 1000).toISOString(),
      },
      MCP_POLICY,
    );
    return decision.allowed;
  } catch {
    return false;
  }
}

function preflight(request: Request, env: McpHandlerEnv): Response {
  const origin = request.headers.get("origin");
  const host = new URL(request.url).hostname;
  if (origin !== env.appOrigin || !env.allowedHostnames.includes(host)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": env.appOrigin,
      "Access-Control-Allow-Methods": "OPTIONS, POST",
      "Access-Control-Allow-Headers":
        "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}

function unauthorized(env: McpHandlerEnv, error = "unauthorized"): Response {
  const metadata = new URL("/.well-known/oauth-protected-resource", env.appOrigin);
  return new Response(JSON.stringify({ error }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": `Bearer resource_metadata="${metadata.toString()}"`,
    },
  });
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  status: number,
): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id }, { status });
}

function emptyCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}
