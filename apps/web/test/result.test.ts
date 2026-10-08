// ABOUTME: Proves A03 result and review markup across roles and outdated states.
// ABOUTME: Server-renders the pure ResultView; live review flows run in the browser spec.

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResultView, type SubmissionView } from "../src/work/result.js";

const CURRENT: SubmissionView = {
  id: "01SUBMISSIONCURRENT000000001",
  version: 2,
  summary: "Synthetic current result",
  limitations: "",
  evidence_refs: [{ kind: "comment", ref: "synthetic-comment" }],
  git_branch: "main",
  git_commit: `${"a".repeat(40)}`,
  git_dirty: false,
  submitted_by_kind: "agent_run",
  submitted_at: "2026-08-12T08:00:00Z",
  superseded: false,
  outdated: false,
  outdated_reasons: [],
};

const SUPERSEDED: SubmissionView = {
  ...CURRENT,
  id: "01SUBMISSIONSUPERSEDED0000001",
  version: 1,
  summary: "Synthetic outdated result",
  superseded: true,
  outdated: true,
  outdated_reasons: ["superseded"],
};

const RUNS = [
  {
    id: "01SYNTHETICRU00000000000001",
    result_state: "submitted",
    activity: "idle",
    resource_version: 2,
  },
];

function view(props: Record<string, unknown>): string {
  return renderToString(
    createElement(ResultView, {
      runs: [],
      submissions: [],
      taskState: "active",
      role: "owner",
      pending: false,
      error: null,
      comment: "",
      ...props,
    }),
  );
}

describe("A03 result view", () => {
  it("shows the current submission with review actions for owners", () => {
    const html = view({ runs: RUNS, submissions: [CURRENT], taskState: "review" });
    expect(html).toContain("Synthetic current result");
    expect(html).toContain("result-current");
    expect(html).toContain("result-evidence-count");
    expect(html).toContain("reference");
    expect(html).toContain("main");
    expect(html).toContain("aaaaaaaaaaaa");
    expect(html).toContain("request-changes-form");
    expect(html).toContain("accept-result");
    expect(html).not.toContain("result-outdated");
  });

  it("marks outdated versions and hides acceptance from reviewers", () => {
    const html = view({
      runs: RUNS,
      submissions: [CURRENT, SUPERSEDED],
      taskState: "review",
      role: "reviewer",
    });
    expect(html).toContain("result-outdated");
    expect(html).toContain("a newer version exists");
    expect(html).toContain("Synthetic outdated result");
    expect(html).toContain("request-changes-form");
    expect(html).not.toContain("accept-result");
  });

  it("explains stale submissions and surfaces review errors", () => {
    const stale = {
      ...CURRENT,
      outdated: true,
      outdated_reasons: ["config_changed"],
    };
    const html = view({
      runs: RUNS,
      submissions: [stale],
      taskState: "review",
      role: "member",
      error: "stale_version: run version conflict",
    });
    expect(html).toContain("result-stale-note");
    expect(html).toContain("run configuration changed after submission");
    expect(html).toContain("result-error");
    expect(html).toContain("stale_version");
    expect(html).not.toContain("request-changes-form");
    expect(html).not.toContain("accept-result");
  });

  it("shows terminal runs without review actions", () => {
    const html = view({
      runs: [{ ...RUNS[0], result_state: "accepted" }],
      submissions: [CURRENT],
      taskState: "done",
    });
    expect(html).toContain("accepted");
    expect(html).not.toContain("request-changes-form");
    expect(html).not.toContain("accept-result");
  });

  it("shows an empty state before any run exists", () => {
    expect(view({})).toContain("result-empty");
  });
});
