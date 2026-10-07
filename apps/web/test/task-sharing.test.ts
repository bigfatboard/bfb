// ABOUTME: Exercises on-demand creator sharing forms and selection-bound asynchronous replies.
// ABOUTME: Synthetic HTTP presentation tests remain separate from domain and native authorization proof.

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskSharingPanel } from "../src/work/sharing.js";

const mounts: Array<{ root: Root; container: HTMLElement }> = [];
type Props = Parameters<typeof TaskSharingPanel>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function sharing(
  taskId = "task-a",
  grants: Array<{ id: string; human_id: string }> = [],
  version = 1,
  hasMore = false,
) {
  return {
    sharing: {
      task_id: taskId,
      access_version: version,
      grants: grants.map((grant) => ({
        ...grant,
        permission: "read",
        authorization_epoch: 1,
        created_at: "2026-10-08T00:00:00Z",
      })),
      has_more: hasMore,
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
    humanId: "creator",
    members: [
      { id: "creator", display_name: "Creator" },
      { id: "person", display_name: "Synthetic colleague" },
    ],
    api: { get: vi.fn(async () => sharing()), post: vi.fn(async () => ({ ok: true })) },
    onChanged: vi.fn(),
    ...initial,
  };
  function render(next: Partial<Props> = {}) {
    props = { ...props, ...next };
    act(() => root.render(createElement(TaskSharingPanel, props)));
  }
  render();
  function button(label: string) {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent === label,
    )!;
  }
  function choose(index: number, value: string) {
    const element = container.querySelectorAll<HTMLSelectElement>("select")[index]!;
    act(() => {
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  function submit() {
    act(() =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
  }
  return { container, render, button, choose, submit };
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

describe("creator sharing presentation", () => {
  it("keeps composition on demand and reports authorized emptiness", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    const view = mount({ api: { get: vi.fn(async () => sharing()), post } });
    await flush();
    expect(view.container.textContent).toContain("No one else currently has access");
    expect(view.container.querySelector("form")).toBeNull();
    expect(view.container.querySelectorAll("button")).toHaveLength(1);
    act(() => view.button("Add person").click());
    expect(view.container.querySelectorAll("label")).toHaveLength(2);
    expect(view.container.querySelectorAll("form button")).toHaveLength(2);
    expect(
      [...view.container.querySelectorAll("option")].map((element) => element.value),
    ).not.toContain("creator");
    act(() => view.button("Cancel").click());
    expect(view.container.querySelector("form")).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("waits for canonical refresh before showing shared access", async () => {
    const pending = deferred<Record<string, unknown>>();
    const get = vi
      .fn()
      .mockResolvedValueOnce(sharing())
      .mockImplementationOnce(() => pending.promise);
    const post = vi.fn(async () => ({ ok: true, result: { grant_id: "grant" }, replayed: false }));
    const onChanged = vi.fn();
    const view = mount({ api: { get, post }, onChanged });
    await flush();
    act(() => view.button("Add person").click());
    view.choose(0, "person");
    view.choose(1, "contribute");
    view.submit();
    await flush();
    expect(post).toHaveBeenCalledWith(
      "/api/v1/workspaces/workspace/tasks/task-a/sharing/grants",
      expect.objectContaining({
        human_id: "person",
        permission: "contribute",
        expected_access_version: 1,
        request_id: expect.stringMatching(/^web-sharing-/u),
      }),
    );
    expect(onChanged).toHaveBeenCalledOnce();
    expect(view.container.textContent).not.toContain("Access shared.");
    expect(view.container.querySelectorAll(".sharing-grant")).toHaveLength(0);
    await act(async () =>
      pending.resolve(sharing("task-a", [{ id: "grant", human_id: "person" }], 2)),
    );
    await flush();
    expect(view.container.textContent).toContain("Access shared.");
    expect(view.container.textContent).toContain("Synthetic colleague");
    expect(view.container.querySelector("form")).toBeNull();
  });

  it("revoke uses the current access version without optimistic removal", async () => {
    const pending = deferred<Record<string, unknown>>();
    const get = vi
      .fn()
      .mockResolvedValueOnce(sharing("task-a", [{ id: "grant", human_id: "person" }], 7))
      .mockResolvedValueOnce(sharing("task-a", [], 8));
    const post = vi.fn(() => pending.promise);
    const view = mount({ api: { get, post } });
    await flush();
    act(() => view.button("Revoke access").click());
    await flush();
    expect(view.container.querySelectorAll(".sharing-grant")).toHaveLength(1);
    expect(post).toHaveBeenCalledWith(
      "/api/v1/workspaces/workspace/tasks/task-a/sharing/grants/grant/revoke",
      expect.objectContaining({ expected_access_version: 7 }),
    );
    await act(async () =>
      pending.resolve({ ok: true, result: { grant_id: "grant" }, replayed: false }),
    );
    await flush();
    expect(view.container.querySelectorAll(".sharing-grant")).toHaveLength(0);
    expect(view.container.textContent).toContain("Access revoked.");
  });

  for (const change of ["task", "workspace", "human"] as const) {
    it(`suppresses an old sharing body after a ${change} selection change`, async () => {
      const pending = deferred<Record<string, unknown>>();
      const get = vi
        .fn()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValueOnce(sharing(change === "task" ? "task-b" : "task-a"));
      const view = mount({ api: { get, post: vi.fn() } });
      view.render(
        change === "task"
          ? { taskId: "task-b" }
          : change === "workspace"
            ? { workspaceId: "other" }
            : { humanId: "other" },
      );
      await flush();
      await act(async () =>
        pending.resolve(sharing("task-a", [{ id: "obsolete", human_id: "obsolete-human" }])),
      );
      await flush();
      expect(view.container.textContent).not.toContain("obsolete-human");
      expect(view.container.querySelectorAll(".sharing-grant")).toHaveLength(0);
    });
  }

  it("clears denied metadata and actions, then provides an explicit retry", async () => {
    const denied = Object.assign(new Error("task not found"), { status: 404, code: "not_found" });
    const get = vi
      .fn()
      .mockResolvedValueOnce(sharing("task-a", [{ id: "grant", human_id: "person" }]))
      .mockRejectedValueOnce(denied)
      .mockResolvedValueOnce(sharing());
    const post = vi.fn(async () => ({ ok: true }));
    const view = mount({ api: { get, post } });
    await flush();
    act(() => view.button("Revoke access").click());
    await flush();
    expect(view.container.textContent).toContain("Sharing is unavailable for this task.");
    expect(view.container.textContent).not.toContain("Synthetic colleague");
    expect(view.container.querySelectorAll(".sharing-grant,form")).toHaveLength(0);
    expect(view.button("Add person")).toBeUndefined();
    act(() => view.button("Retry sharing").click());
    await flush();
    expect(view.container.textContent).toContain("No one else currently has access");
  });

  it("does not present a historical replay as a live grant and admits truthful overflow", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(sharing())
      .mockResolvedValueOnce(sharing("task-a", [], 4, true));
    const post = vi.fn(async () => ({
      ok: true,
      replayed: true,
      result: { grant_id: "historical" },
    }));
    const view = mount({ api: { get, post } });
    await flush();
    act(() => view.button("Add person").click());
    view.choose(0, "person");
    view.submit();
    await flush();
    expect(view.container.textContent).toContain("Sharing refreshed.");
    expect(view.container.textContent).not.toContain("Access shared.");
    expect(view.container.textContent).toContain("More current grants exist");
  });
});
