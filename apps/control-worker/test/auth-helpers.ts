// ABOUTME: Builds migrated Better Auth test databases and signed browser sessions.
// ABOUTME: Shared fixtures exercise the shipped GitHub-only identity configuration.

import Database from "better-sqlite3";
import { makeSignature } from "better-auth/crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adaptBetterSqlite3, applyMigrationsForVerification, type SqlDatabase } from "@bfb/db";

import {
  createHumanAuth,
  parseAuthKeys,
  type AuthEnv,
  type HumanAuth,
} from "../src/auth/better-auth.js";
import { SESSION_COOKIE } from "../src/auth/session.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/d1",
);

export const AUTH_TEST_ENV = {
  APP_ORIGIN: "https://bfb.example.test",
  BETTER_AUTH_SECRETS:
    "2:c02-current-signing-and-encryption-key-4f57d1,1:c02-previous-signing-and-encryption-key-9a23f8",
  GITHUB_CLIENT_ID: "c02-github-client",
  GITHUB_CLIENT_SECRET: "c02-github-secret",
  AUTH_ABUSE_SECRET: "c02-public-auth-abuse-key-5ca7c956",
} satisfies AuthEnv;

export interface AuthTestContext {
  raw: Database.Database;
  db: SqlDatabase;
  auth: HumanAuth;
}

export function openAuthTestContext(oauthNow = "2026-08-11T20:00:00.000Z"): AuthTestContext {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  applyMigrationsForVerification(raw, migrationsDir);
  const db = adaptBetterSqlite3(raw);
  return {
    raw,
    db,
    auth: createHumanAuth(raw, AUTH_TEST_ENV, {
      db,
      now: oauthNow,
    }),
  };
}

export async function seedAuthSession(
  context: Pick<AuthTestContext, "raw">,
  values: {
    userId?: string;
    sessionId?: string;
    token?: string;
    email?: string;
    name?: string;
    humanId?: string;
    now?: string;
    expiresAt?: string;
  } = {},
): Promise<{ cookie: string; sessionId: string; token: string; userId: string }> {
  const userId = values.userId ?? "auth-user-c02";
  const sessionId = values.sessionId ?? "auth-session-c02";
  const token = values.token ?? "auth-token-c02";
  const email = values.email ?? "c02-human@synthetic.test";
  const name = values.name ?? "C02 Human";
  const now = values.now ?? "2026-08-11T20:00:00.000Z";
  const expiresAt = values.expiresAt ?? "2027-08-11T20:00:00.000Z";

  context.raw
    .prepare(
      `INSERT INTO better_auth_users
       (id, name, email, email_verified, image, created_at, updated_at)
       VALUES (?, ?, ?, 1, NULL, ?, ?)`,
    )
    .run(userId, name, email, now, now);
  context.raw
    .prepare(
      `INSERT INTO better_auth_sessions
       (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(sessionId, expiresAt, token, now, now, userId);
  if (values.humanId) {
    const mapping = context.raw
      .prepare(`UPDATE humans SET better_auth_user_id = ? WHERE id = ?`)
      .run(userId, values.humanId);
    if (mapping.changes !== 1) {
      throw new Error("test human mapping target unavailable");
    }
  }

  const signingKey = parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS)[0];
  if (!signingKey) {
    throw new Error("test auth key unavailable");
  }
  const signed = `${token}.${await makeSignature(token, signingKey.value)}`;
  return {
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(signed)}`,
    sessionId,
    token,
    userId,
  };
}
