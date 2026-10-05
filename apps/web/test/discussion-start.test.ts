// ABOUTME: Proves discussion start freezes the observed checkout head.
// ABOUTME: A fabricated placeholder revision must never reach the create request.

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { DiscussionStart } from "../src/discussion/DiscussionStart.js";

const HEAD = "d".repeat(40);

interface StubState {
  alphaHead: string | undefined;
  betaHead: string | undefined;
  posted: Record<string, unknown>[];
  started: string[];
}

function checkoutStatus(state: StubState): unknown {
  return {
    runner_id: "runner-1",
    device_label: "Synthetic Mac",
    owner_human_id: "human-1",
    status: "enrolled",
    inventory_revision: 7,
    inventory_received_at: "2026-08-07T12:00:00.000Z",
    inventory_valid: true,
    checkouts: [
      {
        schema_version: 1,
        checkout_id: "checkout-alpha",
        workspace_id: "ws-1",
        runner_id: "runner-1",
        project_id: "project-1",
        label: "Synthetic D03 Alpha Checkout",
        repository_identity: "synthetic/d03",
        workspace_subpath: "alpha",
        physical_worktree_hash: `sha256:${"a".repeat(64)}`,
        repository_config_hash: `sha256:${"b".repeat(64)}`,
        is_default: true,
        ...(state.alphaHead === undefined ? {} : { head: state.alphaHead }),
        dirty: false,
        status: "validated",
        validated_at: "2026-08-07T12:00:00.000Z",
      },
      {
        schema_version: 1,
        checkout_id: "checkout-beta",
        workspace_id: "ws-1",
        runner_id: "runner-1",
        project_id: "project-1",
        label: "Synthetic D03 Beta Checkout",
        repository_identity: "synthetic/d03",
        workspace_subpath: "beta",
        physical_worktree_hash: `sha256:${"c".repeat(64)}`,
        repository_config_hash: `sha256:${"b".repeat(64)}`,
        is_default: false,
        ...(state.betaHead === undefined ? {} : { head: state.betaHead }),
        dirty: false,
        status: "validated",
        validated_at: "2026-08-07T12:00:00.000Z",
      },
    ],
    providers: [],
  };
}

