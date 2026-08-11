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

const fixtureNow = "2026-08-07T12:00:02Z";

function planeAt(now = fixtureNow): FakeControlPlane {
  return new FakeControlPlane(() => now);
}

function prepareLaunch(): {
  plane: FakeControlPlane;
  client: FakeProtocolClient;
  enrollment: RunnerEnrollment;
  specification: LaunchSpecification;
  assignment: ExecutionAssignment;
  claim: LaunchClaim;
} {
  const plane = planeAt();
  const client = new FakeProtocolClient(plane);
  const enrollment = load<RunnerEnrollment>("runner-enrollment.online.json");
  const specification = load<LaunchSpecification>("launch-specification.interactive.json");
  const assignment = load<ExecutionAssignment>("execution-assignment.active.json");
  const claim = load<LaunchClaim>("launch-claim.request.json");
  plane.seedEnrollment(enrollment);
  client.enroll(enrollment.runner_id);
  plane.queueLaunch({ specification, assignment });
  client.claim(claim);
  return { plane, client, enrollment, specification, assignment, claim };
}

describe("fake control plane round trip", () => {
  it("enrolls, claims, authorizes, accepts events, and serves context/attention", () => {
    const plane = planeAt();
    const client = new FakeProtocolClient(plane);

    const enrollment = load<RunnerEnrollment>("runner-enrollment.online.json");
    plane.seedEnrollment(enrollment);
    expect(client.enroll(enrollment.runner_id).status).toBe("online");

    const specification = load<LaunchSpecification>("launch-specification.interactive.json");
    const assignment = load<ExecutionAssignment>("execution-assignment.active.json");
    plane.queueLaunch({ specification, assignment });

    const claim = load<LaunchClaim>("launch-claim.request.json");
    expect(client.claim(claim).launch_id).toBe(specification.launch_id);

    const auth = client.finalAuthorize(specification.launch_id);
    expect(auth.decision).toBe("authorized");

    const submission = load<RunnerEventSubmission>("runner-event-submission.heartbeat.json");
    const disposition = client.submitEvent(submission);
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
    const plane = planeAt();
    const enrollment = load<RunnerEnrollment>("runner-enrollment.online.json");
    plane.seedEnrollment(enrollment);
    plane.enrollRunner(enrollment.runner_id);
    const specification = load<LaunchSpecification>("launch-specification.interactive.json");
    const assignment = load<ExecutionAssignment>("execution-assignment.active.json");
    plane.queueLaunch({ specification, assignment });
    plane.claimLaunch(load("launch-claim.request.json"), enrollment.authorization_epoch);
    plane.finalAuthorize(
      specification.launch_id,
      enrollment.runner_id,
      enrollment.authorization_epoch,
    );
    const accepted = load<RunnerEventSubmission>("runner-event-submission.heartbeat.json");
    expect(
      plane.submitEvent(accepted, enrollment.runner_id, enrollment.authorization_epoch).disposition,
    ).toBe("accepted");
    plane.revokeRunner(enrollment.runner_id);

    const submission = {
      ...accepted,
      event_id: "01JBFB0EVENT00200000000000",
      source_sequence: accepted.source_sequence + 1,
    };
    const disposition = plane.submitEvent(
      submission,
      enrollment.runner_id,
      enrollment.authorization_epoch,
    );
    expect(disposition.disposition).toBe("permanently_rejected");
    expect(disposition.diagnostic?.code).toBe("runner_revoked");
  });

  it("does not let a runner invent its enrollment grants", () => {
    const plane = planeAt();
    const client = new FakeProtocolClient(plane);
    expect(() => client.enroll("01JBFB0RVNNER1D00000000000")).toThrow("runner not seeded");
  });

  it("rejects launch assignments that do not match the immutable specification", () => {
    const plane = planeAt();
    const enrollment = load<RunnerEnrollment>("runner-enrollment.online.json");
    plane.seedEnrollment(enrollment);
    plane.enrollRunner(enrollment.runner_id);
    const specification = load<LaunchSpecification>("launch-specification.interactive.json");
    const assignment = load<ExecutionAssignment>("execution-assignment.active.json");

    expect(() =>
      plane.queueLaunch({
        specification,
        assignment: { ...assignment, task_id: "01JBFB0TASKYYYY00000000000" },
      }),
    ).toThrow("assignment does not match launch specification");
  });

  it("rejects expired claims and final authorization after expiry", () => {
    let now = fixtureNow;
    const plane = new FakeControlPlane(() => now);
    const enrollment = load<RunnerEnrollment>("runner-enrollment.online.json");
    plane.seedEnrollment(enrollment);
    plane.enrollRunner(enrollment.runner_id);
    const specification = load<LaunchSpecification>("launch-specification.interactive.json");
    const assignment = load<ExecutionAssignment>("execution-assignment.active.json");
    plane.queueLaunch({ specification, assignment });

    const claim = load<LaunchClaim>("launch-claim.request.json");
    now = specification.expires_at;
    expect(() =>
      plane.claimLaunch(
        { ...claim, claimed_at: "2026-08-07T12:00:00Z" },
        enrollment.authorization_epoch,
      ),
    ).toThrow("launch expired");

    now = fixtureNow;
    plane.claimLaunch(claim, enrollment.authorization_epoch);
    now = specification.expires_at;
    const authorization = plane.finalAuthorize(
      specification.launch_id,
      enrollment.runner_id,
      enrollment.authorization_epoch,
    );
    expect(authorization.decision).toBe("rejected");
    expect(authorization.rejection?.code).toBe("launch_expired");
  });

  it("rejects conflicting runner attribution hints", () => {
    const plane = planeAt();
    const enrollment = load<RunnerEnrollment>("runner-enrollment.online.json");
    plane.seedEnrollment(enrollment);
    plane.enrollRunner(enrollment.runner_id);
    const specification = load<LaunchSpecification>("launch-specification.interactive.json");
    const assignment = load<ExecutionAssignment>("execution-assignment.active.json");
    plane.queueLaunch({ specification, assignment });
    plane.claimLaunch(load("launch-claim.request.json"), enrollment.authorization_epoch);
    plane.finalAuthorize(
      specification.launch_id,
      enrollment.runner_id,
      enrollment.authorization_epoch,
    );

    const submission = load<RunnerEventSubmission>("runner-event-submission.heartbeat.json");
    const disposition = plane.submitEvent(
      { ...submission, claimed_task_id: "01JBFB0TASKYYYY00000000000" },
      enrollment.runner_id,
      enrollment.authorization_epoch,
    );
    expect(disposition.disposition).toBe("permanently_rejected");
    expect(disposition.diagnostic?.category).toBe("authoritative_runner_claim");
  });

  it("deduplicates a source stream sequence independently of event ids", () => {
    const plane = planeAt();
    const enrollment = load<RunnerEnrollment>("runner-enrollment.online.json");
    plane.seedEnrollment(enrollment);
    plane.enrollRunner(enrollment.runner_id);
    const specification = load<LaunchSpecification>("launch-specification.interactive.json");
    const assignment = load<ExecutionAssignment>("execution-assignment.active.json");
    plane.queueLaunch({ specification, assignment });
    plane.claimLaunch(load("launch-claim.request.json"), enrollment.authorization_epoch);
    plane.finalAuthorize(
      specification.launch_id,
      enrollment.runner_id,
      enrollment.authorization_epoch,
    );

    const submission = load<RunnerEventSubmission>("runner-event-submission.heartbeat.json");
    expect(
      plane.submitEvent(submission, enrollment.runner_id, enrollment.authorization_epoch)
        .disposition,
    ).toBe("accepted");
    const duplicateSequence = plane.submitEvent(
      { ...submission, event_id: "01JBFB0EVENT00200000000000" },
      enrollment.runner_id,
      enrollment.authorization_epoch,
    );
    expect(duplicateSequence.disposition).toBe("permanently_rejected");
    expect(duplicateSequence.diagnostic?.code).toBe("source_identity_collision");
  });

  it("assigns workspace cursors independently", () => {
    const plane = planeAt();
    const firstEnrollment = load<RunnerEnrollment>("runner-enrollment.online.json");
    const firstSpecification = load<LaunchSpecification>("launch-specification.interactive.json");
    const firstAssignment = load<ExecutionAssignment>("execution-assignment.active.json");
    const firstClaim = load<LaunchClaim>("launch-claim.request.json");
    const firstSubmission = load<RunnerEventSubmission>("runner-event-submission.heartbeat.json");

    plane.seedEnrollment(firstEnrollment);
    plane.enrollRunner(firstEnrollment.runner_id);
    plane.queueLaunch({ specification: firstSpecification, assignment: firstAssignment });
    plane.claimLaunch(firstClaim, firstEnrollment.authorization_epoch);
    plane.finalAuthorize(
      firstSpecification.launch_id,
      firstEnrollment.runner_id,
      firstEnrollment.authorization_epoch,
    );
    plane.submitEvent(
      firstSubmission,
      firstEnrollment.runner_id,
      firstEnrollment.authorization_epoch,
    );

    const secondEnrollment: RunnerEnrollment = {
      ...firstEnrollment,
      runner_id: "01JBFB0RVNNER2D00000000000",
      workspace_id: "01JBFB0W0RKSPACE0000000001",
      granted_project_ids: ["01JBFB0PR0JECTY00000000000"],
    };
    const secondSpecification: LaunchSpecification = {
      ...firstSpecification,
      launch_id: "01JBFB01AVNCH2D00000000000",
      run_id: "01JBFB0RVNYYYYY00000000000",
      run_execution_id: "01JBFB0EXECYYYY00000000000",
      task_id: "01JBFB0TASKYYYY00000000000",
      runner_id: secondEnrollment.runner_id,
      checkout_id: "01JBFB0CHECK0VY00000000000",
    };
    const secondAssignment: ExecutionAssignment = {
      ...firstAssignment,
      run_execution_id: secondSpecification.run_execution_id,
      runner_id: secondEnrollment.runner_id,
      run_id: secondSpecification.run_id,
      task_id: secondSpecification.task_id,
      project_id: secondEnrollment.granted_project_ids?.[0] ?? "",
      workspace_id: secondEnrollment.workspace_id,
      checkout_id: secondSpecification.checkout_id,
    };
    const secondClaim: LaunchClaim = {
      ...firstClaim,
      launch_id: secondSpecification.launch_id,
      runner_id: secondEnrollment.runner_id,
      idempotency_key: "claim-synthetic-002",
    };
    const secondSubmission: RunnerEventSubmission = {
      ...firstSubmission,
      event_id: "01JBFB0EVENT00200000000000",
      source_stream_id: "01JBFB0STREAM0200000000000",
      source_sequence: 1,
      run_execution_id: secondSpecification.run_execution_id,
      claimed_workspace_id: secondEnrollment.workspace_id,
    };

    plane.seedEnrollment(secondEnrollment);
    plane.enrollRunner(secondEnrollment.runner_id);
    plane.queueLaunch({ specification: secondSpecification, assignment: secondAssignment });
    plane.claimLaunch(secondClaim, secondEnrollment.authorization_epoch);
    plane.finalAuthorize(
      secondSpecification.launch_id,
      secondEnrollment.runner_id,
      secondEnrollment.authorization_epoch,
    );
    plane.submitEvent(
      secondSubmission,
      secondEnrollment.runner_id,
      secondEnrollment.authorization_epoch,
    );

    expect(plane.getEvent(firstSubmission.event_id)?.workspace_cursor).toBe(1);
    expect(plane.getEvent(secondSubmission.event_id)?.workspace_cursor).toBe(1);
  });

  it("keeps enrollment, launch, event, context, and attention authority immutable", () => {
    const plane = planeAt();
    const client = new FakeProtocolClient(plane);
    const enrollment = load<RunnerEnrollment>("runner-enrollment.online.json");
    plane.seedEnrollment(enrollment);
    const returnedEnrollment = client.enroll(enrollment.runner_id);
    returnedEnrollment.granted_project_ids?.push("01JBFB0PR0JECTY00000000000");

    const specification = load<LaunchSpecification>("launch-specification.interactive.json");
    const assignment = load<ExecutionAssignment>("execution-assignment.active.json");
    const returnedSpecification = plane.queueLaunch({ specification, assignment });
    returnedSpecification.expires_at = "2026-08-07T11:00:00Z";
    specification.expires_at = "2026-08-07T11:00:00Z";
    expect(client.claim(load("launch-claim.request.json")).expires_at).toBe("2026-08-07T12:05:00Z");

    client.finalAuthorize(returnedSpecification.launch_id);
    const submission = load<RunnerEventSubmission>("runner-event-submission.heartbeat.json");
    expect(client.submitEvent(submission).disposition).toBe("accepted");
    const event = plane.getEvent(submission.event_id);
    if (!event) {
      throw new Error("accepted event missing");
    }
    event.actor.id = "01JBFB0RVNNER2D00000000000";
    expect(plane.getEvent(submission.event_id)?.actor.id).toBe(enrollment.runner_id);

    const context = plane.putContext({
      task_id: assignment.task_id,
      version: 1,
      audience: "agent",
      body: "immutable context",
    });
    context.body = "mutated";
    expect(
      plane.getContext(assignment.task_id, enrollment.runner_id, enrollment.authorization_epoch)
        ?.body,
    ).toBe("immutable context");

    const attention = plane.putAttention({
      attention_id: "01JBFB0ATTENT1000000000000",
      task_id: assignment.task_id,
      state: "open",
      summary: "immutable attention",
    });
    attention.state = "resolved";
    expect(
      plane.getAttention(
        attention.attention_id,
        enrollment.runner_id,
        enrollment.authorization_epoch,
      )?.state,
    ).toBe("open");
  });

  it("fails closed for absent project grants and rechecks changed grants", () => {
    const plane = planeAt();
    const enrollment = load<RunnerEnrollment>("runner-enrollment.online.json");
    const specification = load<LaunchSpecification>("launch-specification.interactive.json");
    const assignment = load<ExecutionAssignment>("execution-assignment.active.json");
    const { granted_project_ids: _grants, ...withoutGrants } = enrollment;
    plane.seedEnrollment(withoutGrants);
    plane.enrollRunner(enrollment.runner_id);
    expect(() => plane.queueLaunch({ specification, assignment })).toThrow(
      "assignment project is outside runner enrollment",
    );

    plane.seedEnrollment(enrollment);
    plane.queueLaunch({ specification, assignment });
    plane.seedEnrollment({ ...enrollment, granted_project_ids: [] });
    expect(() =>
      plane.claimLaunch(load("launch-claim.request.json"), enrollment.authorization_epoch),
    ).toThrow("runner grant revoked");
  });

  it("makes launch queueing and claims immutable and idempotent", () => {
    const { plane, enrollment, specification, assignment, claim } = prepareLaunch();
    expect(plane.queueLaunch({ specification, assignment }).launch_id).toBe(
      specification.launch_id,
    );
    expect(plane.claimLaunch(claim, enrollment.authorization_epoch).launch_id).toBe(
      specification.launch_id,
    );
    expect(() =>
      plane.claimLaunch(
        { ...claim, idempotency_key: "claim-conflict-002" },
        enrollment.authorization_epoch,
      ),
    ).toThrow("launch already claimed");

    const conflictingSpecification = {
      ...specification,
      run_id: "01JBFB0RVNYYYYY00000000000",
    };
    const conflictingAssignment = {
      ...assignment,
      run_id: conflictingSpecification.run_id,
    };
    expect(() =>
      plane.queueLaunch({
        specification: conflictingSpecification,
        assignment: conflictingAssignment,
      }),
    ).toThrow("launch id conflicts with immutable launch");

    const secondSpecification = {
      ...specification,
      launch_id: "01JBFB01AVNCH2D00000000000",
    };
    expect(() => plane.queueLaunch({ specification: secondSpecification, assignment })).toThrow(
      "execution assignment is already bound to another launch",
    );
  });

  it("binds each protocol client to one runner for claim, authorization, and events", () => {
    const { plane, client, enrollment } = prepareLaunch();
    expect(() => client.enroll("01JBFB0RVNNER2D00000000000")).toThrow(
      "already bound to another runner",
    );
    expect(() =>
      client.claim({
        ...load<LaunchClaim>("launch-claim.request.json"),
        runner_id: "01JBFB0RVNNER2D00000000000",
      }),
    ).toThrow("protocol client runner mismatch");
    expect(client.finalAuthorize("01JBFB01AVNCH1D00000000000").decision).toBe("authorized");

    const otherEnrollment = {
      ...enrollment,
      runner_id: "01JBFB0RVNNER2D00000000000",
    };
    plane.seedEnrollment(otherEnrollment);
    const otherClient = new FakeProtocolClient(plane);
    otherClient.enroll(otherEnrollment.runner_id);
    expect(() => otherClient.finalAuthorize("01JBFB01AVNCH1D00000000000")).toThrow(
      "runner mismatch",
    );
  });

  it("accepts launch lifecycle events before final authorization", () => {
    const { plane, client, enrollment, specification } = prepareLaunch();
    const submission: RunnerEventSubmission = {
      ...load<RunnerEventSubmission>("runner-event-submission.heartbeat.json"),
      event_id: "01JBFB0EVENT00200000000000",
      source_sequence: 43,
      kind: "launch_claimed",
    };
    expect(client.submitEvent(submission).disposition).toBe("accepted");
    expect(plane.getEvent(submission.event_id)?.actor).toEqual({
      type: "runner",
      id: enrollment.runner_id,
    });
    expect(client.finalAuthorize(specification.launch_id).decision).toBe("authorized");
  });

  it("derives agent provenance and server receipt time from trusted state", () => {
    const { plane, client, specification, assignment } = prepareLaunch();
    client.finalAuthorize(specification.launch_id);
    const submission: RunnerEventSubmission = {
      ...load<RunnerEventSubmission>("runner-event-submission.heartbeat.json"),
      kind: "progress_reported",
      capture_origin: "agent_reported",
    };
    expect(client.submitEvent(submission).disposition).toBe("accepted");
    const event = plane.getEvent(submission.event_id);
    expect(event?.actor).toEqual({ type: "agent_run", id: assignment.run_id });
    expect(event?.source).toEqual({
      type: "runner",
      id: assignment.runner_id,
      provider: specification.execution_config.provider,
    });
    expect(event?.received_at).toBe(fixtureNow);
    expect(event?.received_at).not.toBe(submission.occurred_at);
  });

  it("keeps exact event replays stable and rejects both identity collisions", () => {
    const { plane, client, enrollment, specification } = prepareLaunch();
    client.finalAuthorize(specification.launch_id);
    const submission = load<RunnerEventSubmission>("runner-event-submission.heartbeat.json");
    expect(client.submitEvent(submission).disposition).toBe("accepted");
    expect(client.submitEvent(submission).disposition).toBe("accepted");

    const eventCollision = plane.submitEvent(
      { ...submission, source_sequence: submission.source_sequence + 1 },
      enrollment.runner_id,
      enrollment.authorization_epoch,
    );
    expect(eventCollision.diagnostic?.code).toBe("event_identity_collision");

    const sourceCollision = plane.submitEvent(
      { ...submission, event_id: "01JBFB0EVENT00200000000000" },
      enrollment.runner_id,
      enrollment.authorization_epoch,
    );
    expect(sourceCollision.diagnostic?.code).toBe("source_identity_collision");

    plane.revokeRunner(enrollment.runner_id);
    const revokedReplay = client.submitEvent(submission);
    expect(revokedReplay.disposition).toBe("permanently_rejected");
    expect(revokedReplay.diagnostic?.code).toBe("runner_revoked");
  });

  it("does not let an unknown assignment reserve an event identity", () => {
    const { plane, client, enrollment, specification } = prepareLaunch();
    client.finalAuthorize(specification.launch_id);
    const submission = load<RunnerEventSubmission>("runner-event-submission.heartbeat.json");
    const unknownAssignment = plane.submitEvent(
      {
        ...submission,
        run_execution_id: submission.run_execution_id.slice(0, -1) + "1",
      },
      enrollment.runner_id,
      enrollment.authorization_epoch,
    );
    expect(unknownAssignment.diagnostic?.code).toBe("unknown_assignment");
    expect(client.submitEvent(submission).disposition).toBe("accepted");
  });

  it("rechecks project grants before accepting telemetry", () => {
    const { plane, client, enrollment, specification } = prepareLaunch();
    client.finalAuthorize(specification.launch_id);
    plane.seedEnrollment({ ...enrollment, granted_project_ids: [] });
    const disposition = client.submitEvent(
      load<RunnerEventSubmission>("runner-event-submission.heartbeat.json"),
    );
    expect(disposition.disposition).toBe("permanently_rejected");
    expect(disposition.diagnostic?.code).toBe("runner_grant_revoked");
  });

  it("fences stale runner authorization epochs across privileged operations", () => {
    const { plane, client, enrollment, specification, claim } = prepareLaunch();
    plane.seedEnrollment({
      ...enrollment,
      authorization_epoch: enrollment.authorization_epoch + 1,
    });

    expect(() => client.claim(claim)).toThrow("runner credential is stale");
    const authorization = client.finalAuthorize(specification.launch_id);
    expect(authorization.decision).toBe("rejected");
    expect(authorization.rejection?.code).toBe("runner_epoch_stale");

    const disposition = client.submitEvent(
      load<RunnerEventSubmission>("runner-event-submission.heartbeat.json"),
    );
    expect(disposition.disposition).toBe("retryable");
    expect(disposition.diagnostic?.code).toBe("runner_epoch_stale");

    client.enroll(enrollment.runner_id);
    expect(client.finalAuthorize(specification.launch_id).decision).toBe("authorized");
    expect(
      client.submitEvent(load<RunnerEventSubmission>("runner-event-submission.heartbeat.json"))
        .disposition,
    ).toBe("accepted");
  });

  it("scopes context and attention reads to an enrolled runner assignment and audience", () => {
    const { plane, client, assignment } = prepareLaunch();
    const anonymous = new FakeProtocolClient(plane);
    expect(() => anonymous.getContext(assignment.task_id)).toThrow("not enrolled");

    plane.putContext({
      task_id: assignment.task_id,
      version: 1,
      audience: "human",
      body: "human-only context",
    });
    expect(client.getContext(assignment.task_id)).toBeUndefined();

    const otherTaskId = "01JBFB0TASKYYYY00000000000";
    plane.putContext({
      task_id: otherTaskId,
      version: 1,
      audience: "agent",
      body: "other assignment",
    });
    expect(() => client.getContext(otherTaskId)).toThrow("outside runner assignment");

    plane.putAttention({
      attention_id: "01JBFB0ATTENT2000000000000",
      task_id: otherTaskId,
      state: "open",
      summary: "other task",
    });
    expect(() => client.getAttention("01JBFB0ATTENT2000000000000")).toThrow(
      "outside runner assignment",
    );
  });
});
