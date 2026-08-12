// ABOUTME: Validates wire-shaped UTC timestamps for persistence boundaries.
// ABOUTME: Rejects non-Z, missing T, and non-ISO values before SQL writes.

const UTC_PATTERN =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-5][0-9])(?:\.[0-9]{1,6})?Z$/;

/** Returns the timestamp when it is a valid wire UTC instant; otherwise throws. */
export function assertUtcTimestamp(value: string, field = "timestamp"): string {
  const match = typeof value === "string" ? UTC_PATTERN.exec(value) : null;
  if (!match) {
    throw new Error(`invalid UTC timestamp for ${field}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const daysInMonth =
    month >= 1 && month <= 12
      ? [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
      : undefined;
  if (!daysInMonth || day < 1 || day > daysInMonth || hour > 23 || minute > 59) {
    throw new Error(`invalid UTC timestamp for ${field}`);
  }
  return value;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
