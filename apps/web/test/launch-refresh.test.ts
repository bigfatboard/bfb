// ABOUTME: Proves the launch card keeps reading launches after claim.
// ABOUTME: Attached, detached, ended, and containment moves surface without reload.

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LaunchStatus } from "../src/launch/api.js";
import { LaunchSection } from "../src/launch/operations.js";

interface FakeChannel {
  onmessage: ((data: string) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

function createFakeTransport(opened: FakeChannel[]): {
  open(url: string, protocol: string): FakeChannel;
} {
  return {
    open(): FakeChannel {
      const channel: FakeChannel = {
        onmessage: null,
        onclose: null,
        send(): void {},
        close(): void {},
      };
      opened.push(channel);
      return channel;
    },
  };
}

function attachedLaunch(): LaunchStatus {
  return {
    launch_id: "01JBFB0TASKW021000000000L1",
    run_id: "01JBFB0TASKW021000000000R1",
    run_execution_id: "01JBFB0TASKW021000000000E1",
    assignment_generation: 1,
    task_id: "task-1",
    project_id: "project-1",
    runner_id: "runner-1",
    checkout_id: "checkout-1",
    requesting_human_id: "human-1",
    state: "started",
    expires_at: "2026-08-07T12:02:00.000Z",
    cancelled: false,
    end_reason: null,
    execution_state: "attached",
    execution_end_reason: null,
    result_state: "open",
    activity: "working",
    lease_state: "live",
    containment_reason: null,
    agent_profile_id: "profile-1",
    provider: "fake",
    model: "synthetic",
    execution_mode: "interactive",
  };
}

function endedLaunch(): LaunchStatus {
  return {
    ...attachedLaunch(),
    execution_state: "ended",
    execution_end_reason: "process_exit",
    lease_state: "released",
  };
}

function invalidationFrame(workspaceId: string): string {
  return JSON.stringify({
    schema_version: 1,
    kind: "event.committed",
    workspace_id: workspaceId,
    high_water_cursor: 7,
  });
}

function stubFetch(state: { launches: LaunchStatus[]; launchReads: number }): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const json = async (): Promise<unknown> => {
      if (url === "/api/v1/workspaces/ws-1/tasks/task-1") {
        return {
          task: {
            id: "task-1",
            project_id: "project-1",
            title: "Synthetic launch card",
            state: "active",
            resource_version: 1,
          },
        };
      }
      if (url === "/api/v1/workspaces/ws-1/agent-profiles?limit=100") {
        return { profiles: [] };
      }
      if (url === "/api/v1/workspaces/ws-1/runners") {
        return { runners: [] };
      }
      if (url === "/api/v1/workspaces/ws-1/launches?task_id=task-1") {
        state.launchReads += 1;
        return { launches: state.launches };
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    return { status: 200, ok: true, json } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function flushRenders(rounds = 25): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function mountCard(state: { launches: LaunchStatus[]; launchReads: number }): {
  container: HTMLElement;
  opened: FakeChannel[];
  unmount(): void;
} {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const opened: FakeChannel[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      createElement(LaunchSection, {
        workspaceId: "ws-1",
        taskId: "task-1",
        humanId: "human-1",
        role: "owner",
        csrfToken: "csrf-1",
        fetchImpl: stubFetch(state),
        transport: createFakeTransport(opened),
      }),
    );
  });
  return {
    container,
    opened,
    unmount(): void {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("launch card refresh after claim", () => {
  it("re-reads a started launch on the refresh interval", async () => {
    vi.useFakeTimers();
    const state = { launches: [attachedLaunch()], launchReads: 0 };
    const card = mountCard(state);
    try {
      await flushRenders();
      expect(card.container.textContent).toMatch(/Provider attached/);
      const initialReads = state.launchReads;
      expect(initialReads).toBeGreaterThan(0);

      // The Mac reports the process exit; the card must show it without a reload.
      state.launches = [endedLaunch()];
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      await flushRenders();
      expect(state.launchReads).toBeGreaterThan(initialReads);
      expect(card.container.textContent).toMatch(/Process ended/);
    } finally {
      card.unmount();
    }
  });

  it("refetches launches on a realtime invalidation", async () => {
    vi.useFakeTimers();
    const state = { launches: [attachedLaunch()], launchReads: 0 };
    const card = mountCard(state);
    try {
      await flushRenders();
      expect(card.container.textContent).toMatch(/Provider attached/);
      const channel = card.opened[0];
      if (!channel) throw new Error("launch realtime socket did not open");

      state.launches = [{ ...attachedLaunch(), execution_state: "detached", lease_state: "live" }];
      const readsBefore = state.launchReads;
      await act(async () => {
        channel.onmessage?.(invalidationFrame("ws-1"));
      });
      await flushRenders();
      expect(state.launchReads).toBeGreaterThan(readsBefore);
      expect(card.container.textContent).toMatch(/Execution detached/);
    } finally {
      card.unmount();
    }
  });

  it("stops polling once every launch settles", async () => {
    vi.useFakeTimers();
    const state = { launches: [endedLaunch()], launchReads: 0 };
    const card = mountCard(state);
    try {
      await flushRenders();
      expect(card.container.textContent).toMatch(/Process ended/);
      const settledReads = state.launchReads;
      await act(async () => {
        vi.advanceTimersByTime(30000);
      });
      await flushRenders();
      expect(state.launchReads).toBe(settledReads);
    } finally {
      card.unmount();
    }
  });
});
