// ABOUTME: Provides an in-memory fake control plane for enrollment, launch, and event fixtures.
// ABOUTME: Exercises wire contracts without D1, Durable Objects, or provider processes.

import { decodeWireDocument, encodeWireDocument } from "../codec.js";
import type {
  EventDisposition,
  EventEnvelope,
  ExecutionAssignment,
  FinalAuthorization,
  LaunchClaim,
  LaunchSpecification,
  RunnerEnrollment,
  RunnerEventSubmission,
} from "../generated/types.js";

export interface FakeAttentionFixture {
  attention_id: string;
  task_id: string;
  state: "open" | "resolved";
  summary: string;
}

export interface FakeContextFixture {
  task_id: string;
  version: number;
  audience: "agent" | "human" | "both";
  body: string;
}

interface PendingLaunch {
  specification: LaunchSpecification;
  assignment: ExecutionAssignment;
  claim?: {
    json: string;
    claimedAt: string;
  };
  authorization?: FinalAuthorization;
  revoked: boolean;
}

interface EventRecord {
  runnerId: string;
  submissionJson: string;
  disposition: EventDisposition;
}

const preAuthorizationKinds = new Set<RunnerEventSubmission["kind"]>([
  "launch_claimed",
  "launch_blocked",
]);

const runnerActorKinds = new Set<RunnerEventSubmission["kind"]>([
  "launch_claimed",
  "launch_blocked",
  "execution_attached",
  "execution_detached",
  "execution_ended",
  "heartbeat",
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireAccept<T>(document: Parameters<typeof decodeWireDocument>[0], value: unknown): T {
  const result = decodeWireDocument<T>(
    document,
    new TextEncoder().encode(encodeWireDocument(value)),
  );
  if (!result.ok) {
    throw new Error(document + " rejected: " + result.error.code + " " + result.error.message);
  }
  return clone(result.value);
}

function timestampMicros(value: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/u.exec(value);
  if (!match?.[1]) {
    throw new Error("invalid UTC timestamp");
  }
  const seconds = Date.parse(match[1] + "Z") / 1000;
  const fraction = (match[2] ?? "").padEnd(6, "0");
  return BigInt(seconds) * 1_000_000n + BigInt(fraction || "0");
}

function assignmentMatchesSpecification(
  specification: LaunchSpecification,
  assignment: ExecutionAssignment,
): boolean {
  return (
    assignment.run_id === specification.run_id &&
    assignment.run_execution_id === specification.run_execution_id &&
    assignment.assignment_generation === specification.assignment_generation &&
    assignment.runner_id === specification.runner_id &&
    assignment.task_id === specification.task_id &&
    assignment.checkout_id === specification.checkout_id
  );
}

export class FakeControlPlane {
  private enrollments = new Map<string, RunnerEnrollment>();
  private launches = new Map<string, PendingLaunch>();
  private events = new Map<string, EventEnvelope>();
  private eventRecords = new Map<string, EventRecord>();
  private replayDispositions = new Map<string, EventDisposition>();
  private contexts = new Map<string, FakeContextFixture>();
  private attentions = new Map<string, FakeAttentionFixture>();
  private workspaceCursors = new Map<string, number>();
  private sourceSequences = new Map<string, string>();
  private connectedRunners = new Set<string>();
  private revokedRunners = new Set<string>();

  constructor(private readonly now: () => string) {}

  seedEnrollment(enrollment: RunnerEnrollment): RunnerEnrollment {
    const value = requireAccept<RunnerEnrollment>("runner-enrollment", enrollment);
    this.enrollments.set(value.runner_id, value);
    return clone(value);
  }

  enrollRunner(runnerId: string): RunnerEnrollment {
    const enrollment = this.enrollments.get(runnerId);
    if (!enrollment) {
      throw new Error("runner not seeded");
    }
    if (enrollment.status === "revoked" || this.revokedRunners.has(runnerId)) {
      throw new Error("runner revoked");
    }
    this.connectedRunners.add(runnerId);
    return clone(enrollment);
  }

  revokeRunner(runnerId: string): void {
    this.revokedRunners.add(runnerId);
    this.connectedRunners.delete(runnerId);
    const existing = this.enrollments.get(runnerId);
    if (existing) {
      this.enrollments.set(runnerId, { ...existing, status: "revoked" });
    }
  }

  queueEnrollment(runnerId: string): RunnerEnrollment | undefined {
    const enrollment = this.enrollments.get(runnerId);
    return enrollment ? clone(enrollment) : undefined;
  }

  queueLaunch(input: {
    specification: LaunchSpecification;
    assignment: ExecutionAssignment;
  }): LaunchSpecification {
    const specification = requireAccept<LaunchSpecification>(
      "launch-specification",
      input.specification,
    );
    const assignment = requireAccept<ExecutionAssignment>("execution-assignment", input.assignment);
    const enrollment = this.enrollments.get(specification.runner_id);
    if (
      !enrollment ||
      enrollment.status === "revoked" ||
      this.revokedRunners.has(specification.runner_id)
    ) {
      throw new Error("runner not enrolled");
    }
    if (!assignmentMatchesSpecification(specification, assignment)) {
      throw new Error("assignment does not match launch specification");
    }
    if (assignment.workspace_id !== enrollment.workspace_id) {
      throw new Error("assignment workspace is outside runner enrollment");
    }
    if (!enrollment.granted_project_ids?.includes(assignment.project_id)) {
      throw new Error("assignment project is outside runner enrollment");
    }
    const existing = this.launches.get(specification.launch_id);
    if (existing) {
      if (
        encodeWireDocument(existing.specification) === encodeWireDocument(specification) &&
        encodeWireDocument(existing.assignment) === encodeWireDocument(assignment)
      ) {
        return clone(existing.specification);
      }
      throw new Error("launch id conflicts with immutable launch");
    }
    const assignmentAlreadyQueued = [...this.launches.values()].some(
      (launch) =>
        launch.assignment.run_execution_id === assignment.run_execution_id &&
        launch.assignment.assignment_generation === assignment.assignment_generation,
    );
    if (assignmentAlreadyQueued) {
      throw new Error("execution assignment is already bound to another launch");
    }
    this.launches.set(specification.launch_id, {
      specification,
      assignment,
      revoked: false,
    });
    return clone(specification);
  }

  claimLaunch(claim: LaunchClaim, authorizationEpoch: number): LaunchSpecification {
    const value = requireAccept<LaunchClaim>("launch-claim", claim);
    const pending = this.launches.get(value.launch_id);
    if (!pending) {
      throw new Error("unknown launch");
    }
    if (this.revokedRunners.has(value.runner_id) || pending.revoked) {
      throw new Error("runner revoked");
    }
    if (!this.connectedRunners.has(value.runner_id)) {
      throw new Error("runner not connected");
    }
    if (pending.specification.runner_id !== value.runner_id) {
      throw new Error("runner mismatch");
    }
    const enrollment = this.enrollments.get(value.runner_id);
    if (
      !enrollment ||
      enrollment.status === "revoked" ||
      enrollment.workspace_id !== pending.assignment.workspace_id ||
      !enrollment.granted_project_ids?.includes(pending.assignment.project_id)
    ) {
      throw new Error("runner grant revoked");
    }
    if (enrollment.authorization_epoch !== authorizationEpoch) {
      throw new Error("runner credential is stale");
    }
    if (timestampMicros(this.now()) >= timestampMicros(pending.specification.expires_at)) {
      throw new Error("launch expired");
    }
    const claimJson = encodeWireDocument(value);
    if (pending.claim) {
      if (pending.claim.json === claimJson) {
        return clone(pending.specification);
      }
      throw new Error("launch already claimed");
    }
    pending.claim = { json: claimJson, claimedAt: value.claimed_at };
    return clone(pending.specification);
  }

  finalAuthorize(
    launchId: string,
    runnerId: string,
    authorizationEpoch: number,
  ): FinalAuthorization {
    const pending = this.launches.get(launchId);
    if (!pending) {
      throw new Error("unknown launch");
    }
    if (pending.specification.runner_id !== runnerId) {
      throw new Error("runner mismatch");
    }
    const authorizedAt = this.now();
    if (!pending.claim) {
      const rejection = {
        schema_version: 1 as const,
        category: "schema_invalid" as const,
        code: "launch_not_claimable",
        message: "launch is not claimed",
      };
      return requireAccept<FinalAuthorization>("final-authorization", {
        schema_version: 1,
        launch_id: launchId,
        run_execution_id: pending.assignment.run_execution_id,
        assignment_generation: pending.assignment.assignment_generation,
        decision: "rejected",
        authorized_at: authorizedAt,
        rejection,
      });
    }
    if (this.revokedRunners.has(pending.specification.runner_id) || pending.revoked) {
      return requireAccept<FinalAuthorization>("final-authorization", {
        schema_version: 1,
        launch_id: launchId,
        run_execution_id: pending.assignment.run_execution_id,
        assignment_generation: pending.assignment.assignment_generation,
        decision: "rejected",
        authorized_at: authorizedAt,
        rejection: {
          schema_version: 1,
          category: "schema_invalid",
          code: "runner_revoked",
          message: "runner revoked before final authorization",
        },
      });
    }
    const enrollment = this.enrollments.get(pending.specification.runner_id);
    if (
      !enrollment ||
      enrollment.status === "revoked" ||
      enrollment.workspace_id !== pending.assignment.workspace_id ||
      !enrollment.granted_project_ids?.includes(pending.assignment.project_id)
    ) {
      return requireAccept<FinalAuthorization>("final-authorization", {
        schema_version: 1,
        launch_id: launchId,
        run_execution_id: pending.assignment.run_execution_id,
        assignment_generation: pending.assignment.assignment_generation,
        decision: "rejected",
        authorized_at: authorizedAt,
        rejection: {
          schema_version: 1,
          category: "schema_invalid",
          code: "runner_grant_revoked",
          message: "runner grant revoked before final authorization",
        },
      });
    }
    if (enrollment.authorization_epoch !== authorizationEpoch) {
      return requireAccept<FinalAuthorization>("final-authorization", {
        schema_version: 1,
        launch_id: launchId,
        run_execution_id: pending.assignment.run_execution_id,
        assignment_generation: pending.assignment.assignment_generation,
        decision: "rejected",
        authorized_at: authorizedAt,
        rejection: {
          schema_version: 1,
          category: "schema_invalid",
          code: "runner_epoch_stale",
          message: "runner credential epoch is stale",
        },
      });
    }
    if (timestampMicros(authorizedAt) >= timestampMicros(pending.specification.expires_at)) {
      return requireAccept<FinalAuthorization>("final-authorization", {
        schema_version: 1,
        launch_id: launchId,
        run_execution_id: pending.assignment.run_execution_id,
        assignment_generation: pending.assignment.assignment_generation,
        decision: "rejected",
        authorized_at: authorizedAt,
        rejection: {
          schema_version: 1,
          category: "schema_invalid",
          code: "launch_expired",
          message: "launch expired before final authorization",
        },
      });
    }
    if (pending.authorization) {
      return clone(pending.authorization);
    }
    const authorization = requireAccept<FinalAuthorization>("final-authorization", {
      schema_version: 1,
      launch_id: launchId,
      run_execution_id: pending.assignment.run_execution_id,
      assignment_generation: pending.assignment.assignment_generation,
      decision: "authorized",
      authorized_at: authorizedAt,
    });
    pending.authorization = authorization;
    return clone(authorization);
  }

  submitEvent(
    submission: RunnerEventSubmission,
    runnerId: string,
    authorizationEpoch: number,
  ): EventDisposition {
    const value = requireAccept<RunnerEventSubmission>("runner-event-submission", submission);
    const submissionJson = encodeWireDocument(value);
    // Attribution comes from assignment, never from claimed_* fields or the caller-selected client.
    const pending = [...this.launches.values()].find(
      (launch) =>
        launch.assignment.run_execution_id === value.run_execution_id &&
        launch.assignment.assignment_generation === value.assignment_generation &&
        launch.assignment.runner_id === runnerId,
    );
    if (!pending) {
      return this.rejectionDisposition(
        value,
        "permanently_rejected",
        "unknown_assignment",
        "execution assignment not found for runner submission",
        "authoritative_runner_claim",
      );
    }

    const currentEnrollment = this.enrollments.get(runnerId);
    if (this.revokedRunners.has(runnerId) || pending.revoked) {
      return this.rejectionDisposition(
        value,
        "permanently_rejected",
        "runner_revoked",
        "runner revoked",
      );
    }
    if (
      !currentEnrollment ||
      currentEnrollment.status === "revoked" ||
      currentEnrollment.workspace_id !== pending.assignment.workspace_id ||
      !currentEnrollment.granted_project_ids?.includes(pending.assignment.project_id)
    ) {
      return this.rejectionDisposition(
        value,
        "permanently_rejected",
        "runner_grant_revoked",
        "runner grant revoked",
      );
    }
    if (currentEnrollment.authorization_epoch !== authorizationEpoch) {
      return this.rejectionDisposition(
        value,
        "retryable",
        "runner_epoch_stale",
        "runner credential epoch is stale",
      );
    }

    const replayKey = runnerId + "\n" + submissionJson;
    const replay = this.replayDispositions.get(replayKey);
    if (replay) {
      return clone(replay);
    }
    const eventRecord = this.eventRecords.get(value.event_id);
    if (
      eventRecord &&
      (eventRecord.runnerId !== runnerId || eventRecord.submissionJson !== submissionJson)
    ) {
      return this.rememberDisposition(
        value,
        runnerId,
        submissionJson,
        "event_identity_collision",
        "event id is already bound to another submission",
      );
    }

    const sourceSequenceKey =
      pending.assignment.workspace_id +
      ":" +
      value.source_stream_id +
      ":" +
      String(value.source_sequence);
    if (this.sourceSequences.has(sourceSequenceKey)) {
      return this.rememberDisposition(
        value,
        runnerId,
        submissionJson,
        "source_identity_collision",
        "source stream sequence is already bound to another event",
      );
    }
    const launchIsReady = preAuthorizationKinds.has(value.kind)
      ? pending.claim !== undefined
      : pending.authorization?.decision === "authorized";
    if (!launchIsReady) {
      return this.rememberDisposition(
        value,
        runnerId,
        submissionJson,
        "launch_state_invalid",
        "event is not allowed in the current launch state",
        "authoritative_runner_claim",
        sourceSequenceKey,
      );
    }

    const claimedAttribution = [
      ["workspace", value.claimed_workspace_id, pending.assignment.workspace_id],
      ["project", value.claimed_project_id, pending.assignment.project_id],
      ["task", value.claimed_task_id, pending.assignment.task_id],
      ["run", value.claimed_run_id, pending.assignment.run_id],
    ] as const;
    const conflictingClaim = claimedAttribution.find(
      ([, claimed, assigned]) => claimed !== undefined && claimed !== assigned,
    );
    if (conflictingClaim) {
      return this.rememberDisposition(
        value,
        runnerId,
        submissionJson,
        "claimed_attribution_mismatch",
        "runner " + conflictingClaim[0] + " claim conflicts with its assignment",
        "authoritative_runner_claim",
        sourceSequenceKey,
      );
    }

    const workspaceCursor = (this.workspaceCursors.get(pending.assignment.workspace_id) ?? 0) + 1;
    this.workspaceCursors.set(pending.assignment.workspace_id, workspaceCursor);
    const envelope = requireAccept<EventEnvelope>("event-envelope", {
      schema_version: 1,
      event_id: value.event_id,
      workspace_cursor: workspaceCursor,
      source_stream_id: value.source_stream_id,
      source_event_id: value.source_event_id,
      source_sequence: value.source_sequence,
      workspace_id: pending.assignment.workspace_id,
      project_id: pending.assignment.project_id,
      task_id: pending.assignment.task_id,
      run_id: pending.assignment.run_id,
      run_execution_id: pending.assignment.run_execution_id,
      assignment_generation: pending.assignment.assignment_generation,
      provider_session_id: value.provider_session_id,
      actor:
        value.capture_origin === "runner_observed" || runnerActorKinds.has(value.kind)
          ? { type: "runner", id: runnerId }
          : { type: "agent_run", id: pending.assignment.run_id },
      source: {
        type: "runner",
        id: runnerId,
        provider: pending.specification.execution_config.provider,
      },
      kind: value.kind,
      occurred_at: value.occurred_at,
      received_at: this.now(),
      payload: value.payload ?? {},
    });
    this.events.set(envelope.event_id, clone(envelope));
    const disposition = requireAccept<EventDisposition>("event-disposition", {
      schema_version: 1,
      event_id: value.event_id,
      source_stream_id: value.source_stream_id,
      source_sequence: value.source_sequence,
      disposition: "accepted",
    });
    this.eventRecords.set(value.event_id, { runnerId, submissionJson, disposition });
    this.replayDispositions.set(replayKey, disposition);
    this.sourceSequences.set(sourceSequenceKey, value.event_id);
    return clone(disposition);
  }

  private rememberDisposition(
    value: RunnerEventSubmission,
    runnerId: string,
    submissionJson: string,
    code: string,
    message: string,
    category: "schema_invalid" | "authoritative_runner_claim" = "schema_invalid",
    sourceSequenceKey?: string,
  ): EventDisposition {
    const disposition = this.rejectionDisposition(
      value,
      "permanently_rejected",
      code,
      message,
      category,
    );
    const replayKey = runnerId + "\n" + submissionJson;
    if (!this.eventRecords.has(value.event_id)) {
      this.eventRecords.set(value.event_id, { runnerId, submissionJson, disposition });
    }
    this.replayDispositions.set(replayKey, disposition);
    if (sourceSequenceKey && !this.sourceSequences.has(sourceSequenceKey)) {
      this.sourceSequences.set(sourceSequenceKey, value.event_id);
    }
    return clone(disposition);
  }

  private rejectionDisposition(
    value: RunnerEventSubmission,
    disposition: "retryable" | "permanently_rejected",
    code: string,
    message: string,
    category: "schema_invalid" | "authoritative_runner_claim" = "schema_invalid",
  ): EventDisposition {
    return requireAccept<EventDisposition>("event-disposition", {
      schema_version: 1,
      event_id: value.event_id,
      source_stream_id: value.source_stream_id,
      source_sequence: value.source_sequence,
      disposition,
      diagnostic: {
        schema_version: 1,
        category,
        code,
        message,
      },
    });
  }

  getEvent(eventId: string): EventEnvelope | undefined {
    const event = this.events.get(eventId);
    return event ? clone(event) : undefined;
  }

  putContext(context: FakeContextFixture): FakeContextFixture {
    const stored = clone(context);
    this.contexts.set(stored.task_id, stored);
    return clone(stored);
  }

  getContext(
    taskId: string,
    runnerId: string,
    authorizationEpoch: number,
  ): FakeContextFixture | undefined {
    this.requireTaskAccess(runnerId, authorizationEpoch, taskId);
    const context = this.contexts.get(taskId);
    return context && context.audience !== "human" ? clone(context) : undefined;
  }

  putAttention(attention: FakeAttentionFixture): FakeAttentionFixture {
    const stored = clone(attention);
    this.attentions.set(stored.attention_id, stored);
    return clone(stored);
  }

  getAttention(
    attentionId: string,
    runnerId: string,
    authorizationEpoch: number,
  ): FakeAttentionFixture | undefined {
    const attention = this.attentions.get(attentionId);
    if (attention) {
      this.requireTaskAccess(runnerId, authorizationEpoch, attention.task_id);
    }
    return attention ? clone(attention) : undefined;
  }

  private requireTaskAccess(runnerId: string, authorizationEpoch: number, taskId: string): void {
    const enrollment = this.enrollments.get(runnerId);
    if (
      !this.connectedRunners.has(runnerId) ||
      !enrollment ||
      enrollment.status === "revoked" ||
      enrollment.authorization_epoch !== authorizationEpoch
    ) {
      throw new Error("runner credential is stale or disconnected");
    }
    const assigned = [...this.launches.values()].some(
      (launch) =>
        launch.assignment.runner_id === runnerId &&
        launch.assignment.task_id === taskId &&
        launch.assignment.workspace_id === enrollment.workspace_id &&
        enrollment.granted_project_ids?.includes(launch.assignment.project_id),
    );
    if (!assigned) {
      throw new Error("task is outside runner assignment");
    }
  }
}

export class FakeProtocolClient {
  private runnerId?: string;
  private authorizationEpoch?: number;

  constructor(private readonly plane: FakeControlPlane) {}

  enroll(runnerId: string): RunnerEnrollment {
    if (this.runnerId && this.runnerId !== runnerId) {
      throw new Error("protocol client is already bound to another runner");
    }
    const enrollment = this.plane.enrollRunner(runnerId);
    this.runnerId = runnerId;
    this.authorizationEpoch = enrollment.authorization_epoch;
    return enrollment;
  }

  claim(claim: LaunchClaim): LaunchSpecification {
    if (!this.runnerId || claim.runner_id !== this.runnerId) {
      throw new Error("protocol client runner mismatch");
    }
    return this.plane.claimLaunch(claim, this.authorizationEpoch ?? 0);
  }

  finalAuthorize(launchId: string): FinalAuthorization {
    if (!this.runnerId) {
      throw new Error("protocol client is not enrolled");
    }
    return this.plane.finalAuthorize(launchId, this.runnerId, this.authorizationEpoch ?? 0);
  }

  submitEvent(submission: RunnerEventSubmission): EventDisposition {
    if (!this.runnerId) {
      throw new Error("protocol client is not enrolled");
    }
    return this.plane.submitEvent(submission, this.runnerId, this.authorizationEpoch ?? 0);
  }

  getContext(taskId: string): FakeContextFixture | undefined {
    if (!this.runnerId || this.authorizationEpoch === undefined) {
      throw new Error("protocol client is not enrolled");
    }
    return this.plane.getContext(taskId, this.runnerId, this.authorizationEpoch);
  }

  getAttention(attentionId: string): FakeAttentionFixture | undefined {
    if (!this.runnerId || this.authorizationEpoch === undefined) {
      throw new Error("protocol client is not enrolled");
    }
    return this.plane.getAttention(attentionId, this.runnerId, this.authorizationEpoch);
  }
}
