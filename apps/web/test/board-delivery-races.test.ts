// ABOUTME: Proves mounted board delivery stays bound to the current human, workspace incarnation and latest read.
// ABOUTME: Deferred HTTP and JSON responses expose stale content, profiles, authority and loading-state races.

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectLane } from "@bfb/domain";
import { AppShell } from "../src/app.js";

type Scope = "alpha" | "beta";
type Role = "owner" | "member" | "reviewer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface BoardRead {
  scope: Scope;
  board: ReturnType<typeof deferred<Response>>;
  profiles: ReturnType<typeof deferred<Response>>;
}

function board(
  scope: Scope,
  label: string = scope,
  role: Role = "owner",
  humanId = "human-current",
) {
  const lanes: ProjectLane[] = [
    {
      projectId: `project-${scope}`,
      name: `Synthetic ${scope} project`,
      slug: `project-${scope}`,
      tint: "#197d7d",
      tasks: [
        {
          taskId: `task-${scope}`,
          projectId: `project-${scope}`,
          title: `SYNTHETIC-${label}-TASK`,
          state: "ready",
          priority: "P2",
          punchline: `SYNTHETIC-${label}-CONTENT`,
          nowLabel: "NOW",
          whyDelegable: "An independent synthetic review is allowed",
          passToAgentProfileId: "profile-shared-name",
          projectTint: "#197d7d",
          topEdgePx: 3,
          sideStripe: false,
          runSummary: { resultState: "open", activity: "unknown" },
        },
      ],
    },
  ];
  return {
    human: { id: humanId, display_name: `Synthetic ${humanId}` },
    role,
    authorization_epoch: 1,
    lanes,
    needs_now: [],
    agent_work_available: false,
  };
}

function profiles(label: string) {
  return {
    profiles: [
      { id: "profile-shared-name", name: `SYNTHETIC-${label}-PROFILE`, provider: "synthetic" },
    ],
  };
}

function backend() {
  const reads: BoardRead[] = [];
  const calls: Array<{ path: string; method: string }> = [];
  const creates: Array<{ scope: Scope; reply: ReturnType<typeof deferred<Response>> }> = [];
  const state = { humanId: "human-current" };
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = String(input),
      method = init?.method ?? "GET";
    calls.push({ path, method });
    if (path === "/auth/session")
      return Response.json({
        human: {
          id: state.humanId,
          email: "human@synthetic.test",
          display_name: `Synthetic ${state.humanId}`,
        },
        csrf_token: "synthetic-csrf",
      });
    if (path === "/api/v1/workspaces")
      return Response.json({
        workspaces: [
          {
            id: "workspace-alpha",
            slug: "alpha",
            jurisdiction: "eu",
            role: "owner",
            authorization_epoch: 1,
          },
          {
            id: "workspace-beta",
            slug: "beta",
            jurisdiction: "eu",
            role: "owner",
            authorization_epoch: 1,
          },
        ],
      });
    const request = path.match(
      /^\/api\/v1\/workspaces\/workspace-(alpha|beta)\/(board|agent-profiles\?limit=100)$/u,
    );
    if (request) {
      const scope = request[1] as Scope;
      if (request[2] === "board") {
        const read = { scope, board: deferred<Response>(), profiles: deferred<Response>() };
        reads.push(read);
        return read.board.promise;
      }
      const read = reads.filter((candidate) => candidate.scope === scope).at(-1);
      if (!read) throw new Error("Synthetic profile read has no paired board request");
      return read.profiles.promise;
    }
    const create = path.match(/^\/api\/v1\/workspaces\/workspace-(alpha|beta)\/tasks$/u);
    if (create && method === "POST") {
      const entry = { scope: create[1] as Scope, reply: deferred<Response>() };
      creates.push(entry);
      return entry.reply.promise;
    }
    if (path === "/api/v1/_substrate") return Response.json({ ok: true, features: {} });
    const task = path.match(/^\/api\/v1\/workspaces\/workspace-(alpha|beta)\/tasks\/([^/?]+)$/u);
    if (task)
      return Response.json({
        task: {
          id: task[2],
          project_id: `project-${task[1]}`,
          title: "Synthetic committed task",
          state: "ready",
          priority: "P2",
          next_owner_type: "unassigned",
          next_owner_id: null,
          next_action_reason: null,
          punchline: "",
          resource_version: 1,
        },
      });
    if (path.includes("/comments?")) return Response.json({ comments: [] });
    if (path.includes("/context?")) return Response.json({ context: [] });
    if (path.includes("/members?")) return Response.json({ members: [] });
    if (path.endsWith("/runs")) return Response.json({ runs: [] });
    throw new Error(`Unexpected synthetic board request: ${method} ${path}`);
  };
  return { fetchImpl, reads, calls, creates, state };
}

