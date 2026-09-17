// ABOUTME: Deterministic replay-race suite for the subscribe-first resync machine.
// ABOUTME: Injects commits at every race point and asserts exactly-once ordered apply.

import { describe, expect, it } from "vitest";

import type { ReplayEnvelope } from "../src/realtime/protocol.js";
import { createResyncMachine, type FetchEffect } from "../src/realtime/resync.js";

let ids = 0;

function envelope(cursor: number, kind = "heartbeat"): ReplayEnvelope {
  ids += 1;
  return {
    event_id: `01K0000000000000000RACE${String(ids).padStart(6, "0")}`,
    workspace_cursor: cursor,
    run_id: "01K00000000000000000000011",
    run_execution_id: "01K00000000000000000000022",
    assignment_generation: 1,
    actor: { type: "runner", id: "01K00000000000000000000033" },
    source: { type: "runner", id: "01K00000000000000000000033", provider: "fake" },
    kind,
    occurred_at: "2026-09-12T12:00:00.000Z",
    received_at: "2026-09-12T12:00:01.000Z",
  };
}

/** Committed-ledger double plus the socket-open flag driving invalidations. */
function harness() {
  const ledger: ReplayEnvelope[] = [];
  const machine = createResyncMachine(0);
  let open = false;
  function fetch({ after, through }: FetchEffect): { envelopes: ReplayEnvelope[]; hasMore: boolean } {
    return {
      envelopes: ledger.filter((row) => row.workspace_cursor > after && row.workspace_cursor <= through),
      hasMore: false,
    };
  }
  return {
    machine,
    openSocket(): void {
      open = true;
    },
    /** Commits cursors and, when the socket is open, delivers invalidations first. */
    commit(cursors: number[], kind = "heartbeat"): void {
      for (const cursor of cursors) ledger.push(envelope(cursor, kind));
      if (open) {
        for (const cursor of cursors) machine.dispatch({ type: "invalidation", cursor });
      }
    },
    ready(): FetchEffect[] {
      const highWater = ledger.length > 0 ? (ledger[ledger.length - 1] as ReplayEnvelope).workspace_cursor : 0;
      return machine.dispatch({ type: "ready", highWater });
    },
    resolve(effects: FetchEffect[]): FetchEffect[] {
      const next: FetchEffect[] = [];
      for (const effect of effects) {
        const page = fetch(effect);
        next.push(...machine.dispatch({ type: "replay-done", envelopes: page.envelopes, requestedThrough: effect.through, hasMore: page.hasMore }));
      }
      return next;
    },
    drainFully(first: FetchEffect[]): void {
      let effects = first;
      for (let step = 0; step < 10 && effects.length > 0; step += 1) {
        effects = this.resolve(effects);
      }
      if (effects.length > 0) throw new Error("resync did not converge");
    },
    appliedCursors(): number[] {
      return machine.snapshot().applied.map((row) => row.workspace_cursor);
    },
  };
}

