// ABOUTME: Exercises author-private checkpoint forms, local drafts and selection-bound replies.
// ABOUTME: Uses synthetic presentation responses independently of server authority tests.

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PrivateCheckpointsPanel } from "../src/work/private-checkpoints.js";

type Props = Parameters<typeof PrivateCheckpointsPanel>[0];
const mounts: Array<{ root: Root; container: HTMLElement }> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function progress(taskId = "task-a", note = "", hasMore = false) {
  return {
    progress: {
      task_id: taskId,
      has_more: hasMore,
      checkpoints: note
        ? [
            {
              id: "checkpoint",
              body: note,
              content_hash: `sha256:${"a".repeat(64)}`,
              created_at: "2026-10-08T00:00:00Z",
              origin: "human",
            },
          ]
        : [],
    },
  };
}

function mount(initial: Partial<Props> = {}) {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounts.push({ root, container });
  let props: Props = {
    workspaceId: "workspace",
    taskId: "task-a",
    humanId: "author",
    api: { get: vi.fn(async () => progress()), post: vi.fn(async () => ({ ok: true })) },
    ...initial,
  };
  function render(next: Partial<Props> = {}) {
    props = { ...props, ...next };
    act(() => root.render(createElement(PrivateCheckpointsPanel, props)));
  }
  render();
  function button(label: string) {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === label,
    )!;
  }
  function input(body: string) {
    const field = container.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        body,
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function submit() {
    act(() =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
  }
  return { container, render, button, input, submit };
}

async function flush() {
  for (let index = 0; index < 20; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

afterEach(() => {
  for (const { root, container } of mounts.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("private checkpoint presentation", () => {
  it("keeps composition on demand with a named scope and keyboard return", async () => {
    const post = vi.fn();
    const view = mount({ api: { get: vi.fn(async () => progress()), post } });
    await flush();
    expect(view.container.textContent).toContain("Sharing this task does not share these notes");
    expect(view.container.querySelectorAll("button")).toHaveLength(1);
    expect(view.container.querySelector("form")).toBeNull();
    act(() => view.button("Add checkpoint").click());
    expect(view.container.querySelector("textarea")).toBe(document.activeElement);
    expect(view.container.querySelectorAll("form button")).toHaveLength(2);
    view.input("Local unfinished note");
    act(() => view.button("Cancel").click());
    expect(view.button("Add checkpoint")).toBe(document.activeElement);
    act(() => view.button("Add checkpoint").click());
    expect(view.container.querySelector("textarea")!.value).toBe("Local unfinished note");
    expect(post).not.toHaveBeenCalled();
  });

  it("waits for a canonical refresh before confirming a private save", async () => {
    const pending = deferred<Record<string, unknown>>();
    const get = vi
      .fn()
      .mockResolvedValueOnce(progress())
      .mockImplementationOnce(() => pending.promise);
    const post = vi.fn(async () => ({ ok: true }));
    const view = mount({ api: { get, post } });
    await flush();
    act(() => view.button("Add checkpoint").click());
    view.input("Synthetic private note");
    view.submit();
    await flush();
    expect(post).toHaveBeenCalledWith("/api/v1/workspaces/workspace/tasks/task-a/checkpoints", {
      body: "Synthetic private note",
      request_id: expect.stringMatching(/^web-checkpoint-/u),
    });
    expect(view.container.querySelectorAll("li")).toHaveLength(0);
    expect(view.container.textContent).not.toContain("Private checkpoint saved.");
    await act(async () => pending.resolve(progress("task-a", "Synthetic private note")));
    await flush();
    expect(view.container.querySelectorAll("li")).toHaveLength(1);
    expect(view.container.textContent).toContain("Not published to the task.");
    expect(view.container.querySelector("h3")).toBe(document.activeElement);
    expect(view.container.querySelector("form")).toBeNull();
  });

  it("preserves edits made while an earlier checkpoint save is pending", async () => {
    const pending = deferred<Record<string, unknown>>();
    const get = vi
      .fn()
      .mockResolvedValueOnce(progress())
      .mockResolvedValueOnce(progress("task-a", "Earlier note"));
    const view = mount({ api: { get, post: vi.fn(() => pending.promise) } });
    await flush();
    act(() => view.button("Add checkpoint").click());
    view.input("Earlier note");
    view.submit();
    view.input("Newer unsent note");
    await act(async () => pending.resolve({ ok: true }));
    await flush();
    expect(view.container.querySelector("textarea")!.value).toBe("Newer unsent note");
    expect(view.container.querySelector("textarea")).toBe(document.activeElement);
    expect(view.container.textContent).toContain("Earlier note");
  });

  it("discards late bodies and drafts when the task or human changes", async () => {
    const pending = deferred<Record<string, unknown>>();
    const get = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(progress("task-b"));
    const view = mount({ api: { get, post: vi.fn() } });
    view.render({ taskId: "task-b", humanId: "other-human" });
    await flush();
    await act(async () => pending.resolve(progress("task-a", "Earlier author's private note")));
    await flush();
    expect(view.container.textContent).not.toContain("Earlier author's private note");
    act(() => view.button("Add checkpoint").click());
    expect(view.container.querySelector("textarea")!.value).toBe("");
  });

  it("discards late mutation follow-up reads after a new selection", async () => {
    const pending = deferred<Record<string, unknown>>();
    const get = vi.fn().mockResolvedValueOnce(progress()).mockResolvedValueOnce(progress("task-b"));
    const view = mount({ api: { get, post: vi.fn(() => pending.promise) } });
    await flush();
    act(() => view.button("Add checkpoint").click());
    view.input("Task A draft");
    view.submit();
    view.render({ taskId: "task-b" });
    await flush();
    await act(async () => pending.resolve({ ok: true }));
    await flush();
    expect(get).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).not.toContain("Private checkpoint saved.");
    expect(view.container.querySelector("form")).toBeNull();
    act(() => view.button("Add checkpoint").click());
    expect(view.container.querySelector("textarea")!.value).toBe("");
  });

  it("clears denied bodies and forms, then offers only explicit read retry", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(progress("task-a", "Synthetic delivered note"))
      .mockResolvedValueOnce(progress());
    const post = vi.fn(async () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    });
    const view = mount({ api: { get, post } });
    await flush();
    act(() => view.button("Add checkpoint").click());
    view.input("Unsent note");
    view.submit();
    await flush();
    expect(view.container.textContent).toContain("Private checkpoints are unavailable");
    expect(view.container.textContent).not.toContain("Synthetic delivered note");
    expect(view.container.querySelectorAll("form,li")).toHaveLength(0);
    expect(view.container.querySelectorAll("button")).toHaveLength(1);
    act(() => view.button("Retry private checkpoints").click());
    await flush();
    expect(get).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledOnce();
    act(() => view.button("Add checkpoint").click());
    expect(view.container.querySelector("textarea")!.value).toBe("Unsent note");
  });

  it("rejects invalid local bodies without writing and exposes bounded history", async () => {
    const post = vi.fn();
    const view = mount({
      api: { get: vi.fn(async () => progress("task-a", "Newest note", true)), post },
    });
    await flush();
    expect(view.container.textContent).toContain("Showing your newest 100 checkpoints");
    act(() => view.button("Add checkpoint").click());
    for (const body of ["   ", "x".repeat(2049), "x\u0000", "x\ny", "x\ty"]) {
      view.input(body);
      view.submit();
      await flush();
    }
    expect(post).not.toHaveBeenCalled();
    expect(view.container.querySelector("textarea")!.getAttribute("aria-describedby")).toBe(
      "private-checkpoint-error",
    );
  });

  it("rejects a mismatched parent body rather than rendering another task", async () => {
    const view = mount({
      api: { get: vi.fn(async () => progress("task-b", "Other task private note")), post: vi.fn() },
    });
    await flush();
    expect(view.container.textContent).not.toContain("Other task private note");
    expect(view.container.textContent).toContain("could not be loaded");
    expect(view.container.querySelector("form")).toBeNull();
  });
});
