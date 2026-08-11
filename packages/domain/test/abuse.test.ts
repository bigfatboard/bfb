// ABOUTME: Verifies C01 atomic abuse budgets across concurrent and repeated requests.
// ABOUTME: Tests hashed storage, window resets, request bounds, expiry, and uniform failures.

import { describe, expect, it } from "vitest";

import {
  abuseBucketKey,
  consumeAbuseBudget,
  consumeRateLimit,
  hashIp,
  type AbusePolicy,
} from "../src/abuse.js";
import { openDomainDb } from "./helpers.js";

const policy: AbusePolicy = {
  attemptLimit: 2,
  pollLimit: 3,
  windowSeconds: 60,
  maxBodyBytes: 1024,
};

function bucket(): string {
  return abuseBucketKey({
    ipHashSeed: hashIp("203.0.113.10"),
    subject: "oauth-token-secret",
    surface: "mcp",
    client: "oauth-client-secret",
  });
}

describe("abuse control", () => {
  it("atomically counts concurrent requests and reaches Turnstile escalation", async () => {
    const db = await openDomainDb();
    const key = bucket();
    const decisions = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        consumeRateLimit(db, key, `2026-08-07T12:00:0${index}Z`, 3, 60),
      ),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(3);
    expect(decisions.at(-1)?.escalateTurnstile).toBe(true);

    const stored = (await db.prepare(`SELECT bucket_key, count FROM rate_limit_buckets`).get()) as {
      bucket_key: string;
      count: number;
    };
    expect(stored).toEqual({ bucket_key: key, count: 6 });
    expect(stored.bucket_key).not.toContain("203.0.113.10");
    expect(stored.bucket_key).not.toContain("oauth-token-secret");
    expect(stored.bucket_key).not.toContain("oauth-client-secret");
  });

  it("resets the durable window at its exact boundary", async () => {
    const db = await openDomainDb();
    const key = bucket();
    await consumeRateLimit(db, key, "2026-08-07T12:00:00Z", 1, 60);
    const blocked = await consumeRateLimit(db, key, "2026-08-07T12:00:59.999Z", 1, 60);
    const reset = await consumeRateLimit(db, key, "2026-08-07T12:01:00Z", 1, 60);
    expect(blocked.allowed).toBe(false);
    expect(reset).toMatchObject({ allowed: true, remaining: 0, escalateTurnstile: false });
  });

  it("separates attempt and polling budgets", async () => {
    const db = await openDomainDb();
    const base = {
      bucketKey: bucket(),
      bodyBytes: 128,
      now: "2026-08-07T12:00:00Z",
      expiresAt: "2026-08-07T12:05:00Z",
    };
    const attempts = await Promise.all(
      Array.from({ length: 3 }, () =>
        consumeAbuseBudget(db, { ...base, activity: "attempt" }, policy),
      ),
    );
    const polls = await Promise.all(
      Array.from({ length: 3 }, () =>
        consumeAbuseBudget(db, { ...base, activity: "poll" }, policy),
      ),
    );
    expect(attempts.map((decision) => decision.allowed).sort()).toEqual([false, true, true]);
    expect(polls.every((decision) => decision.allowed)).toBe(true);
  });

  it("uses one public failure for exhausted, oversized, and expired requests", async () => {
    const db = await openDomainDb();
    const base = {
      bucketKey: bucket(),
      activity: "attempt" as const,
      bodyBytes: 128,
      now: "2026-08-07T12:00:00Z",
      expiresAt: "2026-08-07T12:05:00Z",
    };
    await consumeAbuseBudget(db, base, { ...policy, attemptLimit: 1 });
    const exhausted = await consumeAbuseBudget(db, base, { ...policy, attemptLimit: 1 });
    const oversized = await consumeAbuseBudget(
      db,
      { ...base, bodyBytes: policy.maxBodyBytes + 1 },
      policy,
    );
    const expired = await consumeAbuseBudget(db, { ...base, expiresAt: base.now }, policy);
    expect(exhausted.failure).toEqual({ code: "request_rejected", message: "request rejected" });
    expect(oversized.failure).toEqual(exhausted.failure);
    expect(expired.failure).toEqual(exhausted.failure);
    expect([exhausted, oversized, expired].every((decision) => !decision.allowed)).toBe(true);
    const stored = (await db
      .prepare(`SELECT SUM(count) AS count FROM rate_limit_buckets`)
      .get()) as { count: number };
    expect(stored.count).toBe(2);
  });

  it("rejects raw bucket keys and unbounded policy values before persistence", async () => {
    const db = await openDomainDb();
    await expect(
      consumeRateLimit(db, "203.0.113.10", "2026-08-07T12:00:00Z", 3, 60),
    ).rejects.toThrow("SHA-256");
    await expect(
      consumeAbuseBudget(
        db,
        {
          bucketKey: bucket(),
          activity: "attempt",
          bodyBytes: 1,
          now: "2026-08-07T12:00:00Z",
          expiresAt: "2026-08-07T12:01:00Z",
        },
        { ...policy, attemptLimit: Number.POSITIVE_INFINITY },
      ),
    ).rejects.toThrow("invalid attempt limit");
    expect(() =>
      abuseBucketKey({
        ipHashSeed: "203.0.113.10",
        subject: "oauth-token",
        surface: "mcp",
      }),
    ).toThrow("IP hash seed");
    expect(() => hashIp("x".repeat(65))).toThrow("invalid IP address");
  });
});
