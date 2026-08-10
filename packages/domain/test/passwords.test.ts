// ABOUTME: Verifies scrypt password hashing rejects wrong passwords for C02 sign-in.
// ABOUTME: Uses the real hashPassword/verifyPassword helpers, not a reimplementation.

import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword, SYNTHETIC_PASSWORD } from "../src/passwords.js";

describe("password verification", () => {
  it("accepts the correct password and rejects wrong ones", () => {
    const encoded = hashPassword(SYNTHETIC_PASSWORD, "test-salt");
    expect(verifyPassword(SYNTHETIC_PASSWORD, encoded)).toBe(true);
    expect(verifyPassword("wrong", encoded)).toBe(false);
    expect(verifyPassword("", encoded)).toBe(false);
  });
});
