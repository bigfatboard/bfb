// ABOUTME: Validates MCP 2026-07-28 Streamable HTTP routing metadata for X03A.
// ABOUTME: Rejects legacy session/initialize transport and mismatched headers/body names.

import { DomainError } from "./hub.js";
import { MCP_PROTOCOL_VERSION } from "./oauth.js";

export type McpMethod =
  "server/discover" | "tools/list" | "tools/call" | "resources/read" | "prompts/get";

const METHODS_REQUIRING_NAME = new Set<McpMethod>(["tools/call", "resources/read", "prompts/get"]);

export interface McpRoutingHeaders {
  protocolVersion: string | null;
  method: string | null;
  name: string | null;
  sessionId: string | null;
  host: string | null;
  origin: string | null;
}

export interface McpRoutingPolicy {
  allowedHostnames: string[];
  appOrigin: string;
}

export function validateMcpRouting(
  headers: McpRoutingHeaders,
  body: { method?: string; name?: string; jsonrpc?: string },
  policy: McpRoutingPolicy,
): { method: McpMethod; name?: string | undefined } {
  if (headers.sessionId) {
    throw new DomainError("legacy_transport", "Mcp-Session-Id is rejected");
  }
  if (headers.protocolVersion !== MCP_PROTOCOL_VERSION) {
    throw new DomainError("protocol_version", "MCP-Protocol-Version must be 2026-07-28");
  }
  if (!headers.method) {
    throw new DomainError("routing_metadata", "Mcp-Method required");
  }
  if (headers.host) {
    // Browsers and local servers send Host with an explicit port (e.g. 127.0.0.1:4173).
    const hostname = headers.host.split(":")[0] ?? headers.host;
    const allowed = policy.allowedHostnames.some(
      (entry) => entry === headers.host || entry === hostname || entry.split(":")[0] === hostname,
    );
    if (!allowed) {
      throw new DomainError("host_rejected", "Host not allowed");
    }
  }
  if (headers.origin) {
    if (headers.origin === "null" || headers.origin === "opaque") {
      throw new DomainError("origin_rejected", "opaque origin rejected");
    }
    if (headers.origin !== policy.appOrigin) {
      throw new DomainError("origin_rejected", "Origin must match app origin");
    }
  }

  const method = headers.method as McpMethod;
  const supported: McpMethod[] = [
    "server/discover",
    "tools/list",
    "tools/call",
    "resources/read",
    "prompts/get",
  ];
  if (!supported.includes(method)) {
    if (method === ("initialize" as McpMethod) || headers.method === "initialize") {
      throw new DomainError("legacy_transport", "initialize is rejected");
    }
    throw new DomainError("routing_metadata", "unsupported Mcp-Method");
  }
  if (body.method && body.method !== method) {
    throw new DomainError("routing_metadata", "body method mismatches Mcp-Method");
  }
  if (METHODS_REQUIRING_NAME.has(method)) {
    if (!headers.name) {
      throw new DomainError("routing_metadata", "Mcp-Name required for " + method);
    }
    if (body.name && body.name !== headers.name) {
      throw new DomainError("routing_metadata", "body name mismatches Mcp-Name");
    }
    return { method, name: headers.name };
  }
  if (headers.name) {
    // Optional name allowed but if present with body must match.
    if (body.name && body.name !== headers.name) {
      throw new DomainError("routing_metadata", "body name mismatches Mcp-Name");
    }
  }
  return { method, name: headers.name ?? undefined };
}

export const MCP_TOOL_NAMES = [
  "bfb_list_projects",
  "bfb_list_tasks",
  "bfb_get_task",
  "bfb_get_context",
  "bfb_add_comment",
  "bfb_report_progress",
  "bfb_propose_task",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
