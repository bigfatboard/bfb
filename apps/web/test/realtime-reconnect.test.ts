// ABOUTME: Proves public realtime hooks remain inert across selection changes and manual refresh.
// ABOUTME: Discussion focus refresh uses the current HTTP callback without a socket or cursor state.

// @vitest-environment happy-dom
import { createElement, useRef } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { useDiscussionSync } from "../src/discussion/DiscussionPanel.js";
import { useRunRealtime } from "../src/realtime/useRealtime.js";

function renderHook<Props, Result>(
  hook: (props: Props) => Result,
  initialProps: Props,
): {
  result(): Result;
  rerender(props: Props): void;
  unmount(): void;
} {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const box: { current: Result | null } = { current: null };
  function Probe(props: { value: Props }): null {
    const holder = useRef(box);
    holder.current.current = hook(props.value);
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(createElement(Probe, { value: initialProps })));
  return {
    result(): Result {
      if (box.current === null) throw new Error("hook did not render");
      return box.current;
    },
    rerender(props: Props): void {
      act(() => root.render(createElement(Probe, { value: props })));
    },
    unmount(): void {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function seams() {
  return {
    fetchImpl: vi.fn(async () => Response.json({ events: [], comments: [] })),
    transport: { open: vi.fn() },
  };
}

describe("public realtime availability", () => {
  it("does not reconnect or replay after a run/workspace selection change", () => {
    const network = seams();
    const props: Parameters<typeof useRunRealtime>[0] = {
      workspaceId: "ws-1",
      taskId: "task-1",
      runId: "run-1",
      ...network,
    };
    const hook = renderHook(useRunRealtime, props);
    try {
      hook.rerender({ ...props, workspaceId: "ws-2", taskId: "task-2", runId: "run-2" });
      hook.rerender({ ...props, runId: null });
      expect(hook.result()).toEqual({ available: false });
      expect(network.fetchImpl).not.toHaveBeenCalled();
      expect(network.transport.open).not.toHaveBeenCalled();
    } finally {
      hook.unmount();
    }
  });

  it("does not manufacture history or presence without a selected run", () => {
    const network = seams();
    const hook = renderHook(useRunRealtime, {
      workspaceId: "ws-1",
      taskId: "task-1",
      runId: null,
      ...network,
    });
    try {
      expect(hook.result()).toEqual({ available: false });
      expect(network.fetchImpl).not.toHaveBeenCalled();
      expect(network.transport.open).not.toHaveBeenCalled();
    } finally {
      hook.unmount();
    }
  });

  it("uses the current discussion callback for manual and focus refresh without reconnecting", () => {
    const network = seams();
    const first = vi.fn();
    const current = vi.fn();
    const props = { workspaceId: "ws-1", onInvalidate: first, ...network };
    const hook = renderHook(useDiscussionSync, props);
    try {
      hook.rerender({ ...props, workspaceId: "ws-2", onInvalidate: current });
      act(() => hook.result().refresh());
      act(() => window.dispatchEvent(new Event("focus")));
      expect(first).not.toHaveBeenCalled();
      expect(current).toHaveBeenCalledTimes(2);
      expect(hook.result().available).toBe(false);
      expect(hook.result().refreshCount).toBe(2);
      expect(network.transport.open).not.toHaveBeenCalled();
    } finally {
      hook.unmount();
    }
  });

  it("removes the discussion focus refresh on unmount", () => {
    const callback = vi.fn();
    const network = seams();
    const hook = renderHook(useDiscussionSync, {
      workspaceId: "ws-1",
      onInvalidate: callback,
      ...network,
    });
    hook.unmount();
    act(() => window.dispatchEvent(new Event("focus")));
    expect(callback).not.toHaveBeenCalled();
    expect(network.transport.open).not.toHaveBeenCalled();
  });
});