describe("subscribe-first resync races", () => {
  it("renders pre-subscription commits once in order", () => {
    const h = harness();
    h.commit([1, 2, 3]);
    h.openSocket();
    h.drainFully(h.ready());
    expect(h.machine.snapshot().phase).toBe("live");
    expect(h.appliedCursors()).toEqual([1, 2, 3]);
  });

  it("covers commits that land before high-water capture", () => {
    const h = harness();
    h.commit([1, 2]);
    h.openSocket();
    h.commit([3, 4]);
    expect(h.machine.snapshot().buffered).toEqual([3, 4]);
    h.drainFully(h.ready());
    expect(h.appliedCursors()).toEqual([1, 2, 3, 4]);
  });

  it("covers the commit exactly at the high-water mark", () => {
    const h = harness();
    h.openSocket();
    h.commit([1]);
    // The ready mark is inclusive: the boundary commit replays, never buffered-forever.
    h.drainFully(h.ready());
    expect(h.appliedCursors()).toEqual([1]);
    expect(h.machine.snapshot().buffered).toEqual([]);
  });

  it("buffers commits that land after capture and during replay", () => {
    const h = harness();
    h.commit([1, 2, 3]);
    h.openSocket();
    const first = h.ready();
    expect(first).toEqual([{ type: "fetch", after: 0, through: 3 }]);
    h.commit([4]);
    expect(h.machine.snapshot().phase).toBe("replaying");
    const second = h.resolve(first);
    expect(second).toEqual([{ type: "fetch", after: 3, through: 4 }]);
    h.commit([5]);
    h.drainFully(second);
    expect(h.machine.snapshot().phase).toBe("live");
    expect(h.appliedCursors()).toEqual([1, 2, 3, 4, 5]);
  });

  it("drains commits that land during the drain without loss or duplication", () => {
    const h = harness();
    h.commit([1, 2, 3]);
    h.openSocket();
    const first = h.ready();
    h.commit([4, 5]);
    const second = h.resolve(first);
    expect(second).toEqual([{ type: "fetch", after: 3, through: 5 }]);
    h.commit([6]);
    h.drainFully(second);
    expect(h.machine.snapshot().phase).toBe("live");
    expect(h.appliedCursors()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("never applies an invalidation without an authoritative replay", () => {
    const h = harness();
    h.openSocket();
    h.commit([7, 8]);
    // No ready and no fetch yet: buffered cursors are hints, not entries.
    expect(h.machine.snapshot().applied).toEqual([]);
    h.drainFully(h.ready());
    expect(h.appliedCursors()).toEqual([7, 8]);
  });

  it("dedupes overlapping replay pages by event id", () => {
    const h = harness();
    h.commit([1, 2]);
    h.openSocket();
    const row = envelope(1);
    const machine = h.machine;
    machine.dispatch({ type: "ready", highWater: 2 });
    machine.dispatch({
      type: "replay-done",
      envelopes: [row, row, envelope(2)],
      requestedThrough: 2,
      hasMore: false,
    });
    const cursors = machine.snapshot().applied.map((entry) => entry.workspace_cursor);
    expect(cursors).toEqual([1, 2]);
  });

  it("orders out-of-order replay pages by cursor", () => {
    const h = harness();
    h.openSocket();
    h.machine.dispatch({ type: "ready", highWater: 3 });
    h.machine.dispatch({
      type: "replay-done",
      envelopes: [envelope(3), envelope(1), envelope(2)],
      requestedThrough: 3,
      hasMore: false,
    });
    expect(h.appliedCursors()).toEqual([1, 2, 3]);
  });

  it("retries a failed replay and resumes where it stopped", () => {
    const h = harness();
    h.commit([1, 2]);
    h.openSocket();
    const first = h.ready();
    h.machine.dispatch({ type: "replay-failed", error: "network reset" });
    expect(h.machine.snapshot().phase).toBe("failed");
    const retry = h.machine.dispatch({ type: "retry" });
    expect(retry).toEqual(first);
    h.drainFully(retry);
    expect(h.machine.snapshot().phase).toBe("live");
    expect(h.appliedCursors()).toEqual([1, 2]);
  });

  it("pages a long backlog through has_more without skipping", () => {
    const h = harness();
    for (const cursor of [1, 2, 3, 4]) h.commit([cursor]);
    h.openSocket();
    h.machine.dispatch({ type: "ready", highWater: 4 });
    const page = (after: number, through: number, take: number) => {
      const rows = [1, 2, 3, 4]
        .filter((cursor) => cursor > after && cursor <= through)
        .slice(0, take)
        .map((cursor) => envelope(cursor));
      const last = rows.length > 0 ? (rows[rows.length - 1] as ReplayEnvelope).workspace_cursor : after;
      return h.machine.dispatch({
        type: "replay-done",
        envelopes: rows,
        requestedThrough: through,
        hasMore: last < through,
      });
    };
    let effects = page(0, 4, 2);
    expect(effects).toEqual([{ type: "fetch", after: 2, through: 4 }]);
    effects = page(2, 4, 2);
    expect(effects).toEqual([]);
    expect(h.machine.snapshot().phase).toBe("live");
    expect(h.appliedCursors()).toEqual([1, 2, 3, 4]);
  });
});
