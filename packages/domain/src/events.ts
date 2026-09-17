// ABOUTME: Ingests authenticated runner event batches into the immutable ledger with per-event dispositions.
// ABOUTME: Attribution is derived server-side from execution assignments; claimed IDs are hints only.

import type { AuthorizationContext, SqlDatabase } from "@bfb/db";
import { WorkspaceRepository } from "@bfb/db";
import {
  decodeWireDocument,
  type EventDisposition,
  type EventEnvelope,
  type RunnerEventSubmission,
  type TypedError,
} from "@bfb/protocol";

import { assertEpoch, assertRole, loadPrincipal } from "./authorization.js";
import { DomainError, type HubCommand } from "./hub.js";
import { isUlid } from "./ids.js";
import { launchRunner } from "./launch-state.js";
import { rejectRunnerRequest, runnerId, runnerObject } from "./runner-crypto.js";
import type { RunnerPrincipal } from "./runners.js";

/** Maximum runner events committed by one ingest command. Bounds the cursor reservation. */
export const EVENT_BATCH_LIMIT = 25;
/** Maximum ingest request body in bytes, enforced at the runner transport. */
export const EVENT_BODY_LIMIT = 65_536;
/** Maximum ingest item encoding in bytes; larger items are transport violations. */
export const EVENT_ITEM_LIMIT = 8_192;
/** Events dated further beyond the server clock are rejected as clock confusion. */
export const EVENT_FUTURE_TOLERANCE_MS = 300_000;

export const RUNNER_SUBMISSION_KINDS = [
  "launch_claimed",
  "launch_blocked",
  "execution_attached",
  "execution_detached",
  "execution_ended",
  "session_started",
  "session_resumed",
  "session_ended",
  "turn_started",
  "turn_stopped",
  "turn_failed",
  "tool_started",
  "tool_finished",
  "tool_failed",
  "progress_reported",
  "attention_requested",
  "subagent_started",
  "subagent_ended",
  "context_compacted",
  "artifact_published",
  "result_submitted",
  "run_failed",
  "run_cancelled",
  "heartbeat",
] as const;

/**
 * Submission kinds that additionally persist a raw measurement observation.
 * Each observation keeps the unique identity and provenance of its event so
 * later derived intervals and totals cannot be inflated by replay. A04 owns
 * every derived aggregate; E01 never computes intervals, prices, or display
 * totals here.
 */
export const OBSERVATION_KINDS: ReadonlySet<string> = new Set([
  "heartbeat",
  "session_started",
  "session_resumed",
  "session_ended",
  "turn_started",
  "turn_stopped",
  "turn_failed",
  "tool_started",
  "tool_finished",
  "tool_failed",
  "progress_reported",
]);

export interface IngestRunnerEventsInput {
  principal: RunnerPrincipal;
  events: unknown[];
}

export interface IngestRunnerEventsResult {
  schema_version: 1;
  workspace_id: string;
  high_water_cursor: number;
  dispositions: EventDisposition[];
}

export interface LedgerReplayOptions {
  afterCursor: number;
  throughCursor: number;
  limit?: number;
}

function diagnostic(category: TypedError["category"], code: string, message: string): TypedError {
  return { schema_version: 1, category, code, message };
}

interface EventTriple {
  eventId: string;
  streamId: string;
  sequence: number;
}

function extractTriple(raw: unknown): EventTriple | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const { event_id: eventId, source_stream_id: streamId, source_sequence: sequence } = record;
  if (
    typeof eventId !== "string" ||
    !isUlid(eventId) ||
    typeof streamId !== "string" ||
    !isUlid(streamId) ||
    !Number.isSafeInteger(sequence) ||
    (sequence as number) < 1
  ) {
    return null;
  }
  return { eventId, streamId, sequence: sequence as number };
}

function encodeSubmission(raw: unknown): string {
  return JSON.stringify(raw);
}

function decodeDisposition(value: EventDisposition): EventDisposition {
  const decoded = decodeWireDocument("event-disposition", Buffer.from(JSON.stringify(value)));
  if (!decoded.ok) {
    throw new DomainError("event_history_corrupt", "ingest disposition failed validation");
  }
  return decoded.value as EventDisposition;
}

