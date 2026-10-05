// ABOUTME: G02 evidence redaction scan: one needle per prohibited content class.
// ABOUTME: run.ts plants G02_CANARIES in flow inputs; the scan proves none reach evidence.

// Planted canaries: synthetic secret/private payloads that must never surface
// in generated evidence. Content classes (task bodies, cookies, bearer
// secrets, hook payloads, artifact bytes, terminal output) have no reliable
// format signature, so each is watched by its exact planted value. Format
// classes (local paths, private keys, token shapes) are watched by patterns.
export const G02_CANARIES = {
  taskBody: "G02-CANARY-TASK-BODY-alpha",
  cookie: "G02-CANARY-COOKIE-beta=smoke-forged-secret",
  bearer: "Bearer G02-CANARY-BEARER-gamma",
  hook: "G02-CANARY-HOOK-PAYLOAD-delta",
  artifact: "G02-CANARY-ARTIFACT-BYTES-epsilon",
  terminal: "G02-CANARY-TERMINAL-OUTPUT-zeta",
};

interface ScanPattern {
  name: string;
  pattern: RegExp;
}

// Format needles. Each is precise enough to pass the evidence's own redaction
// prose: bare words such as "cookies", "hook payloads", or "terminal output"
// and the redacted "Bearer [REDACTED]" placeholder must not hit.
const SCAN_PATTERNS: ScanPattern[] = [
  // Local absolute paths, including the mkdtemp scratch dirs the gate uses.
  { name: "local_path", pattern: /(\/Users\/|\/home\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\)/ },
  // Private keys, bare or PEM-wrapped (RSA/EC variants included).
  { name: "private_key", pattern: /BEGIN PRIVATE KEY/ },
  { name: "private_key", pattern: /-----[A-Z ]*PRIVATE KEY-----/ },
  // Bearer secrets with a token-shaped value; the redacted placeholder has none.
  { name: "bearer_secret", pattern: /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/ },
  // Cookie assignments name a cookie; prose that merely says "cookies" is clean.
  { name: "cookie_value", pattern: /[A-Za-z0-9_$-]*cookie[A-Za-z0-9_$-]*\s*=\s*[^\s;,]+/i },
  // Provider token shapes.
  { name: "provider_token", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "provider_token", pattern: /gh[pousr]_[A-Za-z0-9]+/ },
  { name: "provider_token", pattern: /xox[baprs]-[A-Za-z0-9-]+/ },
];

/** Reports prohibited content in one evidence document. Empty means clean. */
export function scanEvidenceText(text: string): string[] {
  const hits: string[] = [];
  for (const [key, value] of Object.entries(G02_CANARIES)) {
    if (value !== "" && text.includes(value)) {
      hits.push(`canary:${key}`);
    }
  }
  for (const { name, pattern } of SCAN_PATTERNS) {
    if (pattern.test(text)) {
      hits.push(`pattern:${name}`);
    }
  }
  return [...new Set(hits)];
}
