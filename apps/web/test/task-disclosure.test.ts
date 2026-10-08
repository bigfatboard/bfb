// ABOUTME: Checks on-demand task sections, selection races and keyboard focus without business writes.
// ABOUTME: Keeps failed reads, current workspace identity and reviewer permissions distinct from presentation.

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkMutations, type WorkMutationsProps } from "../src/work/mutations.js";
import { SecurityPage } from "../src/auth/onboarding.js";

const mounts: { root: Root; container: HTMLElement }[] = [];

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

function task(id: string, title = `Task ${id}`) {
  return {
    id,
    title,
    project_id: "project",
    state: "ready",
    priority: "P2",
    next_owner_type: "human",
    next_owner_id: "human",
    next_action_reason: "Review the evidence.",
    punchline: "Waiting for a human decision.",
    resource_version: 1,
  };
}

function mockAPI(
  read: (id: string, workspace: string) => Promise<Response> = async (id) =>
    Response.json({ task: task(id) }),
) {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    const match = url.match(/^\/api\/v1\/workspaces\/([^/]+)\/tasks\/([^/?]+)$/u);
    if (match) return read(match[2]!, match[1]!);
    if (url === "/api/v1/_substrate") return Response.json({ ok: true, features: {} });
    if (url.includes("/comments?")) return Response.json({ comments: [] });
    if (url.includes("/context?")) return Response.json({ context: [] });
    if (url.includes("/members?"))
      return Response.json({
        members: [{ id: "human", display_name: "Synthetic owner", role: "owner" }],
      });
    throw new Error(`Unexpected request: ${url}`);
  };
  return { fetchImpl, calls };
}

function mountTask(fetchImpl: typeof fetch, initial: Partial<WorkMutationsProps> = {}) {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounts.push({ root, container });
  let props: WorkMutationsProps = {
    workspaceId: "workspace",
    selectedTaskId: "a",
    humanId: "human",
    role: "owner",
    agentProfiles: [],
    fetchImpl,
    csrfToken: "csrf",
    onChanged: vi.fn(),
    onClose: vi.fn(),
    ...initial,
  };
  function render(next: Partial<WorkMutationsProps> = {}) {
    props = { ...props, ...next };
    act(() => root.render(createElement(WorkMutations, props)));
  }
  render();
  function section(value: string) {
    const select = container.querySelector<HTMLSelectElement>("[data-testid=task-section]")!;
    act(() => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  return { container, render, section };
}

afterEach(() => {
  for (const { root, container } of mounts.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

describe("progressive task disclosure", () => {
  it("starts with overview and two item controls, without mounting operational panels", async () => {
    const api = mockAPI();
    const view = mountTask(api.fetchImpl);
    await flush();
    expect(view.container.querySelector("h2")?.textContent).toBe("Task a");
    expect(
      view.container.querySelector(".task-panel-actions")?.querySelectorAll("button,select"),
    ).toHaveLength(2);
    expect(view.container.querySelectorAll("form,iframe,[data-panel]")).toHaveLength(0);
    expect(api.calls.every((call) => call.method === "GET")).toBe(true);
    expect(
      api.calls.some((call) =>
        /measurements|launches|discussions|artifacts|events|results/u.test(call.url),
      ),
    ).toBe(false);
    view.section("comments");
    expect(view.container.querySelector("[data-panel=comments]")?.hasAttribute("hidden")).toBe(
      false,
    );
    expect(view.container.querySelector("[data-testid=comment-form]")).toBeNull();
    view.section("overview");
    expect(view.container.querySelector("[data-panel=comments]")?.hasAttribute("hidden")).toBe(
      true,
    );
    expect(api.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("does not replace the selected task with a late response", async () => {
    let resolveA!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveA = resolve;
    });
    const api = mockAPI(async (id) => (id === "a" ? pending : Response.json({ task: task(id) })));
    const view = mountTask(api.fetchImpl);
    view.render({ selectedTaskId: "b" });
    await flush();
    expect(view.container.querySelector("h2")?.textContent).toBe("Task b");
    await act(async () => resolveA(Response.json({ task: task("a", "Obsolete task") })));
    await flush();
    expect(view.container.querySelector("h2")?.textContent).toBe("Task b");
    expect(view.container.textContent).not.toContain("Obsolete task");
  });

  it("never exposes a cached task from a different workspace with the same task ID", async () => {
    let resolveNext!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveNext = resolve;
    });
    const api = mockAPI(async (id, workspace) =>
      workspace === "other" ? pending : Response.json({ task: task(id, "First workspace") }),
    );
    const view = mountTask(api.fetchImpl);
    await flush();
    view.render({ workspaceId: "other" });
    expect(view.container.textContent).not.toContain("First workspace");
    await act(async () => resolveNext(Response.json({ task: task("a", "Second workspace") })));
    await flush();
    expect(view.container.querySelector("h2")?.textContent).toBe("Second workspace");
  });

  it("shows a failed read with retry rather than cached current task content", async () => {
    let failed = true;
    const api = mockAPI(async (id) =>
      failed
        ? Response.json({ error: "forbidden", message: "Access denied" }, { status: 403 })
        : Response.json({ task: task(id) }),
    );
    const view = mountTask(api.fetchImpl);
    await flush();
    expect(view.container.querySelector("[role=alert]")?.textContent).toContain("Access denied");
    expect(view.container.querySelector("[data-testid=task-section]")).toBeNull();
    failed = false;
    const retry = [...view.container.querySelectorAll("button")].find(
      (node) => node.textContent === "Try again",
    )!;
    act(() => retry.click());
    await flush();
    expect(view.container.querySelector("h2")?.textContent).toBe("Task a");
  });

  it("keeps owner-only editing and handoff out of reviewer discovery", async () => {
    const view = mountTask(mockAPI().fetchImpl, { role: "reviewer" });
    await flush();
    const options = [...view.container.querySelectorAll("option")].map((node) => node.value);
    expect(options).not.toContain("edit");
    expect(options).not.toContain("handoff");
    expect(options).toContain("comments");
    view.section("context");
    expect(view.container.querySelector("[data-testid=context-form]")).toBeNull();
    view.section("artifacts");
    expect(
      view.container.querySelector("[data-testid=artifact-features-unavailable]"),
    ).not.toBeNull();
    expect(view.container.querySelector("iframe")).toBeNull();
  });

  it("focuses the heading on open and restores the originating control on close", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = mountTask(mockAPI().fetchImpl, { selectedTaskId: null, onClose });
    view.render({ selectedTaskId: "a" });
    await flush();
    expect(document.activeElement).toBe(view.container.querySelector("h2"));
    act(() =>
      view.container
        .querySelector("h2")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(onClose).toHaveBeenCalledOnce();
    view.render({ selectedTaskId: null });
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

it("offers a fresh explicit enrollment flow even when an existing passkey is registered", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounts.push({ root, container });
  const fetchImpl: typeof fetch = async () =>
    Response.json({ passkeys: [{ id: "key", name: "Existing key" }] });
  act(() =>
    root.render(
      createElement(SecurityPage, {
        fetchImpl,
        csrfToken: "csrf",
        search: "?passkey_enrollment=01K00000000000000000000009",
        navigate: vi.fn(),
      }),
    ),
  );
  await flush();
  expect(container.querySelector("input[name=name]")).not.toBeNull();
  expect(container.textContent).not.toContain("Existing key");
});
