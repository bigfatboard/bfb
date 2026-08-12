// ABOUTME: Verifies persistence timestamps match the canonical wire UTC calendar rules.
// ABOUTME: Covers proleptic Gregorian year-zero and invalid-day boundaries.

import { describe, expect, it } from "vitest";

import { assertUtcTimestamp } from "../src/timestamps.js";

describe("UTC timestamp persistence boundary", () => {
  it("accepts the canonical leap day in year zero", () => {
    expect(assertUtcTimestamp("0000-02-29T00:00:00Z")).toBe("0000-02-29T00:00:00Z");
  });

  it("rejects an invalid day in year zero", () => {
    expect(() => assertUtcTimestamp("0000-02-30T00:00:00Z")).toThrow(/invalid UTC timestamp/);
  });
});
