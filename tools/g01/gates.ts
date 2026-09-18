// ABOUTME: Declares the G01 release-gate composition table with per-gate proof owners.
// ABOUTME: Keeps each gate row pointing at the package target and manifest that carry its proof.

export interface GateRow {
  gate: string;
  status: "passed" | "waived" | "not_run";
  /** "G01" for gates G01 proves itself; otherwise the owning WP id (e.g. "C04"). */
  owner: string;
  command: string;
  evidence: string;
  waiver?: string;
  detail: string;
}

export const G01_COMMAND = "pnpm test:g01";
export const G01_GATE_EVIDENCE = "docs/work-packages/evidence/WP-G01/gate-report.json";

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
    status: "waived",
    owner: "G01",
    command: "pnpm test:g01",
    evidence: "docs/work-packages/evidence/WP-G01/gate-report.json",
    detail:
      "Cloud-plane contention, expiry, and cleanup receipts pass in G01; owning evidence WP-C09/WP-W02.",
    waiver:
      "Native Terminal launch trace is L05-owned and blocked on L05 Terminal acceptance; this machine cannot drive Terminal from G01 while the L05 agent owns it.",
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
    status: "waived",
    owner: "G01",
    command: "pnpm test:g01",
    evidence: "docs/work-packages/evidence/WP-G01/gate-report.json",
    detail:
      "Shared Stop/exit lifecycle predicate matrix and provider capability ceilings pass in G01; owning evidence WP-L03/WP-L07/WP-P01/WP-P02.",
    waiver:
      "Live Claude/Codex/Grok turns need L05 supervision plus provider credentials and consent, unavailable to G01.",
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
