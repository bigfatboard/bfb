// ABOUTME: Proves a stale socket close never reports a live session offline.
// ABOUTME: A replaced channel's late close must not clear the new connection.

// @vitest-environment happy-dom
import { createElement, useRef } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { useDiscussionSync } from "../src/discussion/DiscussionPanel.js";
import { useRunRealtime } from "../src/realtime/useRealtime.js";

interface FakeChannel {
  onmessage: ((data: string) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

interface FakeTransport {
  open(url: string, protocol: string): FakeChannel;
}

/** Sockets close asynchronously, so close() stays silent and the test fires the late event by hand. */
function createFakeTransport(opened: FakeChannel[]): FakeTransport {
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

function readyFrame(workspaceId: string, connectionId: string): string {
  return JSON.stringify({
    schema_version: 1,
    kind: "browser.realtime.ready",
    workspace_id: workspaceId,
    connection_id: connectionId,
    high_water_cursor: 0,
    server_time: "2026-09-12T12:00:00.000Z",
  });
}

function stubFetch(): typeof fetch {
  return (async () =>
    ({
      status: 200,
      ok: true,
      json: async () => ({ events: [], has_more: false, comments: [] }),
    }) as unknown as Response) as unknown as typeof fetch;
}

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
    // The ref indirection keeps the latest render output reachable outside React.
    const holder = useRef(box);
    holder.current.current = hook(props.value);
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(createElement(Probe, { value: initialProps }));
  });
  return {
    result(): Result {
      const current = box.current;
      if (current === null) throw new Error("hook did not render");
      return current;
    },
    rerender(props: Props): void {
      act(() => {
        root.render(createElement(Probe, { value: props }));
      });
    },
    unmount(): void {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const OFFLINE_NOTICE = "Realtime offline. Committed history below stays authoritative.";

describe("stale realtime close", () => {
  it("ignores the old run-timeline socket close after reconnect", async () => {
    const opened: FakeChannel[] = [];
    const hook = renderHook(useRunRealtime, {
      workspaceId: "ws-1",
      taskId: "task-1",
      runId: "run-1",
      fetchImpl: stubFetch(),
      transport: createFakeTransport(opened),
      nowImpl: () => Date.now(),
    });
    try {
      const first = opened[0];
      if (!first) throw new Error("realtime socket did not open");
      await act(async () => {
        first.onmessage?.(readyFrame("ws-1", "conn-a"));
      });
      expect(hook.result().connectivity).toBe("live");

      await act(async () => {
        hook.result().reconnect();
      });
      const second = opened[1];
      if (!second) throw new Error("reconnect did not open a new socket");
      await act(async () => {
        second.onmessage?.(readyFrame("ws-1", "conn-b"));
      });
      // The replaced socket's close handshake lands after the new ready.
      await act(async () => {
        first.onclose?.({ code: 1005, reason: "" });
      });

      expect(hook.result().notice).toBeNull();
      expect(hook.result().connectivity).toBe("live");
    } finally {
      hook.unmount();
    }
  });

  it("ignores the old run-timeline socket close after a run switch", async () => {
    const opened: FakeChannel[] = [];
    const props = {
      workspaceId: "ws-1",
      taskId: "task-1",
      runId: "run-1",
      fetchImpl: stubFetch(),
      transport: createFakeTransport(opened),
      nowImpl: () => Date.now(),
    };
    const hook = renderHook(useRunRealtime, props);
    try {
      const first = opened[0];
      if (!first) throw new Error("realtime socket did not open");
      await act(async () => {
        first.onmessage?.(readyFrame("ws-1", "conn-a"));
      });

      hook.rerender({ ...props, runId: "run-2" });
      const second = opened[1];
      if (!second) throw new Error("run switch did not open a new socket");
      await act(async () => {
        second.onmessage?.(readyFrame("ws-1", "conn-b"));
      });
      await act(async () => {
        first.onclose?.({ code: 1005, reason: "" });
      });

      expect(hook.result().notice).toBeNull();
      expect(hook.result().connectivity).toBe("live");
    } finally {
      hook.unmount();
    }
  });

  it("ignores the old discussion socket close after reconnect", async () => {
    const opened: FakeChannel[] = [];
    let invalidations = 0;
    const hook = renderHook(useDiscussionSync, {
      workspaceId: "ws-1",
      onInvalidate: () => {
        invalidations += 1;
      },
      transport: createFakeTransport(opened),
      nowImpl: () => Date.now(),
    });
    try {
      const first = opened[0];
      if (!first) throw new Error("discussion socket did not open");
      await act(async () => {
        first.onmessage?.(readyFrame("ws-1", "conn-a"));
      });
      expect(hook.result().connectivity).toBe("live");

      await act(async () => {
        hook.result().reconnect();
      });
      const second = opened[1];
      if (!second) throw new Error("reconnect did not open a new socket");
      await act(async () => {
        second.onmessage?.(readyFrame("ws-1", "conn-b"));
      });
      await act(async () => {
        first.onclose?.({ code: 1005, reason: "" });
      });

      expect(hook.result().notice).toBeNull();
      expect(hook.result().connectivity).toBe("live");
      expect(invalidations).toBeGreaterThan(0);
    } finally {
      hook.unmount();
    }
  });

  it("still reports a genuine close on the current socket", async () => {
    const opened: FakeChannel[] = [];
    const hook = renderHook(useRunRealtime, {
      workspaceId: "ws-1",
      taskId: "task-1",
      runId: "run-1",
      fetchImpl: stubFetch(),
      transport: createFakeTransport(opened),
      nowImpl: () => Date.now(),
    });
    try {
      const first = opened[0];
      if (!first) throw new Error("realtime socket did not open");
      await act(async () => {
        first.onmessage?.(readyFrame("ws-1", "conn-a"));
      });
      await act(async () => {
        first.onclose?.({ code: 1005, reason: "" });
      });

      expect(hook.result().notice).toBe(OFFLINE_NOTICE);
      expect(hook.result().connectivity).toBe("offline");
    } finally {
      hook.unmount();
    }
  });
});
