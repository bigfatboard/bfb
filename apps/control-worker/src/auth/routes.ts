// ABOUTME: Mounts the bounded GitHub sign-in, callback, session, and sign-out surface.
// ABOUTME: Durable abuse budgets and browser credential checks wrap Better Auth routes.

import { createHmac } from "node:crypto";

import type { Context } from "hono";

import type { SqlDatabase } from "@bfb/db";
import { abuseBucketKey, consumeAbuseBudget } from "@bfb/domain";

import type { AuthKey, HumanAuth } from "./better-auth.js";
import {
  completeInitialEnrollmentReauthentication,
  createAdditionalEnrollmentFlow,
  createAuthenticationOptions,
  createInitialEnrollmentFlow,
  createRegistrationOptions,
  domainStepUpError,
  listPasskeys,
  parsePresentedStepUpAction,
  recordPasskeySecurityEvent,
  removePasskey,
  verifyAuthentication,
  verifyRegistration,
} from "./passkeys.js";
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
  surface = "human-auth",
  client = "github",
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
        surface,
        client,
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

function jsonWithCookies(upstream: Response, body: unknown): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  for (const cookie of upstream.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return new Response(JSON.stringify(body), { status: upstream.status, headers });
}

async function passkeyPost(
  deps: AuthRouteDeps,
  request: Request,
  path: string,
): Promise<{
  request: Request;
  principal: NonNullable<Awaited<ReturnType<typeof resolvePrincipal>>>;
  body: Record<string, unknown>;
} | null> {
  const bounded = await boundedRequest(request);
  if (!bounded) {
    return null;
  }
  if (
    !(await consumePublicAuthBudget(
      deps,
      bounded.request,
      path,
      bounded.bodyBytes,
      "passkey",
      "browser",
    ))
  ) {
    return null;
  }
  const principal = await resolvePrincipal(deps, bounded.request);
  if (!principal) {
    throw new Error("passkey session required");
  }
  assertBrowserMutation(bounded.request, deps.appOrigin, {
    sessionId: principal.sessionId,
    authKeys: deps.authKeys,
  });
  let body: unknown = {};
  if (bounded.bodyBytes > 0) {
    body = await bounded.request.json();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return { request: bounded.request, principal, body: body as Record<string, unknown> };
}

function passkeyKind(path: string): "enrollment" | "removal" | "step_up" {
  if (path.includes("remove")) {
    return "removal";
  }
  return path.includes("step-up") ? "step_up" : "enrollment";
}

async function recordPasskeyFailure(
  deps: AuthRouteDeps,
  path: string,
  humanId?: string,
  ceremonyId?: string,
): Promise<void> {
  await recordPasskeySecurityEvent(deps.db, {
    humanId,
    ceremonyId,
    kind: passkeyKind(path),
    outcome: "failed",
    code: "request_rejected",
    now: deps.now,
  });
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
    let callbackURL = "/";
    if (bounded.bodyBytes > 0) {
      try {
        const body = (await bounded.request.clone().json()) as { callback_path?: unknown };
        if (typeof body.callback_path !== "string" || !validOauthCallbackPath(body.callback_path)) {
          return rejected();
        }
        callbackURL = body.callback_path;
      } catch {
        return rejected();
      }
    }
    try {
      return await deps.auth.handler(
        internalAuthRequest(
          bounded.request,
          deps.appOrigin,
          "/auth/sign-in/social",
          JSON.stringify({ provider: "github", callbackURL }),
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

  if (path === "/auth/passkeys" && c.req.method === "GET") {
    try {
      const principal = await resolvePrincipal(deps, c.req.raw);
      if (!principal) {
        return rejected(401);
      }
      return c.json({ passkeys: await listPasskeys(deps.db, principal) });
    } catch {
      return rejected();
    }
  }

  if (path === "/auth/passkeys/enroll/reauth" && c.req.method === "GET") {
    let principal: Awaited<ReturnType<typeof resolvePrincipal>> = null;
    const url = new URL(c.req.url);
    const flowId = url.searchParams.get("flow_id") ?? "";
    try {
      if (!(await consumePublicAuthBudget(deps, c.req.raw, path, 0, "passkey", "browser"))) {
        return rejected(403);
      }
      principal = await resolvePrincipal(deps, c.req.raw);
      if (!principal) {
        return rejected(403);
      }
      await completeInitialEnrollmentReauthentication(
        deps.db,
        principal,
        flowId,
        url.searchParams.get("completion") ?? "",
        deps.now,
      );
      return c.redirect(`/settings/security?passkey_enrollment=${encodeURIComponent(flowId)}`);
    } catch {
      await recordPasskeyFailure(deps, path, principal?.humanId, flowId || undefined);
      return rejected(403);
    }
  }

  if (path === "/auth/passkeys/enroll/start" && c.req.method === "POST") {
    let attempt: Awaited<ReturnType<typeof passkeyPost>> = null;
    try {
      attempt = await passkeyPost(deps, c.req.raw, path);
      if (!attempt) {
        return rejected(429);
      }
      const existing = await listPasskeys(deps.db, attempt.principal);
      if (existing.length === 0) {
        const flow = await createInitialEnrollmentFlow(
          deps.db,
          attempt.principal,
          deps.appOrigin,
          deps.now,
        );
        const upstream = await deps.auth.handler(
          internalAuthRequest(
            attempt.request,
            deps.appOrigin,
            "/auth/sign-in/social",
            JSON.stringify({ provider: "github", callbackURL: flow.callbackUrl }),
          ),
        );
        const payload = (await upstream.clone().json()) as { redirect?: boolean; url?: string };
        if (!upstream.ok || !payload.url || payload.url.includes("completion=")) {
          throw new Error("fresh GitHub reauthentication did not start");
        }
        return jsonWithCookies(upstream, {
          ...payload,
          flow_id: flow.flowId,
          requires_reauthentication: true,
        });
      }
      const proofId = typeof attempt.body.proof_id === "string" ? attempt.body.proof_id : "";
      const proofAction = parsePresentedStepUpAction(attempt.body.proof_action);
      const flow = await createAdditionalEnrollmentFlow(
        deps.db,
        attempt.principal,
        proofId,
        proofAction,
        deps.now,
      );
      return c.json({ flow_id: flow.flowId, requires_reauthentication: false });
    } catch {
      await recordPasskeyFailure(deps, path, attempt?.principal.humanId);
      return rejected(403);
    }
  }

  if (path === "/auth/passkeys/enroll/options" && c.req.method === "POST") {
    let attempt: Awaited<ReturnType<typeof passkeyPost>> = null;
    try {
      attempt = await passkeyPost(deps, c.req.raw, path);
      if (!attempt) {
        return rejected(429);
      }
      const flowId = typeof attempt.body.flow_id === "string" ? attempt.body.flow_id : "";
      const name =
        typeof attempt.body.name === "string" ? attempt.body.name.slice(0, 128) : undefined;
      const options = await createRegistrationOptions(
        deps.db,
        attempt.principal,
        flowId,
        deps.appOrigin,
        name,
        deps.now,
      );
      return c.json({ flow_id: flowId, options });
    } catch {
      await recordPasskeyFailure(
        deps,
        path,
        attempt?.principal.humanId,
        typeof attempt?.body.flow_id === "string" ? attempt.body.flow_id : undefined,
      );
      return rejected(403);
    }
  }

  if (path === "/auth/passkeys/enroll/verify" && c.req.method === "POST") {
    let attempt: Awaited<ReturnType<typeof passkeyPost>> = null;
    try {
      attempt = await passkeyPost(deps, c.req.raw, path);
      if (!attempt) {
        return rejected(429);
      }
      const flowId = typeof attempt.body.flow_id === "string" ? attempt.body.flow_id : "";
      const passkey = await verifyRegistration(
        deps.db,
        attempt.principal,
        flowId,
        attempt.body.response as never,
        deps.appOrigin,
        deps.now,
      );
      return c.json({ passkey });
    } catch {
      await recordPasskeyFailure(
        deps,
        path,
        attempt?.principal.humanId,
        typeof attempt?.body.flow_id === "string" ? attempt.body.flow_id : undefined,
      );
      return rejected(403);
    }
  }

  if (path === "/auth/step-up/options" && c.req.method === "POST") {
    let attempt: Awaited<ReturnType<typeof passkeyPost>> = null;
    try {
      attempt = await passkeyPost(deps, c.req.raw, path);
      if (!attempt) {
        return rejected(429);
      }
      const result = await createAuthenticationOptions(
        deps.db,
        attempt.principal,
        attempt.body.action,
        deps.appOrigin,
        deps.now,
      );
      return c.json({
        challenge_id: result.challengeId,
        action: result.action,
        options: result.options,
      });
    } catch {
      await recordPasskeyFailure(deps, path, attempt?.principal.humanId);
      return rejected(403);
    }
  }

  if (path === "/auth/step-up/verify" && c.req.method === "POST") {
    let attempt: Awaited<ReturnType<typeof passkeyPost>> = null;
    try {
      attempt = await passkeyPost(deps, c.req.raw, path);
      if (!attempt) {
        return rejected(429);
      }
      const challengeId =
        typeof attempt.body.challenge_id === "string" ? attempt.body.challenge_id : "";
      const result = await verifyAuthentication(
        deps.db,
        attempt.principal,
        challengeId,
        attempt.body.response as never,
        deps.appOrigin,
        deps.now,
      );
      return c.json({ proof_id: result.proofId, action: result.action });
    } catch {
      await recordPasskeyFailure(
        deps,
        path,
        attempt?.principal.humanId,
        typeof attempt?.body.challenge_id === "string" ? attempt.body.challenge_id : undefined,
      );
      return rejected(403);
    }
  }

  if (path === "/auth/passkeys/remove" && c.req.method === "POST") {
    let attempt: Awaited<ReturnType<typeof passkeyPost>> = null;
    try {
      attempt = await passkeyPost(deps, c.req.raw, path);
      if (!attempt) {
        return rejected(429);
      }
      const passkeyId = typeof attempt.body.passkey_id === "string" ? attempt.body.passkey_id : "";
      const proofId = typeof attempt.body.proof_id === "string" ? attempt.body.proof_id : "";
      const proofAction = parsePresentedStepUpAction(attempt.body.proof_action);
      await removePasskey(deps.db, attempt.principal, passkeyId, proofId, proofAction, deps.now);
      return c.json({ removed: true });
    } catch (error) {
      const failure = domainStepUpError(error);
      if (!attempt || !["step_up_replayed", "passkey_not_found"].includes(failure.code)) {
        await recordPasskeyFailure(deps, path, attempt?.principal.humanId);
      }
      return rejected(403);
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

function validOauthCallbackPath(value: string): boolean {
  if (value.length > 4096) {
    return false;
  }
  try {
    const callback = new URL(value, "https://bfb.invalid");
    return (
      callback.origin === "https://bfb.invalid" &&
      callback.pathname === "/oauth/authorize" &&
      callback.search.length > 1 &&
      !callback.hash
    );
  } catch {
    return false;
  }
}
