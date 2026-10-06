// ABOUTME: Derives separated provenance-labelled measurements from unique raw observations.
// ABOUTME: Totals union unique identities at read time; replaying an observation can never inflate them.

import type { SqlDatabase } from "@bfb/db";

import { assertEpoch, assertProjectAccess, assertRole, loadPrincipal } from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";
import { canonicalLaunchJson, launchRunner, readLaunch, snapshotOf } from "./launch-state.js";
import {
  listRunMeasurementActivitySources,
  listRunMeasurementSources,
  type MeasurementSourceReference,
} from "./measurement-sources.js";
import { rejectRunnerRequest, runnerHash, runnerId, runnerObject } from "./runner-crypto.js";
import type { RunnerPrincipal } from "./runners.js";
import {
  normalizeTokenFields,
  persistTokenObservation,
  TOKEN_FIELD_NAMES,
  tokenFieldsPresent,
} from "./measurement-tokens.js";
export {
  normalizeTokenFields,
  persistTokenObservation,
  tokenFieldsPresent,
} from "./measurement-tokens.js";

export const MEASUREMENT_PROVIDERS = ["claude", "codex", "grok", "fake"] as const;
export type MeasurementProvider = (typeof MEASUREMENT_PROVIDERS)[number];

export const TOKEN_QUALITIES = [
  "provider_reported",
  "stream_derived",
  "estimated",
  "unavailable",
] as const;
export type TokenQuality = (typeof TOKEN_QUALITIES)[number];

export const MEASUREMENT_PROVENANCES = ["runner_observed", "agent_reported", "hook_inbox"] as const;
export type MeasurementProvenance = (typeof MEASUREMENT_PROVENANCES)[number];

export const REPORTED_INTERVAL_KINDS = [
  "process_alive",
  "active",
  "external_wait",
  "idle",
] as const;
export type ReportedIntervalKind = (typeof REPORTED_INTERVAL_KINDS)[number];

/** Heartbeat gap beyond the architecture presence threshold counts as visible offline time. */
export const HEARTBEAT_STALE_MS = 45_000;
/** Stored browser activity is capped per observation and always labelled estimated. */
export const BROWSER_ACTIVITY_CAP_MS = 300_000;
/** Observations dated further beyond the server clock are rejected as clock confusion. */
export const MEASUREMENT_FUTURE_TOLERANCE_MS = 300_000;
/** Aggregation reads stop here and say so rather than silently truncating. */
export const MEASUREMENT_AGGREGATION_RUN_LIMIT = 200;

export interface IntervalMs {
  start: number;
  end: number;
}

export interface UnionTotal {
  total_ms: number;
  observation_count: number;
}

/**
 * Merges half-open intervals, deduplicating overlaps and adjacency. Inputs
 * are unique observations; identical replays contribute the same identity
 * once because storage keeps one row per observation ID.
 */
export function unionIntervalsMs(intervals: readonly IntervalMs[]): UnionTotal {
  const valid = intervals.filter(
    (interval) =>
      Number.isSafeInteger(interval.start) &&
      Number.isSafeInteger(interval.end) &&
      interval.end >= interval.start,
  );
  if (valid.length === 0) {
    return { total_ms: 0, observation_count: 0 };
  }
  const sorted = [...valid].sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let count = 0;
  let current = sorted[0] as IntervalMs;
  for (const next of sorted.slice(1)) {
    if (next.start <= current.end) {
      if (next.end > current.end) {
        current = { start: current.start, end: next.end };
      }
    } else {
      total += current.end - current.start;
      count += 1;
      current = next;
    }
  }
  total += current.end - current.start;
  count += 1;
  return { total_ms: total, observation_count: count };
}

/** Clips intervals to a half-open window; spans outside the window contribute nothing. */
export function clipIntervals(intervals: readonly IntervalMs[], window: IntervalMs): IntervalMs[] {
  if (window.end <= window.start) {
    return [];
  }
  const clipped: IntervalMs[] = [];
  for (const interval of intervals) {
    const start = Math.max(interval.start, window.start);
    const end = Math.min(interval.end, window.end);
    if (end > start) {
      clipped.push({ start, end });
    }
  }
  return clipped;
}

export interface TokenFields {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  reasoning: number | null;
}

export function sumTokenFields(rows: readonly TokenFields[]): TokenFields {
  return sumTokenFieldsChecked(rows).fields;
}

export type TokenFieldName = keyof TokenFields;

function sumTokenFieldsChecked(
  rows: readonly TokenFields[],
  priorOverflow: readonly TokenFieldName[] = [],
): { fields: TokenFields; overflow_fields: TokenFieldName[] } {
  const sums: Record<(typeof TOKEN_FIELD_NAMES)[number], number | null> = {
    input: null,
    output: null,
    cache_read: null,
    cache_write: null,
    reasoning: null,
  };
  const overflow = new Set<TokenFieldName>(priorOverflow);
  for (const row of rows) {
    for (const name of TOKEN_FIELD_NAMES) {
      const value = row[name];
      if (value !== null && !overflow.has(name)) {
        const next = (sums[name] ?? 0) + value;
        if (!Number.isSafeInteger(next) || next < 0) {
          overflow.add(name);
        } else {
          sums[name] = next;
        }
      }
    }
  }
  for (const name of overflow) sums[name] = null;
  return { fields: sums, overflow_fields: TOKEN_FIELD_NAMES.filter((name) => overflow.has(name)) };
}

export interface PriceEntry {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
}

export const PRICE_CATALOG_2026_06_01: Record<string, PriceEntry> = {
  "codex-fixture-model": {
    input: 2.0,
    output: 8.0,
    cache_read: 0.5,
    cache_write: 2.0,
    reasoning: 8.0,
  },
  "claude-fixture-model": {
    input: 3.0,
    output: 15.0,
    cache_read: 0.3,
    cache_write: 3.75,
    reasoning: 15.0,
  },
};

export const PRICE_CATALOG_2026_09_01: Record<string, PriceEntry> = {
  "codex-fixture-model": {
    input: 1.5,
    output: 6.0,
    cache_read: 0.4,
    cache_write: 1.5,
    reasoning: 6.0,
  },
  "claude-fixture-model": {
    input: 3.0,
    output: 15.0,
    cache_read: 0.3,
    cache_write: 3.75,
    reasoning: 15.0,
  },
  "grok-fixture-model": {
    input: 2.0,
    output: 10.0,
    cache_read: 0.5,
    cache_write: 2.0,
    reasoning: 10.0,
  },
};

export const PRICE_CATALOGS: Record<string, Record<string, PriceEntry>> = {
  "2026-06-01": PRICE_CATALOG_2026_06_01,
  "2026-09-01": PRICE_CATALOG_2026_09_01,
};

export const CURRENT_PRICE_CATALOG_VERSION = "2026-09-01";

export interface CostCalculation {
  amount_usd: number | null;
  catalog_version: string;
  calculated_at: string;
  reason: string | null;
}

/**
 * Derives an optional cost from immutable token facts. Unknown models yield
 * a null amount instead of another model's price; token rows never store money.
 */
export function calculateCost(
  tokens: TokenFields,
  model: string | null,
  catalogVersion: string,
  calculatedAt: string,
): CostCalculation {
  const catalog = PRICE_CATALOGS[catalogVersion];
  if (!catalog) {
    throw new DomainError("invalid_argument", "price catalog version is unknown");
  }
  if (!model || !catalog[model]) {
    return {
      amount_usd: null,
      catalog_version: catalogVersion,
      calculated_at: calculatedAt,
      reason: "unknown_model",
    };
  }
  const entry = catalog[model] as PriceEntry;
  let amount = 0;
  const pairs = [
    [tokens.input, entry.input],
    [tokens.output, entry.output],
    [tokens.cache_read, entry.cache_read],
    [tokens.cache_write, entry.cache_write],
    [tokens.reasoning, entry.reasoning],
  ] as const;
  for (const [count, rate] of pairs) {
    if (count !== null) {
      amount += (count / 1_000_000) * rate;
    }
  }
  return {
    amount_usd: Math.round(amount * 1_000_000) / 1_000_000,
    catalog_version: catalogVersion,
    calculated_at: calculatedAt,
    reason: null,
  };
}

export interface TokenObservation {
  observation_id: string;
  run_id: string;
  run_execution_id: string;
  provider: MeasurementProvider;
  model: string | null;
  tokens: TokenFields;
  quality: TokenQuality;
  provenance: MeasurementProvenance;
  occurred_at: string;
  committed_at: string;
}

export interface ReportedInterval {
  observation_id: string;
  run_id: string;
  run_execution_id: string;
  interval_kind: ReportedIntervalKind;
  started_at: string;
  ended_at: string;
  provenance: MeasurementProvenance;
  occurred_at: string;
  committed_at: string;
}

export interface ReviewTimerRecord {
  id: string;
  task_id: string;
  run_id: string | null;
  started_by_human_id: string;
  started_at: string;
  stopped_at: string | null;
  state: "open" | "stopped";
  resource_version: number;
}

