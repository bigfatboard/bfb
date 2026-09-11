// ABOUTME: Prevents probe summaries from turning ambiguous process outcomes into capability evidence.
// ABOUTME: Covers exact identity, escalation, spawn loss and native concurrency classification.

import assert from "node:assert/strict";
import test from "node:test";
import { classifyCapabilities } from "./capabilities.mjs";

test("presence alone proves no fresh, continuation or permission capability", () => {
  const result = classifyCapabilities({ fresh: { session_id: "synthetic" } });
  assert.equal(result.fresh, "unverified");
  assert.equal(result.exact_resume, "unverified");
  assert.equal(result.read_only, "unverified");
});

test("resume and fork require the observed source identity and remembered fixture", () => {
  const cases = {
    fresh: { completed: true, reply_confirmed: true, session_id: "source" },
    resume: { completed: true, remembered_marker: true, session_id: "source" },
    fork: { completed: true, remembered_marker: true, session_id: "other" },
  };
  assert.equal(classifyCapabilities(cases).exact_resume, "supported");
  assert.equal(classifyCapabilities(cases).fork, "supported");
  cases.resume.session_id = "other";
  cases.fork.session_id = "source";
  assert.equal(classifyCapabilities(cases).exact_resume, "unverified");
  assert.equal(classifyCapabilities(cases).fork, "unverified");
});

test("forced stop, timeout and pre-turn signals do not prove native interrupt", () => {
  const interrupt = { interrupted: true, turn_observed: true };
  assert.equal(classifyCapabilities({ interrupt }).interrupt, "supported");
  for (const fault of [
    { escalated: true },
    { timed_out: true },
    { completed: true },
    { process_lost: true },
    { turn_observed: false },
  ]) {
    assert.equal(
      classifyCapabilities({ interrupt: { ...interrupt, ...fault } }).interrupt,
      "unverified",
    );
  }
});

test("spawn failure and loss do not prove wrong-session rejection", () => {
  for (const wrong of [
    { code: null },
    { code: 0 },
    { code: 1, timed_out: true },
    { code: 1, process_lost: true },
    { code: 1, started: true },
  ]) {
    assert.equal(
      classifyCapabilities({ wrong_session: wrong }).wrong_session_rejection,
      "unverified",
    );
  }
  assert.equal(
    classifyCapabilities({ wrong_session: { code: 1, started: false } }).wrong_session_rejection,
    "supported",
  );
});

test("native busy and duplicate input behavior stay distinct from BFB fencing", () => {
  assert.equal(
    classifyCapabilities({ busy_contender: { overlapping_identity: true } })
      .native_busy_session_rejection,
    "unsupported",
  );
  assert.equal(
    classifyCapabilities({
      busy_contender: { active_writer_rejected: true, started: false, code: 1 },
    }).native_busy_session_rejection,
    "supported",
  );
  assert.equal(
    classifyCapabilities({
      duplicate_first: { completed: true },
      duplicate_second: { completed: true },
    }).native_duplicate_suppression,
    "unsupported",
  );
  assert.equal(classifyCapabilities({}).native_external_idle, "unverified");
  assert.equal(classifyCapabilities({}).native_external_active, "unverified");
});
