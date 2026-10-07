// ABOUTME: Ingests authenticated runner event batches into the immutable ledger with per-event dispositions.
// ABOUTME: Attribution is derived server-side from execution assignments; claimed IDs are hints only.

import type { AuthorizationContext, SqlDatabase } from "@bfb/db";
import {
  decodeWireDocument,
  type EventDisposition,
  type EventEnvelope,
  type RunnerEventSubmission,
  type RunnerTelemetrySubmission,
  type TypedError,
} from "@bfb/protocol";

import { assertEpoch, assertRole, loadPrincipal } from "./authorization.js";
import { DomainError, type HubCommand } from "./hub.js";
import { isUlid } from "./ids.js";
import { canonicalLaunchJson, launchRunner, readLaunch, snapshotOf } from "./launch-state.js";
import {
  prepareMeasurementSource,
  persistMeasurementSource,
  telemetryInputFingerprint,
  type PreparedMeasurementSource,
} from "./measurement-sources.js";
import type { MeasurementProvider } from "./measurements.js";
import { rejectRunnerRequest, runnerHash, runnerId, runnerObject } from "./runner-crypto.js";
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
  /** Exact signed raw item bytes retained by the fixed Worker adapter, never user-supplied authority. */
  encodedEvents?: string[];
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
  submission: RunnerEventSubmission | RunnerTelemetrySubmission;
  measurementSource?: PreparedMeasurementSource;
  binding: AssignmentBinding;
  actorType: "runner" | "agent_run";
  cursor: number;
}

export const ingestRunnerEventsCommand: HubCommand<
  IngestRunnerEventsInput,
  IngestRunnerEventsResult
