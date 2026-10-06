// ABOUTME: Prepares immutable semantic sources for typed telemetry inside the event-ingest transaction.
// ABOUTME: Exposes canonical activity and bounded metadata reads without raw usage or private provider output.

import type { SqlDatabase } from "@bfb/db";
import type { RunnerTelemetrySubmission } from "@bfb/protocol";

import { DomainError } from "./hub.js";
import { canonicalLaunchJson } from "./launch-state.js";
import {
  normalizeTokenFields,
  persistTokenObservation,
  tokenFieldsPresent,
} from "./measurement-tokens.js";
import type { MeasurementProvider, TokenObservation, TokenQuality } from "./measurements.js";
import { runnerHash } from "./runner-crypto.js";
import { sharedTaskPredicate, taskAccessPredicate, type TaskAccessContext } from "./task-access.js";

function sourceTaskPredicate(workspaceId: string, access?: TaskAccessContext) {
  if (access && access.workspaceId !== workspaceId)
    throw new DomainError("not_found", "run not found");
  return access
    ? taskAccessPredicate(access, "read")
    : { sql: sharedTaskPredicate(), parameters: [] };
}

export interface PreparedMeasurementSource {
  sourceKey: string;
  eventId: string;
  canonicalEventId: string;
  inputFingerprint: string;
  semanticFingerprint: string;
  family: "turn" | "tool" | "tokens";
  identity: string;
  phase: "start" | "end" | "turn_delta";
  parentTurnId: string | null;
  isCanonical: boolean;
  token: TokenObservation | null;
}

export function telemetryInputFingerprint(input: RunnerTelemetrySubmission): string {
  return runnerHash(canonicalLaunchJson(input));
}

/** Reads and resolves identities before any event, source, or token insert is staged. */
export async function prepareMeasurementSource(
  db: SqlDatabase,
  workspaceId: string,
  input: RunnerTelemetrySubmission,
  binding: { run_id: string; provider: MeasurementProvider },
  now: string,
  pending: Map<string, PreparedMeasurementSource>,
): Promise<PreparedMeasurementSource> {
  const payload = input.payload as Record<string, unknown>;
  const family =
    input.kind === "progress_reported"
      ? "tokens"
      : input.kind.startsWith("turn_")
        ? "turn"
        : "tool";
  const identity = String(family === "tokens" ? payload.usage_id : payload.activity_id);
  const phase =
    family === "tokens" ? "turn_delta" : input.kind.endsWith("_started") ? "start" : "end";
  const parentTurnId =
    family === "tool" ? ((payload.parent_turn_id as string | undefined) ?? null) : null;
  const sourceKey = runnerHash(
    canonicalLaunchJson({
      run_execution_id: input.run_execution_id,
      assignment_generation: input.assignment_generation,
      provider_session_id: input.provider_session_id ?? null,
      family,
      identity,
      phase,
    }),
  );
  const semanticFingerprint = runnerHash(
    canonicalLaunchJson(
      family === "tokens"
        ? {
            basis: payload.basis,
            model: payload.model,
            quality: payload.quality,
            tokens: payload.tokens,
          }
        : { kind: input.kind, parent_turn_id: parentTurnId },
    ),
  );
  const staged = pending.get(sourceKey);
  const stored =
    staged ??
    ((await db
      .prepare(
        `SELECT event_id AS canonicalEventId,
    semantic_fingerprint AS semanticFingerprint FROM measurement_sources
    WHERE workspace_id = ? AND source_key = ?`,
      )
      .get(workspaceId, sourceKey)) as
      { canonicalEventId: string; semanticFingerprint: string } | undefined);
  if (stored && stored.semanticFingerprint !== semanticFingerprint) {
    throw new DomainError(
      "measurement_source_conflict",
      "semantic measurement identity differs from its original input",
    );
  }
  let token: TokenObservation | null = null;
  if (family === "tokens") {
    const fields = normalizeTokenFields(payload.tokens);
    const quality = payload.quality as TokenQuality;
    if (quality === "unavailable" ? tokenFieldsPresent(fields) : !tokenFieldsPresent(fields)) {
      throw new DomainError("invalid_argument", "token quality and availability disagree");
    }
    token = {
      observation_id: input.event_id,
      run_id: binding.run_id,
      run_execution_id: input.run_execution_id,
      provider: binding.provider,
      model: payload.model as string | null,
      tokens: fields,
      quality,
      provenance: input.capture_origin,
      occurred_at: input.occurred_at,
      committed_at: now,
    };
  }
  const result: PreparedMeasurementSource = {
    sourceKey,
    eventId: input.event_id,
    canonicalEventId: stored?.canonicalEventId ?? input.event_id,
    inputFingerprint: telemetryInputFingerprint(input),
    semanticFingerprint,
    family,
    identity,
    phase,
    parentTurnId,
    isCanonical: !stored,
    token,
  };
  if (!stored) pending.set(sourceKey, result);
  return result;
}

