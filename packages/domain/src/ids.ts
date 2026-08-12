// ABOUTME: Provides deterministic synthetic and random ULID helpers for domain tests and fixtures.
// ABOUTME: Production call sites may inject clock-based generators without coupling to transport.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

export function syntheticUlid(tag: string): string {
  const cleaned = tag
    .toUpperCase()
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V")
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, "0");
  return ("01JBFB0" + cleaned + "00000000000000000000").slice(0, 26);
}

export function randomUlid(random: () => number = Math.random): string {
  let out = "01";
  while (out.length < 26) {
    out += CROCKFORD[Math.floor(random() * CROCKFORD.length)] ?? "0";
  }
  return out;
}
