// ABOUTME: Proves A04 measurements render human, agent, wait, token, and provenance separately.
// ABOUTME: Server-renders the pure MeasurementsView; live timer flows run in the browser spec.

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  formatCount,
  formatDuration,
  MeasurementsView,
  type TaskMeasurementsView,
} from "../src/work/measurements.js";

const MEASUREMENTS: TaskMeasurementsView = {
  totals: {
    active_ms: 90_000,
    process_elapsed_ms: 120_000,
    attention_wait_ms: 540_000,
    exact_tokens: { input: 1200, output: 34, cache_read: 100, cache_write: null, reasoning: 5 },
    estimated_tokens: {
      input: 100,
      output: null,
      cache_read: null,
      cache_write: null,
      reasoning: null,
    },
    unavailable_token_reports: 1,
  },
  review: {
    timers: [
      {
        id: "01SYNTHETICTIMER00000000001",
        started_by_human_id: "01SYNTHETICOWNER00000000001",
        started_at: "2026-08-12T08:00:00Z",
        stopped_at: "2026-08-12T08:04:00Z",
        state: "stopped",
        resource_version: 2,
      },
    ],
    stopped_total_ms: 240_000,
    open_ms: 0,
  },
  attention: [
    {
      request_id: "01SYNTHETICATTN00000000001",
      kind: "blocker",
      blocking: true,
      state: "answered",
      first_response_ms: 30_000,
      resolution_ms: 120_000,
      open: false,
    },
  ],
  browser_activity: [
    {
      human_id: "01SYNTHETICOWNER00000000001",
      observed_ms: 300_000,
      capped_observations: 1,
      quality: "estimated",
    },
  ],
  interventions: { runs: 1, restarts: 0, submission_versions: 2 },
};

function view(props: Record<string, unknown>): string {
  return renderToString(
    createElement(MeasurementsView, {
      measurements: null,
      timers: [],
      pending: false,
      error: null,
      ...props,
    }),
  );
}

describe("A04 measurements view", () => {
  it("keeps human, agent, wait, token, and provenance sections separate", () => {
    const html = view({ measurements: MEASUREMENTS });
    expect(html).toContain('data-testid="measurements-human"');
    expect(html).toContain('data-testid="measurements-attention-latency"');
    expect(html).toContain('data-testid="measurements-browser"');
    expect(html).toContain('data-testid="measurements-agent"');
    expect(html).toContain('data-testid="measurements-waiting"');
    expect(html).toContain('data-testid="measurements-tokens"');
    expect(html).toContain('data-testid="measurements-provenance"');
    // Human review time is its own value, not folded into agent time.
    expect(html).toContain("4m 00s");
    expect(html).toContain("1m 30s");
    // Estimated and unavailable tokens never read as exact.
    expect(html).toContain("estimated");
    expect(html).toContain("1 unavailable");
  });

  it("labels empty states instead of showing zeros as facts", () => {
    const html = view({
      measurements: {
        ...MEASUREMENTS,
        attention: [],
        browser_activity: [],
        totals: {
          ...MEASUREMENTS.totals,
          exact_tokens: {
            input: null,
            output: null,
            cache_read: null,
            cache_write: null,
            reasoning: null,
          },
          estimated_tokens: {
            input: null,
            output: null,
            cache_read: null,
            cache_write: null,
            reasoning: null,
          },
          unavailable_token_reports: 0,
        },
      },
    });
    expect(html).toContain("no attention requests");
    expect(html).toContain("no observations");
    expect(html).toContain("no exact tokens");
  });

  it("offers explicit review-timer controls with per-timer stop", () => {
    const html = view({
      measurements: MEASUREMENTS,
      timers: [
        {
          id: "01SYNTHETICTIMER00000000002",
          started_by_human_id: "01SYNTHETICOWNER00000000001",
          started_at: "2026-08-12T08:00:00Z",
          stopped_at: null,
          state: "open",
          resource_version: 1,
        },
      ],
    });
    expect(html).toContain('data-testid="review-timer-start"');
    expect(html).toContain('data-testid="review-timer-stop"');
    expect(html).toContain('data-testid="review-timer-row"');
  });

  it("formats durations and counts deterministically", () => {
    expect(formatDuration(null)).toBe("unknown");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_700_000)).toBe("1h 1m");
    expect(formatCount(null)).toBe("unavailable");
    expect(formatCount(1_200_000)).toBe("1,200,000");
  });
});
