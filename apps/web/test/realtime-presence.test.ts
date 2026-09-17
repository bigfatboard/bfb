// ABOUTME: Proves presence policy boundaries for connectivity, process, activity, and humans.
// ABOUTME: A live process at an idle prompt is idle; human presence needs committed records.

import { describe, expect, it } from "vitest";

import type { ReplayEnvelope } from "../src/realtime/protocol.js";
import {
  deriveActivity,
  deriveConnectivity,
  deriveHumanPresence,
  deriveProcessPresence,
  relativeTime,
} from "../src/realtime/presence.js";

const AT = "2026-09-12T12:00:00.000Z";
const NOW = Date.parse(AT);

let cursor = 0;

function envelope(kind: string, occurredAt = AT): ReplayEnvelope {
  cursor += 1;
  return {
    event_id: `01K0000000000000000P${String(cursor).padStart(6, "0")}`,
    workspace_cursor: cursor,
    run_id: "01K00000000000000000000011",
    run_execution_id: "01K00000000000000000000022",
    assignment_generation: 1,
    actor: { type: "runner", id: "01K00000000000000000000033" },
    source: { type: "runner", id: "01K00000000000000000000033", provider: "fake" },
    kind,
    occurred_at: occurredAt,
    received_at: occurredAt,
  };
}

describe("presence derivation", () => {
  it("separates connectivity from process state and run results", () => {
    expect(deriveConnectivity({ socketOpen: false, lastSignalAt: NOW, now: NOW })).toBe("offline");
    expect(deriveConnectivity({ socketOpen: true, lastSignalAt: null, now: NOW })).toBe("live");
    expect(deriveConnectivity({ socketOpen: true, lastSignalAt: NOW, now: NOW })).toBe("live");
    expect(
      deriveConnectivity({ socketOpen: true, lastSignalAt: NOW - 44_999, now: NOW }),
    ).toBe("live");
    expect(
      deriveConnectivity({ socketOpen: true, lastSignalAt: NOW - 45_000, now: NOW }),
    ).toBe("stale");
  });

  it("reads process presence from heartbeats only", () => {
    expect(deriveProcessPresence([], NOW)).toBe("unknown");
    expect(deriveProcessPresence([envelope("turn_started")], NOW)).toBe("unknown");
    expect(deriveProcessPresence([envelope("heartbeat")], NOW)).toBe("alive");
    expect(
      deriveProcessPresence([envelope("heartbeat", "2026-09-12T11:59:00.000Z")], NOW),
    ).toBe("stale");
  });

  it("never labels a heartbeat-only run working", () => {
    cursor = 0;
    expect(deriveActivity([], NOW)).toBe("unknown");
    expect(deriveActivity([envelope("heartbeat")], NOW)).toBe("idle");
    expect(deriveActivity([envelope("heartbeat"), envelope("session_started")], NOW)).toBe("idle");
  });

  it("requires an open turn interval for working and closes it on terminal rows", () => {
    cursor = 0;
    expect(deriveActivity([envelope("turn_started")], NOW)).toBe("working");
    expect(
      deriveActivity([envelope("turn_started"), envelope("turn_stopped")], NOW),
    ).toBe("idle");
    expect(
      deriveActivity([envelope("turn_started"), envelope("turn_failed")], NOW),
    ).toBe("idle");
    // A dead execution mid-turn is offline, not working.
    expect(
      deriveActivity([envelope("turn_started"), envelope("execution_ended")], NOW + 60_000),
    ).toBe("offline");
    expect(
      deriveActivity([envelope("attention_requested")], NOW),
    ).toBe("needs_human");
  });

  it("derives human presence from committed notes and never claims review", () => {
    expect(deriveHumanPresence([])).toEqual({ kind: "none" });
    expect(
      deriveHumanPresence([{ id: "c1", created_at: AT, author_human_id: null }]),
    ).toEqual({ kind: "none" });
    const presence = deriveHumanPresence([
      { id: "c1", created_at: "2026-09-12T11:40:00.000Z", author_human_id: "human-1" },
      { id: "c2", created_at: "2026-09-12T11:50:00.000Z", author_human_id: "human-2" },
    ]);
    expect(presence).toEqual({ kind: "note", at: "2026-09-12T11:50:00.000Z" });
    expect(JSON.stringify(presence).toLowerCase()).not.toContain("review");
    expect(relativeTime("2026-09-12T11:40:00.000Z", NOW)).toBe("20 minutes ago");
    expect(relativeTime(AT, NOW)).toBe("just now");
    expect(relativeTime("2026-09-12T10:00:00.000Z", NOW)).toBe("2 hours ago");
  });
});
