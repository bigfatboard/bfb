// ABOUTME: Resolves the current browser human from a Better Auth session cookie for API routes.
// ABOUTME: MCP credentials are never accepted here; cookie confusion is fail-closed for /mcp.

import type { SqlDatabase } from "@bfb/db";

const SESSION_COOKIE = "bfb_session";

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
  const match = cookie.match(/(?:^|;\s*)bfb_session=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function resolveBrowserPrincipal(
  db: SqlDatabase,
  request: Request,
  nowIso: string,
): BrowserPrincipal | null {
  const sessionId = readSessionCookie(request);
  if (!sessionId) {
    return null;
  }
  // Reject MCP-shaped tokens used as cookies.
  if (sessionId.startsWith("mcp_")) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT s.session_id, s.human_id, s.expires_at, s.revoked_at, h.email, h.display_name
       FROM human_sessions s
       JOIN humans h ON h.id = s.human_id
       WHERE s.session_id = ?`,
    )
    .get(sessionId) as
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
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export { SESSION_COOKIE };
