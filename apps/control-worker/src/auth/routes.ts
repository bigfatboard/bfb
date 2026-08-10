// ABOUTME: Mounts human auth routes for sign-in, sign-out, and session inspection.
// ABOUTME: Email sign-in verifies scrypt password hashes; empty/wrong passwords fail closed.

import type { Context } from "hono";

import type { SqlDatabase } from "@bfb/db";
import { randomUlid, verifyPassword } from "@bfb/domain";

import { clearSessionCookie, resolveBrowserPrincipal, setSessionCookie } from "./session.js";
import type { HumanAuth } from "./better-auth.js";

export interface AuthRouteDeps {
  db: SqlDatabase;
  auth: HumanAuth;
  now: string;
}

export async function handleAuthRoute(c: Context, deps: AuthRouteDeps): Promise<Response> {
  const url = new URL(c.req.url);
  const path = url.pathname;

  if (path === "/auth/session" && c.req.method === "GET") {
    const principal = resolveBrowserPrincipal(deps.db, c.req.raw, deps.now);
    if (!principal) {
      return c.json({ authenticated: false }, 401);
    }
    return c.json({
      authenticated: true,
      human: {
        id: principal.humanId,
        email: principal.email,
        display_name: principal.displayName,
      },
    });
  }

  if (path === "/auth/sign-in/email" && c.req.method === "POST") {
    const body = (await c.req.json()) as { email?: string; password?: string };
    if (!body.email || typeof body.password !== "string" || body.password.length === 0) {
      return c.json({ error: "invalid_request", message: "email and password required" }, 400);
    }
    const human = deps.db
      .prepare(`SELECT id, email, display_name FROM humans WHERE email = ?`)
      .get(body.email) as { id: string; email: string; display_name: string } | undefined;
    if (!human) {
      return c.json({ error: "invalid_credentials", message: "invalid email or password" }, 401);
    }
    const credential = deps.db
      .prepare(`SELECT password_hash FROM human_credentials WHERE human_id = ?`)
      .get(human.id) as { password_hash: string } | undefined;
    if (!credential || !verifyPassword(body.password, credential.password_hash)) {
      return c.json({ error: "invalid_credentials", message: "invalid email or password" }, 401);
    }
    const sessionId = randomUlid();
    const expires = new Date(Date.parse(deps.now) + 86400_000).toISOString();
    deps.db
      .prepare(
        `INSERT INTO human_sessions (session_id, human_id, workspace_id, created_at, expires_at)
         VALUES (?, ?, NULL, ?, ?)`,
      )
      .run(sessionId, human.id, deps.now, expires);
    return new Response(
      JSON.stringify({
        ok: true,
        human: { id: human.id, email: human.email, display_name: human.display_name },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": setSessionCookie(sessionId),
        },
      },
    );
  }

  if (path === "/auth/sign-out" && c.req.method === "POST") {
    const principal = resolveBrowserPrincipal(deps.db, c.req.raw, deps.now);
    if (principal) {
      deps.db
        .prepare(`UPDATE human_sessions SET revoked_at = ? WHERE session_id = ?`)
        .run(deps.now, principal.sessionId);
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": clearSessionCookie(),
      },
    });
  }

  if ((path.startsWith("/auth/") && c.req.method === "GET") || path.startsWith("/auth/")) {
    try {
      const response = await deps.auth.handler(c.req.raw);
      return response;
    } catch {
      return c.json(
        {
          ok: false,
          error: "auth_handler_error",
          message: "Better Auth handler failed",
        },
        502,
      );
    }
  }

  return c.json({ error: "not_found" }, 404);
}
