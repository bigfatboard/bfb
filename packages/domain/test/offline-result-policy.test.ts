// ABOUTME: Proves independent closed result permission and tightening-only age bounds.
// ABOUTME: Keeps result submission outside the frozen four-tool permission family.

import { describe, expect, it } from "vitest";
import {
  assertOfflineAgentResultsTightens,
  deniedOfflineAgentResults,
  normalizeOfflineAgentResults,
} from "../src/offline-result-policy.js";
import { OFFLINE_AGENT_TOOLS } from "../src/offline-agent-policy.js";

describe("offline result policy", () => {
  it("returns independent deny defaults", () => {
    const first = deniedOfflineAgentResults();
    first.allow_submit_result = true;
    expect(deniedOfflineAgentResults()).toEqual({
      allow_submit_result: false,
      max_pending_age_seconds: 0,
    });
    expect(OFFLINE_AGENT_TOOLS).not.toContain("bfb_submit_result");
  });
  it.each([1, 300])("accepts enabled age %i", (age) => {
    expect(
      normalizeOfflineAgentResults({ allow_submit_result: true, max_pending_age_seconds: age }),
    ).toEqual({ allow_submit_result: true, max_pending_age_seconds: age });
  });
  it.each([
    undefined,
    null,
    [],
    {},
    { allow_submit_result: false },
    { allow_submit_result: true, max_pending_age_seconds: 0 },
    { allow_submit_result: false, max_pending_age_seconds: 1 },
    { allow_submit_result: true, max_pending_age_seconds: 301 },
    { allow_submit_result: true, max_pending_age_seconds: 1.5 },
    { allow_submit_result: 1, max_pending_age_seconds: 1 },
    { allow_submit_result: true, max_pending_age_seconds: "1" },
    { allow_submit_result: true, max_pending_age_seconds: 1, allowed_tools: [] },
  ])("rejects malformed permission %#", (value) =>
    expect(() => normalizeOfflineAgentResults(value)).toThrow(),
  );
  it("can tighten permission and age independently", () => {
    const parent = { allow_submit_result: true, max_pending_age_seconds: 300 };
    expect(() =>
      assertOfflineAgentResultsTightens(parent, {
        allow_submit_result: true,
        max_pending_age_seconds: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertOfflineAgentResultsTightens(parent, deniedOfflineAgentResults()),
    ).not.toThrow();
    expect(() => assertOfflineAgentResultsTightens(deniedOfflineAgentResults(), parent)).toThrow(
      /cannot widen/,
    );
    expect(() =>
      assertOfflineAgentResultsTightens(
        { allow_submit_result: true, max_pending_age_seconds: 1 },
        parent,
      ),
    ).toThrow(/cannot widen/);
  });
});