const mounted: Array<{ root: Root; container: HTMLElement; active: boolean }> = [];
async function flush() {
  for (let round = 0; round < 25; round += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

function mount(service: ReturnType<typeof backend>) {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState({}, "", "/w/alpha");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container),
    entry = { root, container, active: true };
  mounted.push(entry);
  const render = (fetchImpl: typeof fetch) =>
    act(() => root.render(createElement(AppShell, { fetchImpl })));
  render(service.fetchImpl);
  return {
    container,
    refresh() {
      render((input, init) => service.fetchImpl(input, init));
    },
    unmount() {
      if (entry.active) {
        act(() => root.unmount());
        entry.active = false;
        container.remove();
      }
    },
  };
}

function switchWorkspace(container: HTMLElement, scope: Scope) {
  const select = container.querySelector<HTMLSelectElement>("[data-testid=workspace-switcher]");
  expect(select).not.toBeNull();
  act(() => {
    select!.value = scope;
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function latest(service: ReturnType<typeof backend>, scope: Scope): BoardRead {
  const read = service.reads.filter((candidate) => candidate.scope === scope).at(-1);
  expect(read).toBeDefined();
  return read!;
}

async function submitCreate(container: HTMLElement, service: ReturnType<typeof backend>) {
  const count = service.creates.length;
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "New task",
  );
  expect(button).toBeDefined();
  act(() => button!.click());
  const input = container.querySelector<HTMLInputElement>("[data-testid=create-task-title]")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Synthetic callback task",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const form = container.querySelector("[data-testid=create-task-form]")!;
  act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await flush();
  expect(service.creates).toHaveLength(count + 1);
  return service.creates[count]!;
}

async function complete(
  read: BoardRead,
  label: string = read.scope,
  role: Role = "owner",
  humanId = "human-current",
) {
  await act(async () => {
    read.board.resolve(Response.json(board(read.scope, label, role, humanId)));
    read.profiles.resolve(Response.json(profiles(label)));
  });
  await flush();
}

function labels(container: HTMLElement) {
  return [...container.querySelectorAll(".route-nav button")].map((button) => button.textContent);
}
function expectNoOldAuthority(container: HTMLElement, label: string) {
  expect(container.textContent).not.toContain(`SYNTHETIC-${label}-TASK`);
  expect(container.textContent).not.toContain(`SYNTHETIC-${label}-PROFILE`);
  expect(container.querySelector("[data-testid=work-board]")).toBeNull();
  expect(labels(container)).not.toContain("Projects & policy");
  expect(labels(container)).not.toContain("Operations");
  expect(container.querySelector("[data-testid=current-role]")?.textContent?.trim()).not.toMatch(
    /^(owner|member|reviewer)$/u,
  );
}

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    if (entry.active) act(() => entry.root.unmount());
    entry.container.remove();
  }
  await flush();
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  window.history.replaceState({}, "", "/");
});

