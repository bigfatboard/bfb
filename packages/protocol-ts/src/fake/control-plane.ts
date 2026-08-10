// ABOUTME: Provides an in-memory fake control plane for enrollment, launch, and event fixtures.
// ABOUTME: Exercises wire contracts without D1, Durable Objects, or provider processes.

import { decodeWireDocument } from "../codec.js";
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
  audience: "agent" | "human";
  body: string;
}

interface PendingLaunch {
  specification: LaunchSpecification;
  assignment: ExecutionAssignment;
  claimed: boolean;
  revoked: boolean;
}

function requireAccept<T>(document: Parameters<typeof decodeWireDocument>[0], value: unknown): T {
  const result = decodeWireDocument<T>(document, value);
  if (!result.ok) {
    throw new Error(document + " rejected: " + result.error.code + " " + result.error.message);
  }
  return result.value;
}

export class FakeControlPlane {
  private enrollments = new Map<string, RunnerEnrollment>();
  private launches = new Map<string, PendingLaunch>();
  private events = new Map<string, EventEnvelope>();
  private dispositions = new Map<string, EventDisposition>();
  private contexts = new Map<string, FakeContextFixture>();
  private attentions = new Map<string, FakeAttentionFixture>();
  private workspaceCursor = 0;
  private revokedRunners = new Set<string>();

  enroll(enrollment: RunnerEnrollment): RunnerEnrollment {
    const value = requireAccept<RunnerEnrollment>("runner-enrollment", enrollment);
    this.enrollments.set(value.runner_id, value);
    return value;
  }

  revokeRunner(runnerId: string): void {
    this.revokedRunners.add(runnerId);
    const existing = this.enrollments.get(runnerId);
    if (existing) {
      this.enrollments.set(runnerId, { ...existing, status: "revoked" });
    }
  }

  queueEnrollment(runnerId: string): RunnerEnrollment | undefined {
    return this.enrollments.get(runnerId);
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
    this.launches.set(specification.launch_id, {
      specification,
      assignment,
      claimed: false,
      revoked: false,
    });
    return specification;
  }

  claimLaunch(claim: LaunchClaim): LaunchSpecification {
    const value = requireAccept<LaunchClaim>("launch-claim", claim);
    const pending = this.launches.get(value.launch_id);
    if (!pending) {
      throw new Error("unknown launch");
    }
    if (this.revokedRunners.has(value.runner_id) || pending.revoked) {
      throw new Error("runner revoked");
    }
    if (pending.specification.runner_id !== value.runner_id) {
      throw new Error("runner mismatch");
    }
    pending.claimed = true;
    return pending.specification;
  }

  finalAuthorize(launchId: string, authorizedAt: string): FinalAuthorization {
    const pending = this.launches.get(launchId);
    if (!pending || !pending.claimed) {
      const rejection = {
        schema_version: 1 as const,
        category: "schema_invalid" as const,
        code: "launch_not_claimable",
        message: "launch is not claimed",
      };
      return requireAccept<FinalAuthorization>("final-authorization", {
        schema_version: 1,
        launch_id: launchId,
        run_execution_id: pending?.assignment.run_execution_id ?? "01JBFB0EXECXXXX00000000000",
        assignment_generation: pending?.assignment.assignment_generation ?? 1,
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
    return requireAccept<FinalAuthorization>("final-authorization", {
      schema_version: 1,
      launch_id: launchId,
      run_execution_id: pending.assignment.run_execution_id,
      assignment_generation: pending.assignment.assignment_generation,
      decision: "authorized",
      authorized_at: authorizedAt,
    });
  }

  submitEvent(submission: RunnerEventSubmission, runnerId: string): EventDisposition {
    const value = requireAccept<RunnerEventSubmission>("runner-event-submission", submission);
    if (this.revokedRunners.has(runnerId)) {
      const disposition = requireAccept<EventDisposition>("event-disposition", {
        schema_version: 1,
        event_id: value.event_id,
        source_stream_id: value.source_stream_id,
        source_sequence: value.source_sequence,
        disposition: "permanently_rejected",
        diagnostic: {
          schema_version: 1,
          category: "schema_invalid",
          code: "runner_revoked",
          message: "runner revoked",
        },
      });
      this.dispositions.set(value.event_id, disposition);
      return disposition;
    }

    const existing = this.dispositions.get(value.event_id);
    if (existing) {
      return existing;
    }

    // Attribution comes from assignment, never from claimed_* fields.
    const pending = [...this.launches.values()].find(
      (launch) =>
        launch.assignment.run_execution_id === value.run_execution_id &&
        launch.assignment.assignment_generation === value.assignment_generation &&
        launch.assignment.runner_id === runnerId,
    );
    if (!pending) {
      const disposition = requireAccept<EventDisposition>("event-disposition", {
        schema_version: 1,
        event_id: value.event_id,
        source_stream_id: value.source_stream_id,
        source_sequence: value.source_sequence,
        disposition: "permanently_rejected",
        diagnostic: {
          schema_version: 1,
          category: "authoritative_runner_claim",
          code: "unknown_assignment",
          message: "execution assignment not found for runner submission",
        },
      });
      this.dispositions.set(value.event_id, disposition);
      return disposition;
    }

    this.workspaceCursor += 1;
    const envelope = requireAccept<EventEnvelope>("event-envelope", {
      schema_version: 1,
      event_id: value.event_id,
      workspace_cursor: this.workspaceCursor,
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
      actor: { type: "runner", id: runnerId },
      source: { type: "runner", id: runnerId },
      kind: value.kind,
      occurred_at: value.occurred_at,
      received_at: value.occurred_at,
      payload: value.payload ?? {},
    });
    this.events.set(envelope.event_id, envelope);
    const disposition = requireAccept<EventDisposition>("event-disposition", {
      schema_version: 1,
      event_id: value.event_id,
      source_stream_id: value.source_stream_id,
      source_sequence: value.source_sequence,
      disposition: "accepted",
    });
    this.dispositions.set(value.event_id, disposition);
    return disposition;
  }

  getEvent(eventId: string): EventEnvelope | undefined {
    return this.events.get(eventId);
  }

  putContext(context: FakeContextFixture): FakeContextFixture {
    this.contexts.set(context.task_id, context);
    return context;
  }

  getContext(taskId: string): FakeContextFixture | undefined {
    return this.contexts.get(taskId);
  }

  putAttention(attention: FakeAttentionFixture): FakeAttentionFixture {
    this.attentions.set(attention.attention_id, attention);
    return attention;
  }

  getAttention(attentionId: string): FakeAttentionFixture | undefined {
    return this.attentions.get(attentionId);
  }
}

export class FakeProtocolClient {
  constructor(private readonly plane: FakeControlPlane) {}

  enroll(enrollment: RunnerEnrollment): RunnerEnrollment {
    return this.plane.enroll(enrollment);
  }

  claim(claim: LaunchClaim): LaunchSpecification {
    return this.plane.claimLaunch(claim);
  }

  finalAuthorize(launchId: string, authorizedAt: string): FinalAuthorization {
    return this.plane.finalAuthorize(launchId, authorizedAt);
  }

  submitEvent(submission: RunnerEventSubmission, runnerId: string): EventDisposition {
    return this.plane.submitEvent(submission, runnerId);
  }

  getContext(taskId: string): FakeContextFixture | undefined {
    return this.plane.getContext(taskId);
  }

  getAttention(attentionId: string): FakeAttentionFixture | undefined {
    return this.plane.getAttention(attentionId);
  }
}
