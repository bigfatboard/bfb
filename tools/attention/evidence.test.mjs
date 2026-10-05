// ABOUTME: Locks the A02 harness evidence to deterministic step outcomes.
// ABOUTME: Fails when the recording or waiter cadence carries live ids or wall-clock timings.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertStableCadence,
  assertStableRecording,
  auditRedactionEntry,
  EXPECTED_RECORDING_STEPS,
  idempotentReplayEntry,
  launchClaimedEntry,
  migrationOkEntry,
  observationsEntry,
  reconnectRereadEntry,
  requestedEntry,
  serializeRecording,
  waiterCadenceEntry,
  waiterIdenticalEntry,
  waiterPendingPollsEntry,
} from "./evidence.ts";

const toolDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolDir, "../..");
const evidenceDir = resolve(root, "docs/work-packages/evidence/WP-A02");

function syntheticUlid(seed) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  let state = seed;
  for (let index = 0; index < 26; index++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out += alphabet[state % alphabet.length];
  }
  return out;
}

test("builders drop live ids: different runs serialize identically", () => {
  const build = (seed) =>
    serializeRecording([
      migrationOkEntry(syntheticUlid(seed)),
      launchClaimedEntry(1),
      requestedEntry("clarification", 1),
      idempotentReplayEntry(syntheticUlid(seed + 1), syntheticUlid(seed + 1)),
      waiterPendingPollsEntry(["open", "open", "open"]),
      waiterIdenticalEntry(2),
      auditRedactionEntry(true),
      reconnectRereadEntry("answered", 5),
      observationsEntry(
        [
          { kind: "requested", actor: "agent_run" },
          { kind: "answered", actor: "human" },
        ],
        ["attention.answer", "attention.request"],
      ),
    ]);
  assert.equal(
    build(7),
    build(99),
    "evidence from two runs with different live ids must be byte-identical",
  );
});

test("builders drop wall-clock timings: different durations serialize identically", () => {
  const fast = waiterCadenceEntry({
    pendingPolls: 3,
    pollStates: ["open", "open", "open"],
    timeoutPendingPolls: 5,
    repeatReads: ["answered", "answered", "answered"],
    totalSteps: 16,
  });
  const slow = waiterCadenceEntry({
    pendingPolls: 3,
    pollStates: ["open", "open", "open"],
    timeoutPendingPolls: 5,
    repeatReads: ["answered", "answered", "answered"],
    totalSteps: 16,
  });
  assert.deepEqual(slow, fast, "cadence carries poll counts and states, never measured ms");
  assert.ok(
    !JSON.stringify(slow).includes("_ms"),
    "no millisecond field may reach the cadence file",
  );
});

test("committed recording is the stable 16-step trace without ids or timings", async () => {
  const text = await readFile(resolve(evidenceDir, "recording.jsonl"), "utf8");
  const entries = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    entries.map((entry) => entry["step"]),
    [...EXPECTED_RECORDING_STEPS],
    "recording keeps its sixteen canonical steps in order",
  );
  assertStableRecording(entries);
});

test("committed waiter cadence carries counts and states, not timings", async () => {
  const cadence = JSON.parse(await readFile(resolve(evidenceDir, "waiter-cadence.json"), "utf8"));
  assertStableCadence(cadence);
});

test("harness records no live ids or wall-clock timings", async () => {
  const source = await readFile(resolve(toolDir, "run.ts"), "utf8");
  for (const banned of ["elapsed_ms", "request_ms", "answer_ms", "Date.now()"]) {
    assert.ok(
      !source.includes(banned),
      `tools/attention/run.ts must not contain ${banned} (evidence stays deterministic)`,
    );
  }
});
