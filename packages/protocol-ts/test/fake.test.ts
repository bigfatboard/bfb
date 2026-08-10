// ABOUTME: Exercises the fake control plane and protocol client synthetic launch/event loop.
// ABOUTME: Proves enrollment, claim, final auth, event disposition, context, and attention fixtures.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FakeControlPlane, FakeProtocolClient } from "../src/fake/control-plane.js";
import type {
  ExecutionAssignment,
  LaunchClaim,
  LaunchSpecification,
  RunnerEnrollment,
  RunnerEventSubmission,
} from "../src/generated/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturesRoot = path.join(repoRoot, "protocol/fixtures/v1/valid");

function load<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixturesRoot, name), "utf8")) as T;
}

describe("fake control plane round trip", () => {
  it("enrolls, claims, authorizes, accepts events, and serves context/attention", () => {
    const plane = new FakeControlPlane();
    const client = new FakeProtocolClient(plane);

    const enrollment = load<RunnerEnrollment>("runner-enrollment.online.json");
    expect(client.enroll(enrollment).status).toBe("online");

    const specification = load<LaunchSpecification>("launch-specification.interactive.json");
    const assignment = load<ExecutionAssignment>("execution-assignment.active.json");
    plane.queueLaunch({ specification, assignment });

    const claim = load<LaunchClaim>("launch-claim.request.json");
    expect(client.claim(claim).launch_id).toBe(specification.launch_id);

    const auth = client.finalAuthorize(specification.launch_id, "2026-08-07T12:00:02Z");
    expect(auth.decision).toBe("authorized");

    const submission = load<RunnerEventSubmission>("runner-event-submission.heartbeat.json");
    const disposition = client.submitEvent(submission, enrollment.runner_id);
    expect(disposition.disposition).toBe("accepted");

    const envelope = plane.getEvent(submission.event_id);
    expect(envelope?.workspace_id).toBe(assignment.workspace_id);
    expect(envelope?.task_id).toBe(assignment.task_id);
    // claimed fields must not authoritatively diverge attribution
    expect(envelope?.workspace_id).not.toBeUndefined();

    plane.putContext({
      task_id: assignment.task_id,
      version: 1,
      audience: "agent",
      body: "synthetic agent context",
    });
    expect(client.getContext(assignment.task_id)?.audience).toBe("agent");

    plane.putAttention({
      attention_id: "01JBFB0ATTENT1000000000000",
      task_id: assignment.task_id,
      state: "open",
      summary: "synthetic attention",
    });
    expect(client.getAttention("01JBFB0ATTENT1000000000000")?.state).toBe("open");
  });

  it("rejects events after runner revocation", () => {
    const plane = new FakeControlPlane();
    const enrollment = load<RunnerEnrollment>("runner-enrollment.online.json");
    plane.enroll(enrollment);
    const specification = load<LaunchSpecification>("launch-specification.interactive.json");
    const assignment = load<ExecutionAssignment>("execution-assignment.active.json");
    plane.queueLaunch({ specification, assignment });
    plane.claimLaunch(load("launch-claim.request.json"));
    plane.revokeRunner(enrollment.runner_id);

    const submission = load<RunnerEventSubmission>("runner-event-submission.heartbeat.json");
    const disposition = plane.submitEvent(submission, enrollment.runner_id);
    expect(disposition.disposition).toBe("permanently_rejected");
  });
});
