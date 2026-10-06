// ABOUTME: Pins measurement runtime evidence to deterministic body-free projections.
// ABOUTME: Keeps current security proof distinct from historical arithmetic fixtures and native delivery.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_RUNTIME_SNAPSHOTS,
  RUNTIME_EVIDENCE_SCOPE,
  serializeRuntimeSnapshots,
} from "./evidence.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = resolve(root, "docs/work-packages/evidence/WP-A04");

test("current snapshots have explicit isolated and connected proof scopes", () => {
  const result = JSON.parse(serializeRuntimeSnapshots(EXPECTED_RUNTIME_SNAPSHOTS));
  assert.deepEqual(result.scope, RUNTIME_EVIDENCE_SCOPE);
  assert.equal(result.snapshots.current_human_loop.fixed_calculation_clock_separate, true);
  assert.equal(result.snapshots.derivation.attention_wait_ms, 0);
});

test("unexpected identities, bodies and clocks cannot enter measurement evidence", () => {
  for (const field of [
    "question",
    "summary",
    "run_id",
    "usage_id",
    "local_path",
    "token",
    "observed_at",
  ]) {
    const snapshot = structuredClone(EXPECTED_RUNTIME_SNAPSHOTS);
    snapshot.current_human_loop[field] = "private-or-volatile";
    assert.throws(() => serializeRuntimeSnapshots(snapshot));
  }
});

test("the current artifact is byte-identical to the bounded projection", async () => {
  assert.equal(
    await readFile(resolve(evidence, "runtime-calculation-snapshots.json"), "utf8"),
    serializeRuntimeSnapshots(EXPECTED_RUNTIME_SNAPSHOTS),
  );
});

test("historical calculation evidence stays separately identified", async () => {
  const historical = JSON.parse(
    await readFile(resolve(evidence, "calculation-snapshots.json"), "utf8"),
  );
  assert.equal(historical.scope, undefined);
  assert.equal(historical.snapshots.derivation.attention_wait_ms, 120_000);
  assert.equal(historical.snapshots.current_human_loop, undefined);
});

test("provider fixture absence remains null rather than measured zero", async () => {
  const absent = JSON.parse(
    await readFile(resolve(evidence, "fixtures/missing-usage.json"), "utf8"),
  );
  assert.equal(absent.quality, "unavailable");
  assert.ok(Object.values(absent.expected).every((value) => value === null));
});
