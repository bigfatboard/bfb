// ABOUTME: Derives connectivity, process presence, and normalized activity from committed events.
// ABOUTME: Heartbeats prove liveness only; only an open turn interval may read as working.

import { STALE_THRESHOLD_MS } from "./protocol.js";
import type { ReplayEnvelope } from "./protocol.js";

export type Connectivity = "live" | "stale" | "offline";
export type ProcessPresence = "alive" | "stale" | "unknown";
export type RunActivity = "working" | "needs_human" | "idle" | "offline" | "unknown";

export interface HumanNote {
  id: string;
  created_at: string;
  author_human_id: string | null;
}

export type HumanPresence = { kind: "note"; at: string } | { kind: "none" };

const TERMINAL_EXECUTION = new Set(["execution_ended", "execution_detached"]);

export function deriveConnectivity(options: {
  socketOpen: boolean;
  lastSignalAt: number | null;
  now: number;
}): Connectivity {
  if (!options.socketOpen) return "offline";
  if (options.lastSignalAt === null) return "live";
  return options.now - options.lastSignalAt >= STALE_THRESHOLD_MS ? "stale" : "live";
}

function lastHeartbeatAt(envelopes: readonly ReplayEnvelope[]): number | null {
  let latest: number | null = null;
  for (const envelope of envelopes) {
    if (envelope.kind !== "heartbeat") continue;
    const at = Date.parse(envelope.occurred_at);
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

export function deriveProcessPresence(
  envelopes: readonly ReplayEnvelope[],
  now: number,
): ProcessPresence {
  const heartbeat = lastHeartbeatAt(envelopes);
  if (heartbeat === null) return "unknown";
  return now - heartbeat >= STALE_THRESHOLD_MS ? "stale" : "alive";
}

function hasOpenTurn(envelopes: readonly ReplayEnvelope[]): boolean {
  let open = false;
  for (const envelope of [...envelopes].sort(
    (left, right) => left.workspace_cursor - right.workspace_cursor,
  )) {
    if (envelope.kind === "turn_started") open = true;
    else if (envelope.kind === "turn_stopped" || envelope.kind === "turn_failed") open = false;
    else if (TERMINAL_EXECUTION.has(envelope.kind)) open = false;
  }
  return open;
}

/**
 * Normalizes activity without inventing completion. A live process at an idle
 * prompt is idle; heartbeat-only runs are never working; empty runs are
 * unknown rather than assumed idle.
 */
export function deriveActivity(envelopes: readonly ReplayEnvelope[], now: number): RunActivity {
  if (envelopes.length === 0) return "unknown";
  if (hasOpenTurn(envelopes)) return "working";
  const ordered = [...envelopes].sort(
    (left, right) => left.workspace_cursor - right.workspace_cursor,
  );
  const last = ordered[ordered.length - 1] as ReplayEnvelope;
  if (last.kind === "attention_requested") return "needs_human";
  const heartbeat = lastHeartbeatAt(envelopes);
  if (heartbeat !== null && now - heartbeat < STALE_THRESHOLD_MS) return "idle";
  if (TERMINAL_EXECUTION.has(last.kind)) return "offline";
  // Observed events without a fresh heartbeat are idle evidence, never work.
  return "idle";
}

/**
 * Human presence comes from committed interaction records only. v0.1 has no
 * committed review records, so this projection must never produce a
 * "reviewed" claim; callers render the none case as unknown, never as seen.
 */
export function deriveHumanPresence(comments: readonly HumanNote[]): HumanPresence {
  let latest: HumanNote | null = null;
  for (const comment of comments) {
    if (!comment.author_human_id) continue;
    if (!Number.isFinite(Date.parse(comment.created_at))) continue;
    if (!latest || Date.parse(comment.created_at) > Date.parse(latest.created_at)) latest = comment;
  }
  if (!latest) return { kind: "none" };
  return { kind: "note", at: latest.created_at };
}

export function relativeTime(at: string, now: number): string {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return "at an unknown time";
  const deltaMs = Math.max(0, now - then);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;
  return new Date(then).toISOString().slice(0, 10);
}
