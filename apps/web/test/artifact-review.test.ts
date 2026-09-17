// ABOUTME: Proves V03 review markup across approval, history, conflict, and hostile states.
// ABOUTME: Server-renders the pure ReviewView; live review flows run in the browser spec.

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ReviewView,
  type ArtifactStatusView,
  type ArtifactSummaryView,
  type ReviewEntryView,
} from "../src/artifacts/ArtifactReview.js";

const VERSION = {
  id: "01SYNTHETICV03000000000001",
  state: "available",
  format: "markdown",
  content_hash: "c".repeat(64),
  created_at: "2026-09-17T12:00:00.000Z",
  available_at: "2026-09-17T12:00:01.000Z",
  approvals: 1,
  changes_requested: 0,
};

const ARTIFACTS: ArtifactSummaryView[] = [
  {
    artifact_id: "01SYNTHETICA03000000000001",
    run_id: "01SYNTHETICRUN030000000001",
    format: "markdown",
    role: "review",
    created_at: "2026-09-17T12:00:00.000Z",
    version_count: 1,
    latest_version: VERSION,
    approved: true,
    changes_requested: false,
    review_count: 1,
  },
];

const REVIEW: ReviewEntryView = {
  id: "01SYNTHETICR03000000000001",
  version_id: VERSION.id,
  content_hash: VERSION.content_hash,
  reviewer_human_id: "01SYNTHETICOWN000000000001",
  decision: "approve",
  comment: "Synthetic approval",
  git_commit: null,
  config_hash: null,
  review_timer_observation_id: null,
  created_at: "2026-09-17T12:01:00.000Z",
  historical: false,
  outdated: false,
  outdated_reasons: [],
};

const STATUS: ArtifactStatusView = {
  artifact_id: ARTIFACTS[0]?.artifact_id ?? "",
  run_id: "01SYNTHETICRUN030000000001",
  latest_version: VERSION,
  approved: true,
  changes_requested: false,
  review_count: 1,
  historical_count: 0,
  linked_submissions: [],
  reviews: [REVIEW],
};

function view(props: Record<string, unknown>): string {
  return renderToString(
    createElement(ReviewView, {
      artifacts: [],
      selectedArtifactId: null,
      status: null,
      artifactOrigin: null,
      workspaceId: "01SYNTHETICWS0000000000001",
      csrfToken: "synthetic-csrf",
      taskId: "01SYNTHETICTASK00000000001",
      role: "owner",
      pending: false,
      error: null,
      conflict: false,
      comment: "",
      ...props,
    }),
  );
}

describe("V03 review view", () => {
  it("shows the empty state without artifacts", () => {
    const html = view({});
    expect(html).toContain("No review artifacts yet.");
    expect(html).toContain("never accepts the run result");
  });

  it("shows approval with exact version and hash provenance", () => {
    const html = view({ artifacts: ARTIFACTS, selectedArtifactId: ARTIFACTS[0]?.artifact_id, status: STATUS });
    expect(html).toContain("Approved");
    expect(html).toContain(VERSION.id.slice(0, 8));
    expect(html).toContain(VERSION.content_hash.slice(0, 12));
    expect(html).toContain("Synthetic approval");
    expect(html).not.toContain("Unapproved");
  });

  it("shows each newer version as unapproved with historical reviews", () => {
    const historical: ReviewEntryView = {
      ...REVIEW,
      historical: true,
      outdated: true,
      outdated_reasons: ["newer_version", "config_changed", "git_changed"],
    };
    const html = view({
      artifacts: [{ ...ARTIFACTS[0], approved: false } as ArtifactSummaryView],
      selectedArtifactId: ARTIFACTS[0]?.artifact_id,
      status: { ...STATUS, approved: false, historical_count: 1, reviews: [historical] },
    });
    expect(html).toContain("Unapproved");
    expect(html).toContain("historical");
    expect(html).toContain("a newer version exists");
    expect(html).toContain("run configuration changed after this review");
    expect(html).toContain("submission commit changed after this review");
  });

  it("renders hostile comments as inert text", () => {
    const hostile = `</script><script>alert(document.cookie)</script><img src=x onerror=alert(1)>`;
    const html = view({
      artifacts: ARTIFACTS,
      selectedArtifactId: ARTIFACTS[0]?.artifact_id,
      status: { ...STATUS, reviews: [{ ...REVIEW, decision: "comment", comment: hostile }] },
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("onerror=alert(1)");
  });

  it("lists linked submissions with their result state", () => {
    const html = view({
      artifacts: ARTIFACTS,
      selectedArtifactId: ARTIFACTS[0]?.artifact_id,
      status: {
        ...STATUS,
        linked_submissions: [
          {
            submission_id: "01SYNTHETICSUB00000000001",
            run_id: "01SYNTHETICRUN030000000001",
            submission_version: 1,
            result_state: "submitted",
            bound_version: VERSION.id,
            references_current_version: true,
          },
        ],
      },
    });
    expect(html).toContain("Linked submissions");
    expect(html).toContain("review-linked-count");
    expect(html).toContain("submitted");
  });

  it("shows explicit version conflicts with a reload action", () => {
    const html = view({
      artifacts: ARTIFACTS,
      selectedArtifactId: ARTIFACTS[0]?.artifact_id,
      status: STATUS,
      error: "stale_version: a newer artifact version needs review",
      conflict: true,
    });
    expect(html).toContain("This version changed.");
    expect(html).toContain("Reload current version");
  });

  it("shows requested changes and the authority boundary", () => {
    const html = view({
      artifacts: ARTIFACTS,
      selectedArtifactId: ARTIFACTS[0]?.artifact_id,
      status: {
        ...STATUS,
        approved: false,
        changes_requested: true,
        reviews: [{ ...REVIEW, decision: "request_changes", comment: "Fix the heading" }],
      },
    });
    expect(html).toContain("Changes were requested on this version.");
    expect(html).toContain("Approve version");
    expect(html).toContain("Request changes");
    expect(html).toContain("never grants launch, policy, or credential authority");
  });
});