/** Stages source and observation writes after the original ledger row in the same transaction. */
export async function persistMeasurementSource(
  db: SqlDatabase,
  workspaceId: string,
  input: RunnerTelemetrySubmission,
  binding: { run_id: string; runner_id: string; provider: MeasurementProvider },
  source: PreparedMeasurementSource,
): Promise<void> {
  if (source.isCanonical) {
    await db
      .prepare(
        `INSERT INTO measurement_sources
      (workspace_id, source_key, event_id, run_id, run_execution_id, assignment_generation,
       runner_id, provider, provider_session_id, family, identity, phase, parent_turn_id, semantic_fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspaceId,
        source.sourceKey,
        source.eventId,
        binding.run_id,
        input.run_execution_id,
        input.assignment_generation,
        binding.runner_id,
        binding.provider,
        input.provider_session_id ?? null,
        source.family,
        source.identity,
        source.phase,
        source.parentTurnId,
        source.semanticFingerprint,
      );
    if (source.token) await persistTokenObservation(db, workspaceId, source.token);
  }
  await db
    .prepare(
      `INSERT INTO measurement_event_sources
    (workspace_id, event_id, canonical_event_id, input_fingerprint) VALUES (?, ?, ?, ?)`,
    )
    .run(workspaceId, source.eventId, source.canonicalEventId, source.inputFingerprint);
}

export interface MeasurementActivitySource {
  event_id: string;
  run_execution_id: string;
  assignment_generation: number;
  provider_session_id: string | null;
  kind: string;
  occurred_at: string;
  activity_id: string;
  family: "turn" | "tool";
  phase: "start" | "end";
  parent_turn_id?: string;
}

/** Internal derivation input contains every admitted canonical activity, never a truncated page. */
export async function listRunMeasurementActivitySources(
  db: SqlDatabase,
  workspaceId: string,
  runId: string,
  access?: TaskAccessContext,
): Promise<MeasurementActivitySource[]> {
  const predicate = sourceTaskPredicate(workspaceId, access);
  const rows = (await db
    .prepare(
      `SELECT s.event_id, s.run_execution_id, s.assignment_generation, s.provider_session_id,
    e.kind, e.occurred_at, s.identity AS activity_id, s.family, s.phase,
    s.parent_turn_id FROM measurement_sources s
    JOIN event_ledger e ON e.workspace_id = s.workspace_id AND e.event_id = s.event_id
    JOIN runs AS run ON run.workspace_id = s.workspace_id AND run.id = s.run_id
    JOIN tasks AS task ON task.workspace_id = run.workspace_id AND task.id = run.task_id
      AND task.project_id = run.project_id
    WHERE s.workspace_id = ? AND s.run_id = ? AND s.family IN ('turn', 'tool') AND ${predicate.sql}
    ORDER BY e.workspace_cursor`,
    )
    .all(workspaceId, runId, ...predicate.parameters)) as Array<
    Omit<MeasurementActivitySource, "parent_turn_id"> & { parent_turn_id: string | null }
  >;
  return rows.map(({ parent_turn_id, ...row }) => ({
    ...row,
    ...(parent_turn_id === null ? {} : { parent_turn_id }),
  }));
}

export interface MeasurementSourceReference {
  event_id: string;
  committed_cursor: number;
  run_execution_id: string;
  assignment_generation: number;
  provider: MeasurementProvider;
  provider_session_id: string | null;
  kind: string;
  occurred_at: string;
  family: "turn" | "tool" | "tokens";
  phase: "start" | "end" | "turn_delta";
  activity_id?: string;
  usage_id?: string;
  parent_turn_id?: string;
}

/** Current parent authority precedes pagination; omitted authority admits shared tasks only. */
export async function listRunMeasurementSources(
  db: SqlDatabase,
  workspaceId: string,
  runId: string,
  options: { afterCursor?: number; limit?: number } = {},
  access?: TaskAccessContext,
): Promise<{
  sources: MeasurementSourceReference[];
  has_more: boolean;
  next_cursor: number;
}> {
  const predicate = sourceTaskPredicate(workspaceId, access);
  const authorize = async () => {
    const run = await db
      .prepare(
        `SELECT run.id FROM runs AS run
        JOIN tasks AS task ON task.workspace_id = run.workspace_id AND task.id = run.task_id
          AND task.project_id = run.project_id
        WHERE run.workspace_id = ? AND run.id = ? AND ${predicate.sql}`,
      )
      .get(workspaceId, runId, ...predicate.parameters);
    if (!run) throw new DomainError("not_found", "run not found");
  };
  await authorize();
  const after = options.afterCursor ?? 0,
    limit = options.limit ?? 100;
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new DomainError("invalid_argument", "measurement source page is invalid");
  }
  const rows = (await db
    .prepare(
      `SELECT s.*, e.workspace_cursor, e.kind, e.occurred_at
    FROM measurement_sources s JOIN event_ledger e
    ON e.workspace_id = s.workspace_id AND e.event_id = s.event_id
    JOIN runs AS run ON run.workspace_id = s.workspace_id AND run.id = s.run_id
    JOIN tasks AS task ON task.workspace_id = run.workspace_id AND task.id = run.task_id
      AND task.project_id = run.project_id
    WHERE s.workspace_id = ? AND s.run_id = ? AND e.workspace_cursor > ? AND ${predicate.sql}
    ORDER BY e.workspace_cursor LIMIT ?`,
    )
    .all(workspaceId, runId, after, ...predicate.parameters, limit + 1)) as Record<
    string,
    unknown
  >[];
  const sources = rows.slice(0, limit).map((row): MeasurementSourceReference => ({
    event_id: String(row.event_id),
    committed_cursor: Number(row.workspace_cursor),
    run_execution_id: String(row.run_execution_id),
    assignment_generation: Number(row.assignment_generation),
    provider: row.provider as MeasurementProvider,
    provider_session_id: row.provider_session_id as string | null,
    kind: String(row.kind),
    occurred_at: String(row.occurred_at),
    family: row.family as MeasurementSourceReference["family"],
    phase: row.phase as MeasurementSourceReference["phase"],
    ...(row.family === "tokens"
      ? { usage_id: String(row.identity) }
      : { activity_id: String(row.identity) }),
    ...(row.parent_turn_id === null ? {} : { parent_turn_id: String(row.parent_turn_id) }),
  }));
  await authorize();
  return {
    sources,
    has_more: rows.length > limit,
    next_cursor: sources.at(-1)?.committed_cursor ?? after,
  };
}
