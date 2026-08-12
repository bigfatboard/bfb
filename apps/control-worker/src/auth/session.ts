// ABOUTME: Resolves Better Auth browser sessions into BFB-normalized human principals.
// ABOUTME: Exact origin, Fetch Metadata, and versioned session CSRF checks protect mutations.

import { createHmac, timingSafeEqual } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";
import { randomUlid } from "@bfb/domain";

import type { AuthKey, HumanAuth } from "./better-auth.js";

export const SESSION_COOKIE = "__Host-bfb_session";

export interface BrowserPrincipal {
  type: "human";
  humanId: string;
  authUserId: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  sessionId: string;
}

export function readSessionCookie(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) {
    return null;
  }
  const session = cookie.match(/(?:^|;\s*)__Host-bfb_session=([^;]+)/);
  const value = session?.[1];
  if (!value) {
    return null;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function hasBrowserSessionCookie(request: Request): boolean {
  return readSessionCookie(request) !== null;
}

export function csrfTokenForSession(sessionId: string, keys: readonly AuthKey[]): string {
  const current = keys[0];
  if (!current) {
    throw new Error("auth signing key unavailable");
  }
  return `${current.version}.${csrfSignature(sessionId, current.value)}`;
}

function csrfSignature(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(`bfb-csrf:${sessionId}`).digest("hex");
}

function csrfTokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

export function assertBrowserMutation(
  request: Request,
  appOrigin: string,
  options: { sessionId?: string; authKeys?: readonly AuthKey[] } = {},
): void {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return;
  }
  const origin = request.headers.get("origin");
  if (!origin || origin !== appOrigin) {
    throw authError("csrf_origin", "origin check failed for browser mutation");
  }
  if (request.headers.get("sec-fetch-site") !== "same-origin") {
    throw authError("csrf_fetch_metadata", "same-origin Fetch Metadata required");
  }
  if (options.sessionId && options.authKeys) {
    const provided = request.headers.get("x-bfb-csrf") ?? "";
    const separator = provided.indexOf(".");
    const version = separator === -1 ? Number.NaN : Number(provided.slice(0, separator));
    const signature = separator === -1 ? "" : provided.slice(separator + 1);
    const key = options.authKeys.find((candidate) => candidate.version === version);
    if (!key || !csrfTokensEqual(signature, csrfSignature(options.sessionId, key.value))) {
      throw authError("csrf_token", "session-bound CSRF token missing or invalid");
    }
  }
}

async function mappedHuman(
  db: SqlDatabase,
  authUser: { id: string; email: string; name: string },
  now: string,
): Promise<{ id: string } | null> {
  const existing = (await db
    .prepare(`SELECT id FROM humans WHERE better_auth_user_id = ?`)
    .get(authUser.id)) as { id: string } | undefined;
  if (existing) {
    return existing;
  }

  try {
    const humanId = randomUlid();
    await db
      .prepare(
        `INSERT INTO humans (id, better_auth_user_id, email, display_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(humanId, authUser.id, authUser.email, authUser.name, now);
  } catch {
    const raced = (await db
      .prepare(`SELECT id FROM humans WHERE better_auth_user_id = ?`)
      .get(authUser.id)) as { id: string } | undefined;
    if (!raced) {
      return null;
    }
    return raced;
  }
  const created = (await db
    .prepare(`SELECT id FROM humans WHERE better_auth_user_id = ?`)
    .get(authUser.id)) as { id: string } | undefined;
  return created ?? null;
}

export async function resolveBrowserPrincipal(
  db: SqlDatabase,
  auth: HumanAuth,
  request: Request,
  now: string,
): Promise<BrowserPrincipal | null> {
  if (!hasBrowserSessionCookie(request)) {
    return null;
  }
  const resolved = await auth.api.getSession({ headers: request.headers });
  if (!resolved) {
    return null;
  }
  const human = await mappedHuman(
    db,
    { id: resolved.user.id, email: resolved.user.email, name: resolved.user.name },
    now,
  );
  if (!human) {
    throw authError("identity_conflict", "human identity requires explicit account linking");
  }
  return {
    type: "human",
    humanId: human.id,
    authUserId: resolved.user.id,
    email: resolved.user.email,
    emailVerified: resolved.user.emailVerified,
    displayName: resolved.user.name,
    sessionId: resolved.session.id,
  };
}
