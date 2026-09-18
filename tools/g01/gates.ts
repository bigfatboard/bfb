// ABOUTME: Declares the G01 release-gate composition table with per-gate proof owners.
// ABOUTME: Keeps each gate row pointing at the package target and manifest that carry its proof.

export interface GateRow {
  gate: string;
  status: "passed" | "waived" | "failed" | "not_run";
  /** "G01" for gates G01 proves itself; otherwise the owning WP id (e.g. "C04"). */
  owner: string;
  command: string;
  evidence: string;
  waiver?: string;
  detail: string;
}

export const G01_COMMAND = "pnpm test:g01";
export const G01_GATE_EVIDENCE = "docs/work-packages/evidence/WP-G01/gate-report.json";

// A waiver is only authorized by an architecture decision record that names
// the gate and records Timo's explicit decision, per docs/work-packages/ACCEPTANCE.md.
export const WAIVER_ADR_PATTERN = /docs\/adr\/(\d{4})-[A-Za-z0-9-]+\.md/;

// A passed release gate cannot cite proof that records a failed run: per
// docs/work-packages/ACCEPTANCE.md a flaky check is not a release gate.
// linkedDocuments are the parsed JSON artifacts the owning manifest links
// from its commands.
export function flakyProofDefect(row: GateRow, linkedDocuments: unknown[]): string | null {
  if (row.status !== "passed" || row.owner === "G01") {
    return null;
  }
  if (!linkedDocuments.some(hasFailedRun)) {
    return null;
  }
  return (
    `${row.gate} cites ${row.evidence}, which records a failed run: ` +
    `a flaky check is not a release gate`
  );
}

function hasFailedRun(document: unknown): boolean {
  let failed = false;
  const visit = (value: unknown, insideGateRuns: boolean): void => {
    if (failed) {
      return;
    }
    if (typeof value === "string") {
      if (value === "failed" && insideGateRuns) {
        failed = true;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, insideGateRuns);
      }
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    const record = value as Record<string, unknown>;
    if (record["outcome"] === "failed" && typeof record["command"] === "string") {
      failed = true;
      return;
    }
    for (const [key, entry] of Object.entries(record)) {
      visit(entry, insideGateRuns || key === "gate_runs");
    }
  };
  visit(document, false);
  return failed;
}

export function waiverDefect(row: GateRow, adrIndex: Map<string, string>): string | null {
  if (row.status !== "waived") return null;
  if (!row.waiver) return `${row.gate} is waived without a recorded waiver`;
  const cited = WAIVER_ADR_PATTERN.exec(row.waiver)?.[0];
  if (!cited) return `${row.gate} waiver cites no docs/adr decision record`;
  const adr = adrIndex.get(cited);
  if (!adr) return `${row.gate} waiver cites ${cited}, which is not a recorded ADR`;
  if (!adr.includes(row.gate)) return `${cited} does not decide ${row.gate}`;
  if (!/timo/i.test(adr) || !/decision/i.test(adr)) {
    return `${cited} records no explicit Timo decision for ${row.gate}`;
  }
  return null;
}

