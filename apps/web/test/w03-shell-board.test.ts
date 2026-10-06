// ABOUTME: Covers compact board action budgets and discoverable workspace navigation.
// ABOUTME: Uses isolated synthetic reads to prove disclosures and appearance never mutate work.

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttentionDeckItem, ProjectLane } from "@bfb/domain";

import { AppShell } from "../src/app.js";
import { WorkBoard } from "../src/work/board.js";
import { THEME_STORAGE_KEY } from "../src/theme.js";

const LANE: ProjectLane = {
  projectId: "project-synthetic",
  name: "Synthetic project",
  slug: "synthetic-project",
  tint: "#197d7d",
  tasks: [
    {
      taskId: "task-synthetic",
      projectId: "project-synthetic",
      title: "Synthetic routing task",
      state: "ready",
      priority: "P1",
      punchline: "Prepare the review",
      nowLabel: "NOW",
      whyDelegable: "An independent reviewer can check the evidence",
      passToAgentProfileId: "profile-synthetic",
      projectTint: "#197d7d",
      topEdgePx: 3,
      sideStripe: false,
      latestEvent: { kind: "progress_reported", createdAt: "2026-10-06T12:00:00Z" },
      runSummary: { resultState: "open", activity: "unknown" },
    },
  ],
};

const cleanups: Array<() => void> = [];

function mount(element: React.ReactNode): HTMLElement {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(element));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

