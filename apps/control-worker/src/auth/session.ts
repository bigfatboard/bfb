// ABOUTME: Resolves the current browser human from a Better Auth session cookie for API routes.
// ABOUTME: MCP credentials are never accepted here; cookie confusion is fail-closed for /mcp.

import type { SqlDatabase } from "@bfb/db";

/** __Host- requires Secure, Path=/, and no Domain attribute. */
export const SESSION_COOKIE = "__Host-bfb_session";

export interface BrowserPrincipal {
  humanId: string;
  email: string;
  displayName: string;
  sessionId: string;
}

export function readSessionCookie(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) {
    return null;
  }
  const hostPrefixed = cookie.match(/(?:^|;\s*)__Host-bfb_session=([^;]+)/);
  if (hostPrefixed?.[1]) {
    return decodeURIComponent(hostPrefixed[1]);
  }
  // Reject legacy unscoped session cookie names; never accept them as auth.
  if (/(?:^|;\s*)bfb_session=/.test(cookie)) {
    return null;
  }
  return null;
}

/**
 * Enforces Origin + Fetch Metadata CSRF defenses on cookie-authenticated mutations.
 * Safe methods (GET/HEAD/OPTIONS) are not gated.
 */
export function assertBrowserMutation(request: Request, appOrigin: string): void {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return;
  }
  const origin = request.headers.get("origin");
  if (!origin || origin !== appOrigin) {
    const error = new Error("origin check failed for browser mutation");
    (error as { code?: string }).code = "csrf_origin";
    throw error;
  }
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site") {
    const error = new Error("cross-site fetch metadata rejected");
    (error as { code?: string }).code = "csrf_fetch_metadata";
    throw error;
  }
}

export async function resolveBrowserPrincipal(
  db: SqlDatabase,
  request: Request,
  nowIso: string,
): Promise<BrowserPrincipal | null> {
  const sessionId = readSessionCookie(request);
  if (!sessionId) {
    return null;
  }
  // Reject MCP-shaped tokens used as cookies.
  if (sessionId.startsWith("mcp_")) {
    return null;
  }
  const row = (await db
    .prepare(
      `SELECT s.session_id, s.human_id, s.expires_at, s.revoked_at, h.email, h.display_name
       FROM human_sessions s
       JOIN humans h ON h.id = s.human_id
       WHERE s.session_id = ?`,
    )
    .get(sessionId)) as
    | {
        session_id: string;
        human_id: string;
        expires_at: string;
        revoked_at: string | null;
        email: string;
        display_name: string;
      }
    | undefined;
  if (!row || row.revoked_at) {
    return null;
  }
  if (Date.parse(row.expires_at) <= Date.parse(nowIso)) {
    return null;
  }
  return {
    humanId: row.human_id,
    email: row.email,
    displayName: row.display_name,
    sessionId: row.session_id,
  };
}

export function setSessionCookie(sessionId: string, maxAgeSeconds = 86400): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export function clearSessionCookie(): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=0"].join(
    "; ",
  );
}