function stubFetch(state: StubState): typeof fetch {
  return (async (input: unknown, init?: unknown) => {
    const url = String(input);
    const method = (init as { method?: string } | undefined)?.method ?? "GET";
    const json = async (): Promise<unknown> => {
      if (method === "POST" && url === "/api/v1/workspaces/ws-1/tasks/task-1/discussions") {
        const body = JSON.parse(String((init as { body?: string }).body)) as Record<
          string,
          unknown
        >;
        state.posted.push(body);
        return { result: { discussion_id: "discussion-1" } };
      }
      if (url === "/api/v1/workspaces/ws-1/agent-profiles?limit=100") {
        return {
          profiles: [
            {
              id: "profile-claude",
              name: "Synthetic D03 Claude",
              provider: "claude",
              model: "synthetic",
              execution_mode: "headless",
              harness_mode: "restricted",
              resource_version: 1,
            },
            {
              id: "profile-codex",
              name: "Synthetic D03 Codex",
              provider: "codex",
              model: "synthetic",
              execution_mode: "headless",
              harness_mode: "restricted",
              resource_version: 1,
            },
          ],
        };
      }
      if (url === "/api/v1/workspaces/ws-1/runners") {
        return {
          runners: [
            {
              schema_version: 1,
              runner_id: "runner-1",
              workspace_id: "ws-1",
              owner_human_id: "human-1",
              device_label: "Synthetic Mac",
              public_key_thumbprint: "thumb",
              authorization_epoch: 1,
              grant_epoch: 1,
              status: "enrolled",
              enrolled_at: "2026-08-07T12:00:00.000Z",
              granted_project_ids: ["project-1"],
              launcher_human_ids: ["human-1"],
              checkout_status: null,
            },
          ],
        };
      }
      if (url === "/api/v1/workspaces/ws-1/tasks/task-1") {
        return { task: { id: "task-1", project_id: "project-1" } };
      }
      if (url === "/api/v1/workspaces/ws-1/workspace-policy") {
        return { policy: { resourceVersion: 3 } };
      }
      if (url === "/api/v1/workspaces/ws-1/projects/project-1/policy") {
        return { policy: { resourceVersion: 2 } };
      }
      if (url === "/api/v1/workspaces/ws-1/projects/project-1/repository-config") {
        return { config: { resource_version: 2 } };
      }
      if (url === "/api/v1/workspaces/ws-1/runners/runner-1/checkouts") {
        return checkoutStatus(state);
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    };
    return { status: 200, ok: true, json } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function flushRenders(rounds = 30): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function mountStart(state: StubState): { container: HTMLElement; unmount(): void } {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      createElement(DiscussionStart, {
        workspaceId: "ws-1",
        taskId: "task-1",
        taskVersion: 3,
        projectId: "project-1",
        humanId: "human-1",
        role: "owner",
        fetchImpl: stubFetch(state),
        csrfToken: "csrf-1",
        onStarted: (discussionId: string) => {
          state.started.push(discussionId);
        },
      }),
    );
  });
  return {
    container,
    unmount(): void {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function byTestId(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector(`[data-testid="${id}"]`);
  if (!element) {
    throw new Error(`missing element ${id}`);
  }
  return element as HTMLElement;
}

function choose(container: HTMLElement, id: string, value: string): void {
  const select = byTestId(container, id) as HTMLSelectElement;
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function ask(container: HTMLElement, question: string): void {
  const field = byTestId(container, "discussion-question") as HTMLTextAreaElement;
  // Bypass React's value tracker so the input event registers as a change.
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) {
    throw new Error("textarea value setter is unavailable");
  }
  act(() => {
    setter.call(field, question);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function fillEligibleSlots(container: HTMLElement): Promise<void> {
  ask(container, "Which synthetic alternative holds?");
  choose(container, "discussion-first-profile", "profile-claude");
  choose(container, "discussion-second-profile", "profile-codex");
  choose(container, "discussion-first-checkout", "checkout-alpha");
  choose(container, "discussion-second-checkout", "checkout-beta");
  await flushRenders();
}

function submit(container: HTMLElement): void {
  const form = byTestId(container, "discussion-start-form") as HTMLFormElement;
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("discussion start frozen revision", () => {
  it("posts the observed checkout head, never a fabricated placeholder", async () => {
    const state: StubState = { alphaHead: HEAD, betaHead: HEAD, posted: [], started: [] };
    const start = mountStart(state);
    try {
      await flushRenders();
      await fillEligibleSlots(start.container);
      const button = byTestId(start.container, "discussion-start-button") as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      submit(start.container);
      await flushRenders();
      expect(state.posted).toHaveLength(1);
      expect(state.posted[0]?.git_revision).toBe(HEAD);
      expect(state.posted[0]?.git_revision).not.toBe("0".repeat(40));
      expect(state.started).toEqual(["discussion-1"]);
    } finally {
      start.unmount();
    }
  });

  it("stays blocked with an actionable reason while a head is unobserved", async () => {
    const state: StubState = { alphaHead: HEAD, betaHead: undefined, posted: [], started: [] };
    const start = mountStart(state);
    try {
      await flushRenders();
      await fillEligibleSlots(start.container);
      const button = byTestId(start.container, "discussion-start-button") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(byTestId(start.container, "discussion-start-blocked").textContent).toMatch(
        /Checkout head unavailable/,
      );
      submit(start.container);
      await flushRenders();
      expect(state.posted).toHaveLength(0);
    } finally {
      start.unmount();
    }
  });

  it("stays blocked with an actionable reason when the checkouts disagree", async () => {
    const state: StubState = {
      alphaHead: HEAD,
      betaHead: "e".repeat(40),
      posted: [],
      started: [],
    };
    const start = mountStart(state);
    try {
      await flushRenders();
      await fillEligibleSlots(start.container);
      const button = byTestId(start.container, "discussion-start-button") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(byTestId(start.container, "discussion-start-blocked").textContent).toMatch(
        /Checkouts disagree on the commit/,
      );
      submit(start.container);
      await flushRenders();
      expect(state.posted).toHaveLength(0);
    } finally {
      start.unmount();
    }
  });
});
