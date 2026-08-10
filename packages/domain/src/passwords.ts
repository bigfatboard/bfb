// ABOUTME: Hashes and verifies human passwords for C02 email sign-in.
// ABOUTME: Uses scrypt with a fixed synthetic salt scheme for fixtures; never logs passwords.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_KEYLEN = 32;

export function hashPassword(password: string, salt?: string): string {
  const usedSalt = salt ?? randomBytes(16).toString("hex");
  const hash = scryptSync(password, usedSalt, SCRYPT_KEYLEN).toString("hex");
  return `scrypt$${usedSalt}$${hash}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const salt = parts[1] ?? "";
  const expected = parts[2] ?? "";
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  try {
    return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/** Fixture password used by synthetic humans in tests and local demos. */
export const SYNTHETIC_PASSWORD = "synthetic-password";