function acceptedDisposition(triple: EventTriple): EventDisposition {
  return decodeDisposition({
    schema_version: 1,
    event_id: triple.eventId,
    source_stream_id: triple.streamId,
    source_sequence: triple.sequence,
    disposition: "accepted",
  });
}

function alreadyCommittedDisposition(triple: EventTriple): EventDisposition {
  return decodeDisposition({
    schema_version: 1,
    event_id: triple.eventId,
    source_stream_id: triple.streamId,
    source_sequence: triple.sequence,
    disposition: "already_committed",
  });
}

function retryableDisposition(triple: EventTriple, fault: TypedError): EventDisposition {
  return decodeDisposition({
    schema_version: 1,
    event_id: triple.eventId,
    source_stream_id: triple.streamId,
    source_sequence: triple.sequence,
    disposition: "retryable",
    diagnostic: fault,
  });
}

function rejectedDisposition(triple: EventTriple, fault: TypedError): EventDisposition {
  return decodeDisposition({
    schema_version: 1,
    event_id: triple.eventId,
    source_stream_id: triple.streamId,
    source_sequence: triple.sequence,
    disposition: "permanently_rejected",
    diagnostic: fault,
  });
}

interface AssignmentBinding {
  runner_id: string;
  project_id: string;
  task_id: string;
  run_id: string;
  provider: string | null;
}

interface PreparedEvent {
  triple: EventTriple;
  submission: RunnerEventSubmission;
  binding: AssignmentBinding;
  actorType: "runner" | "agent_run";
  cursor: number;
}

export const ingestRunnerEventsCommand: HubCommand<
  IngestRunnerEventsInput,
  IngestRunnerEventsResult
