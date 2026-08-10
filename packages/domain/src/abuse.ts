// ABOUTME: Implements shared D1-backed abuse-control buckets for public capability endpoints.
// ABOUTME: Isolate memory is never authoritative; keys are hashed dimensions only.

import { createHash } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";

export interface AbuseDecision {
  allowed: boolean;
  remaining: number;
  escalateTurnstile: boolean;
}

export function abuseBucketKey(parts: {
  ipHashSeed: string;
  subject: string;
  surface: string;
}): string {
  return createHash("sha256")
    .update([parts.surface, parts.subject, parts.ipHashSeed].join("|"))
    .digest("hex");
}

export function hashIp(ip: string): string {
  return createHash("sha256")
    .update("ip:" + ip)
    .digest("hex");
}

export async function consumeRateLimit(
  db: SqlDatabase,
  bucketKey: string,
  nowIso: string,
  limit: number,
  windowSeconds: number,
): Promise<AbuseDecision> {
  const now = Date.parse(nowIso);
  const row = (await db
    .prepare(`SELECT window_started_at, count FROM rate_limit_buckets WHERE bucket_key = ?`)
    .get(bucketKey)) as { window_started_at: string; count: number } | undefined;

  if (!row) {
    await db
      .prepare(
        `INSERT INTO rate_limit_buckets (bucket_key, window_started_at, count, updated_at)
       VALUES (?, ?, 1, ?)`,
      )
      .run(bucketKey, nowIso, nowIso);
    return { allowed: true, remaining: limit - 1, escalateTurnstile: false };
  }

  const started = Date.parse(row.window_started_at);
  if (now - started >= windowSeconds * 1000) {
    await db
      .prepare(
        `UPDATE rate_limit_buckets SET window_started_at = ?, count = 1, updated_at = ? WHERE bucket_key = ?`,
      )
      .run(nowIso, nowIso, bucketKey);
    return { allowed: true, remaining: limit - 1, escalateTurnstile: false };
  }

  if (row.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      escalateTurnstile: row.count >= limit * 2,
    };
  }

  await db
    .prepare(`UPDATE rate_limit_buckets SET count = count + 1, updated_at = ? WHERE bucket_key = ?`)
    .run(nowIso, bucketKey);
  return { allowed: true, remaining: limit - row.count - 1, escalateTurnstile: false };
}
