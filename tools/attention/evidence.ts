// ABOUTME: Deterministic builders for the A02 harness evidence files.
// ABOUTME: Evidence records step outcomes only; live ids and wall-clock timings never reach disk.

import assert from "node:assert/strict";

export interface RecordingEntry {
  step: string;
  [key: string]: unknown;
}

export interface WaiterCadence {
  pending_polls: number;
  poll_states: string[];
  timeout_pending_polls: number;
  repeat_reads: string[];
  total_steps: number;
}

export const EXPECTED_RECORDING_STEPS = [
  "migration_ok",
  "launch_claimed",
  "requested",
  "idempotent_replay",
  "waiter_pending_polls",
  "answered",
  "waiter_returned_identical",
  "duplicate_rejected",
  "permission_matrix",
  "resolved",
  "timeout_retry",
  "request_guards",
  "revocation",
  "reconnect_reread",
  "audit_redaction",
  "observations",
] as const;

export function migrationOkEntry(preservedTaskId: string): RecordingEntry {
  return { step: "migration_ok", preserved: preservedTaskId.length > 0 };
}

export function launchClaimedEntry(generation: number): RecordingEntry {
  return { step: "launch_claimed", claimed: true, generation };
}

export function requestedEntry(kind: string, version: number): RecordingEntry {
  return { step: "requested", kind, version };
}

export function idempotentReplayEntry(
  firstId: string | null,
  secondId: string | null,
): RecordingEntry {
  return { step: "idempotent_replay", converged: firstId !== null && firstId === secondId };
}

export function waiterPendingPollsEntry(states: Array<string>): RecordingEntry {
  return { step: "waiter_pending_polls", polls: states.length, states: [...states] };
}

export function answeredEntry(version: number, by: string): RecordingEntry {
  return { step: "answered", version, by };
}

export function waiterIdenticalEntry(version: number): RecordingEntry {
  return { step: "waiter_returned_identical", version, identical: true };
}

export function duplicateRejectedEntry(code: string, keptVersion: number): RecordingEntry {
  return { step: "duplicate_rejected", code, kept_version: keptVersion };
}

export function permissionMatrixEntry(): RecordingEntry {
  return {
    step: "permission_matrix",
    reviewer_review: "answered",
    reviewer_credential: "forbidden",
    member_credential: "forbidden",
    owner_credential: "answered",
  };
}

export function resolvedEntry(version: number): RecordingEntry {
  return { step: "resolved", version, state: "resolved" };
}

export function timeoutRetryEntry(
  pendingPolls: number,
  repeatReads: Array<string>,
): RecordingEntry {
  return { step: "timeout_retry", pending_polls: pendingPolls, repeat_reads: [...repeatReads] };
}

export function requestGuardsEntry(): RecordingEntry {
  return {
    step: "request_guards",
    foreign_execution: "request_rejected",
    terminal_run: "invalid_transition",
  };
}

export function revocationEntry(code: string): RecordingEntry {
  return { step: "revocation", old_epoch_answer: code };
}

export function reconnectRereadEntry(state: string, ranked: number): RecordingEntry {
  return { step: "reconnect_reread", state, ranked };
}

export function auditRedactionEntry(resultBindsRecord: boolean): RecordingEntry {
  return {
    step: "audit_redaction",
    input_echo: "metadata-only",
    result_binds_record: resultBindsRecord,
  };
}

export function observationsEntry(
  firstRequest: Array<{ kind: string; actor: string }>,
  trail: Array<string>,
): RecordingEntry {
  return {
    step: "observations",
    first_request: firstRequest.map((entry) => ({ ...entry })),
    trail: [...trail],
  };
}

export function waiterCadenceEntry(input: {
  pendingPolls: number;
  pollStates: Array<string>;
  timeoutPendingPolls: number;
  repeatReads: Array<string>;
  totalSteps: number;
}): WaiterCadence {
  return {
    pending_polls: input.pendingPolls,
    poll_states: [...input.pollStates],
    timeout_pending_polls: input.timeoutPendingPolls,
    repeat_reads: [...input.repeatReads],
    total_steps: input.totalSteps,
  };
}

export function serializeRecording(entries: Array<RecordingEntry>): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

const ulidPattern = /\b[0-9A-HJKMNP-TV-Z]{26}\b/u;
const volatileKeys = new Set(["elapsed_ms", "request_ms", "answer_ms"]);

function assertNoVolatileContent(value: unknown, path: string): void {
  if (typeof value === "string") {
    assert.ok(
      !ulidPattern.test(value),
      `${path} must not carry a generated id, found ${JSON.stringify(value)}`,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoVolatileContent(item, `${path}[${index}]`);
    });
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      assert.ok(!volatileKeys.has(key), `${path}.${key} is a wall-clock timing and is forbidden`);
      assertNoVolatileContent(item, `${path}.${key}`);
    }
  }
}

export function assertStableRecording(entries: Array<RecordingEntry>): void {
  assert.deepEqual(
    entries.map((entry) => entry.step),
    [...EXPECTED_RECORDING_STEPS],
    "recording keeps its sixteen canonical steps in order",
  );
  for (const [index, entry] of entries.entries()) {
    assertNoVolatileContent(entry, `recording[${index}]`);
  }
}

export function assertStableCadence(value: unknown): void {
  assert.equal(typeof value, "object", "waiter cadence is one JSON object");
  assert.ok(value !== null, "waiter cadence is one JSON object");
  const cadence = value as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(cadence).sort(),
    ["pending_polls", "poll_states", "repeat_reads", "timeout_pending_polls", "total_steps"],
    "waiter cadence carries counts and states only",
  );
  assertNoVolatileContent(cadence, "waiter-cadence");
}