> = {
  name: "event.ingest",
  async authorize(input, ctx) {
    await launchRunner(ctx, input.principal);
  },
  inputFingerprint: (input) =>
    runnerHash(
      canonicalLaunchJson({
        events: input.events,
        encodedEvents: input.encodedEvents ?? input.events.map(encodeSubmission),
      }),
    ),
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
    runnerObject(raw, ["principal", "events", "encodedEvents"]);
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
    if (
      input.encodedEvents &&
      (!Array.isArray(input.encodedEvents) || input.encodedEvents.length !== items.length)
    )
      rejectRunnerRequest();

    // Phase 1: decode every item before any database write is staged. Items
    // without a well-formed transport triple are transport violations: the
    // whole batch is rejected uniformly and nothing commits, because no
    // disposition could address the row. Well-identified poison receives a
    // per-event permanently_rejected and never blocks later rows.
    const decoded: Array<
      | { triple: EventTriple; submission: RunnerEventSubmission | RunnerTelemetrySubmission }
      | { triple: EventTriple; fault: TypedError }
    > = [];
    for (const [index, rawItem] of items.entries()) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        rejectRunnerRequest();
      }
      const encoded = input.encodedEvents?.[index] ?? encodeSubmission(rawItem);
      if (typeof encoded !== "string") rejectRunnerRequest();
      if (input.encodedEvents) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(encoded);
        } catch {
          rejectRunnerRequest();
        }
        if (encodeSubmission(parsed) !== encodeSubmission(rawItem)) rejectRunnerRequest();
      }
      if (Buffer.byteLength(encoded) > EVENT_ITEM_LIMIT) {
        const triple = extractTriple(rawItem);
        if (!triple) rejectRunnerRequest();
        decoded.push({
          triple,
          fault: diagnostic("bound_exceeded", "event_too_large", "event item exceeds the limit"),
        });
        continue;
      }
      const telemetry = (rawItem as Record<string, unknown>).schema_version === 2;
      const result = decodeWireDocument(
        telemetry ? "runner-telemetry-submission" : "runner-event-submission",
        Buffer.from(encoded),
      );
      if (!result.ok) {
        const triple = extractTriple(rawItem);
        if (!triple) rejectRunnerRequest();
        decoded.push({ triple, fault: result.error });
        continue;
      }
      decoded.push({
        triple: extractTriple(rawItem) as EventTriple,
        submission: result.value as RunnerEventSubmission | RunnerTelemetrySubmission,
      });
    }

    // Phase 2: reads only. D1 batch transactions forbid reads after a queued
    // write, so every lookup completes before the first staged insert.
    const dispositions: EventDisposition[] = [];
    const prepared: PreparedEvent[] = [];
    const seenIds = new Map<string, EventTriple & { fingerprint: string | null }>();
    const measurementSources = new Map<string, PreparedMeasurementSource>();
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
          `SELECT a.runner_id, a.project_id, a.task_id, a.run_id, l.id AS launch_id
           FROM execution_assignments a
           JOIN runs r ON r.workspace_id = a.workspace_id AND r.id = a.run_id
           LEFT JOIN launch_commands l ON l.workspace_id = a.workspace_id AND l.execution_id = a.execution_id
           WHERE a.workspace_id = ? AND a.execution_id = ? AND a.assignment_generation = ?`,
        )
        .get(ctx.workspaceId, executionId, generation)) as
        | {
            runner_id: string;
            project_id: string;
            task_id: string;
            run_id: string;
            launch_id: string | null;
          }
        | undefined;
      const binding: AssignmentBinding | null = row
        ? {
            runner_id: row.runner_id,
            project_id: row.project_id,
            task_id: row.task_id,
            run_id: row.run_id,
            provider: row.launch_id
              ? snapshotOf(await readLaunch(ctx.db, ctx.workspaceId, row.launch_id))
                  .execution_config.provider
              : null,
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
      const inputFingerprint =
        submission.schema_version === 2 ? telemetryInputFingerprint(submission) : null;
      const duplicate = seenIds.get(triple.eventId);
      if (duplicate) {
        if (
          duplicate.streamId === triple.streamId &&
          duplicate.sequence === triple.sequence &&
          duplicate.fingerprint === inputFingerprint
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
          `SELECT event_id, source_stream_id, source_sequence,
             (SELECT input_fingerprint FROM measurement_event_sources s
              WHERE s.workspace_id = event_ledger.workspace_id AND s.event_id = event_ledger.event_id) AS input_fingerprint
           FROM event_ledger WHERE workspace_id = ? AND event_id = ?`,
        )
        .get(ctx.workspaceId, triple.eventId)) as
        | {
            event_id: string;
            source_stream_id: string;
            source_sequence: number;
            input_fingerprint: string | null;
          }
        | undefined;
      if (committed) {
        if (
          committed.source_stream_id === triple.streamId &&
          committed.source_sequence === triple.sequence &&
          committed.input_fingerprint === inputFingerprint
        ) {
          dispositions.push(alreadyCommittedDisposition(triple));
          seenIds.set(triple.eventId, { ...triple, fingerprint: inputFingerprint });
          seenStreams.set(streamKey, triple.eventId);
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

      let measurementSource: PreparedMeasurementSource | undefined;
      if (submission.schema_version === 2) {
        if (!isKnownProvider(binding.provider)) {
          dispositions.push(
            rejectedDisposition(
              triple,
              diagnostic(
                "conflict",
                "execution_snapshot_missing",
                "telemetry has no immutable provider snapshot",
              ),
            ),
          );
          continue;
        }
        try {
          measurementSource = await prepareMeasurementSource(
            ctx.db,
            ctx.workspaceId,
            submission,
            { ...binding, provider: binding.provider },
            ctx.now,
            measurementSources,
          );
        } catch (error) {
          if (
            !(error instanceof DomainError) ||
            !["measurement_source_conflict", "invalid_argument"].includes(error.code)
          )
            throw error;
          dispositions.push(
            rejectedDisposition(
              triple,
              diagnostic("conflict", error.code, "telemetry differs from its semantic identity"),
            ),
          );
          continue;
        }
      }
      seenIds.set(triple.eventId, { ...triple, fingerprint: inputFingerprint });
      seenStreams.set(streamKey, triple.eventId);
      prepared.push({
        triple,
        submission,
        binding,
        actorType: submission.capture_origin === "runner_observed" ? "runner" : "agent_run",
        cursor: ctx.cursorBase + acceptedCount,
        ...(measurementSource ? { measurementSource } : {}),
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
      if (event.submission.schema_version === 2 && event.measurementSource) {
        await persistMeasurementSource(
          ctx.db,
          ctx.workspaceId,
          event.submission,
          { ...event.binding, provider: event.binding.provider as MeasurementProvider },
          event.measurementSource,
        );
      }
      if (
        OBSERVATION_KINDS.has(envelope.kind) &&
        (!event.measurementSource || event.measurementSource.isCanonical)
      ) {
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

/** Public positions remain unavailable; runner ingest keeps its internal acknowledgement. */
export async function readLedgerHighWater(
  _db: SqlDatabase,
  _authorization: AuthorizationContext,
): Promise<number> {
  throw new DomainError("request_rejected", "event feeds are unavailable");
}

/** Pure range admission remains available while public ledger delivery is held. */
export async function listLedgerEvents(
  _db: SqlDatabase,
  _authorization: AuthorizationContext,
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
  throw new DomainError("request_rejected", "event feeds are unavailable");
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