export interface ReviewTimerObservation {
  observation_id: string;
  timer_id: string;
  observed_kind: "started" | "stopped";
  actor_type: "human";
  actor_id: string;
  occurred_at: string;
}

export interface BrowserActivityObservation {
  observation_id: string;
  human_id: string;
  task_id: string | null;
  started_at: string;
  ended_at: string;
  capped: boolean;
  provenance: "human_observed";
  occurred_at: string;
}

function observedAt(value: unknown, now: string): string {
  if (value === undefined || value === null) {
    return now;
  }
  if (typeof value !== "string") {
    throw new DomainError("invalid_argument", "observed time is invalid");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new DomainError("invalid_argument", "observed time is invalid");
  }
  if (parsed - Date.parse(now) > MEASUREMENT_FUTURE_TOLERANCE_MS) {
    throw new DomainError("invalid_argument", "observed time is in the future");
  }
  return value;
}

function observationId(value: unknown): string {
  if (value === undefined || value === null) {
    return randomUlid();
  }
  if (typeof value !== "string" || !isUlid(value)) {
    throw new DomainError("invalid_argument", "observation id is invalid");
  }
  return value;
}

function modelName(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new DomainError("invalid_argument", "model is invalid");
  }
  const normalized = value.trim();
  if (
    !normalized ||
    [...normalized].length > 128 ||
    [...normalized].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new DomainError("invalid_argument", "model is invalid");
  }
  return normalized;
}

interface ExecutionBinding {
  runner_id: string;
  project_id: string;
  task_id: string;
  run_id: string;
  provider: MeasurementProvider;
}

async function requireExecutionBinding(
  db: SqlDatabase,
  workspaceId: string,
  principal: RunnerPrincipal,
  runId: string,
  executionId: string,
  generation: unknown,
): Promise<ExecutionBinding> {
  if (!Number.isSafeInteger(generation) || Number(generation) < 1) {
    rejectRunnerRequest();
  }
  const binding = (await db
    .prepare(
      `SELECT a.runner_id, a.project_id, a.task_id, a.run_id, l.id AS launch_id
       FROM execution_assignments AS a
       JOIN launch_commands AS l ON l.workspace_id = a.workspace_id AND l.execution_id = a.execution_id
       WHERE a.workspace_id = ? AND a.execution_id = ? AND a.assignment_generation = ?`,
    )
    .get(workspaceId, executionId, Number(generation))) as
    (Omit<ExecutionBinding, "provider"> & { launch_id: string }) | undefined;
  if (!binding || binding.runner_id !== principal.runnerId || binding.run_id !== runId) {
    rejectRunnerRequest();
  }
  if (!principal.projectIds.includes(binding.project_id)) {
    rejectRunnerRequest();
  }
  const provider = snapshotOf(await readLaunch(db, workspaceId, binding.launch_id)).execution_config
    .provider;
  return { ...binding, provider: provider as MeasurementProvider };
}

function measurementFingerprint(input: unknown): string {
  const body = { ...(input as Record<string, unknown>) };
  delete body.principal;
  if (Object.hasOwn(body, "tokens")) body.tokens = normalizeTokenFields(body.tokens);
  return runnerHash(canonicalLaunchJson(JSON.parse(JSON.stringify(body))));
}

async function authorizeRunnerMeasurement(
  input: ReportTokensInput | ReportIntervalInput,
  ctx: HubContext,
) {
  const principal = await launchRunner(ctx, input.principal);
  const binding = await requireExecutionBinding(
    ctx.db,
    ctx.workspaceId,
    principal,
    runnerId(input.runId),
    runnerId(input.executionId),
    input.assignmentGeneration,
  );
  if ("provider" in input && input.provider !== binding.provider) rejectRunnerRequest();
}

function tokenRowToObservation(row: Record<string, unknown>): TokenObservation {
  return {
    observation_id: String(row.observation_id),
    run_id: String(row.run_id),
    run_execution_id: String(row.run_execution_id),
    provider: String(row.provider) as MeasurementProvider,
    model: (row.model as string | null) ?? null,
    tokens: {
      input: (row.input_tokens as number | null) ?? null,
      output: (row.output_tokens as number | null) ?? null,
      cache_read: (row.cache_read_tokens as number | null) ?? null,
      cache_write: (row.cache_write_tokens as number | null) ?? null,
      reasoning: (row.reasoning_tokens as number | null) ?? null,
    },
    quality: String(row.quality) as TokenQuality,
    provenance: String(row.provenance) as MeasurementProvenance,
    occurred_at: String(row.occurred_at),
    committed_at: String(row.committed_at),
  };
}

export interface ReportTokensInput {
  principal: RunnerPrincipal;
  observationId?: string;
  runId: string;
  executionId: string;
  assignmentGeneration: number;
  provider: MeasurementProvider;
  model?: string;
  tokens: unknown;
  quality: TokenQuality;
  provenance?: MeasurementProvenance;
  occurredAt?: string;
}

export const reportTokensCommand: HubCommand<ReportTokensInput, TokenObservation> = {
  name: "token.report",
  authorize: authorizeRunnerMeasurement,
  inputFingerprint: measurementFingerprint,
  auditResult: (result) => ({
    observation_id: result.observation_id,
    run_id: result.run_id,
    run_execution_id: result.run_execution_id,
    provider: result.provider,
    quality: result.quality,
  }),
  auditInput: (input) => ({
    runId: (input as ReportTokensInput)?.runId,
    executionId: (input as ReportTokensInput)?.executionId,
    provider: (input as ReportTokensInput)?.provider,
    quality: (input as ReportTokensInput)?.quality,
  }),
  async run(raw, ctx) {
    const body = runnerObject(raw as unknown, [
      "principal",
      "observationId",
      "runId",
      "executionId",
      "assignmentGeneration",
      "provider",
      "model",
      "tokens",
      "quality",
      "provenance",
      "occurredAt",
    ]);
    const principal = await launchRunner(ctx, body.principal as RunnerPrincipal);
    const runId = runnerId(body.runId);
    const executionId = runnerId(body.executionId);
    const binding = await requireExecutionBinding(
      ctx.db,
      ctx.workspaceId,
      principal,
      runId,
      executionId,
      body.assignmentGeneration,
    );
    if (
      typeof body.provider !== "string" ||
      !MEASUREMENT_PROVIDERS.includes(body.provider as MeasurementProvider) ||
      body.provider !== binding.provider
    ) {
      rejectRunnerRequest();
    }
    if (
      typeof body.quality !== "string" ||
      !TOKEN_QUALITIES.includes(body.quality as TokenQuality)
    ) {
      rejectRunnerRequest();
    }
    const quality = body.quality as TokenQuality;
    const provenanceRaw = body.provenance ?? "runner_observed";
    if (
      typeof provenanceRaw !== "string" ||
      !MEASUREMENT_PROVENANCES.includes(provenanceRaw as MeasurementProvenance)
    ) {
      rejectRunnerRequest();
    }
    let fields: TokenFields;
    try {
      fields = normalizeTokenFields(body.tokens);
    } catch {
      rejectRunnerRequest();
    }
    const present = tokenFieldsPresent(fields!);
    if (quality === "unavailable" ? present : !present) {
      rejectRunnerRequest();
    }
    let id: string;
    try {
      id = observationId(body.observationId);
    } catch {
      rejectRunnerRequest();
    }
    const model = modelName(body.model);
    const occurredAt = observedAt(body.occurredAt, ctx.now);
    const existing = (await ctx.db
      .prepare(`SELECT * FROM token_observations WHERE workspace_id = ? AND observation_id = ?`)
      .get(ctx.workspaceId, id)) as Record<string, unknown> | undefined;
    if (existing) {
      const stored = tokenRowToObservation(existing);
      const identical =
        stored.run_id === runId &&
        stored.run_execution_id === executionId &&
        stored.provider === body.provider &&
        stored.model === (model ?? null) &&
        stored.quality === quality &&
        stored.provenance === provenanceRaw &&
        TOKEN_FIELD_NAMES.every((name) => stored.tokens[name] === fields![name]) &&
        (body.occurredAt === undefined || stored.occurred_at === occurredAt);
      if (!identical) {
        throw new DomainError("conflict", "observation id is bound to another report");
      }
      return stored;
    }
    const observation: TokenObservation = {
      observation_id: id,
      run_id: runId,
      run_execution_id: executionId,
      provider: body.provider as MeasurementProvider,
      model: model ?? null,
      tokens: fields!,
      quality,
      provenance: provenanceRaw as MeasurementProvenance,
      occurred_at: occurredAt,
      committed_at: ctx.now,
    };
    await persistTokenObservation(ctx.db, ctx.workspaceId, observation);
    return observation;
  },
};

export interface ReportIntervalInput {
  principal: RunnerPrincipal;
  observationId?: string;
  runId: string;
  executionId: string;
  assignmentGeneration: number;
  intervalKind: ReportedIntervalKind;
  startedAt: string;
  endedAt: string;
  provenance?: MeasurementProvenance;
  occurredAt?: string;
}

