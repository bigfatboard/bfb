// ABOUTME: Authenticates browser realtime upgrade admission before the uniform public-feed hold.
// ABOUTME: Admitted requests disclose no positions and never resolve or attach a workspace socket.

import { assertLedgerBrowserAccess, loadPrincipal, runnerId } from "@bfb/domain";

import type { HumanAuth } from "../auth/better-auth.js";
import { resolveBrowserPrincipal, type BrowserPrincipal } from "../auth/session.js";
import { BROWSER_REALTIME_PROTOCOL } from "../realtime/browser-sockets.js";
import type { RunnerApiDeps } from "./runners.js";

export interface BrowserRealtimeDeps extends RunnerApiDeps {
  principal: BrowserPrincipal;
  workspaceId: string;
  auth: HumanAuth;
}

const subscribePattern = /^\/realtime\/workspaces\/([^/]+)\/subscribe$/;

export function isBrowserRealtimePath(path: string): boolean {
  return subscribePattern.test(path);
}

function failure(status: number, error: string): Response {
  return Response.json(
    { error, message: error.replaceAll("_", " ") },
    { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );
}

export async function handleBrowserRealtimeApi(
  request: Request,
  deps: BrowserRealtimeDeps,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const match = subscribePattern.exec(url.pathname);
    if (!match?.[1] || url.search) return failure(400, "request_rejected");
    if (request.headers.get("authorization")) {
      return failure(401, "credential_confusion");
    }
    const workspaceId = runnerId(match[1]);
    if (workspaceId !== runnerId(deps.workspaceId)) return failure(404, "not_found");
    if (request.method !== "GET") return failure(400, "request_rejected");
    if (
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      request.headers.get("sec-websocket-protocol") !== BROWSER_REALTIME_PROTOCOL
    ) {
      return failure(400, "request_rejected");
    }
    const resolved = await resolveBrowserPrincipal(deps.db, deps.auth, request, deps.now);
    if (!resolved || resolved.humanId !== deps.principal.humanId) {
      return failure(401, "unauthenticated");
    }
    const session = (await deps.db
      .prepare(
        `SELECT session.expires_at AS expires_at
         FROM better_auth_sessions AS session
         JOIN humans AS human ON human.better_auth_user_id = session.user_id
         WHERE session.id = ? AND human.id = ?`,
      )
      .get(resolved.sessionId, resolved.humanId)) as { expires_at: string } | undefined;
    if (!session || !Number.isFinite(Date.parse(session.expires_at))) {
      return failure(401, "unauthenticated");
    }
    if (Date.parse(session.expires_at) <= Date.parse(deps.now)) {
      return failure(401, "session_expired");
    }
    const principal = await loadPrincipal(deps.db, workspaceId, resolved.humanId);
    await assertLedgerBrowserAccess(
      deps.db,
      workspaceId,
      resolved.humanId,
      principal.authorizationEpoch,
    );
    return Response.json(
      { error: "request_rejected", message: "event feeds are unavailable" },
      { status: 409, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
    );
  } catch {
    return failure(403, "request_rejected");
  }
}
