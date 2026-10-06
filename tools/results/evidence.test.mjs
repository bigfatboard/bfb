// ABOUTME: Pins runtime result evidence to exact redacted deterministic command projections.
// ABOUTME: Preserves historical result artifacts and rejects identities, private payloads or timestamps.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  duplicateResultEntry,
  EXPECTED_RUNTIME_RECORDING,
  RUNTIME_TRANSITIONS,
  serializeRuntimeRecording,
  serializeRuntimeTransitions,
} from "./evidence.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = resolve(root, "docs/work-packages/evidence/WP-A03");

test("duplicate projections compare identity but never retain it", () => {
  assert.deepEqual(
    duplicateResultEntry("first-live-id", "first-live-id", true),
    duplicateResultEntry("different-live-id", "different-live-id", true),
  );
  assert.equal(duplicateResultEntry("first", "different", true).same_submission, false);
});

test("serialized trace rejects arbitrary private and volatile fields", () => {
  for (const field of [
    "summary",
    "limitations",
    "local_path",
    "request_id",
    "elapsed_ms",
    "captured_at",
    "token",
  ]) {
    const entries = EXPECTED_RUNTIME_RECORDING.map((entry) => ({ ...entry }));
    entries[0][field] = "must-not-be-recorded";
    assert.throws(() => serializeRuntimeRecording(entries));
  }
});

test("the committed current trace is byte-identical to its bounded projection", async () => {
  assert.equal(
    await readFile(resolve(evidence, "runtime-recording.jsonl"), "utf8"),
    serializeRuntimeRecording(EXPECTED_RUNTIME_RECORDING),
  );
});

test("the transition trace names its isolated scope without overstating native proof", async () => {
  const text = await readFile(resolve(evidence, "runtime-transition-matrix.json"), "utf8");
  assert.equal(text, serializeRuntimeTransitions());
  assert.deepEqual(JSON.parse(text), RUNTIME_TRANSITIONS);
});

test("historical manifests and fixtures remain separately identified", async () => {
  const text = await readFile(resolve(evidence, "command-result.json"), "utf8");
  assert.ok(!text.includes("A03_NATIVE_PROOF_COMPLETE"));
  const stale = JSON.parse(await readFile(resolve(evidence, "fixtures/stale-review.json"), "utf8"));
  assert.ok(stale && typeof stale === "object");
});