function intervalRowToReported(row: Record<string, unknown>): ReportedInterval {
  return {
    observation_id: String(row.observation_id),
    run_id: String(row.run_id),
    run_execution_id: String(row.run_execution_id),
    interval_kind: String(row.interval_kind) as ReportedIntervalKind,
    started_at: String(row.started_at),
    ended_at: String(row.ended_at),
    provenance: String(row.provenance) as MeasurementProvenance,
    occurred_at: String(row.occurred_at),
    committed_at: String(row.committed_at),
  };
}

export const reportIntervalCommand: HubCommand<ReportIntervalInput, ReportedInterval> = {
  name: "interval.report",
  authorize: authorizeRunnerMeasurement,
  inputFingerprint: measurementFingerprint,
  auditInput: (input) => ({
    runId: (input as ReportIntervalInput)?.runId,
    executionId: (input as ReportIntervalInput)?.executionId,
    intervalKind: (input as ReportIntervalInput)?.intervalKind,
  }),
  async run(raw, ctx) {
    const body = runnerObject(raw as unknown, [
      "principal",
      "observationId",
      "runId",
      "executionId",
      "assignmentGeneration",
      "intervalKind",
      "startedAt",
      "endedAt",
      "provenance",
      "occurredAt",
    ]);
    const principal = await launchRunner(ctx, body.principal as RunnerPrincipal);
    const runId = runnerId(body.runId);
    const executionId = runnerId(body.executionId);
    await requireExecutionBinding(
      ctx.db,
      ctx.workspaceId,
      principal,
      runId,
      executionId,
      body.assignmentGeneration,
    );
    if (
      typeof body.intervalKind !== "string" ||
      !REPORTED_INTERVAL_KINDS.includes(body.intervalKind as ReportedIntervalKind)
    ) {
      rejectRunnerRequest();
    }
    const provenanceRaw = body.provenance ?? "runner_observed";
    if (
      typeof provenanceRaw !== "string" ||
      !MEASUREMENT_PROVENANCES.includes(provenanceRaw as MeasurementProvenance)
    ) {
      rejectRunnerRequest();
    }
    if (typeof body.startedAt !== "string" || typeof body.endedAt !== "string") {
      rejectRunnerRequest();
    }
    const start = Date.parse(body.startedAt as string);
    const end = Date.parse(body.endedAt as string);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      rejectRunnerRequest();
    }
    let id: string;
    try {
      id = observationId(body.observationId);
    } catch {
      rejectRunnerRequest();
    }
    const occurredAt = observedAt(body.occurredAt, ctx.now);
    const existing = (await ctx.db
      .prepare(`SELECT * FROM measurement_intervals WHERE workspace_id = ? AND observation_id = ?`)
      .get(ctx.workspaceId, id)) as Record<string, unknown> | undefined;
    if (existing) {
      const stored = intervalRowToReported(existing);
      const identical =
        stored.run_id === runId &&
        stored.run_execution_id === executionId &&
        stored.interval_kind === body.intervalKind &&
        stored.started_at === body.startedAt &&
        stored.ended_at === body.endedAt &&
        stored.provenance === provenanceRaw &&
        (body.occurredAt === undefined || stored.occurred_at === occurredAt);
      if (!identical) {
        throw new DomainError("conflict", "observation id is bound to another interval");
      }
      return stored;
    }
    await ctx.db
      .prepare(
        `INSERT INTO measurement_intervals
         (workspace_id, observation_id, run_id, run_execution_id, interval_kind,
          started_at, ended_at, provenance, occurred_at, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        id,
        runId,
        executionId,
        body.intervalKind as string,
        body.startedAt as string,
        body.endedAt as string,
        provenanceRaw as string,
        occurredAt,
        ctx.now,
      );
    return {
      observation_id: id,
      run_id: runId,
      run_execution_id: executionId,
      interval_kind: body.intervalKind as ReportedIntervalKind,
      started_at: body.startedAt as string,
      ended_at: body.endedAt as string,
      provenance: provenanceRaw as MeasurementProvenance,
      occurred_at: occurredAt,
      committed_at: ctx.now,
    };
  },
};

function timerRowToRecord(row: Record<string, unknown>): ReviewTimerRecord {
  return {
    id: String(row.id),
    task_id: String(row.task_id),
    run_id: (row.run_id as string | null) ?? null,
    started_by_human_id: String(row.started_by_human_id),
    started_at: String(row.started_at),
    stopped_at: (row.stopped_at as string | null) ?? null,
    state: row.state as "open" | "stopped",
    resource_version: Number(row.resource_version),
  };
}

async function requireMeasurementHuman(ctx: HubContext) {
  if (!ctx.actorHumanId || ctx.actorDelegationId || ctx.actorRunnerId || ctx.actorSystemId) {
    throw new DomainError("forbidden", "direct authorized human required");
  }
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertEpoch(principal, ctx.authorizationEpoch);
  assertRole(principal, ["owner", "member", "reviewer"]);
  return principal;
}

async function requireTaskProject(
  db: SqlDatabase,
  workspaceId: string,
  principal: Awaited<ReturnType<typeof loadPrincipal>>,
  taskId: string,
): Promise<{ project_id: string }> {
  if (!isUlid(taskId)) {
    throw new DomainError("not_found", "task not found");
  }
  const row = (await db
    .prepare(`SELECT project_id FROM tasks WHERE workspace_id = ? AND id = ?`)
    .get(workspaceId, taskId)) as { project_id: string } | undefined;
  if (!row) {
    throw new DomainError("not_found", "task not found");
  }
  assertProjectAccess(principal, row.project_id);
  return row;
}

export interface StartReviewTimerInput {
  taskId: string;
  runId?: string;
}

export const startReviewTimerCommand: HubCommand<StartReviewTimerInput, ReviewTimerRecord> = {
  name: "review_timer.start",
  async authorize(input, ctx) {
    const principal = await requireMeasurementHuman(ctx);
    await requireTaskProject(ctx.db, ctx.workspaceId, principal, input.taskId);
    if (input.runId !== undefined && input.runId !== null) {
      const run = (await ctx.db
        .prepare("SELECT task_id FROM runs WHERE workspace_id = ? AND id = ?")
        .get(ctx.workspaceId, input.runId)) as { task_id: string } | undefined;
      if (!run || run.task_id !== input.taskId)
        throw new DomainError("not_found", "run not found for this task");
    }
  },
  inputFingerprint: measurementFingerprint,
  auditInput: (input) => ({
    taskId: (input as StartReviewTimerInput)?.taskId,
    runId: (input as StartReviewTimerInput)?.runId,
  }),
  async run(input, ctx) {
    const principal = await requireMeasurementHuman(ctx);
    const body = (input ?? {}) as Partial<StartReviewTimerInput>;
    if (typeof body.taskId !== "string") {
      throw new DomainError("invalid_argument", "task id is invalid");
    }
    await requireTaskProject(ctx.db, ctx.workspaceId, principal, body.taskId);
    let runId: string | null = null;
    if (body.runId !== undefined && body.runId !== null) {
      if (typeof body.runId !== "string" || !isUlid(body.runId)) {
        throw new DomainError("invalid_argument", "run id is invalid");
      }
      const run = (await ctx.db
        .prepare(`SELECT task_id FROM runs WHERE workspace_id = ? AND id = ?`)
        .get(ctx.workspaceId, body.runId)) as { task_id: string } | undefined;
      if (!run || run.task_id !== body.taskId) {
        throw new DomainError("not_found", "run not found for this task");
      }
      runId = body.runId;
    }
    const open = (await ctx.db
      .prepare(
        `SELECT id FROM review_timers
         WHERE workspace_id = ? AND task_id = ? AND started_by_human_id = ? AND state = 'open'`,
      )
      .get(ctx.workspaceId, body.taskId, ctx.actorHumanId as string)) as { id: string } | undefined;
    if (open) {
      throw new DomainError("timer_open", "a review timer is already open for this task");
    }
    const id = randomUlid();
    const observationIdValue = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO review_timers
         (workspace_id, id, task_id, run_id, started_by_human_id, started_at,
          stopped_at, state, resource_version)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'open', 1)`,
      )
      .run(ctx.workspaceId, id, body.taskId, runId, ctx.actorHumanId as string, ctx.now);
    await ctx.db
      .prepare(
        `INSERT INTO review_timer_observations
         (workspace_id, observation_id, timer_id, observed_kind, actor_type, actor_id, occurred_at)
         VALUES (?, ?, ?, 'started', 'human', ?, ?)`,
      )
      .run(ctx.workspaceId, observationIdValue, id, ctx.actorHumanId as string, ctx.now);
    return {
      id,
      task_id: body.taskId,
      run_id: runId,
      started_by_human_id: ctx.actorHumanId as string,
      started_at: ctx.now,
      stopped_at: null,
      state: "open" as const,
      resource_version: 1,
    };
  },
};

export interface StopReviewTimerInput {
  timerId: string;
  expectedVersion: number;
}

