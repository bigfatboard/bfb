// ABOUTME: Pure burst-baseline math for the G01 performance envelope.
// ABOUTME: Summarizes measured per-command latencies so perf-baseline.json records figures, not literals.

/** Measured hub-burst summary. Every field derives from the sampled timings. */
export interface BurstLatencySummary {
  commands: number;
  committed: number;
  bound_ms: number;
  elapsed_ms: number;
  within_bound: boolean;
  latency_min_ms: number;
  latency_p50_ms: number;
  latency_mean_ms: number;
  latency_p95_ms: number;
  latency_max_ms: number;
  throughput_per_s: number;
}

/** Hub persistence cost of one burst: rows written between two counter reads. */
export interface BurstWriteCounters {
  tasks: number;
  ledger_events: number;
  semantic_events: number;
}

/** Rows written by a burst. Deltas must be non-negative; rows never vanish. */
export interface BurstWriteDelta {
  tasks_written: number;
  ledger_events_written: number;
  semantic_events_written: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Nearest-rank percentile over ascending samples: rank ceil(p * n), 1-indexed.
 * Deterministic for a fixed sample set; no interpolation hides slow commands.
 */
function percentileRank(ascending: number[], rank: number): number {
  const pick = ascending[Math.min(ascending.length - 1, Math.max(0, Math.ceil(rank) - 1))];
  if (pick === undefined) {
    throw new Error("burst summary needs at least one measured command latency");
  }
  return pick;
}

/**
 * Summarize one measured burst. The bound verdict is computed from the
 * measured wall-clock elapsed, so a hub slowdown changes the summary instead
 * of leaving a constant record behind.
 */
export function summarizeBurstLatencies(
  samplesMs: number[],
  elapsedMs: number,
  boundMs: number,
): BurstLatencySummary {
  if (!Number.isInteger(elapsedMs) || elapsedMs <= 0) {
    throw new Error(`burst elapsed must be a positive integer of ms, saw ${elapsedMs}`);
  }
  if (!Number.isInteger(boundMs) || boundMs <= 0) {
    throw new Error(`burst bound must be a positive integer of ms, saw ${boundMs}`);
  }
  if (samplesMs.length === 0) {
    throw new Error("burst summary needs at least one measured command latency");
  }
  for (const sample of samplesMs) {
    if (!Number.isInteger(sample) || sample < 0 || !Number.isFinite(sample)) {
      throw new Error(`burst latencies must be non-negative integer ms, saw ${sample}`);
    }
  }
  const ascending = [...samplesMs].sort((left, right) => left - right);
  const total = ascending.reduce((sum, sample) => sum + sample, 0);
  const count = ascending.length;
  const slowest = ascending[count - 1];
  if (ascending[0] === undefined || slowest === undefined) {
    throw new Error("burst summary needs at least one measured command latency");
  }
  const fastest: number = ascending[0];
  const peak: number = slowest;
  return {
    commands: count,
    committed: count,
    bound_ms: boundMs,
    elapsed_ms: elapsedMs,
    within_bound: elapsedMs < boundMs,
    latency_min_ms: fastest,
    latency_p50_ms: percentileRank(ascending, 0.5 * count),
    latency_mean_ms: round1(total / count),
    latency_p95_ms: percentileRank(ascending, 0.95 * count),
    latency_max_ms: peak,
    throughput_per_s: round2(count / (elapsedMs / 1000)),
  };
}

/** Difference two counter reads into the rows one burst wrote. */
export function burstWriteDelta(
  before: BurstWriteCounters,
  after: BurstWriteCounters,
): BurstWriteDelta {
  const delta = {
    tasks_written: after.tasks - before.tasks,
    ledger_events_written: after.ledger_events - before.ledger_events,
    semantic_events_written: after.semantic_events - before.semantic_events,
  };
  for (const [label, value] of Object.entries(delta)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`burst ${label} must be a non-negative row delta, saw ${value}`);
    }
  }
  return delta;
}
