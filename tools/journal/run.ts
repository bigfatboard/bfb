// ABOUTME: Certifies the L06 journal upload contract against the F02 fake ingest server.
// ABOUTME: Writes a bounded redacted disposition report without provider or secret material.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FakeControlPlane,
  FakeProtocolClient,
} from "../../packages/protocol-ts/src/fake/control-plane.js";
import type {
  ExecutionAssignment,
  LaunchClaim,
  LaunchSpecification,
  RunnerEnrollment,
  RunnerEventSubmission,
} from "../../packages/protocol-ts/src/generated/types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixturesRoot = resolve(root, "protocol/fixtures/v1/valid");
const evidenceDir = resolve(root, "docs/work-packages/evidence/WP-L06");

function load<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), "utf8")) as T;
}

// Synthetic ULIDs below reuse the reserved fixture alphabet. They are test
// vectors only and never authenticate against a real control plane.
const STREAM = "01JBFB0106STREAM0000000000";
const now = "2026-08-07T12:00:02.000Z";
const plane = new FakeControlPlane(() => now);
const client = new FakeProtocolClient(plane);

const enrollment = load<RunnerEnrollment>("runner-enrollment.online.json");
const specification = load<LaunchSpecification>("launch-specification.interactive.json");
const assignment = load<ExecutionAssignment>("execution-assignment.active.json");
const claim = load<LaunchClaim>("launch-claim.request.json");
plane.seedEnrollment(enrollment);
client.enroll(enrollment.runner_id);
plane.queueLaunch({ specification, assignment });
client.claim(claim);
client.finalAuthorize(specification.launch_id);

function submission(
  eventId: string,
  sequence: number,
  kind: RunnerEventSubmission["kind"],
  captureOrigin: RunnerEventSubmission["capture_origin"],
  extra: Partial<RunnerEventSubmission> = {},
): RunnerEventSubmission {
  return {
    schema_version: 1,
    event_id: eventId,
    source_stream_id: STREAM,
    source_sequence: sequence,
    source_event_id: `l06-${sequence}`,
    run_execution_id: assignment.run_execution_id,
    assignment_generation: assignment.assignment_generation,
    claimed_workspace_id: assignment.workspace_id,
    kind,
    occurred_at: "2026-08-07T12:00:02Z",
    capture_origin: captureOrigin,
    payload: {},
    ...extra,
  };
}

const results: Array<{ check: string; disposition: string }> = [];
function check(name: string, event: RunnerEventSubmission, want: string): void {
  const disposition = client.submitEvent(event);
  assert.equal(disposition.disposition, want, name);
  assert.equal(disposition.event_id, event.event_id, name + " identity");
  assert.equal(disposition.source_stream_id, event.source_stream_id, name + " stream");
  assert.equal(disposition.source_sequence, event.source_sequence, name + " sequence");
  results.push({ check: name, disposition: disposition.disposition });
}

// Journal-shaped agent telemetry is accepted and attributed from the immutable
// assignment, never from the runner's claimed hints.
const session = submission("01JBFB0106EVENT00000000001", 1, "session_started", "agent_reported", {
  provider_session_id: "sess-l06-synthetic",
});
check("session_started accepted", session, "accepted");
const envelope = plane.getEvent(session.event_id);
assert.equal(envelope?.workspace_id, assignment.workspace_id);
assert.equal(envelope?.run_execution_id, assignment.run_execution_id);
assert.equal(envelope?.actor.type, "agent_run");
assert.equal(envelope?.provider_session_id, "sess-l06-synthetic");

const heartbeat = submission("01JBFB0106EVENT00000000002", 2, "heartbeat", "runner_observed");
check("heartbeat accepted", heartbeat, "accepted");
assert.equal(plane.getEvent(heartbeat.event_id)?.actor.type, "runner");

// Transport retries of one persisted submission have exactly one effect.
check("duplicate replay accepted", session, "accepted");
assert.equal(plane.getEvent(session.event_id)?.workspace_cursor, envelope?.workspace_cursor);

// Conflicting claimed attribution is permanently rejected without blocking the
// stream; later events from the same assignment still upload.
const mismatch = submission("01JBFB0106EVENT00000000003", 3, "turn_started", "agent_reported", {
  claimed_workspace_id: "01JBFB0W0RKSPACE0000000001",
});
check("attribution mismatch rejected", mismatch, "permanently_rejected");
const later = submission("01JBFB0106EVENT00000000004", 4, "turn_started", "agent_reported");
check("later event accepted after reject", later, "accepted");

const unknown = submission("01JBFB0106EVENT00000000005", 5, "turn_started", "agent_reported", {
  run_execution_id: "01JBFB0EXECZZZZ00000000000",
});
check("unknown assignment rejected", unknown, "permanently_rejected");

await mkdir(evidenceDir, { recursive: true });
await writeFile(
  resolve(evidenceDir, "fake-ingest.json"),
  JSON.stringify(
    {
      package: "L06",
      fake: "F02 FakeControlPlane",
      submitted: results.length,
      accepted: results.filter((item) => item.disposition === "accepted").length,
      rejected: results.filter((item) => item.disposition === "permanently_rejected").length,
      checks: results,
    },
    null,
    2,
  ) + "\n",
);
console.log(`L06 fake ingest acceptance passed (${results.length} checks)`);