export const stopReviewTimerCommand: HubCommand<StopReviewTimerInput, ReviewTimerRecord> = {
  name: "review_timer.stop",
  async authorize(input, ctx) {
    const principal = await requireMeasurementHuman(ctx);
    const row = (await ctx.db
      .prepare(
        "SELECT task_id, started_by_human_id FROM review_timers WHERE workspace_id = ? AND id = ?",
      )
      .get(ctx.workspaceId, input.timerId)) as
      { task_id: string; started_by_human_id: string } | undefined;
    if (!row) throw new DomainError("not_found", "review timer not found");
    await requireTaskProject(ctx.db, ctx.workspaceId, principal, row.task_id);
    if (row.started_by_human_id !== ctx.actorHumanId)
      throw new DomainError("forbidden", "only the starting reviewer can stop this timer");
  },
  inputFingerprint: measurementFingerprint,
  auditInput: (input) => ({
    timerId: (input as StopReviewTimerInput)?.timerId,
    expectedVersion: (input as StopReviewTimerInput)?.expectedVersion,
  }),
  async run(input, ctx) {
    const principal = await requireMeasurementHuman(ctx);
    const body = (input ?? {}) as Partial<StopReviewTimerInput>;
    if (typeof body.timerId !== "string" || !isUlid(body.timerId)) {
      throw new DomainError("not_found", "review timer not found");
    }
    if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
      throw new DomainError("invalid_argument", "expected timer version is invalid");
    }
    const row = (await ctx.db
      .prepare(`SELECT * FROM review_timers WHERE workspace_id = ? AND id = ?`)
      .get(ctx.workspaceId, body.timerId)) as Record<string, unknown> | undefined;
    if (!row) {
      throw new DomainError("not_found", "review timer not found");
    }
    const record = timerRowToRecord(row);
    await requireTaskProject(ctx.db, ctx.workspaceId, principal, record.task_id);
    if (record.started_by_human_id !== ctx.actorHumanId) {
      throw new DomainError("forbidden", "only the starting reviewer can stop this timer");
    }
    if (record.state !== "open") {
      throw new DomainError("invalid_transition", "review timer is already stopped");
    }
    if (record.resource_version !== Number(body.expectedVersion)) {
      throw new DomainError("stale_version", "review timer version conflict");
    }
    const next = record.resource_version + 1;
    await ctx.db
      .prepare(
        `UPDATE review_timers
         SET state = 'stopped', stopped_at = ?, resource_version = ?
         WHERE workspace_id = ? AND id = ? AND state = 'open' AND resource_version = ?`,
      )
      .run(ctx.now, next, ctx.workspaceId, record.id, record.resource_version);
    await ctx.db
      .prepare(
        `INSERT INTO review_timer_observations
         (workspace_id, observation_id, timer_id, observed_kind, actor_type, actor_id, occurred_at)
         VALUES (?, ?, ?, 'stopped', 'human', ?, ?)`,
      )
      .run(ctx.workspaceId, randomUlid(), record.id, ctx.actorHumanId as string, ctx.now);
    return { ...record, state: "stopped" as const, stopped_at: ctx.now, resource_version: next };
  },
};

export interface RecordBrowserActivityInput {
  observationId?: string;
  taskId?: string;
  startedAt: string;
  endedAt: string;
}

export const recordBrowserActivityCommand: HubCommand<
  RecordBrowserActivityInput,
  BrowserActivityObservation
> = {
  name: "browser_activity.record",
  async authorize(input, ctx) {
    const principal = await requireMeasurementHuman(ctx);
    if (input.taskId !== undefined && input.taskId !== null) {
      await requireTaskProject(ctx.db, ctx.workspaceId, principal, input.taskId);
    }
  },
  inputFingerprint: measurementFingerprint,
  auditInput: (input) => ({
    taskId: (input as RecordBrowserActivityInput)?.taskId,
  }),
  async run(input, ctx) {
    const principal = await requireMeasurementHuman(ctx);
    const body = (input ?? {}) as Partial<RecordBrowserActivityInput>;
    if (typeof body.startedAt !== "string" || typeof body.endedAt !== "string") {
      throw new DomainError("invalid_argument", "browser activity interval is invalid");
    }
    const start = Date.parse(body.startedAt);
    const end = Date.parse(body.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new DomainError("invalid_argument", "browser activity interval is invalid");
    }
    if (start - Date.parse(ctx.now) > MEASUREMENT_FUTURE_TOLERANCE_MS) {
      throw new DomainError("invalid_argument", "browser activity starts in the future");
    }
    let taskId: string | null = null;
    if (body.taskId !== undefined && body.taskId !== null) {
      if (typeof body.taskId !== "string") {
        throw new DomainError("invalid_argument", "task id is invalid");
      }
      await requireTaskProject(ctx.db, ctx.workspaceId, principal, body.taskId);
      taskId = body.taskId;
    }
    const capped = end - start > BROWSER_ACTIVITY_CAP_MS;
    const storedEnd = capped
      ? new Date(start + BROWSER_ACTIVITY_CAP_MS).toISOString()
      : body.endedAt;
    let id: string;
    try {
      id = observationId(body.observationId);
    } catch {
      throw new DomainError("invalid_argument", "observation id is invalid");
    }
    const existing = (await ctx.db
      .prepare(
        `SELECT observation_id, human_id, task_id, started_at, ended_at, capped, provenance
         FROM browser_activity_observations WHERE workspace_id = ? AND observation_id = ?`,
      )
      .get(ctx.workspaceId, id)) as Record<string, unknown> | undefined;
    if (existing) {
      const identical =
        String(existing.human_id) === ctx.actorHumanId &&
        ((existing.task_id as string | null) ?? null) === taskId &&
        String(existing.started_at) === body.startedAt &&
        String(existing.ended_at) === storedEnd;
      if (!identical) {
        throw new DomainError("conflict", "observation id is bound to another activity row");
      }
      return {
        observation_id: id,
        human_id: ctx.actorHumanId as string,
        task_id: taskId,
        started_at: body.startedAt,
        ended_at: storedEnd,
        capped: Number(existing.capped) === 1,
        provenance: "human_observed" as const,
        occurred_at: ctx.now,
      };
    }
    await ctx.db
      .prepare(
        `INSERT INTO browser_activity_observations
         (workspace_id, observation_id, human_id, task_id, started_at, ended_at,
          capped, provenance, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'human_observed', ?)`,
      )
      .run(
        ctx.workspaceId,
        id,
        ctx.actorHumanId as string,
        taskId,
        body.startedAt,
        storedEnd,
        capped ? 1 : 0,
        ctx.now,
      );
    return {
      observation_id: id,
      human_id: ctx.actorHumanId as string,
      task_id: taskId,
      started_at: body.startedAt,
      ended_at: storedEnd,
      capped,
      provenance: "human_observed" as const,
      occurred_at: ctx.now,
    };
  },
};

export async function listTokenObservations(
  db: SqlDatabase,
  workspaceId: string,
  runId: string,
): Promise<TokenObservation[]> {
  const rows = (await db
    .prepare(
      `SELECT * FROM token_observations
       WHERE workspace_id = ? AND run_id = ?
       ORDER BY occurred_at ASC, observation_id ASC`,
    )
    .all(workspaceId, runId)) as Record<string, unknown>[];
  return rows.map(tokenRowToObservation);
}

export async function listMeasurementIntervals(
  db: SqlDatabase,
  workspaceId: string,
  runId: string,
): Promise<ReportedInterval[]> {
  const rows = (await db
    .prepare(
      `SELECT * FROM measurement_intervals
       WHERE workspace_id = ? AND run_id = ?
       ORDER BY started_at ASC, observation_id ASC`,
    )
    .all(workspaceId, runId)) as Record<string, unknown>[];
  return rows.map(intervalRowToReported);
}

export async function listReviewTimers(
  db: SqlDatabase,
  workspaceId: string,
  taskId: string,
): Promise<ReviewTimerRecord[]> {
  const rows = (await db
    .prepare(
      `SELECT * FROM review_timers
       WHERE workspace_id = ? AND task_id = ?
       ORDER BY started_at ASC, id ASC`,
    )
    .all(workspaceId, taskId)) as Record<string, unknown>[];
  return rows.map(timerRowToRecord);
}

export async function listReviewTimerObservations(
  db: SqlDatabase,
  workspaceId: string,
  timerId: string,
): Promise<ReviewTimerObservation[]> {
  const rows = (await db
    .prepare(
      `SELECT observation_id, timer_id, observed_kind, actor_type, actor_id, occurred_at
       FROM review_timer_observations
       WHERE workspace_id = ? AND timer_id = ?
       ORDER BY occurred_at ASC, observation_id ASC`,
    )
    .all(workspaceId, timerId)) as Array<{
    observation_id: string;
    timer_id: string;
    observed_kind: "started" | "stopped";
    actor_type: "human";
    actor_id: string;
    occurred_at: string;
  }>;
  return rows;
}

export async function listBrowserActivity(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
): Promise<BrowserActivityObservation[]> {
  const rows = (await db
    .prepare(
      `SELECT observation_id, human_id, task_id, started_at, ended_at, capped, provenance
       FROM browser_activity_observations
       WHERE workspace_id = ? AND human_id = ?
       ORDER BY started_at ASC, observation_id ASC`,
    )
    .all(workspaceId, humanId)) as Array<{
    observation_id: string;
    human_id: string;
    task_id: string | null;
    started_at: string;
    ended_at: string;
    capped: number;
    provenance: "human_observed";
  }>;
  return rows.map((row) => ({
    observation_id: row.observation_id,
    human_id: row.human_id,
    task_id: row.task_id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    capped: row.capped === 1,
    provenance: row.provenance,
    occurred_at: row.started_at,
  }));
}

