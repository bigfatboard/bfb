// ABOUTME: Proves held public feeds never start network effects or render stale positions in product panels.
// ABOUTME: Keeps authorized HTTP reads, manual discussion refresh, drafts and measurement arithmetic available.

// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiscussionPanel } from "../src/discussion/DiscussionPanel.js";
import type { DiscussionView } from "../src/discussion/api.js";
import { OperationsPage } from "../src/operations/page.js";
import { RunTimeline } from "../src/realtime/RunTimeline.js";
import { useRunRealtime } from "../src/realtime/useRealtime.js";
import { MeasurementsView, type TaskMeasurementsView } from "../src/work/measurements.js";

const mounts: { root: Root; container: HTMLElement }[] = [];

function mount(node: ReactNode, hidden = false) {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  container.hidden = hidden;
  document.body.appendChild(container);
  const root = createRoot(container);
  mounts.push({ root, container });
  const render = (next: ReactNode) => act(() => root.render(next));
  render(node);
  return { container, render };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

function transport() {
  return {
    open: vi.fn(() => ({
      onmessage: null,
      onclose: null,
      send: vi.fn(),
      close: vi.fn(),
    })),
  };
}

const DISCUSSION: DiscussionView = {
  schema_version: 1,
  scope: "human",
  discussion_id: "discussion-1",
  task_id: "task-1",
  state: "active",
  version: 1,
  deadline: "2026-10-07T12:15:00.000Z",
  brief_hash: "sha256:synthetic",
  brief: {
    schema_version: 1,
    task_id: "task-1",
    title: "Synthetic task",
    question: "Which alternative holds?",
    git_revision: "a".repeat(40),
    context: [],
  },
  participants: [],
  turns: [],
  messages: [],
};

function measurements(sources: unknown): TaskMeasurementsView {
  return {
    totals: {
      active_ms: 90_000,
      process_elapsed_ms: 120_000,
      process_alive_ms: 120_000,
      offline_ms: 20_000,
      external_wait_ms: null,
      idle_ms: null,
      attention_wait_ms: 0,
      unknown_run_counts: { process: 0, active: 0, external_wait: 1, idle: 1 },
      legacy_estimated_runs: 0,
      exact_overflow_fields: [],
      estimated_overflow_fields: [],
      exact_tokens: {
        input: 1200,
        output: 34,
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
      unavailable_token_reports: 1,
    },
    runs: [
      {
        run_id: "run-1",
        provider: "synthetic",
        sources,
        provenance: {
          ledger_events: 3,
          token_observations: 2,
          reported_intervals: 1,
          attention_observations: 0,
        },
        times: { open_intervals: 1, ambiguous_legacy_events: 0 },
        tokens: { costs: [], costs_total_usd: null, catalog_version: "synthetic" },
      },
    ],
    review: { timers: [], stopped_total_ms: 60_000, open_ms: 0 },
    attention: [],
    browser_activity: [],
    interventions: { runs: 1, restarts: 0, submission_versions: 0 },
  } as unknown as TaskMeasurementsView;
}

afterEach(() => {
  for (const { root, container } of mounts.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});

describe("public-position UI quarantine", () => {
  it("keeps a hidden timeline inert across selection changes and time", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () =>
      Response.json({ runs: [{ id: "run-1", result_state: "open" }] }),
    );
    const socket = transport();
    const props = { workspaceId: "workspace", taskId: "task-1", fetchImpl, transport: socket };
    const view = mount(createElement(RunTimeline, props), true);
    await flush();
    view.render(createElement(RunTimeline, { ...props, workspaceId: "other", taskId: "task-2" }));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(socket.open).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("Run timeline and live presence are unavailable.");
    expect(
      view.container.querySelector("[data-testid=run-presence], [data-cursor], button, select"),
    ).toBeNull();
    expect(view.container.textContent).not.toMatch(/No runs|No committed|offline|live history/i);
  });

  it("keeps the exported realtime hook unavailable without fallback reads", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ events: [], comments: [] }));
    const socket = transport();
    let result: unknown;
    function Probe() {
      result = useRunRealtime({
        workspaceId: "workspace",
        taskId: "task-1",
        runId: "run-1",
        fetchImpl,
        transport: socket,
      });
      return null;
    }
    mount(createElement(Probe));
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(socket.open).not.toHaveBeenCalled();
    expect(result).toEqual({ available: false });
  });

  it.each(["owner", "reviewer"] as const)(
    "does not load or display activity for %s across workspaces",
    async (role) => {
      const calls: string[] = [];
      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        calls.push(url);
        return Response.json(
          url.endsWith("/activity")
            ? {
                entries: [
                  { workspace_cursor: 987654, kind: "stale-private-canary", actor_type: "human" },
                ],
              }
            : { entries: [], health: {}, queues: {}, policy: null, eligible: { eligible: [] } },
        );
      };
      const props = {
        workspaceId: "workspace",
        role,
        authorizationEpoch: 1,
        csrfToken: "csrf",
        fetchImpl,
      };
      const view = mount(createElement(OperationsPage, props));
      await flush();
      view.render(createElement(OperationsPage, { ...props, workspaceId: "other" }));
      await flush();
      expect(calls.some((url) => url.endsWith("/activity"))).toBe(false);
      expect(
        view.container.querySelector("[data-testid=operations-activity]")?.textContent,
      ).toContain("Activity feed is unavailable.");
      expect(view.container.textContent).not.toMatch(
        /stale-private-canary|987654|Loading activity/,
      );
      if (role === "owner") {
        for (const path of ["/health", "/queues", "/security-audit", "/retention"])
          expect(calls.filter((url) => url.endsWith(path))).toHaveLength(2);
      } else expect(calls).toEqual([]);
    },
  );

  it.each([
    null,
    {
      sources: [
        {
          event_id: "stale-source-canary",
          kind: "turn_started",
          occurred_at: "2026-10-07T12:00:00Z",
          committed_cursor: 987654,
        },
      ],
      has_more: true,
      next_cursor: 987654,
    },
  ])("suppresses source-page state while retaining arithmetic for %j", (sources) => {
    const html = renderToString(
      createElement(MeasurementsView, {
        measurements: measurements(sources),
        timers: [],
        pending: false,
        error: null,
      }),
    );
    expect(html).toContain("Measurement source history is unavailable.");
    expect(html).not.toMatch(
      /stale-source-canary|987654|No identity-linked|first 100 canonical|authorized source API/,
    );
    expect(html).toContain("1m 30s");
    expect(html).toContain("input 1,200");
    expect(html).toContain("token reports");
    expect(html).toContain("incomplete activity pairs");
    expect(html).toContain('data-testid="review-timer-start"');
  });

  it("retains discussion HTTP refresh and drafts in a hidden panel without sockets", async () => {
    let reads = 0;
    const fetchImpl: typeof fetch = async () => {
      reads += 1;
      return Response.json({ discussion: { ...DISCUSSION, version: reads } });
    };
    const socket = transport();
    const view = mount(
      createElement(DiscussionPanel, {
        workspaceId: "workspace",
        discussionId: DISCUSSION.discussion_id,
        humanId: "human",
        humanDisplayName: "Synthetic human",
        role: "owner",
        fetchImpl,
        transport: socket,
      }),
      true,
    );
    await flush();
    const field = view.container.querySelector<HTMLTextAreaElement>(
      "[data-testid=intervene-text]",
    )!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(field, "Keep this unsent draft.");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const before = reads;
    act(() => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(reads).toBe(before + 1);
    expect(socket.open).not.toHaveBeenCalled();
    const refresh = view.container.querySelector<HTMLButtonElement>(
      "[data-testid=discussion-refresh]",
    )!;
    expect(refresh).not.toBeNull();
    act(() => refresh.click());
    await flush();
    expect(reads).toBe(before + 2);
    expect(field.value).toBe("Keep this unsent draft.");
    expect(socket.open).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("Live updates are unavailable.");
    expect(view.container.textContent).not.toMatch(
      /Discussion live|Discussion offline|Signal stale|Reconnect/,
    );
  });
});
