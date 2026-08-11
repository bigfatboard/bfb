// ABOUTME: Declares SPA path ownership relative to Control Worker-first routes.
// ABOUTME: Ensures the asset SPA cannot claim API, auth, OAuth, MCP, or discovery paths.

export const SPA_ALLOWED_PATH_EXAMPLES = ["/", "/w/demo", "/settings"] as const;

export const WORKER_FIRST_PATH_EXAMPLES = [
  "/api/v1/tasks",
  "/auth/sign-in",
  "/mcp",
  "/oauth",
  "/oauth/authorize",
  "/oauth/token",
  "/realtime/workspaces/01JBFB0W0RKSPACE0000000000",
  "/runner/connect",
  "/webhooks/github",
  "/.well-known/oauth-authorization-server",
  "/healthz",
] as const;

export function isSpaAssetPath(pathname: string): boolean {
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
    return false;
  }
  if (pathname === "/oauth" || pathname.startsWith("/oauth/")) {
    return false;
  }
  const blocked = ["/api/", "/auth/", "/realtime/", "/runner/", "/webhooks/", "/.well-known/"];
  if (pathname === "/healthz") {
    return false;
  }
  return !blocked.some((prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));
}
