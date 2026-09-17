// ABOUTME: Proves timeline projection identity, fixed summaries, and hostile-data handling.
// ABOUTME: Summaries are data-only templates; no projection may emit markup or claims.

import { describe, expect, it } from "vitest";

import type { ReplayEnvelope } from "../src/realtime/protocol.js";
import { parseReplayEnvelope, parseServerFrame } from "../src/realtime/protocol.js";
import { buildTimelineEntries, shortId, summarizeEventKind } from "../src/realtime/timeline.js";

function envelope(overrides: Partial<ReplayEnvelope> = {}): ReplayEnvelope {
  return {
    event_id: "01K00000000000000000000001",
    workspace_cursor: 1,
    run_id: "01K00000000000000000000011",
    run_execution_id: "01K00000000000000000000022",
    assignment_generation: 2,
    actor: { type: "runner", id: "01K00000000000000000000033" },
    source: { type: "runner", id: "01K00000000000000000000033", provider: "codex" },
    kind: "heartbeat",
    occurred_at: "2026-09-12T12:00:00.000Z",
    received_at: "2026-09-12T12:00:01.000Z",
    ...overrides,
  };
}

describe("timeline projection", () => {
  it("carries actor, source, provenance, and session identity per entry", () => {
    const entries = buildTimelineEntries([
      envelope({
        workspace_cursor: 2,
        kind: "turn_started",
        actor: { type: "agent_run", id: "01K00000000000000000000022" },
        provider_session_id: "sess-9",
      }),
      envelope({ workspace_cursor: 1, kind: "heartbeat" }),
    ]);
    expect(entries.map((entry) => entry.cursor)).toEqual([1, 2]);
    expect(entries[0]).toMatchObject({
      summary: "Runner heartbeat observed",
      actorLabel: "Runner",
      sourceLabel: "Runner via codex",
      provenance: "daemon-observed",
      provider: "codex",
    });
    expect(entries[1]).toMatchObject({
      summary: "Agent turn started",
      actorLabel: "Agent run",
      provenance: "agent-reported",
      sessionId: "sess-9",
      executionId: "01K00000000000000000000022",
      assignmentGeneration: 2,
    });
  });

  it("never claims results, acceptance, or completion in summaries", () => {
    const banned = ["complet", "accept", " approv", "done", "success", "working"];
    for (const kind of [
      "turn_started",
      "heartbeat",
      "tool_finished",
      "progress_reported",
      "result_submitted",
      "session_started",
      "unknown_future_kind",
    ]) {
      const summary = summarizeEventKind(kind).toLowerCase();
      for (const word of banned) expect(summary).not.toContain(word);
    }
    expect(summarizeEventKind("result_submitted")).toBe("Result submitted for review");
    expect(summarizeEventKind("unknown_future_kind")).toBe("Recorded run event");
  });

  it("keeps hostile event strings as data and truncates long identifiers", () => {
    const hostile = "<img src=x onerror=alert(document.domain)>";
    const [entry] = buildTimelineEntries([
      envelope({ kind: "session_started", provider_session_id: hostile }),
    ]);
    expect(entry?.sessionId).toBe(hostile);
    expect(entry?.summary).not.toContain("<");
    expect(shortId(hostile).length).toBeLessThan(hostile.length);
    expect(shortId("short")).toBe("short");
  });

  it("rejects malformed replay rows and server frames", () => {
    expect(parseReplayEnvelope(null)).toBeNull();
    expect(parseReplayEnvelope({ ...envelope(), workspace_cursor: 0 })).toBeNull();
    expect(parseReplayEnvelope({ ...envelope(), actor: { type: "runner" } })).toBeNull();
    expect(parseReplayEnvelope({ ...envelope(), occurred_at: "not-a-time" })).toBeNull();
    expect(
      parseReplayEnvelope({ ...envelope(), provider_session_id: "<ok>", kind: "heartbeat" })
        ?.provider_session_id,
    ).toBe("<ok>");
    expect(parseServerFrame({ kind: "event.committed" })).toBeNull();
    expect(
      parseServerFrame({
        schema_version: 1,
        kind: "event.committed",
        workspace_id: "w",
        high_water_cursor: 4,
        injected: true,
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        schema_version: 1,
        kind: "event.committed",
        workspace_id: "w",
        high_water_cursor: 4,
      }),
    ).toEqual({ kind: "invalidation", workspaceId: "w", highWater: 4 });
    expect(
      parseServerFrame({
        schema_version: 1,
        kind: "browser.realtime.close",
        workspace_id: "w",
        reason: "bogus",
      }),
    ).toBeNull();
  });
});