> = {
  name: "event.ingest",
  extraCursors: (input) => {
    try {
      const events = (input as IngestRunnerEventsInput | null)?.events;
      if (!Array.isArray(events)) return 0;
      return Math.min(events.length, EVENT_BATCH_LIMIT);
    } catch {
      return 0;
    }
  },
  auditInput: (input) => {
    try {
      const principal = (input as IngestRunnerEventsInput).principal;
      const events = (input as IngestRunnerEventsInput).events;
      return {
        runnerId: principal?.runnerId,
        eventCount: Array.isArray(events) ? events.length : 0,
      };
    } catch {
      return { eventCount: 0 };
    }
  },
  async run(raw, ctx) {
    runnerObject(raw, ["principal", "events"]);
    const input = raw as IngestRunnerEventsInput;
    const principal = await launchRunner(ctx, input.principal);
    if (
      !Array.isArray(input.events) ||
      input.events.length < 1 ||
      input.events.length > EVENT_BATCH_LIMIT
    ) {
      rejectRunnerRequest();
    }
    const items = input.events;

    // Phase 1: decode every item before any database write is staged. Items
    // without a well-formed transport triple are transport violations: the
    // whole batch is rejected uniformly and nothing commits, because no
    // disposition could address the row. Well-identified poison receives a
    // per-event permanently_rejected and never blocks later rows.
    const decoded: Array<
      | { triple: EventTriple; submission: RunnerEventSubmission }
      | { triple: EventTriple; fault: TypedError }
    > = [];
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        rejectRunnerRequest();
      }
      const encoded = encodeSubmission(rawItem);
      if (Buffer.byteLength(encoded) > EVENT_ITEM_LIMIT) {
        const triple = extractTriple(rawItem);
        if (!triple) rejectRunnerRequest();
        decoded.push({
          triple,
          fault: diagnostic("bound_exceeded", "event_too_large", "event item exceeds the limit"),
        });
        continue;
      }
      const result = decodeWireDocument("runner-event-submission", Buffer.from(encoded));
      if (!result.ok) {
        const triple = extractTriple(rawItem);
        if (!triple) rejectRunnerRequest();
        decoded.push({ triple, fault: result.error });
        continue;
      }
      decoded.push({
        triple: extractTriple(rawItem) as EventTriple,
        submission: result.value as RunnerEventSubmission,
      });
    }

    // Phase 2: reads only. D1 batch transactions forbid reads after a queued
    // write, so every lookup completes before the first staged insert.
    const dispositions: EventDisposition[] = [];
    const prepared: PreparedEvent[] = [];
    const seenIds = new Map<string, EventTriple>();
    const seenStreams = new Map<string, string>();
    const bindings = new Map<string, AssignmentBinding | null>();
    const executions = new Map<string, boolean>();
    const assignedExecutions = new Map<string, boolean>();
    let acceptedCount = 0;

    async function bindingFor(
      executionId: string,
      generation: number,
    ): Promise<AssignmentBinding | null> {
      const key = `${executionId}:${generation}`;
      const cached = bindings.get(key);
      if (cached !== undefined) return cached;
      const row = (await ctx.db
        .prepare(
          `SELECT a.runner_id, a.project_id, a.task_id, a.run_id, p.provider
           FROM execution_assignments a
           JOIN runs r ON r.workspace_id = a.workspace_id AND r.id = a.run_id
           LEFT JOIN agent_profiles p
             ON p.workspace_id = a.workspace_id AND p.id = r.agent_profile_id
           WHERE a.workspace_id = ? AND a.execution_id = ? AND a.assignment_generation = ?`,
        )
        .get(ctx.workspaceId, executionId, generation)) as
        | {
            runner_id: string;
            project_id: string;
            task_id: string;
            run_id: string;
            provider: string | null;
          }
        | undefined;
      const binding: AssignmentBinding | null = row
        ? {
            runner_id: row.runner_id,
            project_id: row.project_id,
            task_id: row.task_id,
            run_id: row.run_id,
            provider: row.provider,
          }
        : null;
      bindings.set(key, binding);
      return binding;
    }

    async function executionExists(executionId: string): Promise<boolean> {
      const cached = executions.get(executionId);
      if (cached !== undefined) return cached;
      const row = (await ctx.db
        .prepare(`SELECT 1 AS found FROM run_executions WHERE workspace_id = ? AND id = ?`)
        .get(ctx.workspaceId, executionId)) as { found: number } | undefined;
      const exists = Boolean(row);
      executions.set(executionId, exists);
      return exists;
    }

    async function executionHasAssignment(executionId: string): Promise<boolean> {
      const cached = assignedExecutions.get(executionId);
      if (cached !== undefined) return cached;
      const row = (await ctx.db
        .prepare(
          `SELECT 1 AS found FROM execution_assignments WHERE workspace_id = ? AND execution_id = ?`,
        )
        .get(ctx.workspaceId, executionId)) as { found: number } | undefined;
      const exists = Boolean(row);
      assignedExecutions.set(executionId, exists);
      return exists;
    }

    for (const entry of decoded) {
      if (!("submission" in entry)) {
        dispositions.push(rejectedDisposition(entry.triple, entry.fault));
        continue;
      }
      const { triple, submission } = entry;
      const duplicate = seenIds.get(triple.eventId);
      if (duplicate) {
        if (duplicate.streamId === triple.streamId && duplicate.sequence === triple.sequence) {
          dispositions.push(alreadyCommittedDisposition(triple));
        } else {
          dispositions.push(
            rejectedDisposition(
              triple,
              diagnostic(
                "conflict",
                "event_id_confusion",
                "event id is bound to another stream row",
              ),
            ),
          );
        }
        continue;
      }
      const streamKey = `${triple.streamId}:${triple.sequence}`;
      const streamOwner = seenStreams.get(streamKey);
      if (streamOwner !== undefined && streamOwner !== triple.eventId) {
        dispositions.push(
          rejectedDisposition(
            triple,
            diagnostic(
              "conflict",
              "stream_sequence_conflict",
              "stream sequence is bound to another event",
            ),
          ),
        );
        continue;
      }
      seenIds.set(triple.eventId, triple);
      seenStreams.set(streamKey, triple.eventId);

      const occurred = Date.parse(submission.occurred_at);
      if (occurred - Date.parse(ctx.now) > EVENT_FUTURE_TOLERANCE_MS) {
        dispositions.push(
          rejectedDisposition(
            triple,
            diagnostic("type_mismatch", "future_timestamp", "event occurred_at is in the future"),
          ),
        );
        continue;
      }

      const binding = await bindingFor(
        submission.run_execution_id,
        submission.assignment_generation,
      );
      if (!binding) {
        if (!(await executionExists(submission.run_execution_id))) {
          dispositions.push(
            rejectedDisposition(
              triple,
              diagnostic("conflict", "unknown_execution", "run execution is unknown"),
            ),
          );
          continue;
        }
        if (await executionHasAssignment(submission.run_execution_id)) {
          dispositions.push(
            rejectedDisposition(
              triple,
              diagnostic(
                "conflict",
                "assignment_generation_confusion",
                "assignment generation does not match the execution",
              ),
            ),
          );
          continue;
        }
        dispositions.push(
          retryableDisposition(
            triple,
            diagnostic(
              "unavailable",
              "assignment_not_committed",
              "execution has no committed assignment yet",
            ),
          ),
        );
        continue;
      }
      if (binding.runner_id !== principal.runnerId) {
        dispositions.push(
          rejectedDisposition(
            triple,
            diagnostic(
              "authorization_denied",
              "wrong_runner",
              "execution is assigned to another runner",
            ),
          ),
        );
        continue;
      }
      if (!principal.projectIds.includes(binding.project_id)) {
        dispositions.push(
          rejectedDisposition(
            triple,
            diagnostic(
              "authorization_denied",
              "project_grant_revoked",
              "runner has no grant for the assigned project",
            ),
          ),
        );
        continue;
      }

      const committed = (await ctx.db
        .prepare(
          `SELECT event_id, source_stream_id, source_sequence
           FROM event_ledger WHERE workspace_id = ? AND event_id = ?`,
        )
        .get(ctx.workspaceId, triple.eventId)) as
        { event_id: string; source_stream_id: string; source_sequence: number } | undefined;
      if (committed) {
        if (
          committed.source_stream_id === triple.streamId &&
          committed.source_sequence === triple.sequence
        ) {
          dispositions.push(alreadyCommittedDisposition(triple));
        } else {
          dispositions.push(
            rejectedDisposition(
              triple,
              diagnostic(
                "conflict",
                "event_id_confusion",
                "event id is bound to another stream row",
              ),
            ),
          );
        }
        continue;
      }
      const streamRow = (await ctx.db
        .prepare(
          `SELECT event_id FROM event_ledger
           WHERE workspace_id = ? AND source_stream_id = ? AND source_sequence = ?`,
        )
        .get(ctx.workspaceId, triple.streamId, triple.sequence)) as
        { event_id: string } | undefined;
      if (streamRow) {
        dispositions.push(
          rejectedDisposition(
            triple,
            diagnostic(
              "conflict",
              "stream_sequence_conflict",
              "stream sequence is bound to another event",
            ),
          ),
        );
        continue;
      }

      prepared.push({
        triple,
        submission,
        binding,
        actorType: submission.capture_origin === "runner_observed" ? "runner" : "agent_run",
        cursor: ctx.cursorBase + acceptedCount,
      });
      acceptedCount += 1;
      dispositions.push(acceptedDisposition(triple));
    }

    // Absolute projection inputs: committed counts plus this batch's accepted
    // rows. Totals are recomputed, never incremented, so transport replay and
    // batch retries cannot double count.
    const runBase = new Map<string, number>();
    const executionBase = new Map<string, number>();
    const executionHeartbeats = new Map<string, number>();
    const kindBase = new Map<string, number>();
    const sessionBase = new Map<string, number>();
    if (prepared.length > 0) {
      const runIds = [...new Set(prepared.map((event) => event.binding.run_id))];
      for (const runId of runIds) {
        const row = (await ctx.db
          .prepare(
            `SELECT COUNT(*) AS total FROM event_ledger WHERE workspace_id = ? AND run_id = ?`,
          )
          .get(ctx.workspaceId, runId)) as { total: number };
        runBase.set(runId, row.total);
      }
      const executionIds = [...new Set(prepared.map((event) => event.submission.run_execution_id))];
      for (const executionId of executionIds) {
        const row = (await ctx.db
          .prepare(
            `SELECT COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN kind = 'heartbeat' THEN 1 ELSE 0 END), 0) AS heartbeats
             FROM event_ledger WHERE workspace_id = ? AND run_execution_id = ?`,
          )
          .get(ctx.workspaceId, executionId)) as { total: number; heartbeats: number };
        executionBase.set(executionId, row.total);
        executionHeartbeats.set(executionId, row.heartbeats);
      }
      const kindKeys = [
        ...new Set(
          prepared.map((event) => `${event.submission.run_execution_id}:${event.submission.kind}`),
        ),
      ];
      for (const key of kindKeys) {
        const [executionId, kind] = key.split(":") as [string, string];
        const row = (await ctx.db
          .prepare(
            `SELECT COUNT(*) AS total FROM event_ledger
             WHERE workspace_id = ? AND run_execution_id = ? AND kind = ?`,
          )
          .get(ctx.workspaceId, executionId, kind)) as { total: number };
        kindBase.set(key, row.total);
      }
      const sessionKeys = [
        ...new Set(
          prepared
            .filter((event) => event.submission.provider_session_id !== undefined)
            .map(
              (event) =>
                `${event.submission.run_execution_id}:${event.submission.provider_session_id as string}`,
            ),
        ),
      ];
      for (const key of sessionKeys) {
        const separator = key.lastIndexOf(":");
        const executionId = key.slice(0, separator);
        const sessionId = key.slice(separator + 1);
        const row = (await ctx.db
          .prepare(
            `SELECT COUNT(*) AS total FROM event_ledger
             WHERE workspace_id = ? AND run_execution_id = ? AND provider_session_id = ?`,
          )
          .get(ctx.workspaceId, executionId, sessionId)) as { total: number };
        sessionBase.set(key, row.total);
      }
    }

    // Phase 3: staged writes only. No reads follow; D1 flushes the batch atomically.
    const runAccepted = new Map<string, PreparedEvent[]>();
    const executionAccepted = new Map<string, PreparedEvent[]>();
    const sessionAccepted = new Map<string, PreparedEvent[]>();
    const kindAccepted = new Map<string, PreparedEvent[]>();
    for (const event of prepared) {
      const envelope = envelopeOf(event, ctx.workspaceId, principal.runnerId, ctx.now);
      await ctx.db
        .prepare(
          `INSERT INTO event_ledger
           (workspace_id, event_id, workspace_cursor, source_stream_id, source_sequence, source_event_id,
            run_execution_id, assignment_generation, project_id, task_id, run_id, provider_session_id,
            actor_type, actor_id, source_type, source_id, source_provider,
            capture_origin, kind, occurred_at, received_at, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ctx.workspaceId,
          envelope.event_id,
          envelope.workspace_cursor,
          envelope.source_stream_id,
          envelope.source_sequence,
          envelope.source_event_id ?? null,
          envelope.run_execution_id as string,
          envelope.assignment_generation as number,
          envelope.project_id as string,
          envelope.task_id as string,
          envelope.run_id as string,
          envelope.provider_session_id ?? null,
          envelope.actor.type,
          envelope.actor.id,
          envelope.source.type,
          envelope.source.id,
          envelope.source.provider ?? null,
          event.submission.capture_origin,
          envelope.kind,
          envelope.occurred_at,
          envelope.received_at,
          JSON.stringify(event.submission.payload),
        );
      if (OBSERVATION_KINDS.has(envelope.kind)) {
        await ctx.db
          .prepare(
            `INSERT INTO measurement_observations
             (workspace_id, observation_id, run_execution_id, run_id, measure_kind,
              capture_origin, actor_type, actor_id, occurred_at, committed_cursor)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ctx.workspaceId,
            envelope.event_id,
            envelope.run_execution_id as string,
            envelope.run_id as string,
            envelope.kind,
            event.submission.capture_origin,
            envelope.actor.type,
            envelope.actor.id,
            envelope.occurred_at,
            envelope.workspace_cursor,
          );
      }
      pushTo(runAccepted, event.binding.run_id, event);
      pushTo(executionAccepted, event.submission.run_execution_id, event);
      pushTo(kindAccepted, `${event.submission.run_execution_id}:${event.submission.kind}`, event);
      if (event.submission.provider_session_id !== undefined) {
        pushTo(
          sessionAccepted,
          `${event.submission.run_execution_id}:${event.submission.provider_session_id}`,
          event,
        );
      }
    }

    for (const [runId, events] of runAccepted) {
      const last = events[events.length - 1] as PreparedEvent;
      await ctx.db
        .prepare(
          `INSERT INTO run_event_projections
           (workspace_id, run_id, last_cursor, event_count, last_kind, last_occurred_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, run_id) DO UPDATE SET
             last_cursor = excluded.last_cursor,
             event_count = excluded.event_count,
             last_kind = excluded.last_kind,
             last_occurred_at = excluded.last_occurred_at,
             updated_at = excluded.updated_at
           WHERE excluded.last_cursor > run_event_projections.last_cursor`,
        )
        .run(
          ctx.workspaceId,
          runId,
          last.cursor,
          (runBase.get(runId) ?? 0) + events.length,
          last.submission.kind,
          last.submission.occurred_at,
          ctx.now,
        );
    }
    for (const [executionId, events] of executionAccepted) {
      const last = events[events.length - 1] as PreparedEvent;
      const heartbeats = events.filter((event) => event.submission.kind === "heartbeat");
      const lastHeartbeat = heartbeats.length > 0 ? heartbeats[heartbeats.length - 1] : undefined;
      await ctx.db
        .prepare(
          `INSERT INTO execution_event_projections
           (workspace_id, run_execution_id, run_id, last_cursor, event_count, last_kind, last_occurred_at,
            heartbeat_count, last_heartbeat_at, last_heartbeat_cursor, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, run_execution_id) DO UPDATE SET
             last_cursor = excluded.last_cursor,
             event_count = excluded.event_count,
             last_kind = excluded.last_kind,
             last_occurred_at = excluded.last_occurred_at,
             heartbeat_count = excluded.heartbeat_count,
             last_heartbeat_at = excluded.last_heartbeat_at,
             last_heartbeat_cursor = excluded.last_heartbeat_cursor,
             updated_at = excluded.updated_at
           WHERE excluded.last_cursor > execution_event_projections.last_cursor`,
        )
        .run(
          ctx.workspaceId,
          executionId,
          events[0]?.binding.run_id as string,
          last.cursor,
          (executionBase.get(executionId) ?? 0) + events.length,
          last.submission.kind,
          last.submission.occurred_at,
          (executionHeartbeats.get(executionId) ?? 0) + heartbeats.length,
          lastHeartbeat ? lastHeartbeat.submission.occurred_at : null,
          lastHeartbeat ? lastHeartbeat.cursor : null,
          ctx.now,
        );
    }
    for (const [key, events] of sessionAccepted) {
      const separator = key.lastIndexOf(":");
      const executionId = key.slice(0, separator);
      const sessionId = key.slice(separator + 1);
      const last = events[events.length - 1] as PreparedEvent;
      await ctx.db
        .prepare(
          `INSERT INTO session_event_projections
           (workspace_id, run_execution_id, provider_session_id, run_id,
            last_cursor, event_count, last_kind, last_occurred_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, run_execution_id, provider_session_id) DO UPDATE SET
             last_cursor = excluded.last_cursor,
             event_count = excluded.event_count,
             last_kind = excluded.last_kind,
             last_occurred_at = excluded.last_occurred_at,
             updated_at = excluded.updated_at
           WHERE excluded.last_cursor > session_event_projections.last_cursor`,
        )
        .run(
          ctx.workspaceId,
          executionId,
          sessionId,
          events[0]?.binding.run_id as string,
          last.cursor,
          (sessionBase.get(key) ?? 0) + events.length,
          last.submission.kind,
          last.submission.occurred_at,
          ctx.now,
        );
    }
    for (const [key, events] of kindAccepted) {
      const separator = key.lastIndexOf(":");
      const executionId = key.slice(0, separator);
      const kind = key.slice(separator + 1);
      const last = events[events.length - 1] as PreparedEvent;
      await ctx.db
        .prepare(
          `INSERT INTO event_kind_counters
           (workspace_id, run_execution_id, kind, event_count, last_cursor, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, run_execution_id, kind) DO UPDATE SET
             event_count = excluded.event_count,
             last_cursor = excluded.last_cursor,
             updated_at = excluded.updated_at
           WHERE excluded.last_cursor > event_kind_counters.last_cursor`,
        )
        .run(
          ctx.workspaceId,
          executionId,
          kind,
          (kindBase.get(key) ?? 0) + events.length,
          last.cursor,
          ctx.now,
        );
    }

    return {
      schema_version: 1 as const,
      workspace_id: ctx.workspaceId,
      high_water_cursor:
        prepared.length > 0
          ? (prepared[prepared.length - 1]?.cursor as number)
          : ctx.cursorBase - 1,
      dispositions,
    };
  },
};

