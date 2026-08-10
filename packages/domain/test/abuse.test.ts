// ABOUTME: Verifies C01 shared D1 abuse-control counters across repeated requests.
// ABOUTME: Bucket keys are hashed and isolate memory is not consulted.

import { describe, expect, it } from "vitest";

import { abuseBucketKey, consumeRateLimit, hashIp } from "../src/abuse.js";
import { openDomainDb } from "./helpers.js";

describe("abuse control", () => {
  it("enforces a shared D1-backed limit", () => {
    const db = openDomainDb();
    const key = abuseBucketKey({
      ipHashSeed: hashIp("203.0.113.10"),
      subject: "oauth-token",
      surface: "mcp",
    });
    expect(key).not.toContain("203.0.113.10");
    for (let i = 0; i < 3; i += 1) {
      const decision = consumeRateLimit(db, key, "2026-08-07T12:00:0" + i + "Z", 3, 60);
      expect(decision.allowed).toBe(true);
    }
    const blocked = consumeRateLimit(db, key, "2026-08-07T12:00:04Z", 3, 60);
    expect(blocked.allowed).toBe(false);
  });
});
