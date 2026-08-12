// ABOUTME: Validates persistence-boundary identifiers and counters against F02 primitives.
// ABOUTME: Keeps database authority inputs aligned with the canonical wire contract.

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function assertUlid(value: string, field: string): string {
  if (typeof value !== "string" || !ULID_PATTERN.test(value)) {
    throw new Error(`${field} must be a ULID`);
  }
  return value;
}

export function assertAuthorizationEpoch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("authorization epoch must be a positive safe integer");
  }
  return value;
}