function pushTo(map: Map<string, PreparedEvent[]>, key: string, event: PreparedEvent): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(event);
  } else {
    map.set(key, [event]);
  }
}

function isKnownProvider(
  value: string | null,
): value is NonNullable<EventEnvelope["source"]["provider"]> {
  return value === "claude" || value === "codex" || value === "grok" || value === "fake";
}

function envelopeOf(
  event: PreparedEvent,
  workspaceId: string,
  runnerIdValue: string,
  receivedAt: string,
): EventEnvelope {
  const { triple, submission, binding, actorType, cursor } = event;
  const envelope: EventEnvelope = {
    schema_version: 1,
    event_id: triple.eventId,
    workspace_cursor: cursor,
    source_stream_id: triple.streamId,
    source_sequence: triple.sequence,
    workspace_id: workspaceId,
    project_id: binding.project_id,
    task_id: binding.task_id,
    run_id: binding.run_id,
    run_execution_id: submission.run_execution_id,
    assignment_generation: submission.assignment_generation,
    actor: {
      type: actorType,
      id: actorType === "runner" ? runnerIdValue : submission.run_execution_id,
    },
    source: {
      type: "runner",
      id: runnerIdValue,
      ...(isKnownProvider(binding.provider) ? { provider: binding.provider } : {}),
    },
    kind: submission.kind,
    occurred_at: submission.occurred_at,
    received_at: receivedAt,
    payload: {},
  };
  if (submission.source_event_id !== undefined) {
    envelope.source_event_id = submission.source_event_id;
  }
  if (submission.provider_session_id !== undefined) {
    envelope.provider_session_id = submission.provider_session_id;
  }
  const decoded = decodeWireDocument("event-envelope", Buffer.from(JSON.stringify(envelope)));
  if (!decoded.ok) {
    throw new DomainError("event_history_corrupt", "committed envelope failed validation");
  }
  return decoded.value as EventEnvelope;
}