async function flush(): Promise<void> {
  for (let round = 0; round < 15; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function click(element: Element): void {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function shellFetch(role: "owner" | "member" | "reviewer" = "owner") {
  const calls: Array<{ path: string; method: string }> = [];
  const fetchImpl = (async (input, init) => {
    const path = String(input);
    calls.push({ path, method: init?.method ?? "GET" });
    let body: unknown;
    if (path === "/auth/session") {
      body = {
        human: {
          id: "human-synthetic",
          display_name: "Synthetic human",
          email: "human@synthetic.test",
        },
        csrf_token: "synthetic-csrf",
      };
    } else if (path === "/api/v1/workspaces") {
      body = {
        workspaces: [
          {
            id: "workspace-synthetic",
            slug: "synthetic",
            jurisdiction: "eu",
            role,
            authorization_epoch: 1,
          },
        ],
      };
    } else if (path.endsWith("/board")) {
      body = {
        human: { id: "human-synthetic", display_name: "Synthetic human" },
        role,
        authorization_epoch: 1,
        lanes: [LANE],
        needs_now: [],
        agent_work_available: false,
      };
    } else if (path.includes("/agent-profiles")) {
      body = {
        profiles: [
          { id: "profile-synthetic", name: "Independent reviewer", provider: "synthetic" },
        ],
      };
    } else if (path === "/auth/sign-out") {
      body = { ok: true };
    } else {
      throw new Error(`Unexpected synthetic read: ${path}`);
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("compact project board", () => {
  it("exposes only Open and Details by default while retaining routing and run information", () => {
    const onSelectTask = vi.fn();
    const onPassToAgent = vi.fn();
    const container = mount(
      createElement(WorkBoard, {
        humanDisplayName: "Synthetic human",
        lanes: [LANE],
        needsNow: [],
        agentWorkAvailable: false,
        agentProfiles: [
          { id: "profile-synthetic", name: "Independent reviewer", provider: "synthetic" },
        ],
        canManageTasks: true,
        onSelectTask,
        onPassToAgent,
      }),
    );
    const card = container.querySelector(".task-card")!;
    const details = card.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(card.querySelectorAll(":scope > button, :scope > details > summary")).toHaveLength(2);
    expect(card.querySelector(".task-open")?.textContent).toContain("Prepare the review");
    expect(card.querySelector(".priority-marker")?.textContent).toContain("P1 HIGH");
    for (const selector of [
      ".routing-reason",
      "[data-testid=latest-event]",
      "[data-testid=run-summary]",
      "[data-testid=pass-to-agent]",
    ]) {
      expect(card.querySelector(selector)?.closest("details")).toBe(details);
    }
    expect(card.querySelector("[data-testid=agent-work-state]")).toBeNull();
    expect(onSelectTask).not.toHaveBeenCalled();
    expect(onPassToAgent).not.toHaveBeenCalled();

    click(card.querySelector("summary")!);
    expect(details.open).toBe(true);
    expect(onSelectTask).not.toHaveBeenCalled();
    expect(onPassToAgent).not.toHaveBeenCalled();
    click(card.querySelector("[data-testid=pass-to-agent]")!);
    expect(onPassToAgent).toHaveBeenCalledWith("task-synthetic", "profile-synthetic");
    act(() =>
      details.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(card.querySelector("summary"));
    click(card.querySelector(".task-open")!);
    expect(onSelectTask).toHaveBeenCalledWith("task-synthetic");
  });

  it("keeps the deck bounded to three and escapes task content without granting reviewer actions", () => {
    const needsNow: AttentionDeckItem[] = Array.from({ length: 4 }, (_, index) => ({
      taskId: `task-${index}`,
      projectId: LANE.projectId,
      title: `Synthetic question ${index}`,
      priority: "P1",
      punchline: "Decision needed",
      reason: "Assigned explicitly",
    }));
    const container = mount(
      createElement(WorkBoard, {
        humanDisplayName: "Synthetic human",
        lanes: [{ ...LANE, tasks: [{ ...LANE.tasks[0]!, title: "<img src=x onerror=alert(1)>" }] }],
        needsNow,
        agentWorkAvailable: false,
        agentProfiles: [],
        canManageTasks: false,
      }),
    );
    expect(container.querySelectorAll(".attention-open")).toHaveLength(3);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.querySelector("[data-testid=pass-to-agent]")).toBeNull();
  });
});

describe("quiet authenticated shell", () => {
  it("keeps secondary routes discoverable and returns focus when navigation closes its menu", async () => {
    const stub = shellFetch();
    const container = mount(
      createElement(AppShell, { initialPath: "/w/synthetic", fetchImpl: stub.fetchImpl }),
    );
    await flush();
    const nav = container.querySelector(".route-nav")!;
    expect(
      [...nav.querySelectorAll(":scope > button")].map((button) => button.textContent),
    ).toEqual(["Work", "Attention"]);
    const more = nav.querySelector("details")!;
    expect(more.open).toBe(false);
    click(more.querySelector("summary")!);
    expect(more.open).toBe(true);
    const latest = [...more.querySelectorAll("button")].find(
      (button) => button.textContent === "Latest",
    )!;
    click(latest);
    await flush();
    expect(container.querySelector("[data-testid=latest-placeholder]")).not.toBeNull();
    expect(more.open).toBe(false);
    expect(document.activeElement).toBe(more.querySelector("summary"));
    expect(stub.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("retains account security, sign out, and theme behind a keyboard-operable account menu", async () => {
    const stub = shellFetch();
    const container = mount(
      createElement(AppShell, { initialPath: "/w/synthetic", fetchImpl: stub.fetchImpl }),
    );
    await flush();
    expect(container.querySelectorAll("[data-testid=agent-work-state]")).toHaveLength(1);
    expect(container.querySelector("[data-testid=agent-work-state]")?.textContent).toBe(
      "Agent work unavailable",
    );
    const account = container.querySelector(".human-menu details")!;
    expect(account.open).toBe(false);
    click(account.querySelector("summary")!);
    expect(account.open).toBe(true);
    expect(account.textContent).toContain("Account security");
    expect(account.textContent).toContain("Sign out");
    expect(container.querySelector("[data-testid=current-human]")?.textContent).toBe(
      "Synthetic human",
    );
    expect(container.querySelector("[data-testid=current-role]")?.textContent).toBe("owner");
    const appearance = account.querySelector("select")!;
    act(() => {
      appearance.value = "dark";
      appearance.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(account.open).toBe(true);
    expect(stub.calls.every((call) => call.method === "GET")).toBe(true);
    act(() =>
      appearance.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(account.open).toBe(false);
    expect(document.activeElement).toBe(account.querySelector("summary"));
    click(account.querySelector("summary")!);
    const signOut = [...account.querySelectorAll("button")].find(
      (button) => button.textContent === "Sign out",
    )!;
    click(signOut);
    await flush();
    expect(stub.calls.filter((call) => call.method !== "GET")).toEqual([
      { path: "/auth/sign-out", method: "POST" },
    ]);
    expect(container.querySelector("[data-testid=sign-in-form]")).not.toBeNull();
  });

  it.each(["owner", "member", "reviewer"] as const)(
    "preserves %s navigation permissions",
    async (role) => {
      const stub = shellFetch(role);
      const container = mount(
        createElement(AppShell, { initialPath: "/w/synthetic", fetchImpl: stub.fetchImpl }),
      );
      await flush();
      const more = container.querySelector(".route-nav details")!;
      const labels = [...more.querySelectorAll("button")].map((button) => button.textContent);
      expect(labels).toContain("Runners");
      expect(labels.includes("Projects & policy")).toBe(role === "owner");
      expect(labels.includes("Operations")).toBe(role !== "reviewer");
      expect(container.querySelector("[data-testid=workspace-switcher]")).not.toBeNull();
    },
  );
});
