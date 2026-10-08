// ABOUTME: Pins the X05 Operations presentation contract: role gating, labels, and safe rendering.
// ABOUTME: DOM behavior is proven in the Playwright spec; this suite pins the presentation contract.

import { describe, expect, it } from "vitest";

import {
  buildRecoveryBody,
  describeStuckItem,
  formatCount,
  operationsPath,
  OPS_SECTION_LABELS,
  visibleSections,
} from "../src/operations/api.js";

describe("operations presentation", () => {
  it("gates privileged sections by role", () => {
    expect(visibleSections("owner")).toContain("securityAudit");
    expect(visibleSections("owner")).toContain("retention");
    expect(visibleSections("owner")).toContain("diagnostics");
    expect(visibleSections("member")).not.toContain("securityAudit");
    expect(visibleSections("member")).toContain("retention");
    expect(visibleSections("member")).toContain("diagnostics");
    expect(visibleSections("reviewer")).toEqual(["activity"]);
  });

  it("labels every section distinctly", () => {
    expect(Object.keys(OPS_SECTION_LABELS).sort()).toEqual([
      "activity",
      "diagnostics",
      "health",
      "queues",
      "retention",
      "securityAudit",
    ]);
  });

  it("builds scoped operations paths", () => {
    expect(operationsPath("ws1", "/health")).toBe("/api/v1/workspaces/ws1/operations/health");
    expect(operationsPath("ws1", "/diagnostics/b1/consent")).toBe(
      "/api/v1/workspaces/ws1/operations/diagnostics/b1/consent",
    );
  });

  it("describes stuck items with truncated ids and ages only", () => {
    const text = describeStuckItem({ command_id: "01JSTUCKCOMMAND000000000001", age_ms: 90_000 });
    expect(text).toContain("01JSTUCK");
    expect(text).toContain("90s");
    expect(text).not.toContain("01JSTUCKCOMMAND000000000001");
  });

  it("formats counts without inventing values", () => {
    expect(formatCount(3)).toBe("3");
    expect(formatCount(null)).toBe("—");
    expect(formatCount(Number.NaN)).toBe("—");
  });

  it("builds recovery bodies with closed kinds and fresh keys", () => {
    const first = buildRecoveryBody("resolve_stuck_upload", { version_ids: ["v1"] });
    const second = buildRecoveryBody("resolve_stuck_upload", { version_ids: ["v1"] });
    expect(first.kind).toBe("resolve_stuck_upload");
    expect(first.request_id).toMatch(/^ops-[0-9a-f]{32}$/);
    expect(second.request_id).not.toBe(first.request_id);
  });
});
