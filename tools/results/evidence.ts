// ABOUTME: Validates bounded deterministic evidence from the real result command harness.
// ABOUTME: Keeps generated identities, private result content and wall-clock facts out of committed traces.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadMigrationManifest } from "@bfb/db";

export const EXPECTED_RUNTIME_RECORDING = [
  { step: "migration", head: "0040_offline_result_policy", result_tables_present: true },
  { step: "human_submit", version: 1, run: "submitted", task: "review" },
  { step: "cross_worker_retry", replayed: true, same_submission: true },
  { step: "changed_retry", code: "request_rejected" },
  {
    step: "guards",
    duplicate_evidence: "invalid_argument",
    reviewer_submit: "forbidden",
    stale_accept: "stale_version",
  },
  { step: "request_changes", run: "changes_requested", task: "active" },
  { step: "resubmit", versions: [2, 1], old_outdated: true, immutable_history: true },
  { step: "human_accept", run: "accepted", task: "done" },
  { step: "agent_self_accept", code: "forbidden" },
  { step: "review_race", winners: 1, reviews: 1, loser: "invalid_transition" },
  { step: "lease_retention", identical: true },
  { step: "failure", run: "failed", task: "active" },
  { step: "privacy", private_result_and_review_payloads_absent: true },
] as const;

export const CERTIFIED_RUNTIME_MIGRATION_HEAD = EXPECTED_RUNTIME_RECORDING[0].head;
const migrationManifest = loadMigrationManifest(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations/d1"),
);

function validateRuntimeMigrationHead(head: string): void {
  assert.ok(
    migrationManifest.migrations.some((entry) => entry.id === CERTIFIED_RUNTIME_MIGRATION_HEAD),
    "A03 offline result policy migration must be registered",
  );
  assert.ok(
    head === CERTIFIED_RUNTIME_MIGRATION_HEAD || head === migrationManifest.migration_head,
    "runtime result trace requires its certified or actual manifest head",
  );
}

/** A newer integration run validates its own head without replacing the certified trace. */
export function shouldWriteRuntimeEvidence(head: string): boolean {
  validateRuntimeMigrationHead(head);
  return head === CERTIFIED_RUNTIME_MIGRATION_HEAD;
}

export const RUNTIME_TRANSITIONS = {
  submitted: { run: "submitted", task: "review" },
  changes_requested: { run: "changes_requested", task: "active" },
  accepted: { run: "accepted", task: "done" },
  failed: { run: "failed", task: "active" },
  cancellation: "covered_by_domain_and_route_matrix_not_this_trace",
  ownership: "human_decisions_do_not_release_live_checkout_lease",
  scope: "isolated_real_worker_hub_d1_human_command_trace",
} as const;

export function serializeRuntimeRecording(
  entries: readonly unknown[],
  migrationHead: string = CERTIFIED_RUNTIME_MIGRATION_HEAD,
): string {
  validateRuntimeMigrationHead(migrationHead);
  assert.deepEqual(
    entries,
    EXPECTED_RUNTIME_RECORDING.map((entry) =>
      entry.step === "migration" ? { ...entry, head: migrationHead } : entry,
    ),
    "runtime result trace must match exact safe projections",
  );
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export function serializeRuntimeTransitions(): string {
  return `${JSON.stringify(RUNTIME_TRANSITIONS, null, 2)}\n`;
}

export function duplicateResultEntry(firstId: string, repeatedId: string, replayed: boolean) {
  return {
    step: "cross_worker_retry",
    replayed,
    same_submission: firstId.length > 0 && firstId === repeatedId,
  };
}