interface LedgerRow {
  event_id: string;
  typed_measurement: number;
  provider_session_id: string | null;
  kind: string;
  occurred_at: string;
  run_execution_id: string;
  workspace_cursor: number;
}

interface AttentionRow {
  id: string;
  kind: string;
  blocking: number;
  state: string;
  requested_at: string;
  first_response_at: string | null;
  answered_at: string | null;
  resolved_at: string | null;
}

function parseMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface AttentionLatency {
  request_id: string;
  kind: string;
  blocking: boolean;
  state: string;
  first_response_ms: number | null;
  resolution_ms: number | null;
  open: boolean;
}

export function deriveAttentionLatency(row: AttentionRow): AttentionLatency {
  const requested = parseMs(row.requested_at);
  const first = row.first_response_at ? parseMs(row.first_response_at) : null;
  const resolvedAt = row.resolved_at ?? row.answered_at;
  const resolved = resolvedAt ? parseMs(resolvedAt) : null;
  return {
    request_id: row.id,
    kind: row.kind,
    blocking: row.blocking === 1,
    state: row.state,
    first_response_ms: requested !== null && first !== null ? first - requested : null,
    resolution_ms: requested !== null && resolved !== null ? resolved - requested : null,
    open: resolved === null,
  };
}

export interface TokenCostEntry {
  model: string | null;
  amount_usd: number | null;
  reason: string | null;
}

export interface TokenSummary {
  exact: TokenFields;
  estimated: TokenFields;
  exact_overflow_fields: TokenFieldName[];
  estimated_overflow_fields: TokenFieldName[];
  unavailable_count: number;
  exact_observation_ids: string[];
  estimated_observation_ids: string[];
  unavailable_observation_ids: string[];
  costs: TokenCostEntry[];
  costs_total_usd: number | null;
  catalog_version: string;
  calculated_at: string;
}

export function summarizeTokens(
  observations: readonly TokenObservation[],
  catalogVersion: string,
  calculatedAt: string,
): TokenSummary {
  const exactRows = observations.filter(
    (row) => row.quality === "provider_reported" || row.quality === "stream_derived",
  );
  const estimatedRows = observations.filter((row) => row.quality === "estimated");
  const unavailable = observations.filter((row) => row.quality === "unavailable");
  const byModel = new Map<string | null, TokenFields[]>();
  for (const row of exactRows) {
    const group = byModel.get(row.model) ?? [];
    group.push(row.tokens);
    byModel.set(row.model, group);
  }
  const costs: TokenCostEntry[] = [...byModel.entries()].map(([model, rows]) => {
    const total = sumTokenFieldsChecked(rows);
    if (total.overflow_fields.length > 0) {
      return { model, amount_usd: null, reason: "counter_overflow" };
    }
    const result = calculateCost(total.fields, model, catalogVersion, calculatedAt);
    return { model, amount_usd: result.amount_usd, reason: result.reason };
  });
  const known = costs.filter((entry) => entry.amount_usd !== null);
  const exact = sumTokenFieldsChecked(exactRows.map((row) => row.tokens));
  const estimated = sumTokenFieldsChecked(estimatedRows.map((row) => row.tokens));
  return {
    exact: exact.fields,
    estimated: estimated.fields,
    exact_overflow_fields: exact.overflow_fields,
    estimated_overflow_fields: estimated.overflow_fields,
    unavailable_count: unavailable.length,
    exact_observation_ids: exactRows.map((row) => row.observation_id),
    estimated_observation_ids: estimatedRows.map((row) => row.observation_id),
    unavailable_observation_ids: unavailable.map((row) => row.observation_id),
    costs,
    costs_total_usd:
      known.length > 0 && known.length === costs.length && exact.overflow_fields.length === 0
        ? known.reduce((sum, entry) => sum + (entry.amount_usd ?? 0), 0)
        : null,
    catalog_version: catalogVersion,
    calculated_at: calculatedAt,
  };
}

export interface RunTimeMeasures {
  launch_latency_ms: number | null;
  launch_latency_reason: string | null;
  process_elapsed_ms: number | null;
  process_alive_ms: number;
  active_ms: number;
  active_quality: "observed" | "includes_legacy_estimates" | "unavailable";
  ambiguous_legacy_events: number;
  attention_wait_ms: number;
  external_wait_ms: number | null;
  idle_ms: number | null;
  offline_ms: number;
  run_age_ms: number;
  run_complete: boolean;
  open_intervals: number;
  live_execution: boolean;
  attention_open: boolean;
}

export interface RunMeasurements {
  run_id: string;
  task_id: string;
  project_id: string;
  provider: string | null;
  result_state: string;
  activity: string;
  times: RunTimeMeasures;
  attention: AttentionLatency[];
  tokens: TokenSummary;
  review: {
    timers: ReviewTimerRecord[];
    stopped_total_ms: number;
    open_ms: number;
  };
  sources: { sources: MeasurementSourceReference[]; has_more: boolean; next_cursor: number };
  provenance: {
    ledger_events: number;
    token_observations: number;
    reported_intervals: number;
    attention_observations: number;
  };
}

// A run may span resumed executions; only immutable launch snapshots name their providers.
const RUN_PROVIDER_SQL = `(SELECT CASE WHEN COUNT(DISTINCT json_extract(snapshot.canonical_json,
  '$.execution_config.provider')) = 1 THEN MIN(json_extract(snapshot.canonical_json,
  '$.execution_config.provider')) END FROM launch_commands AS launch
  JOIN run_configuration_snapshots AS snapshot ON snapshot.workspace_id = launch.workspace_id
    AND snapshot.id = launch.snapshot_id AND snapshot.run_id = launch.run_id
  WHERE launch.workspace_id = r.workspace_id AND launch.run_id = r.id)`;