export const GATE_ROWS: GateRow[] = [
  {
    gate: "AG-01",
    status: "passed",
    owner: "C04",
    command: "pnpm test:c04",
    evidence: "docs/work-packages/evidence/WP-C04/manifest.json",
    detail:
      "Owner/member/reviewer matrix holds across all ten fixture projects; owning evidence WP-C04/WP-C06/WP-W01/WP-X03A.",
  },
  {
    gate: "AG-02",
    status: "failed",
    owner: "L05",
    command: "pnpm test:l05",
    evidence: "docs/work-packages/evidence/WP-L05/manifest.json",
    detail:
      "Native Terminal proof is not a deterministic release gate: WP-L05 certification records one fail-closed clean-checkout failure in five full gates (exactly one SIGINT with a verified whole-group end, yet a same-instant ownership uncertainty wedged the release leg past its wait with the lock retained), and the retained evidence is the bounded redacted matrix plus command-result assertions with no separate raw launch trace committed. Cloud-plane contention, expiry, and cleanup receipts pass in G01. No ADR and no explicit decision authorizes a waiver, so the gate fails instead of passing.",
  },
  {
    gate: "AG-03",
    status: "passed",
    owner: "E01",
    command: "pnpm test:e01",
    evidence: "docs/work-packages/evidence/WP-E01/manifest.json",
    detail:
      "Duplicate/out-of-order/concurrent ingest has one effect with exact replay; owning evidence WP-E01/WP-E02/WP-L06.",
  },
  {
    gate: "AG-04",
    status: "failed",
    owner: "G01",
    command: "pnpm test:g01",
    evidence: "docs/work-packages/evidence/WP-G01/gate-report.json",
    detail:
      "Shared Stop/exit lifecycle predicate matrix and provider capability ceilings pass in G01, but live Claude/Codex/Grok turns are unproven: provider credentials and consent are unavailable, L07 is review pending live Claude credentials, and P01/P02 are planned. No ADR and no explicit decision authorizes a waiver, so the gate fails instead of waiving.",
  },
  {
    gate: "AG-05",
    status: "passed",
    owner: "A02",
    command: "pnpm test:a02",
    evidence: "docs/work-packages/evidence/WP-A02/manifest.json",
    detail:
      "Attention request/answer/resolve round-trips with version guards; owning evidence WP-A02/WP-E02/WP-X01.",
  },
  {
    gate: "AG-06",
    status: "passed",
    owner: "V03",
    command: "pnpm test:v03",
    evidence: "docs/work-packages/evidence/WP-V03/manifest.json",
    detail:
      "Hostile bytes publish inertly; single-use grants; sweep spares live versions; owning evidence WP-V01/WP-V02/WP-V03.",
  },
  {
    gate: "AG-07",
    status: "passed",
    owner: "A04",
    command: "pnpm test:a04",
    evidence: "docs/work-packages/evidence/WP-A04/manifest.json",
    detail:
      "Token observations dedupe; derivations union exact/estimated/unavailable; owning evidence WP-A04/WP-E01.",
  },
  {
    gate: "AG-08",
    status: "passed",
    owner: "C04",
    command: "pnpm test:c04",
    evidence: "docs/work-packages/evidence/WP-C04/manifest.json",
    detail:
      "Epoch, grant, token, and delegation revocation fence authority before cleanup; owning evidence WP-C04/WP-C05/WP-C06.",
  },
  {
    gate: "AG-09",
    status: "passed",
    owner: "G01",
    command: "pnpm test:g01",
    evidence: "docs/work-packages/evidence/WP-G01/gate-report.json",
    detail:
      "Injection corpus rejected; launch specs carry no executable surface; hostile browser isolation in the G01 browser report; owning evidence WP-V02/WP-V03.",
  },
  {
    gate: "AG-10",
    status: "not_run",
    owner: "G01",
    command: "pnpm test:g01",
    evidence: "docs/work-packages/evidence/WP-G01/gate-report.json",
    detail: "G02 owns clean-install proof.",
    waiver: "G02 owns AG-10; the G01 procedure and frozen release candidate are recorded for G02.",
  },
  {
    gate: "SG-01",
    status: "passed",
    owner: "G01",
    command: "pnpm test:g01",
    evidence: "docs/work-packages/evidence/WP-G01/gate-report.json",
    detail:
      "Credential-type confusion matrix with live delegation revocation; owning evidence WP-C02/WP-C03/WP-C05/WP-C06/WP-X03A.",
  },
  {
    gate: "SG-02",
    status: "passed",
    owner: "C01",
    command: "pnpm test:c01",
    evidence: "docs/work-packages/evidence/WP-C01/manifest.json",
    detail: "Hub FIFO with idempotent results and eviction recovery; owning evidence WP-C01.",
  },
  {
    gate: "SG-03",
    status: "passed",
    owner: "V01",
    command: "pnpm test:v01",
    evidence: "docs/work-packages/evidence/WP-V01/manifest.json",
    detail:
      "No v0.1 artifact delete path; uploads converge on content hash; owning evidence WP-V01/WP-X05.",
  },
  {
    gate: "SG-04",
    status: "passed",
    owner: "G01",
    command: "pnpm test:g01",
    evidence: "docs/work-packages/evidence/WP-G01/gate-report.json",
    detail:
      "Step-up mismatch/stale/replay matrix rejects bypasses; owning evidence WP-C02/WP-C03/WP-X03A.",
  },
  {
    gate: "SG-05",
    status: "passed",
    owner: "G01",
    command: "pnpm test:g01",
    evidence: "docs/work-packages/evidence/WP-G01/gate-report.json",
    detail:
      "Selection extracts IDs; links, payloads, audit, activity, and diagnostics carry no canaries; browser URL scan in the G01 browser report; owning evidence WP-X01/WP-X04/WP-X05.",
  },
  {
    gate: "OG-01",
    status: "passed",
    owner: "X04",
    command: "pnpm test:x04",
    evidence: "docs/work-packages/evidence/WP-X04/manifest.json",
    detail:
      "Hub idempotency, ledger redelivery, and GitHub webhook dedupe converge on one effect; Queue/DLQ/Cron delivery owning evidence WP-X04/WP-X05.",
  },
  {
    gate: "OG-02",
    status: "not_run",
    owner: "G01",
    command: "pnpm test:g01",
    evidence: "docs/work-packages/evidence/WP-G01/gate-report.json",
    detail: "G02 owns migration/rotation/rollback proof.",
    waiver:
      "G02 owns OG-02; the G01 migration matrix (empty plus populated upgrade) is recorded for G02.",
  },
];