async function assertLedgerReadScope(
  db: SqlDatabase,
  authorization: AuthorizationContext,
): Promise<void> {
  const workspace = await WorkspaceRepository.forAuthorization(db, authorization).getWorkspace();
  if (!workspace) {
    throw new DomainError("workspace_not_found", "workspace not found");
  }
  if (workspace.jurisdiction !== authorization.jurisdiction) {
    throw new DomainError(
      "workspace_jurisdiction_mismatch",
      "workspace jurisdiction does not match the authorization context",
    );
  }
}

/** Workspace high-water cursor over committed ledger rows. Reads go directly to D1. */
export async function readLedgerHighWater(
  db: SqlDatabase,
  authorization: AuthorizationContext,
): Promise<number> {
  await assertLedgerReadScope(db, authorization);
  const row = (await db
    .prepare(
      `SELECT COALESCE(MAX(workspace_cursor), 0) AS high_water FROM event_ledger WHERE workspace_id = ?`,
    )
    .get(authorization.workspaceId)) as { high_water: number };
  if (!Number.isSafeInteger(row.high_water) || row.high_water < 0) {
    throw new DomainError("event_history_corrupt", "ledger high-water is invalid");
  }
  return row.high_water;
}

interface LedgerRow {
  event_id: string;
  workspace_cursor: number;
  source_stream_id: string;
  source_event_id: string | null;
  source_sequence: number;
  workspace_id: string;
  project_id: string;
  task_id: string;
  run_id: string;
  run_execution_id: string;
  assignment_generation: number;
  provider_session_id: string | null;
  actor_type: string;
  actor_id: string;
  source_type: string;
  source_id: string;
  source_provider: string | null;
  capture_origin: string;
  kind: string;
  occurred_at: string;
  received_at: string;
  payload_json: string;
}

