// ABOUTME: Tests Attention safety labels, disclosed decisions, and retained drafts.
// ABOUTME: Mounted synthetic responses preserve versions, failures, and polling truth.

// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AttentionHome,
  AttentionList,
  KIND_LABELS,
  NATIVE_PERMISSION_NOTICE,
  STATE_LABELS,
  requiredRoleLabel,
  type AttentionHomeItem,
} from "../src/attention/home.js";

const cleanups: Array<() => void> = [];

function mount(element: ReactElement) {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (next: ReactElement) => act(() => root.render(next));
  render(element);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, render };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
}

function fill(container: HTMLElement, value: string): HTMLTextAreaElement {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("Answer composer is not open");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

function item(overrides: Partial<AttentionHomeItem> = {}): AttentionHomeItem {
  return {
    id: "01SYNTHETICAT00000000000001",
    kind: "clarification",
    required_role: "reviewer",
    reference_kind: null,
    reference_id: null,
    question: "Synthetic question",
    blocking: true,
    state: "open",
    answer: null,
    task_title: "Synthetic task",
    project_name: "Alpha",
    run_result_state: "open",
    run_activity: "needs_human",
    rank_reason: "blocking clarification requested 2026-08-07T12:00:00Z",
    resource_version: 1,
    requested_at: "2026-08-07T12:00:00Z",
    answered_at: null,
    resolved_at: null,
    ...overrides,
  };
}

describe("attention home presentation", () => {
  it("labels every kind and state distinctly", () => {
    expect(Object.keys(KIND_LABELS).sort()).toEqual([
      "blocker",
      "capability",
      "clarification",
      "credential",
      "destructive_action",
      "review",
    ]);
    expect(KIND_LABELS.credential).not.toBe(KIND_LABELS.clarification);
    expect(KIND_LABELS.destructive_action).not.toBe(KIND_LABELS.review);
    expect(STATE_LABELS.open).not.toBe(STATE_LABELS.answered);
    expect(STATE_LABELS.answered).not.toBe(STATE_LABELS.resolved);
    expect(requiredRoleLabel("owner")).toContain("owner");
    expect(requiredRoleLabel("reviewer")).toContain("Reviewer");
  });

  it("keeps provider-native permissions visibly separate", () => {
    expect(NATIVE_PERMISSION_NOTICE).toContain("separate");
    expect(NATIVE_PERMISSION_NOTICE).toContain("never approves");
    expect(NATIVE_PERMISSION_NOTICE).toContain("never grants");
  });

  it("carries the ranked server order with explainable reasons", () => {
    const ranked = [
      item({
        id: "a",
        kind: "blocker",
        blocking: true,
        rank_reason: "blocking blocker requested t0",
      }),
      item({
        id: "b",
        kind: "review",
        blocking: false,
        rank_reason: "non-blocking review requested t1",
      }),
    ];
    expect(ranked.map((entry) => entry.id)).toEqual(["a", "b"]);
    for (const entry of ranked) {
      expect(entry.rank_reason).toContain(entry.kind);
      expect(entry.rank_reason).toContain(entry.blocking ? "blocking" : "non-blocking");
    }
  });

  it("exposes committed answers and versions for answer and resolve actions", () => {
    const answered = item({ state: "answered", answer: "Synthetic answer", resource_version: 2 });
    expect(answered.answer).toBe("Synthetic answer");
    expect(answered.resource_version).toBe(2);
    const resolved = item({ state: "resolved", answer: "Synthetic answer", resource_version: 3 });
    expect(resolved.state).toBe("resolved");
  });
});

describe("attention disclosure", () => {
  it("keeps at most two default row actions and essential safety without a composer", () => {
    const onAnswer = vi.fn();
    const onResolve = vi.fn();
    const { container } = mount(
      createElement(AttentionList, {
        items: [
          item({ question: "<script>Synthetic question</script>", required_role: "owner" }),
          item({ id: "answered", state: "answered", answer: "Synthetic answer" }),
          item({ id: "resolved", state: "resolved" }),
        ],
        onAnswer,
        onResolve,
        actionError: null,
        pendingId: null,
      }),
    );
    const rows = [...container.querySelectorAll('[data-testid="attention-item"]')];
    expect(rows.map((row) => row.querySelectorAll("button").length)).toEqual([2, 2, 1]);
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(rows[0]?.textContent).toContain("Blocking the run");
    expect(rows[0]?.textContent).toContain("Needs an owner");
    expect(rows[0]?.textContent).toContain("Alpha · Synthetic task");
    expect(container.textContent).not.toContain("2026-08-07T12:00:00Z");
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("discloses rank, run, timestamps and version without issuing a command", () => {
    const onAnswer = vi.fn();
    const onResolve = vi.fn();
    const { container } = mount(
      createElement(AttentionList, {
        items: [item()],
        onAnswer,
        onResolve,
        actionError: null,
        pendingId: null,
      }),
    );
    const details = button(container, "Details");
    act(() => details.click());
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("#1 · blocking clarification");
    expect(container.textContent).toContain("Run open · needs_human · version 1");
    expect(container.textContent).toContain("Requested 2026-08-07T12:00:00Z");
    act(() => details.click());
    expect(container.querySelector(".attention-details")).toBeNull();
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("retains a draft across Details, Cancel, another item and a polled version", async () => {
    const onAnswer = vi.fn(async () => false);
    const props = {
      items: [item(), item({ id: "another" })],
      onAnswer,
      onResolve: vi.fn(),
      actionError: null,
      pendingId: null,
    };
    const { container, render } = mount(createElement(AttentionList, props));
    act(() => button(container, "Answer").click());
    fill(container, "Synthetic retained decision");
    act(() => button(container, "Details").click());
    expect(container.querySelector("textarea")?.value).toBe("Synthetic retained decision");
    act(() => button(container, "Cancel").click());
    expect(document.activeElement?.getAttribute("data-testid")).toBe(`answer-trigger-${item().id}`);
    const another = container.querySelector<HTMLButtonElement>(
      '[data-testid="answer-trigger-another"]',
    )!;
    act(() => another.click());
    fill(container, "Synthetic second draft");
    act(() => button(container, "Answer").click());
    expect(container.querySelector("textarea")?.value).toBe("Synthetic retained decision");
    render(
      createElement(AttentionList, {
        ...props,
        items: [item({ resource_version: 2 }), item({ id: "another" })],
      }),
    );
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onAnswer).toHaveBeenCalledWith(item().id, 2, "Synthetic retained decision");
    expect(container.querySelector("textarea")?.value).toBe("Synthetic retained decision");
    expect(container.querySelector(".attention-decision-notice")?.textContent).toContain(
      "never grants workspace authority",
    );
  });

  it("clears and closes only a successfully committed answer", async () => {
    const { container } = mount(
      createElement(AttentionList, {
        items: [item()],
        onAnswer: vi.fn(async () => true),
        onResolve: vi.fn(),
        actionError: null,
        pendingId: null,
      }),
    );
    act(() => button(container, "Answer").click());
    fill(container, "Synthetic committed decision");
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector("textarea")).toBeNull();
    act(() => button(container, "Answer").click());
    expect(container.querySelector("textarea")?.value).toBe("");
  });

  it("keeps a newly selected decision open when a previous answer commits", async () => {
    let commit: ((succeeded: boolean) => void) | undefined;
    const pendingAnswer = new Promise<boolean>((resolve) => {
      commit = resolve;
    });
    const { container } = mount(
      createElement(AttentionList, {
        items: [item(), item({ id: "another" })],
        onAnswer: vi.fn(() => pendingAnswer),
        onResolve: vi.fn(),
        actionError: null,
        pendingId: null,
      }),
    );
    act(() => button(container, "Answer").click());
    fill(container, "Synthetic pending decision");
    act(() => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="answer-trigger-another"]')!.click();
    });
    fill(container, "Synthetic next decision");
    await act(async () => {
      commit!(true);
    });
    expect(container.querySelector("form")?.id).toBe("answer-form-another");
    expect(container.querySelector("textarea")?.value).toBe("Synthetic next decision");
  });

  it.each([
    ["stale_version", "Someone else answered first"],
    ["already_answered", "Already answered"],
    ["forbidden", "Your role cannot answer"],
  ])("retains the decision after %s and sends the current version and CSRF", async (code, text) => {
    const posted: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        posted.push(init);
        return Response.json({ error: { code } }, { status: 409 });
      }
      return Response.json({ attention: [item({ resource_version: 3 })] });
    };
    const { container } = mount(
      createElement(AttentionHome, {
        workspaceId: "synthetic-workspace",
        role: "reviewer",
        csrfToken: "synthetic-csrf",
        fetchImpl,
      }),
    );
    await flush();
    act(() => button(container, "Answer").click());
    fill(container, "Synthetic unsuccessful decision");
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(JSON.parse(String(posted[0]?.body))).toMatchObject({
      expected_version: 3,
      answer: "Synthetic unsuccessful decision",
    });
    expect(new Headers(posted[0]?.headers).get("x-bfb-csrf")).toBe("synthetic-csrf");
    expect(container.querySelector("textarea")?.value).toBe("Synthetic unsuccessful decision");
    expect(
      container.querySelector('[data-testid="attention-action-error"]')?.textContent,
    ).toContain(text);
  });

  it("retains drafts through a failed poll without presenting cached requests as current", async () => {
    vi.useFakeTimers();
    let offline = false;
    const fetchImpl: typeof fetch = async () => {
      if (offline) throw new Error("Synthetic network loss");
      return Response.json({ attention: [item()] });
    };
    const { container } = mount(
      createElement(AttentionHome, {
        workspaceId: "synthetic-workspace",
        role: "owner",
        csrfToken: "synthetic-csrf",
        fetchImpl,
      }),
    );
    await flush();
    act(() => button(container, "Answer").click());
    fill(container, "Synthetic offline draft");
    offline = true;
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await flush();
    expect(container.querySelector('[data-testid="attention-item"]')).toBeNull();
    expect(container.textContent).toContain("No cached state is presented as current");
    offline = false;
    await act(async () => {
      button(container, "Try again").click();
    });
    await flush();
    expect(container.querySelector("textarea")?.value).toBe("Synthetic offline draft");
  });

  it("resolves only the selected answered record with its current version", () => {
    const onResolve = vi.fn();
    const { container } = mount(
      createElement(AttentionList, {
        items: [item({ state: "answered", resource_version: 4, answer: "Synthetic answer" })],
        onAnswer: vi.fn(),
        onResolve,
        actionError: null,
        pendingId: null,
      }),
    );
    act(() => button(container, "Mark resolved").click());
    expect(onResolve).toHaveBeenCalledWith(item().id, 4);
  });
});
