// ABOUTME: Pins runtime result evidence to exact redacted deterministic command projections.
// ABOUTME: Preserves historical result artifacts and rejects identities, private payloads or timestamps.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadMigrationManifest } from "@bfb/db";
import {
  CERTIFIED_RUNTIME_MIGRATION_HEAD,
  duplicateResultEntry,
  EXPECTED_RUNTIME_RECORDING,
  RUNTIME_TRANSITIONS,
  serializeRuntimeRecording,
  serializeRuntimeTransitions,
  shouldWriteRuntimeEvidence,
} from "./evidence.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = resolve(root, "docs/work-packages/evidence/WP-A03");
const migrationManifest = loadMigrationManifest(resolve(root, "migrations/d1"));
const atHead = (head) =>
  EXPECTED_RUNTIME_RECORDING.map((entry) =>
    entry.step === "migration" ? { ...entry, head } : { ...entry },
  );

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
    for (const head of [CERTIFIED_RUNTIME_MIGRATION_HEAD, migrationManifest.migration_head]) {
      const entries = atHead(head);
      entries[0][field] = "must-not-be-recorded";
      assert.throws(() => serializeRuntimeRecording(entries, head));
    }
  }
});

test("the current manifest head validates without replacing the certified recording", async () => {
  const head = migrationManifest.migration_head;
  const baseline = await readFile(resolve(evidence, "runtime-recording.jsonl"), "utf8");
  const serialized = serializeRuntimeRecording(atHead(head), head);
  assert.equal(JSON.parse(serialized.split("\n")[0]).head, head);
  assert.equal(shouldWriteRuntimeEvidence(head), head === CERTIFIED_RUNTIME_MIGRATION_HEAD);
  assert.equal(shouldWriteRuntimeEvidence(CERTIFIED_RUNTIME_MIGRATION_HEAD), true);
  assert.equal(baseline, serializeRuntimeRecording(EXPECTED_RUNTIME_RECORDING));
  assert.equal(await readFile(resolve(evidence, "runtime-recording.jsonl"), "utf8"), baseline);
  if (head !== CERTIFIED_RUNTIME_MIGRATION_HEAD) {
    assert.notEqual(serialized, baseline);
    assert.throws(() => serializeRuntimeRecording(atHead(head)));
    assert.throws(() => serializeRuntimeRecording(EXPECTED_RUNTIME_RECORDING, head));
  }
});

test("arbitrary and older migration heads cannot be recorded or written", () => {
  for (const head of ["0041_arbitrary", "9999_arbitrary", "0039_offline_agent_policy", "secret"]) {
    assert.throws(() => serializeRuntimeRecording(atHead(head), head));
    assert.throws(() => shouldWriteRuntimeEvidence(head));
  }
});

test("a newer head does not relax any non-migration projection", () => {
  const head = migrationManifest.migration_head;
  const entries = atHead(head);
  entries[1].task = "done";
  assert.throws(() => serializeRuntimeRecording(entries, head));
});

test("the certified trace is byte-identical to its bounded projection", async () => {
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
