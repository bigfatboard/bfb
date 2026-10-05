// ABOUTME: Validates the bounded offline permissions available to run-scoped agent work.
// ABOUTME: Missing permission fails closed and child policies can only tighten their parent.

import { DomainError } from "./hub.js";

export const OFFLINE_AGENT_TOOLS = [
  "bfb_add_comment",
  "bfb_propose_task",
  "bfb_report_progress",
  "bfb_update_task",
] as const;

export type OfflineAgentTool = (typeof OFFLINE_AGENT_TOOLS)[number];

export interface OfflineAgentWorkPolicy {
  allowed_tools: OfflineAgentTool[];
  max_pending_age_seconds: number;
}

export function deniedOfflineAgentWork(): OfflineAgentWorkPolicy {
  return { allowed_tools: [], max_pending_age_seconds: 0 };
}

export function normalizeOfflineAgentWork(value: unknown): OfflineAgentWorkPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("invalid_policy", "offline_agent_work must be a complete object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "allowed_tools" ||
    keys[1] !== "max_pending_age_seconds" ||
    !Array.isArray(record.allowed_tools) ||
    record.allowed_tools.some(
      (tool) => typeof tool !== "string" || !OFFLINE_AGENT_TOOLS.includes(tool as OfflineAgentTool),
    ) ||
    !Number.isSafeInteger(record.max_pending_age_seconds)
  ) {
    throw new DomainError("invalid_policy", "offline_agent_work contains invalid fields");
  }
  const tools = [...new Set(record.allowed_tools as OfflineAgentTool[])].sort();
  const age = record.max_pending_age_seconds as number;
  if ((tools.length === 0 && age !== 0) || (tools.length > 0 && (age < 1 || age > 300))) {
    throw new DomainError(
      "invalid_policy",
      "offline_agent_work age must match its tool permission",
    );
  }
  return { allowed_tools: tools, max_pending_age_seconds: age };
}

export function assertOfflineAgentWorkTightens(
  parent: OfflineAgentWorkPolicy,
  child: OfflineAgentWorkPolicy,
): void {
  const ceiling = normalizeOfflineAgentWork(parent);
  const requested = normalizeOfflineAgentWork(child);
  if (
    requested.allowed_tools.some((tool) => !ceiling.allowed_tools.includes(tool)) ||
    requested.max_pending_age_seconds > ceiling.max_pending_age_seconds
  ) {
    throw new DomainError("policy_widening", "offline agent work cannot widen its parent");
  }
}
