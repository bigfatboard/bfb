// ABOUTME: Pure Operations request builders, labels, and role-gated section visibility.
// ABOUTME: DOM behavior is proven in the Playwright spec; this module pins the presentation contract.

export type OperationsRole = "owner" | "member" | "reviewer";

export const OPS_SECTION_LABELS = {
  health: "Health",
  queues: "Queues & stuck work",
  activity: "Activity",
  securityAudit: "Security audit",
  retention: "Retention",
  diagnostics: "Diagnostics",
} as const;

export type OpsSection = keyof typeof OPS_SECTION_LABELS;

const OWNER_SECTIONS: OpsSection[] = [
  "health",
  "queues",
  "activity",
  "securityAudit",
  "retention",
  "diagnostics",
];
const MEMBER_SECTIONS: OpsSection[] = ["health", "queues", "activity", "retention", "diagnostics"];
const REVIEWER_SECTIONS: OpsSection[] = ["activity"];

/** Owner-only security audit and privileged recovery never render for other roles. */
export function visibleSections(role: OperationsRole): OpsSection[] {
  if (role === "owner") {
    return OWNER_SECTIONS;
  }
  if (role === "member") {
    return MEMBER_SECTIONS;
  }
  return REVIEWER_SECTIONS;
}

export function operationsPath(workspaceId: string, suffix: string): string {
  return `/api/v1/workspaces/${workspaceId}/operations${suffix}`;
}

export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface RecoveryTarget {
  kind:
    | "retry_notification_dispatch"
    | "requeue_github_outbox"
    | "resolve_stuck_upload"
    | "clear_recovery_state";
  target: Record<string, unknown>;
}

export function buildRecoveryBody(
  kind: RecoveryTarget["kind"],
  target: Record<string, unknown>,
): {
  kind: string;
  target: Record<string, unknown>;
  request_id: string;
} {
  return { kind, target, request_id: `ops-${newIdempotencyKey()}` };
}

/** Recovery target IDs shown in the UI are opaque identifiers only, never content. */
export function describeStuckItem(item: {
  command_id?: string;
  version_id?: string;
  age_ms: number;
}): string {
  const id = item.command_id ?? item.version_id ?? "unknown";
  const seconds = Math.max(0, Math.round(item.age_ms / 1000));
  return `${id.slice(0, 8)}… stuck ${seconds}s`;
}

export function formatCount(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}