describe("mounted board delivery races", () => {
  it("renders a current successful board with profiles and unchanged default actions", async () => {
    const service = backend(),
      view = mount(service);
    await flush();
    await complete(latest(service, "alpha"));
    expect(view.container.textContent).toContain("SYNTHETIC-alpha-TASK");
    expect(view.container.textContent).toContain("SYNTHETIC-alpha-PROFILE");
    expect(view.container.querySelector("[data-testid=current-role]")?.textContent?.trim()).toBe(
      "owner",
    );
    const card = view.container.querySelector(".task-card")!;
    expect(card.querySelectorAll(":scope > button, :scope > details > summary")).toHaveLength(2);
    expect(service.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("holds a healthy board response belonging to a different session human", async () => {
    const service = backend(),
      view = mount(service);
    await flush();
    await complete(latest(service, "alpha"), "foreign-human", "owner", "human-other");
    expectNoOldAuthority(view.container, "foreign-human");
    expect(view.container.querySelector("[data-testid=current-human]")?.textContent).toBe(
      "Synthetic human-current",
    );
    expect(view.container.textContent).toContain("BOARD UNAVAILABLE");
    expect(
      [...view.container.querySelectorAll("button")].filter(
        (button) => button.textContent === "Try again",
      ),
    ).toHaveLength(1);
  });

  it("suppresses delivered alpha content, profiles and role immediately while beta is pending", async () => {
    const service = backend(),
      view = mount(service);
    await flush();
    await complete(latest(service, "alpha"));
    switchWorkspace(view.container, "beta");
    await flush();
    expect(latest(service, "beta")).toBeDefined();
    expectNoOldAuthority(view.container, "alpha");
    await complete(latest(service, "beta"), "beta", "reviewer");
    expect(view.container.textContent).toContain("SYNTHETIC-beta-TASK");
    expect(view.container.querySelector("[data-testid=current-role]")?.textContent?.trim()).toBe(
      "reviewer",
    );
  });

  it("ignores a late alpha response after beta delivered current reviewer authority", async () => {
    const service = backend(),
      view = mount(service);
    await flush();
    const alpha = latest(service, "alpha");
    switchWorkspace(view.container, "beta");
    await flush();
    await complete(latest(service, "beta"), "beta", "reviewer");
    await complete(alpha, "old-alpha", "owner");
    expect(view.container.textContent).toContain("SYNTHETIC-beta-TASK");
    expect(view.container.textContent).toContain("SYNTHETIC-beta-PROFILE");
    expect(view.container.textContent).not.toContain("SYNTHETIC-old-alpha");
    expect(labels(view.container)).not.toContain("Projects & policy");
  });

  it("does not resurrect the first alpha incarnation after alpha to beta to alpha", async () => {
    const service = backend(),
      view = mount(service);
    await flush();
    const oldAlpha = latest(service, "alpha");
    switchWorkspace(view.container, "beta");
    await flush();
    const beta = latest(service, "beta");
    switchWorkspace(view.container, "alpha");
    await flush();
    const newAlpha = latest(service, "alpha");
    expect(newAlpha).not.toBe(oldAlpha);
    await complete(beta, "old-beta");
    await complete(newAlpha, "current-alpha", "reviewer");
    await complete(oldAlpha, "old-alpha", "owner");
    expect(view.container.textContent).toContain("SYNTHETIC-current-alpha-TASK");
    expect(view.container.textContent).not.toContain("SYNTHETIC-old-alpha");
    expect(view.container.querySelector("[data-testid=current-role]")?.textContent?.trim()).toBe(
      "reviewer",
    );
  });

  it("keeps the newest same-workspace board when re-auth-triggered reads finish out of order", async () => {
    const service = backend(),
      view = mount(service);
    await flush();
    await complete(latest(service, "alpha"));
    const before = service.reads.length;
    // Changing the public fetch prop re-runs authentication; this is not a production refresh action.
    view.refresh();
    await flush();
    view.refresh();
    await flush();
    const pending = service.reads.slice(before),
      current = latest(service, "alpha");
    expect(pending.length).toBeGreaterThanOrEqual(2);
    await complete(current, "current-refresh", "reviewer");
    for (const read of pending.filter((candidate) => candidate !== current))
      await complete(read, "old-refresh", "owner");
    expect(view.container.textContent).toContain("SYNTHETIC-current-refresh-TASK");
    expect(view.container.textContent).not.toContain("SYNTHETIC-old-refresh");
    expect(view.container.querySelector("[data-testid=current-role]")?.textContent?.trim()).toBe(
      "reviewer",
    );
  });

  it.each(["board", "profiles"] as const)(
    "fences delayed alpha %s JSON parsing after beta selection",
    async (field) => {
      const service = backend(),
        view = mount(service);
      await flush();
      const alpha = latest(service, "alpha");
      const body = deferred<unknown>(),
        response = Response.json({}),
        json = vi.spyOn(response, "json").mockImplementation(() => body.promise);
      await act(async () => {
        alpha.board.resolve(
          field === "board" ? response : Response.json(board("alpha", "old-json")),
        );
        alpha.profiles.resolve(
          field === "profiles" ? response : Response.json(profiles("old-json")),
        );
      });
      await flush();
      expect(json).toHaveBeenCalledOnce();
      switchWorkspace(view.container, "beta");
      await flush();
      await complete(latest(service, "beta"), "beta", "reviewer");
      await act(async () =>
        body.resolve(field === "board" ? board("alpha", "old-json") : profiles("old-json")),
      );
      await flush();
      expect(view.container.textContent).toContain("SYNTHETIC-beta-TASK");
      expect(view.container.textContent).not.toContain("SYNTHETIC-old-json");
      expect(view.container.querySelector("[data-testid=current-role]")?.textContent?.trim()).toBe(
        "reviewer",
      );
    },
  );

  it.each(["http", "network"] as const)(
    "ignores old alpha %s errors and finally while beta still reads",
    async (kind) => {
      const service = backend(),
        view = mount(service);
      await flush();
      const alpha = latest(service, "alpha");
      switchWorkspace(view.container, "beta");
      await flush();
      const beta = latest(service, "beta");
      await act(async () => {
        alpha.profiles.resolve(Response.json(profiles("old-alpha")));
        if (kind === "http")
          alpha.board.resolve(Response.json({ error: "synthetic denial" }, { status: 404 }));
        else alpha.board.reject(new Error("Synthetic old network error"));
      });
      await flush();
      expect(view.container.querySelector("[data-testid=agent-work-state]")?.textContent).toBe(
        "Reading workspace…",
      );
      expect(view.container.querySelector(".board-loading")).not.toBeNull();
      expect(view.container.textContent).not.toContain("Control plane offline");
      expect(view.container.textContent).not.toContain("Workspace not available.");
      await complete(beta, "beta", "reviewer");
      expect(view.container.textContent).toContain("SYNTHETIC-beta-TASK");
    },
  );

  it.each(["http", "network", "body"] as const)(
    "clears previous board, profiles and role on current %s failure",
    async (kind) => {
      const service = backend(),
        view = mount(service);
      await flush();
      await complete(latest(service, "alpha"));
      const before = service.reads.length;
      view.refresh();
      await flush();
      const pending = service.reads.slice(before);
      expect(pending.length).toBeGreaterThanOrEqual(1);
      for (const read of pending)
        await act(async () => {
          read.profiles.resolve(Response.json(profiles("should-not-deliver")));
          if (kind === "http")
            read.board.resolve(Response.json({ error: "synthetic denial" }, { status: 404 }));
          else if (kind === "network")
            read.board.reject(new Error("Synthetic current network failure"));
          else read.board.resolve(new Response("synthetic invalid JSON", { status: 200 }));
        });
      await flush();
      expectNoOldAuthority(view.container, "alpha");
      expect(view.container.textContent).not.toContain("SYNTHETIC-should-not-deliver");
      expect(
        [...view.container.querySelectorAll("button")].filter(
          (button) => button.textContent === "Try again",
        ),
      ).toHaveLength(1);
    },
  );

  it("suppresses previous workspace authority on an unknown popstate destination", async () => {
    const service = backend(),
      view = mount(service);
    await flush();
    await complete(latest(service, "alpha"));
    act(() => {
      window.history.pushState({}, "", "/w/unknown-synthetic");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush();
    expectNoOldAuthority(view.container, "alpha");
    expect(
      view.container.querySelector("[data-testid=work-surface-prompt]")?.textContent,
    ).toContain("Workspace not available.");
    expect(service.reads).toHaveLength(1);
  });

  it("does not let a late old-workspace creation callback start a read or select its task in beta", async () => {
    const service = backend(),
      view = mount(service);
    await flush();
    await complete(latest(service, "alpha"));
    const create = await submitCreate(view.container, service);
    switchWorkspace(view.container, "beta");
    await flush();
    const beta = latest(service, "beta");
    await act(async () =>
      create.reply.resolve(Response.json({ ok: true, result: { id: "created-alpha" } })),
    );
    await flush();
    expect(service.reads.filter((read) => read.scope === "alpha")).toHaveLength(1);
    expect(service.calls.map((call) => call.path)).not.toContain(
      "/api/v1/workspaces/workspace-beta/tasks/created-alpha",
    );
    await complete(beta, "beta", "reviewer");
    expect(view.container.textContent).toContain("SYNTHETIC-beta-TASK");
  });

  it("keeps genuine current task-creation refresh and selection available", async () => {
    const service = backend(),
      view = mount(service);
    await flush();
    await complete(latest(service, "alpha"));
    const initial = latest(service, "alpha"),
      create = await submitCreate(view.container, service);
    await act(async () =>
      create.reply.resolve(Response.json({ ok: true, result: { id: "created-alpha" } })),
    );
    await flush();
    const refreshed = latest(service, "alpha");
    expect(refreshed).not.toBe(initial);
    await complete(refreshed, "committed-refresh");
    expect(view.container.textContent).toContain("SYNTHETIC-committed-refresh-TASK");
    expect(view.container.textContent).toContain("Synthetic committed task");
    expect(service.calls.map((call) => call.path)).toContain(
      "/api/v1/workspaces/workspace-alpha/tasks/created-alpha",
    );
    expect(service.creates).toHaveLength(1);
  });

  it("resets a selected task and composer when popstate commits a different workspace", async () => {
    const service = backend(),
      view = mount(service);
    await flush();
    await complete(latest(service, "alpha"));
    const createButton = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "New task",
    )!;
    act(() => createButton.click());
    expect(view.container.querySelector("[data-testid=create-task-form]")).not.toBeNull();
    act(() => view.container.querySelector<HTMLButtonElement>(".task-open")!.click());
    await flush();
    expect(service.calls.map((call) => call.path)).toContain(
      "/api/v1/workspaces/workspace-alpha/tasks/task-alpha",
    );
    act(() => {
      window.history.pushState({}, "", "/w/beta");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush();
    await complete(latest(service, "beta"), "beta", "owner");
    expect(view.container.textContent).toContain("SYNTHETIC-beta-TASK");
    expect(view.container.querySelector("[data-testid=create-task-form]")).toBeNull();
    expect(service.calls.map((call) => call.path)).not.toContain(
      "/api/v1/workspaces/workspace-beta/tasks/task-alpha",
    );
  });

  it("suppresses the old human's delivered board while renewed human authority is loading", async () => {
    const service = backend(),
      view = mount(service);
    await flush();
    await complete(latest(service, "alpha"), "old-human");
    service.state.humanId = "human-renewed";
    view.refresh();
    await flush();
    expect(view.container.querySelector("[data-testid=current-human]")?.textContent).toBe(
      "Synthetic human-renewed",
    );
    expectNoOldAuthority(view.container, "old-human");
    await complete(latest(service, "alpha"), "current-human", "reviewer", "human-renewed");
    expect(view.container.textContent).toContain("SYNTHETIC-current-human-TASK");
  });

  it("keeps an unmounted shell inert when its pending board completes", async () => {
    const service = backend(),
      view = mount(service);
    await flush();
    const alpha = latest(service, "alpha");
    const before = service.calls.length,
      errors = vi.spyOn(console, "error").mockImplementation(() => {});
    view.unmount();
    await complete(alpha, "unmounted");
    expect(view.container.childNodes).toHaveLength(0);
    expect(document.body.textContent).not.toContain("SYNTHETIC-unmounted");
    expect(service.calls).toHaveLength(before);
    expect(errors).not.toHaveBeenCalled();
  });
});
