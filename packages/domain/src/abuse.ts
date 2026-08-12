// ABOUTME: Implements shared D1-backed abuse-control buckets for public capability endpoints.
// ABOUTME: Atomic counters use hashed dimensions; isolate memory is never authoritative.

import { createHash } from "node:crypto";

import { assertUtcTimestamp, type SqlDatabase } from "@bfb/db";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_LIMIT = 10_000;
const MAX_WINDOW_SECONDS = 86_400;
const MAX_BODY_BYTES = 1_048_576;

export interface AbuseDecision {
  allowed: boolean;
  remaining: number;
  escalateTurnstile: boolean;
  failure?: { code: "request_rejected"; message: "request rejected" } | undefined;
}

export interface AbusePolicy {
  attemptLimit: number;
  pollLimit: number;
  windowSeconds: number;
  maxBodyBytes: number;
}

export interface AbuseRequest {
  bucketKey: string;
  activity: "attempt" | "poll";
  bodyBytes: number;
  now: string;
  expiresAt: string;
}

export function abuseBucketKey(parts: {
  ipHashSeed: string;
  subject: string;
  surface: string;
  client?: string;
}): string {
  if (!HASH_PATTERN.test(parts.ipHashSeed)) {
    throw new Error("IP hash seed must be a SHA-256 digest");
  }
  assertBoundedDimension(parts.subject, 512, "abuse subject");
  assertBoundedDimension(parts.surface, 128, "abuse surface");
  if (parts.client !== undefined) {
    assertBoundedDimension(parts.client, 256, "abuse client");
  }
  return createHash("sha256")
    .update(JSON.stringify([parts.surface, parts.subject, parts.client ?? "", parts.ipHashSeed]))
    .digest("hex");
}

export function hashIp(ip: string): string {
  assertBoundedDimension(ip, 64, "IP address");
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
  assertBucketKey(bucketKey);
  assertPositiveBoundedInteger(limit, MAX_LIMIT, "rate limit");
  assertPositiveBoundedInteger(windowSeconds, MAX_WINDOW_SECONDS, "rate window");
  assertUtcTimestamp(nowIso, "rate limit time");
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    throw new Error("invalid UTC timestamp for rate limit time");
  }
  const canonicalNow = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - windowSeconds * 1000).toISOString();
  const escalationCount = limit * 2;

  const row = (await db
    .prepare(
      `INSERT INTO rate_limit_buckets (bucket_key, window_started_at, count, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         window_started_at = CASE
           WHEN julianday(rate_limit_buckets.window_started_at) <= julianday(?)
             THEN excluded.window_started_at
           ELSE rate_limit_buckets.window_started_at
         END,
         count = CASE
           WHEN julianday(rate_limit_buckets.window_started_at) <= julianday(?) THEN 1
           ELSE MIN(rate_limit_buckets.count + 1, ?)
         END,
         updated_at = excluded.updated_at
       RETURNING count`,
    )
    .get(bucketKey, canonicalNow, canonicalNow, cutoff, cutoff, escalationCount)) as
    { count: number } | undefined;
  if (!row || !Number.isSafeInteger(row.count) || row.count < 1) {
    throw new Error("rate limit counter did not return an authoritative value");
  }

  const allowed = row.count <= limit;
  return {
    allowed,
    remaining: allowed ? limit - row.count : 0,
    escalateTurnstile: row.count >= escalationCount,
    ...(allowed ? {} : { failure: publicFailure() }),
  };
}

export async function consumeAbuseBudget(
  db: SqlDatabase,
  request: AbuseRequest,
  policy: AbusePolicy,
): Promise<AbuseDecision> {
  assertAbusePolicy(policy);
  assertBucketKey(request.bucketKey);
  assertUtcTimestamp(request.now, "abuse request time");
  assertUtcTimestamp(request.expiresAt, "abuse request expiry");
  if (request.activity !== "attempt" && request.activity !== "poll") {
    return rejectedDecision(false);
  }
  const now = Date.parse(request.now);
  const expiresAt = Date.parse(request.expiresAt);
  if (
    !Number.isSafeInteger(request.bodyBytes) ||
    request.bodyBytes < 0 ||
    request.bodyBytes > policy.maxBodyBytes ||
    !Number.isFinite(now) ||
    !Number.isFinite(expiresAt) ||
    now >= expiresAt
  ) {
    return rejectedDecision(false);
  }

  const limit = request.activity === "poll" ? policy.pollLimit : policy.attemptLimit;
  const activityKey = createHash("sha256")
    .update(JSON.stringify([request.bucketKey, request.activity]))
    .digest("hex");
  return consumeRateLimit(db, activityKey, request.now, limit, policy.windowSeconds);
}

function assertAbusePolicy(policy: AbusePolicy): void {
  assertPositiveBoundedInteger(policy.attemptLimit, MAX_LIMIT, "attempt limit");
  assertPositiveBoundedInteger(policy.pollLimit, MAX_LIMIT, "poll limit");
  assertPositiveBoundedInteger(policy.windowSeconds, MAX_WINDOW_SECONDS, "rate window");
  assertPositiveBoundedInteger(policy.maxBodyBytes, MAX_BODY_BYTES, "body limit");
}

function assertPositiveBoundedInteger(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`invalid ${name}`);
  }
}

function assertBucketKey(value: string): void {
  if (!HASH_PATTERN.test(value)) {
    throw new Error("rate limit bucket key must be a SHA-256 digest");
  }
}

function assertBoundedDimension(value: string, maximum: number, name: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`invalid ${name}`);
  }
}

function publicFailure(): { code: "request_rejected"; message: "request rejected" } {
  return { code: "request_rejected", message: "request rejected" };
}

function rejectedDecision(escalateTurnstile: boolean): AbuseDecision {
  return {
    allowed: false,
    remaining: 0,
    escalateTurnstile,
    failure: publicFailure(),
  };
}
