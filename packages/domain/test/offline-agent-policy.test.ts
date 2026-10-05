// ABOUTME: Proves closed offline permission validation and tightening-only inheritance.
// ABOUTME: Exercises deny defaults, canonical tool sets and exact pending-age bounds.

import { describe, expect, it } from "vitest";

import {
  assertOfflineAgentWorkTightens,
  deniedOfflineAgentWork,
  normalizeOfflineAgentWork,
  OFFLINE_AGENT_TOOLS,
} from "../src/offline-agent-policy.js";

describe("offline agent work policy", () => {
  it("returns separate denied values without reconstructing missing permission", () => {
    const first = deniedOfflineAgentWork();
    first.allowed_tools.push("bfb_add_comment");
    expect(deniedOfflineAgentWork()).toEqual({ allowed_tools: [], max_pending_age_seconds: 0 });
    expect(() => normalizeOfflineAgentWork(undefined)).toThrow(/complete object/);
  });

  it("normalizes a tool set without enabling any other agent operation", () => {
    expect(
      normalizeOfflineAgentWork({
        allowed_tools: ["bfb_update_task", "bfb_add_comment", "bfb_update_task"],
        max_pending_age_seconds: 300,
      }),
    ).toEqual({
      allowed_tools: ["bfb_add_comment", "bfb_update_task"],
      max_pending_age_seconds: 300,
    });
    expect(OFFLINE_AGENT_TOOLS).toHaveLength(4);
  });

  it.each([1, 300])("accepts an enabled age of %i seconds", (age) => {
    expect(
      normalizeOfflineAgentWork({
        allowed_tools: [...OFFLINE_AGENT_TOOLS],
        max_pending_age_seconds: age,
      }),
    ).toEqual({ allowed_tools: [...OFFLINE_AGENT_TOOLS], max_pending_age_seconds: age });
  });

  it.each([
    null,
    [],
    {},
    { allowed_tools: [] },
    { max_pending_age_seconds: 0 },
    { allowed_tools: [], max_pending_age_seconds: 0, allowed: true },
    { allowed_tools: "bfb_add_comment", max_pending_age_seconds: 1 },
    { allowed_tools: [null], max_pending_age_seconds: 1 },
    { allowed_tools: ["bfb_submit_result"], max_pending_age_seconds: 1 },
    { allowed_tools: ["bfb_ask_human"], max_pending_age_seconds: 1 },
    { allowed_tools: ["bfb_add_comment"], max_pending_age_seconds: "1" },
    { allowed_tools: ["bfb_add_comment"], max_pending_age_seconds: null },
    { allowed_tools: ["bfb_add_comment"], max_pending_age_seconds: 1.5 },
    { allowed_tools: ["bfb_add_comment"], max_pending_age_seconds: 0 },
    { allowed_tools: ["bfb_add_comment"], max_pending_age_seconds: 301 },
    { allowed_tools: [], max_pending_age_seconds: 1 },
    { allowed_tools: [], max_pending_age_seconds: -1 },
  ])("rejects incomplete or widened permission %#", (value) => {
    expect(() => normalizeOfflineAgentWork(value)).toThrow();
  });

  it("allows only subsets and shorter retention, including explicit deny", () => {
    const parent = { allowed_tools: [...OFFLINE_AGENT_TOOLS], max_pending_age_seconds: 120 };
    expect(() => assertOfflineAgentWorkTightens(parent, parent)).not.toThrow();
    expect(() => assertOfflineAgentWorkTightens(parent, deniedOfflineAgentWork())).not.toThrow();
    expect(() =>
      assertOfflineAgentWorkTightens(parent, {
        allowed_tools: ["bfb_report_progress"],
        max_pending_age_seconds: 30,
      }),
    ).not.toThrow();
    expect(() =>
      assertOfflineAgentWorkTightens(parent, {
        allowed_tools: ["bfb_report_progress"],
        max_pending_age_seconds: 121,
      }),
    ).toThrow(/cannot widen/);
    expect(() => assertOfflineAgentWorkTightens(deniedOfflineAgentWork(), parent)).toThrow(
      /cannot widen/,
    );
    expect(() =>
      assertOfflineAgentWorkTightens(
        { allowed_tools: ["bfb_add_comment"], max_pending_age_seconds: 120 },
        { allowed_tools: ["bfb_report_progress"], max_pending_age_seconds: 1 },
      ),
    ).toThrow(/cannot widen/);
  });
});
