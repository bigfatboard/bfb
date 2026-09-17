// ABOUTME: Implements the subscribe-first replay state machine with buffered invalidations.
// ABOUTME: Invalidations only trigger authoritative HTTP replay; they never carry event data.

import type { ReplayEnvelope } from "./protocol.js";

export type ResyncPhase = "buffering" | "replaying" | "draining" | "live" | "failed";

export interface FetchEffect {
  type: "fetch";
  after: number;
  through: number;
}

export type ResyncEvent =
  | { type: "ready"; highWater: number }
  | { type: "invalidation"; cursor: number }
  | {
      type: "replay-done";
      envelopes: ReplayEnvelope[];
      requestedThrough: number;
      hasMore: boolean;
    }
  | { type: "replay-failed"; error: string }
  | { type: "retry" };

export interface ResyncSnapshot {
  phase: ResyncPhase;
  clientCursor: number;
  appliedThrough: number;
  readyHighWater: number | null;
  buffered: number[];
  applied: ReplayEnvelope[];
  failure: string | null;
}

interface ResyncState extends ResyncSnapshot {
  seen: Set<string>;
  resumeThrough: number | null;
  resumePhase: ResyncPhase | null;
}

function bufferMax(state: ResyncState): number | null {
  return state.buffered.length > 0 ? (state.buffered[state.buffered.length - 1] as number) : null;
}

function drain(state: ResyncState, effects: FetchEffect[]): void {
  const max = bufferMax(state);
  if (max !== null && max > state.appliedThrough) {
    state.phase = "draining";
    state.resumeThrough = max;
    state.resumePhase = "draining";
    effects.push({ type: "fetch", after: state.appliedThrough, through: max });
  } else {
    state.phase = "live";
    state.resumeThrough = null;
    state.resumePhase = null;
  }
}

/**
 * Creates the deterministic subscribe-first session behind one socket.
 * The machine starts buffering before the ready cursor arrives: every
 * invalidation above the applied cursor is retained until an authoritative
 * replay covers it, and every applied envelope comes from a replay page.
 */
export function createResyncMachine(initialCursor: number): {
  snapshot(): ResyncSnapshot;
  dispatch(event: ResyncEvent): FetchEffect[];
} {
  if (!Number.isSafeInteger(initialCursor) || initialCursor < 0) {
    throw new Error("resync machine requires a non-negative integer cursor");
  }
  const state: ResyncState = {
    phase: "buffering",
    clientCursor: initialCursor,
    appliedThrough: initialCursor,
    readyHighWater: null,
    buffered: [],
    applied: [],
    failure: null,
    seen: new Set(),
    resumeThrough: null,
    resumePhase: null,
  };

  function remember(cursorValue: number): void {
    if (cursorValue > state.appliedThrough && !state.buffered.includes(cursorValue)) {
      state.buffered.push(cursorValue);
      state.buffered.sort((left, right) => left - right);
    }
  }

  function dispatch(event: ResyncEvent): FetchEffect[] {
    const effects: FetchEffect[] = [];
    switch (event.type) {
      case "ready": {
        state.readyHighWater = event.highWater;
        if (event.highWater > state.appliedThrough) {
          state.phase = "replaying";
          state.resumeThrough = event.highWater;
          state.resumePhase = "replaying";
          effects.push({ type: "fetch", after: state.appliedThrough, through: event.highWater });
        } else {
          drain(state, effects);
        }
        return effects;
      }
      case "invalidation": {
        remember(event.cursor);
        if (state.phase === "live") drain(state, effects);
        return effects;
      }
      case "replay-done": {
        if (state.phase !== "replaying" && state.phase !== "draining" && state.phase !== "live") {
          return effects;
        }
        const ordered = [...event.envelopes].sort(
          (left, right) => left.workspace_cursor - right.workspace_cursor,
        );
        for (const envelope of ordered) {
          if (envelope.workspace_cursor <= event.requestedThrough && !state.seen.has(envelope.event_id)) {
            state.seen.add(envelope.event_id);
            state.applied.push(envelope);
          }
        }
        state.applied.sort((left, right) => left.workspace_cursor - right.workspace_cursor);
        const last = ordered.length > 0 ? (ordered[ordered.length - 1] as ReplayEnvelope) : null;
        const pageEnd = last ? last.workspace_cursor : event.requestedThrough;
        state.buffered = state.buffered.filter((cursorValue) => cursorValue > pageEnd);
        if (event.hasMore) {
          if (!last || last.workspace_cursor >= event.requestedThrough) {
            // The resume target stays on the range the failed fetch covered.
            state.phase = "failed";
            state.failure = "empty replay page claims more committed events";
            state.resumeThrough = event.requestedThrough;
            return effects;
          }
          const next: FetchEffect = {
            type: "fetch",
            after: last.workspace_cursor,
            through: event.requestedThrough,
          };
          state.resumeThrough = event.requestedThrough;
          effects.push(next);
          return effects;
        }
        state.appliedThrough = event.requestedThrough;
        drain(state, effects);
        return effects;
      }
      case "replay-failed": {
        state.phase = "failed";
        state.failure = event.error;
        return effects;
      }
      case "retry": {
        if (state.phase !== "failed" || state.resumeThrough === null) return effects;
        state.failure = null;
        state.phase = state.resumePhase === "draining" ? "draining" : "replaying";
        effects.push({ type: "fetch", after: state.appliedThrough, through: state.resumeThrough });
        return effects;
      }
    }
  }

  function snapshot(): ResyncSnapshot {
    return {
      phase: state.phase,
      clientCursor: state.clientCursor,
      appliedThrough: state.appliedThrough,
      readyHighWater: state.readyHighWater,
      buffered: [...state.buffered],
      applied: [...state.applied],
      failure: state.failure,
    };
  }

  return { snapshot, dispatch };
}