/** Paginated replay of committed ledger envelopes in cursor order. Reads go directly to D1. */
export async function listLedgerEvents(
  db: SqlDatabase,
  authorization: AuthorizationContext,
  options: LedgerReplayOptions,
): Promise<EventEnvelope[]> {
  const limit = options.limit ?? 100;
  if (
    !Number.isSafeInteger(options.afterCursor) ||
    options.afterCursor < 0 ||
    !Number.isSafeInteger(options.throughCursor) ||
    options.throughCursor < options.afterCursor ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new DomainError("invalid_event_range", "ledger replay range is invalid");
  }
  await assertLedgerReadScope(db, authorization);
  const rows = (await db
    .prepare(
      `SELECT event_id, workspace_cursor, source_stream_id, source_event_id, source_sequence,
              workspace_id, project_id, task_id, run_id, run_execution_id, assignment_generation,
              provider_session_id, actor_type, actor_id, source_type, source_id, source_provider,
              capture_origin, kind, occurred_at, received_at, payload_json
       FROM event_ledger
       WHERE workspace_id = ? AND workspace_cursor > ? AND workspace_cursor <= ?
       ORDER BY workspace_cursor ASC
       LIMIT ?`,
    )
    .all(
      authorization.workspaceId,
      options.afterCursor,
      options.throughCursor,
      limit,
    )) as LedgerRow[];
  return rows.map((row) => {
    if (!Number.isSafeInteger(row.workspace_cursor) || row.workspace_cursor < 1) {
      throw new DomainError("event_history_corrupt", "ledger cursor is invalid");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      throw new DomainError("event_history_corrupt", "ledger payload is invalid");
    }
    const envelope = {
      schema_version: 1,
      event_id: row.event_id,
      workspace_cursor: row.workspace_cursor,
      source_stream_id: row.source_stream_id,
      ...(row.source_event_id === null ? {} : { source_event_id: row.source_event_id }),
      source_sequence: row.source_sequence,
      workspace_id: row.workspace_id,
      project_id: row.project_id,
      task_id: row.task_id,
      run_id: row.run_id,
      run_execution_id: row.run_execution_id,
      assignment_generation: row.assignment_generation,
      ...(row.provider_session_id === null ? {} : { provider_session_id: row.provider_session_id }),
      actor: { type: row.actor_type, id: row.actor_id },
      source: {
        type: row.source_type,
        id: row.source_id,
        ...(row.source_provider === null ? {} : { provider: row.source_provider }),
      },
      kind: row.kind,
      occurred_at: row.occurred_at,
      received_at: row.received_at,
      payload,
    };
    const decoded = decodeWireDocument("event-envelope", Buffer.from(JSON.stringify(envelope)));
    if (!decoded.ok) {
      throw new DomainError("event_history_corrupt", "stored ledger envelope is invalid");
    }
    return decoded.value as EventEnvelope;
  });
}

/** Browser replay requires a current workspace owner or member; reviewers stay project-scoped. */
export async function assertLedgerBrowserAccess(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
  authorizationEpoch: number,
): Promise<void> {
  const principal = await loadPrincipal(db, runnerId(workspaceId), runnerId(humanId));
  assertEpoch(principal, authorizationEpoch);
  assertRole(principal, ["owner", "member"]);
}