function mergeMeasurementWindows(windows: readonly IntervalMs[]): IntervalMs[] {
  const sorted = windows
    .filter((row) => row.end >= row.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: IntervalMs[] = [];
  for (const row of sorted) {
    const last = merged.at(-1);
    if (last && row.start <= last.end) last.end = Math.max(last.end, row.end);
    else merged.push({ ...row });
  }
  return merged;
}

/** Derives every separated run measure from committed rows at read time. */
export async function getRunMeasurements(
  db: SqlDatabase,
  workspaceId: string,
  runId: string,
  now: string,
): Promise<RunMeasurements> {
  const nowMs = Date.parse(now);
  const run = (await db
    .prepare(
      `SELECT r.id, r.project_id, r.task_id, r.result_state, r.activity, r.created_at,
              ${RUN_PROVIDER_SQL} AS provider
       FROM runs AS r
       WHERE r.workspace_id = ? AND r.id = ?`,
    )
    .get(workspaceId, runId)) as
    | {
        id: string;
        project_id: string;
        task_id: string;
        result_state: string;
        activity: string;
        created_at: string;
        provider: string | null;
      }
    | undefined;
  if (!run) {
    throw new DomainError("not_found", "run not found");
  }
  const executions = (await db
    .prepare(
      `SELECT id, state, created_at, ended_at FROM run_executions
       WHERE workspace_id = ? AND run_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(workspaceId, runId)) as Array<{
    id: string;
    state: string;
    created_at: string;
    ended_at: string | null;
  }>;
  const commands = (await db
    .prepare(
      `SELECT execution_id, state, created_at, expires_at, cancelled_at
       FROM launch_commands WHERE workspace_id = ? AND run_id = ?
       ORDER BY created_at ASC`,
    )
    .all(workspaceId, runId)) as Array<{
    execution_id: string;
    state: string;
    created_at: string;
    expires_at: string;
    cancelled_at: string | null;
  }>;
  const ledger = (await db
    .prepare(
      `SELECT e.event_id, e.kind, e.occurred_at, e.run_execution_id, e.workspace_cursor, e.provider_session_id,
              CASE WHEN s.event_id IS NULL THEN 0 ELSE 1 END AS typed_measurement
       FROM event_ledger e LEFT JOIN measurement_event_sources s
         ON s.workspace_id = e.workspace_id AND s.event_id = e.event_id
       WHERE e.workspace_id = ? AND e.run_id = ? ORDER BY e.workspace_cursor ASC`,
    )
    .all(workspaceId, runId)) as LedgerRow[];
  const attentionRows = (await db
    .prepare(
      `SELECT id, kind, blocking, state, requested_at, first_response_at, answered_at, resolved_at
       FROM attention_requests WHERE workspace_id = ? AND run_id = ?
       ORDER BY requested_at ASC, id ASC`,
    )
    .all(workspaceId, runId)) as AttentionRow[];
  const attentionCount = (await db
    .prepare(
      `SELECT COUNT(*) AS total FROM attention_observations
       WHERE workspace_id = ? AND attention_id IN
         (SELECT id FROM attention_requests WHERE workspace_id = ? AND run_id = ?)`,
    )
    .get(workspaceId, workspaceId, runId)) as { total: number };
  const tokens = await listTokenObservations(db, workspaceId, runId);
  const activitySources = await listRunMeasurementActivitySources(db, workspaceId, runId);
  const sources = await listRunMeasurementSources(db, workspaceId, runId);
  const reported = await listMeasurementIntervals(db, workspaceId, runId);
  const timers = (await db
    .prepare(`SELECT * FROM review_timers WHERE workspace_id = ? AND run_id = ?`)
    .all(workspaceId, runId)) as Record<string, unknown>[];
  const timerRecords = timers.map(timerRowToRecord);
  const submissions = (await db
    .prepare(
      `SELECT submitted_at FROM result_submissions
       WHERE workspace_id = ? AND run_id = ? ORDER BY submitted_at DESC LIMIT 1`,
    )
    .get(workspaceId, runId)) as { submitted_at: string } | undefined;
  const review = (await db
    .prepare(
      `SELECT created_at FROM result_reviews
       WHERE workspace_id = ? AND run_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(workspaceId, runId)) as { created_at: string } | undefined;

  const byExecution = new Map<string, LedgerRow[]>();
  for (const row of ledger) {
    const group = byExecution.get(row.run_execution_id) ?? [];
    group.push(row);
    byExecution.set(row.run_execution_id, group);
  }

  const attachSpans: IntervalMs[] = [];
  const processWindows = new Map<string, IntervalMs[]>();
  let liveExecution = false;
  for (const execution of executions) {
    const rows = (byExecution.get(execution.id) ?? [])
      .map((row) => ({ kind: row.kind, at: parseMs(row.occurred_at) }))
      .filter((row) => row.at !== null) as Array<{ kind: string; at: number }>;
    const created = parseMs(execution.created_at);
    if (created === null) continue;
    const end = Math.min(
      nowMs,
      execution.ended_at ? (parseMs(execution.ended_at) ?? created) : nowMs,
    );
    const attaches = rows
      .filter((row) => row.kind === "execution_attached" && row.at <= end)
      .map((row) => Math.max(created, row.at));
    const attach = attaches.length > 0 ? Math.min(...attaches) : null;
    const explicit = reported
      .filter(
        (row) => row.run_execution_id === execution.id && row.interval_kind === "process_alive",
      )
      .map((row) => ({ start: Date.parse(row.started_at), end: Date.parse(row.ended_at) }));
    const windows = clipIntervals(explicit, { start: created, end });
    if (attach !== null && end >= attach) {
      windows.push({ start: attach, end });
      liveExecution ||= execution.state !== "ended";
    }
    const merged = mergeMeasurementWindows(windows);
    processWindows.set(execution.id, merged);
    attachSpans.push(...merged);
  }

  const elapsedStart =
    attachSpans.length > 0 ? Math.min(...attachSpans.map((span) => span.start)) : null;
  const elapsedEnd =
    attachSpans.length > 0 ? Math.max(...attachSpans.map((span) => span.end)) : null;
  const alive = unionIntervalsMs(attachSpans);
  const clipToProcess = (executionId: string, spans: readonly IntervalMs[]) =>
    (processWindows.get(executionId) ?? []).flatMap((window) => clipIntervals(spans, window));

  const pairedActive: IntervalMs[] = [];
  let openIntervals = 0;
  let legacyPairs = 0;
  let ambiguousLegacyEvents = 0;
  const identified = new Map<string, { execution: string; start?: number; end?: number }>();
  for (const source of activitySources) {
    const at = parseMs(source.occurred_at);
    if (at === null || at > nowMs) continue;
    const key = JSON.stringify([
      source.run_execution_id,
      source.assignment_generation,
      source.provider_session_id,
      source.family,
      source.activity_id,
    ]);
    const pair = identified.get(key) ?? { execution: source.run_execution_id };
    pair[source.phase] = at;
    identified.set(key, pair);
  }
  for (const pair of identified.values()) {
    if (pair.start !== undefined && pair.end !== undefined && pair.end >= pair.start) {
      pairedActive.push(...clipToProcess(pair.execution, [{ start: pair.start, end: pair.end }]));
    } else {
      openIntervals += 1;
    }
  }
  const legacyGroups = new Map<string, { executionId: string; rows: LedgerRow[] }>();
  for (const row of ledger) {
    if (row.typed_measurement !== 0) continue;
    const key = JSON.stringify([row.run_execution_id, row.provider_session_id]);
    const group = legacyGroups.get(key) ?? { executionId: row.run_execution_id, rows: [] };
    group.rows.push(row);
    legacyGroups.set(key, group);
  }
  for (const { executionId, rows } of legacyGroups.values()) {
    const ordered = rows
      .map((row) => ({ kind: row.kind, at: parseMs(row.occurred_at) }))
      .filter((row) => row.at !== null && row.at <= nowMs)
      .sort((a, b) => (a.at as number) - (b.at as number)) as Array<{ kind: string; at: number }>;
    const openTurns: number[] = [];
    const openTools: number[] = [];
    let ambiguousTurns = false;
    let ambiguousTools = false;
    for (const row of ordered) {
      if (row.kind === "turn_started") {
        if (openTurns.length > 0) ambiguousLegacyEvents += 1;
        ambiguousTurns ||= openTurns.length > 0;
        openTurns.push(row.at);
      } else if (row.kind === "turn_stopped" || row.kind === "turn_failed") {
        const start = openTurns.shift();
        if (start !== undefined && row.at >= start && !ambiguousTurns) {
          const spans = clipToProcess(executionId, [{ start, end: row.at }]);
          pairedActive.push(...spans);
          if (spans.length > 0) legacyPairs += 1;
        }
        if (openTurns.length === 0) ambiguousTurns = false;
      } else if (row.kind === "tool_started") {
        if (openTools.length > 0) ambiguousLegacyEvents += 1;
        ambiguousTools ||= openTools.length > 0;
        openTools.push(row.at);
      } else if (row.kind === "tool_finished" || row.kind === "tool_failed") {
        const start = openTools.shift();
        if (start !== undefined && row.at >= start && !ambiguousTools) {
          const spans = clipToProcess(executionId, [{ start, end: row.at }]);
          pairedActive.push(...spans);
          if (spans.length > 0) legacyPairs += 1;
        }
        if (openTools.length === 0) ambiguousTools = false;
      }
    }
    openIntervals += openTurns.length + openTools.length;
  }
  const reportedByKind = (kind: ReportedIntervalKind): IntervalMs[] =>
    reported
      .filter((row) => row.interval_kind === kind)
      .flatMap((row) =>
        clipToProcess(row.run_execution_id, [
          { start: Date.parse(row.started_at), end: Date.parse(row.ended_at) },
        ]),
      );
  const reportedActive = reportedByKind("active");
  const active = unionIntervalsMs([...pairedActive, ...reportedActive]);

  const waitSpans: IntervalMs[] = [];
  let attentionOpen = false;
  const attention = attentionRows.map((row) => {
    const latency = deriveAttentionLatency(row);
    if (row.blocking === 1) {
      const requested = parseMs(row.requested_at);
      const end = row.answered_at ?? row.resolved_at ?? null;
      const endMs = end ? parseMs(end) : nowMs;
      if (requested !== null && endMs !== null && endMs >= requested) {
        waitSpans.push({ start: requested, end: endMs });
      }
      if (end === null) {
        attentionOpen = true;
      }
    }
    return latency;
  });
  const attentionWait = unionIntervalsMs(waitSpans);

  const externalUnion = unionIntervalsMs(reportedByKind("external_wait"));
  const idleUnion = unionIntervalsMs(reportedByKind("idle"));

  let offlineMs = 0;
  for (const [executionId, windows] of processWindows) {
    const heartbeats = (byExecution.get(executionId) ?? [])
      .filter((row) => row.kind === "heartbeat")
      .map((row) => parseMs(row.occurred_at))
      .filter((at): at is number => at !== null)
      .sort((a, b) => a - b);
    for (const window of windows) {
      let cursor = window.start;
      for (const beat of heartbeats.filter((at) => at >= window.start && at <= window.end)) {
        offlineMs += Math.max(0, beat - cursor - HEARTBEAT_STALE_MS);
        cursor = beat;
      }
      offlineMs += Math.max(0, window.end - cursor - HEARTBEAT_STALE_MS);
    }
  }

  let launchLatency: number | null = null;
  let launchReason: string | null = null;
  if (commands.length > 0) {
    const first = commands[0] as {
      execution_id: string;
      state: string;
      created_at: string;
      expires_at: string;
      cancelled_at: string | null;
    };
    const created = parseMs(first.created_at);
    const attachedAt = Math.min(
      ...ledger
        .filter(
          (row) => row.kind === "execution_attached" && row.run_execution_id === first.execution_id,
        )
        .map((row) => parseMs(row.occurred_at) ?? Number.POSITIVE_INFINITY)
        .filter((at) => at <= nowMs && created !== null && at >= created),
    );
    if (created !== null) {
      if (Number.isFinite(attachedAt)) {
        launchLatency = (attachedAt as number) - created;
      } else if (first.cancelled_at) {
        const cancelled = parseMs(first.cancelled_at);
        launchLatency = cancelled !== null ? cancelled - created : null;
        launchReason =
          launchLatency === null ? "cancelled time unreadable" : `launch ${first.state}`;
      } else if (
        first.state === "expired" ||
        nowMs > (parseMs(first.expires_at) ?? Number.POSITIVE_INFINITY)
      ) {
        const expiry = parseMs(first.expires_at);
        launchLatency = expiry !== null ? expiry - created : null;
        launchReason = "launch expired before attach";
      } else {
        launchReason = "launch still pending";
      }
    } else {
      launchReason = "launch creation time unreadable";
    }
  } else {
    launchReason = "no launch command for this run";
  }

  const terminal = ["accepted", "failed", "cancelled"].includes(run.result_state);
  const submittedMs = submissions ? parseMs(submissions.submitted_at) : null;
  const reviewedMs = review ? parseMs(review.created_at) : null;
  const lastEvidence = Math.max(
    submittedMs ?? Number.NEGATIVE_INFINITY,
    reviewedMs ?? Number.NEGATIVE_INFINITY,
  );
  const runAgeMs =
    Number.isFinite(lastEvidence) && (lastEvidence as number) > 0
      ? (lastEvidence as number) - (parseMs(run.created_at) ?? (lastEvidence as number))
      : nowMs - (parseMs(run.created_at) ?? nowMs);

  let stoppedTotal = 0;
  let openMs = 0;
  for (const timer of timerRecords) {
    const started = parseMs(timer.started_at);
    if (started === null) {
      continue;
    }
    if (timer.state === "stopped" && timer.stopped_at) {
      const stopped = parseMs(timer.stopped_at);
      if (stopped !== null && stopped >= started) {
        stoppedTotal += stopped - started;
      }
    } else if (nowMs >= started) {
      openMs += nowMs - started;
    }
  }

  return {
    run_id: runId,
    task_id: run.task_id,
    project_id: run.project_id,
    provider: run.provider,
    result_state: run.result_state,
    activity: run.activity,
    times: {
      launch_latency_ms: launchLatency,
      launch_latency_reason: launchLatency === null ? launchReason : null,
      process_elapsed_ms:
        elapsedStart !== null && elapsedEnd !== null ? elapsedEnd - elapsedStart : null,
      process_alive_ms: alive.total_ms,
      active_ms: active.total_ms,
      active_quality:
        legacyPairs > 0
          ? "includes_legacy_estimates"
          : pairedActive.length + reportedActive.length > 0
            ? "observed"
            : "unavailable",
      ambiguous_legacy_events: ambiguousLegacyEvents,
      attention_wait_ms: attentionWait.total_ms,
      external_wait_ms: externalUnion.observation_count > 0 ? externalUnion.total_ms : null,
      idle_ms: idleUnion.observation_count > 0 ? idleUnion.total_ms : null,
      offline_ms: offlineMs,
      run_age_ms: runAgeMs,
      run_complete: terminal,
      open_intervals: openIntervals,
      live_execution: liveExecution,
      attention_open: attentionOpen,
    },
    attention,
    tokens: summarizeTokens(tokens, CURRENT_PRICE_CATALOG_VERSION, now),
    review: { timers: timerRecords, stopped_total_ms: stoppedTotal, open_ms: openMs },
    sources,
    provenance: {
      ledger_events: ledger.length,
      token_observations: tokens.length,
      reported_intervals: reported.length,
      attention_observations: Number((attentionCount as { total: number }).total),
    },
  };
}

export interface TaskInterventions {
  runs: number;
  restarts: number;
  submission_versions: number;
  reviews_request_changes: number;
  reviews_accept: number;
  attention_by_kind: Record<string, { open: number; answered: number; resolved: number }>;
  launch_blocked: number;
  launch_expired: number;
}

export interface BrowserActivitySummary {
  human_id: string;
  observed_ms: number;
  capped_observations: number;
  quality: "estimated";
}

export interface TaskMeasurements {
  task_id: string;
  project_id: string;
  priority: string;
  runs: RunMeasurements[];
  totals: {
    active_ms: number;
    process_elapsed_ms: number;
    process_alive_ms: number;
    offline_ms: number;
    external_wait_ms: number | null;
    idle_ms: number | null;
    unknown_run_counts: { process: number; active: number; external_wait: number; idle: number };
    legacy_estimated_runs: number;
    attention_wait_ms: number;
    exact_tokens: TokenFields;
    estimated_tokens: TokenFields;
    exact_overflow_fields: TokenFieldName[];
    estimated_overflow_fields: TokenFieldName[];
    unavailable_token_reports: number;
  };
  review: {
    timers: ReviewTimerRecord[];
    stopped_total_ms: number;
    open_ms: number;
  };
  attention: AttentionLatency[];
  interventions: TaskInterventions;
  browser_activity: BrowserActivitySummary[];
}

/** Rolls run-level derivations up to one task without inventing cross-run unions. */
export async function getTaskMeasurements(
  db: SqlDatabase,
  workspaceId: string,
  taskId: string,
  now: string,
): Promise<TaskMeasurements> {
  const nowMs = Date.parse(now);
  const task = (await db
    .prepare(`SELECT id, project_id, priority FROM tasks WHERE workspace_id = ? AND id = ?`)
    .get(workspaceId, taskId)) as { id: string; project_id: string; priority: string } | undefined;
  if (!task) {
    throw new DomainError("not_found", "task not found");
  }
  const runIds = (await db
    .prepare(`SELECT id FROM runs WHERE workspace_id = ? AND task_id = ? ORDER BY id ASC`)
    .all(workspaceId, taskId)) as Array<{ id: string }>;
  const runs: RunMeasurements[] = [];
  for (const row of runIds) {
    runs.push(await getRunMeasurements(db, workspaceId, row.id, now));
  }
  const timers = await listReviewTimers(db, workspaceId, taskId);
  let stoppedTotal = 0;
  let openMs = 0;
  for (const timer of timers) {
    const started = parseMs(timer.started_at);
    if (started === null) {
      continue;
    }
    if (timer.state === "stopped" && timer.stopped_at) {
      const stopped = parseMs(timer.stopped_at);
      if (stopped !== null && stopped >= started) {
        stoppedTotal += stopped - started;
      }
    } else if (nowMs >= started) {
      openMs += nowMs - started;
    }
  }
  const requestRows = (await db
    .prepare(
      `SELECT id, kind, blocking, state, requested_at, first_response_at, answered_at, resolved_at
       FROM attention_requests WHERE workspace_id = ? AND task_id = ?
       ORDER BY requested_at ASC, id ASC`,
    )
    .all(workspaceId, taskId)) as AttentionRow[];
  const attention = requestRows.map(deriveAttentionLatency);
  const attentionByKind: TaskInterventions["attention_by_kind"] = {};
  for (const row of requestRows) {
    const entry = attentionByKind[row.kind] ?? { open: 0, answered: 0, resolved: 0 };
    if (row.state === "open") {
      entry.open += 1;
    } else if (row.state === "answered") {
      entry.answered += 1;
    } else {
      entry.resolved += 1;
    }
    attentionByKind[row.kind] = entry;
  }
  const submissionCount = (await db
    .prepare(
      `SELECT COUNT(*) AS total FROM result_submissions
       WHERE workspace_id = ? AND run_id IN (SELECT id FROM runs WHERE workspace_id = ? AND task_id = ?)`,
    )
    .get(workspaceId, workspaceId, taskId)) as { total: number };
  const reviewRows = (await db
    .prepare(
      `SELECT decision, COUNT(*) AS total FROM result_reviews
       WHERE workspace_id = ? AND run_id IN (SELECT id FROM runs WHERE workspace_id = ? AND task_id = ?)
       GROUP BY decision`,
    )
    .all(workspaceId, workspaceId, taskId)) as Array<{ decision: string; total: number }>;
  let requestChanges = 0;
  let accept = 0;
  for (const row of reviewRows) {
    if (row.decision === "request_changes") {
      requestChanges = Number(row.total);
    } else if (row.decision === "accept") {
      accept = Number(row.total);
    }
  }
  const launchRows = (await db
    .prepare(
      `SELECT state, end_reason, COUNT(*) AS total FROM launch_commands
       WHERE workspace_id = ? AND run_id IN (SELECT id FROM runs WHERE workspace_id = ? AND task_id = ?)
       GROUP BY state, end_reason`,
    )
    .all(workspaceId, workspaceId, taskId)) as Array<{
    state: string;
    end_reason: string | null;
    total: number;
  }>;
  let blocked = 0;
  let expired = 0;
  for (const row of launchRows) {
    if (row.state === "rejected" || row.end_reason === "launch_blocked") {
      blocked += Number(row.total);
    }
    if (row.state === "expired" || row.end_reason === "launch_expired") {
      expired += Number(row.total);
    }
  }
  const activityRows = (await db
    .prepare(
      `SELECT human_id, started_at, ended_at, capped FROM browser_activity_observations
       WHERE workspace_id = ? AND task_id = ? ORDER BY started_at ASC`,
    )
    .all(workspaceId, taskId)) as Array<{
    human_id: string;
    started_at: string;
    ended_at: string;
    capped: number;
  }>;
  const activityByHuman = new Map<string, BrowserActivitySummary>();
  for (const row of activityRows) {
    const start = parseMs(row.started_at);
    const end = parseMs(row.ended_at);
    if (start === null || end === null || end <= start) {
      continue;
    }
    const entry = activityByHuman.get(row.human_id) ?? {
      human_id: row.human_id,
      observed_ms: 0,
      capped_observations: 0,
      quality: "estimated" as const,
    };
    entry.observed_ms += end - start;
    if (row.capped === 1) {
      entry.capped_observations += 1;
    }
    activityByHuman.set(row.human_id, entry);
  }
  const exactTokens = sumTokenFieldsChecked(
    runs.map((run) => run.tokens.exact),
    runs.flatMap((run) => run.tokens.exact_overflow_fields),
  );
  const estimatedTokens = sumTokenFieldsChecked(
    runs.map((run) => run.tokens.estimated),
    runs.flatMap((run) => run.tokens.estimated_overflow_fields),
  );
  const sumKnown = (values: (number | null)[]) =>
    values.some((value) => value !== null)
      ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : null;
  return {
    task_id: taskId,
    project_id: task.project_id,
    priority: task.priority,
    runs,
    totals: {
      active_ms: runs.reduce((sum, run) => sum + run.times.active_ms, 0),
      process_elapsed_ms: runs.reduce((sum, run) => sum + (run.times.process_elapsed_ms ?? 0), 0),
      process_alive_ms: runs.reduce((sum, run) => sum + run.times.process_alive_ms, 0),
      offline_ms: runs.reduce((sum, run) => sum + run.times.offline_ms, 0),
      external_wait_ms: sumKnown(runs.map((run) => run.times.external_wait_ms)),
      idle_ms: sumKnown(runs.map((run) => run.times.idle_ms)),
      unknown_run_counts: {
        process: runs.filter((run) => run.times.process_elapsed_ms === null).length,
        active: runs.filter((run) => run.times.active_quality === "unavailable").length,
        external_wait: runs.filter((run) => run.times.external_wait_ms === null).length,
        idle: runs.filter((run) => run.times.idle_ms === null).length,
      },
      legacy_estimated_runs: runs.filter(
        (run) => run.times.active_quality === "includes_legacy_estimates",
      ).length,
      attention_wait_ms: runs.reduce((sum, run) => sum + run.times.attention_wait_ms, 0),
      exact_tokens: exactTokens.fields,
      estimated_tokens: estimatedTokens.fields,
      exact_overflow_fields: exactTokens.overflow_fields,
      estimated_overflow_fields: estimatedTokens.overflow_fields,
      unavailable_token_reports: runs.reduce((sum, run) => sum + run.tokens.unavailable_count, 0),
    },
    review: { timers, stopped_total_ms: stoppedTotal, open_ms: openMs },
    attention,
    interventions: {
      runs: runs.length,
      restarts: Math.max(0, runs.length - 1),
      submission_versions: Number(submissionCount.total),
      reviews_request_changes: requestChanges,
      reviews_accept: accept,
      attention_by_kind: attentionByKind,
      launch_blocked: blocked,
      launch_expired: expired,
    },
    browser_activity: [...activityByHuman.values()],
  };
}

export interface AggregateFilters {
  projectId?: string;
  provider?: string;
  priority?: string;
}

export interface AggregateCell {
  project_id: string;
  provider: string | null;
  priority: string;
  runs: number;
  active_ms: number;
  process_elapsed_ms: number;
  process_alive_ms: number;
  offline_ms: number;
  process_unavailable_runs: number;
  active_unavailable_runs: number;
  legacy_estimated_runs: number;
  review_stopped_ms: number;
  review_open_ms: number;
  review_scope: "run_linked_timers";
  attention_wait_ms: number;
  exact_tokens: TokenFields;
  estimated_tokens: TokenFields;
  exact_overflow_fields: TokenFieldName[];
  estimated_overflow_fields: TokenFieldName[];
  unavailable_token_reports: number;
  attention_requests: number;
  submission_versions: number;
}

/**
 * Rolls separated run measures up by project, provider, and task priority
 * for later autonomy analysis. Implements no autonomy rule and mutates nothing.
 */
export async function aggregateMeasurements(
  db: SqlDatabase,
  workspaceId: string,
  filters: AggregateFilters,
  now: string,
): Promise<{ cells: AggregateCell[]; truncated: boolean }> {
  const conditions: string[] = ["r.workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (filters.projectId !== undefined) {
    conditions.push("r.project_id = ?");
    params.push(filters.projectId);
  }
  if (filters.priority !== undefined) {
    conditions.push("t.priority = ?");
    params.push(filters.priority);
  }
  if (filters.provider !== undefined) {
    conditions.push(`${RUN_PROVIDER_SQL} = ?`);
    params.push(filters.provider);
  }
  const rows = (await db
    .prepare(
      `SELECT r.id AS run_id, r.project_id, t.priority, ${RUN_PROVIDER_SQL} AS provider,
              (SELECT COUNT(*) FROM attention_requests AS a
               WHERE a.workspace_id = r.workspace_id AND a.run_id = r.id) AS attention_requests,
              (SELECT COUNT(*) FROM result_submissions AS s
               WHERE s.workspace_id = r.workspace_id AND s.run_id = r.id) AS submissions
       FROM runs AS r
       JOIN tasks AS t ON t.workspace_id = r.workspace_id AND t.id = r.task_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY r.id ASC LIMIT ?`,
    )
    .all(...params, MEASUREMENT_AGGREGATION_RUN_LIMIT + 1)) as Array<{
    run_id: string;
    project_id: string;
    priority: string;
    provider: string | null;
    attention_requests: number;
    submissions: number;
  }>;
  const truncated = rows.length > MEASUREMENT_AGGREGATION_RUN_LIMIT;
  const cells = new Map<string, AggregateCell>();
  for (const row of rows.slice(0, MEASUREMENT_AGGREGATION_RUN_LIMIT)) {
    const measured = await getRunMeasurements(db, workspaceId, row.run_id, now);
    const key = `${row.project_id}|${row.provider ?? "unknown"}|${row.priority}`;
    const cell = cells.get(key) ?? {
      project_id: row.project_id,
      provider: row.provider,
      priority: row.priority,
      runs: 0,
      active_ms: 0,
      process_elapsed_ms: 0,
      process_alive_ms: 0,
      offline_ms: 0,
      process_unavailable_runs: 0,
      active_unavailable_runs: 0,
      legacy_estimated_runs: 0,
      review_stopped_ms: 0,
      review_open_ms: 0,
      review_scope: "run_linked_timers" as const,
      attention_wait_ms: 0,
      exact_tokens: {
        input: null,
        output: null,
        cache_read: null,
        cache_write: null,
        reasoning: null,
      },
      estimated_tokens: {
        input: null,
        output: null,
        cache_read: null,
        cache_write: null,
        reasoning: null,
      },
      exact_overflow_fields: [] as TokenFieldName[],
      estimated_overflow_fields: [] as TokenFieldName[],
      unavailable_token_reports: 0,
      attention_requests: 0,
      submission_versions: 0,
    };
    cell.runs += 1;
    cell.active_ms += measured.times.active_ms;
    cell.process_elapsed_ms += measured.times.process_elapsed_ms ?? 0;
    cell.process_alive_ms += measured.times.process_alive_ms;
    cell.offline_ms += measured.times.offline_ms;
    cell.process_unavailable_runs += Number(measured.times.process_elapsed_ms === null);
    cell.active_unavailable_runs += Number(measured.times.active_quality === "unavailable");
    cell.legacy_estimated_runs += Number(
      measured.times.active_quality === "includes_legacy_estimates",
    );
    cell.review_stopped_ms += measured.review.stopped_total_ms;
    cell.review_open_ms += measured.review.open_ms;
    const exact = sumTokenFieldsChecked(
      [cell.exact_tokens, measured.tokens.exact],
      [...cell.exact_overflow_fields, ...measured.tokens.exact_overflow_fields],
    );
    const estimated = sumTokenFieldsChecked(
      [cell.estimated_tokens, measured.tokens.estimated],
      [...cell.estimated_overflow_fields, ...measured.tokens.estimated_overflow_fields],
    );
    cell.exact_tokens = exact.fields;
    cell.exact_overflow_fields = exact.overflow_fields;
    cell.estimated_tokens = estimated.fields;
    cell.estimated_overflow_fields = estimated.overflow_fields;
    cell.unavailable_token_reports += measured.tokens.unavailable_count;
    cell.attention_requests += Number(row.attention_requests);
    cell.submission_versions += Number(row.submissions);
    cell.attention_wait_ms += measured.times.attention_wait_ms;
    cells.set(key, cell);
  }
  return { cells: [...cells.values()], truncated };
}
