// ABOUTME: Validates wire-shaped UTC timestamps for persistence boundaries.
// ABOUTME: Rejects non-Z, missing T, and non-ISO values before SQL writes.

const UTC_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/;

/** Returns the timestamp when it is a valid wire UTC instant; otherwise throws. */
export function assertUtcTimestamp(value: string, field = "timestamp"): string {
  if (typeof value !== "string" || !UTC_PATTERN.test(value)) {
    throw new Error(`invalid UTC timestamp for ${field}`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`invalid UTC timestamp for ${field}`);
  }
  return value;
}
