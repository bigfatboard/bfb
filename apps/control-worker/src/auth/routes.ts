// ABOUTME: Mounts the bounded GitHub sign-in, callback, session, and sign-out surface.
// ABOUTME: Durable abuse budgets and browser credential checks wrap Better Auth routes.

import { createHmac } from "node:crypto";

import type { Context } from "hono";

import type { SqlDatabase } from "@bfb/db";
import { abuseBucketKey, consumeAbuseBudget } from "@bfb/domain";

import type { AuthKey, HumanAuth } from "./better-auth.js";
import { assertBrowserMutation, csrfTokenForSession, resolveBrowserPrincipal } from "./session.js";

export interface AuthRouteDeps {
  db: SqlDatabase;
  auth: HumanAuth;
  authKeys: readonly AuthKey[];
  authAbuseSecret: string;
  now: string;
  appOrigin: string;
}

const AUTH_BODY_LIMIT = 16_384;
const AUTH_WINDOW_SECONDS = 300;
const AUTH_POLICY = {
  attemptLimit: 10,
  pollLimit: 30,
  windowSeconds: AUTH_WINDOW_SECONDS,
  maxBodyBytes: AUTH_BODY_LIMIT,
} as const;

function rejected(status = 400): Response {
  return Response.json({ error: "request_rejected", message: "request rejected" }, { status });
}

async function boundedRequest(
  request: Request,
): Promise<{ request: Request; bodyBytes: number } | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > AUTH_BODY_LIMIT) {
      return null;
    }
  }
  if (request.method === "GET" || request.method === "HEAD") {
    return { request, bodyBytes: 0 };
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > AUTH_BODY_LIMIT) {
    return null;
  }
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
  };
  if (body.byteLength > 0) {
    init.body = body;
  }
  return {
    request: new Request(request.url, init),
    bodyBytes: body.byteLength,
  };
}

function clientHash(request: Request, secret: string): string {
  const ip = request.headers.get("cf-connecting-ip") ?? "unavailable";
  return createHmac("sha256", secret)
    .update(`bfb-auth-ip:${ip.slice(0, 64)}`)
    .digest("hex");
}

async function consumePublicAuthBudget(
  deps: AuthRouteDeps,
  request: Request,
  path: string,
  bodyBytes: number,
): Promise<boolean> {
  const now = Date.parse(deps.now);
  if (!Number.isFinite(now)) {
    return false;
  }
  const decision = await consumeAbuseBudget(
    deps.db,
    {
      bucketKey: abuseBucketKey({
        ipHashSeed: clientHash(request, deps.authAbuseSecret),
        subject: path,
        surface: "human-auth",
        client: "github",
      }),
      activity: "attempt",
      bodyBytes,
      now: deps.now,
      expiresAt: new Date(now + AUTH_WINDOW_SECONDS * 1000).toISOString(),
    },
    AUTH_POLICY,
  );
  return decision.allowed;
}

function internalAuthRequest(
  request: Request,
  appOrigin: string,
  path: string,
  body?: string,
): Request {
  const headers = new Headers(request.headers);
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const init: RequestInit = {
    method: body === undefined ? request.method : "POST",
    headers,
    redirect: "manual",
  };
  if (body !== undefined) {
    init.body = body;
  }
  return new Request(new URL(path, appOrigin), init);
}

async function resolvePrincipal(deps: AuthRouteDeps, request: Request) {
  return resolveBrowserPrincipal(deps.db, deps.auth, request, deps.now);
}

export async function handleAuthRoute(c: Context, deps: AuthRouteDeps): Promise<Response> {
  const path = new URL(c.req.url).pathname;

  if (path === "/auth/session" && c.req.method === "GET") {
    try {
      const principal = await resolvePrincipal(deps, c.req.raw);
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
        csrf_token: csrfTokenForSession(principal.sessionId, deps.authKeys),
      });
    } catch {
      return rejected(409);
    }
  }

  if (path === "/auth/sign-in/github" && c.req.method === "POST") {
    try {
      assertBrowserMutation(c.req.raw, deps.appOrigin);
    } catch {
      return rejected(403);
    }
    const bounded = await boundedRequest(c.req.raw);
    if (
      !bounded ||
      !(await consumePublicAuthBudget(
        deps,
        c.req.raw,
        "/auth/sign-in/github",
        bounded?.bodyBytes ?? 0,
      ))
    ) {
      return rejected(429);
    }
    try {
      return await deps.auth.handler(
        internalAuthRequest(
          bounded.request,
          deps.appOrigin,
          "/auth/sign-in/social",
          JSON.stringify({ provider: "github", callbackURL: "/" }),
        ),
      );
    } catch {
      return rejected();
    }
  }

  if (path === "/auth/callback/github" && c.req.method === "GET") {
    if (!(await consumePublicAuthBudget(deps, c.req.raw, path, 0))) {
      return rejected(429);
    }
    try {
      const response = await deps.auth.handler(c.req.raw);
      const location = response.headers.get("location");
      if (
        response.status >= 400 ||
        (location && new URL(location, deps.appOrigin).searchParams.has("error"))
      ) {
        return rejected();
      }
      return response;
    } catch {
      return rejected();
    }
  }

  if (path === "/auth/sign-out" && c.req.method === "POST") {
    const bounded = await boundedRequest(c.req.raw);
    if (!bounded) {
      return rejected(429);
    }
    try {
      const principal = await resolvePrincipal(deps, bounded.request);
      if (!principal) {
        return c.json({ error: "unauthenticated" }, 401);
      }
      assertBrowserMutation(bounded.request, deps.appOrigin, {
        sessionId: principal.sessionId,
        authKeys: deps.authKeys,
      });
      return await deps.auth.handler(
        internalAuthRequest(bounded.request, deps.appOrigin, "/auth/sign-out", "{}"),
      );
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? String((error as Error & { code: string }).code)
          : "request_rejected";
      return c.json({ error: code, message: "request rejected" }, 403);
    }
  }

  return c.json({ error: "not_found" }, 404);
}
