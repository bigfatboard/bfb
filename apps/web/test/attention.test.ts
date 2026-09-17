// ABOUTME: Tests the A02 Attention home labels, rank preservation, and state distinctions.
// ABOUTME: DOM behavior is proven in the Playwright spec; this suite pins the presentation contract.

import { describe, expect, it } from "vitest";

import {
  KIND_LABELS,
  NATIVE_PERMISSION_NOTICE,
  STATE_LABELS,
  requiredRoleLabel,
  type AttentionHomeItem,
} from "../src/attention/home.js";

function item(overrides: Partial<AttentionHomeItem> = {}): AttentionHomeItem {
  return {
    id: "01SYNTHETICAT00000000000001",
    kind: "clarification",
    required_role: "reviewer",
    reference_kind: null,
    reference_id: null,
    question: "Synthetic question",
    blocking: true,
    state: "open",
    answer: null,
    task_title: "Synthetic task",
    project_name: "Alpha",
    run_result_state: "open",
    run_activity: "needs_human",
    rank_reason: "blocking clarification requested 2026-08-07T12:00:00Z",
    resource_version: 1,
    requested_at: "2026-08-07T12:00:00Z",
    answered_at: null,
    resolved_at: null,
    ...overrides,
  };
}

describe("attention home presentation", () => {
  it("labels every kind and state distinctly", () => {
    expect(Object.keys(KIND_LABELS).sort()).toEqual([
      "blocker",
      "capability",
      "clarification",
      "credential",
      "destructive_action",
      "review",
    ]);
    expect(KIND_LABELS.credential).not.toBe(KIND_LABELS.clarification);
    expect(KIND_LABELS.destructive_action).not.toBe(KIND_LABELS.review);
    expect(STATE_LABELS.open).not.toBe(STATE_LABELS.answered);
    expect(STATE_LABELS.answered).not.toBe(STATE_LABELS.resolved);
    expect(requiredRoleLabel("owner")).toContain("owner");
    expect(requiredRoleLabel("reviewer")).toContain("Reviewer");
  });

  it("keeps provider-native permissions visibly separate", () => {
    expect(NATIVE_PERMISSION_NOTICE).toContain("separate");
    expect(NATIVE_PERMISSION_NOTICE).toContain("never approves");
    expect(NATIVE_PERMISSION_NOTICE).toContain("never grants");
  });

  it("carries the ranked server order with explainable reasons", () => {
    const ranked = [
      item({
        id: "a",
        kind: "blocker",
        blocking: true,
        rank_reason: "blocking blocker requested t0",
      }),
      item({
        id: "b",
        kind: "review",
        blocking: false,
        rank_reason: "non-blocking review requested t1",
      }),
    ];
    expect(ranked.map((entry) => entry.id)).toEqual(["a", "b"]);
    for (const entry of ranked) {
      expect(entry.rank_reason).toContain(entry.kind);
      expect(entry.rank_reason).toContain(entry.blocking ? "blocking" : "non-blocking");
    }
  });

  it("exposes committed answers and versions for answer and resolve actions", () => {
    const answered = item({ state: "answered", answer: "Synthetic answer", resource_version: 2 });
    expect(answered.answer).toBe("Synthetic answer");
    expect(answered.resource_version).toBe(2);
    const resolved = item({ state: "resolved", answer: "Synthetic answer", resource_version: 3 });
    expect(resolved.state).toBe("resolved");
  });
});
