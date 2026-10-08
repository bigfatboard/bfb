// ABOUTME: Validates independent bounded offline result-submission permission.
// ABOUTME: Missing permission denies capture and descendant policies can only tighten it.

import { DomainError } from "./hub.js";

export interface OfflineAgentResultsPolicy {
  allow_submit_result: boolean;
  max_pending_age_seconds: number;
}

export function deniedOfflineAgentResults(): OfflineAgentResultsPolicy {
  return { allow_submit_result: false, max_pending_age_seconds: 0 };
}

export function normalizeOfflineAgentResults(value: unknown): OfflineAgentResultsPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("invalid_policy", "offline_agent_results must be a complete object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const age = record.max_pending_age_seconds;
  if (
    keys.length !== 2 ||
    keys[0] !== "allow_submit_result" ||
    keys[1] !== "max_pending_age_seconds" ||
    typeof record.allow_submit_result !== "boolean" ||
    !Number.isSafeInteger(age) ||
    (record.allow_submit_result ? Number(age) < 1 || Number(age) > 300 : age !== 0)
  ) {
    throw new DomainError("invalid_policy", "offline_agent_results contains invalid fields");
  }
  return {
    allow_submit_result: record.allow_submit_result,
    max_pending_age_seconds: age as number,
  };
}

export function assertOfflineAgentResultsTightens(
  parent: OfflineAgentResultsPolicy,
  child: OfflineAgentResultsPolicy,
): void {
  const ceiling = normalizeOfflineAgentResults(parent);
  const requested = normalizeOfflineAgentResults(child);
  if (
    (!ceiling.allow_submit_result && requested.allow_submit_result) ||
    requested.max_pending_age_seconds > ceiling.max_pending_age_seconds
  ) {
    throw new DomainError("policy_widening", "offline agent results cannot widen their parent");
  }
}
