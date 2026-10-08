// ABOUTME: Tests task disclosure races and retained draft semantics with isolated mounted responses.
// ABOUTME: Exercises late review completion, context audiences, unrelated saves, and composer focus.

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkMutations, type WorkMutationsProps } from "../src/work/mutations.js";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function task(id: string) {
  return {
    id,
    project_id: "project",
    title: `Task ${id}`,
    state: id === "a" ? "review" : "ready",
    priority: "P2",
    next_owner_type: "human",
    next_owner_id: "human",
    next_action_reason: "Review synthetic evidence.",
    punchline: "A committed synthetic task.",
    resource_version: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function responses(
  override: (
    url: string,
    method: string,
    init?: RequestInit,
  ) => Promise<Response> | undefined = () => undefined,
): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const custom = override(url, method, init);
    if (custom) return custom;
    if (url === "/api/v1/_substrate") return Response.json({ ok: true, features: {} });
    if (method === "POST" && url.endsWith("/comments"))
      return Response.json({ ok: true, result: { id: "comment" } });
    const match = url.match(/^\/api\/v1\/workspaces\/workspace\/tasks\/([^/?]+)$/u);
    if (match) return Response.json({ task: task(match[1]!) });
    if (url.includes("/comments?")) return Response.json({ comments: [] });
    if (url.includes("/context?")) return Response.json({ context: [] });
    if (url.includes("/members?")) return Response.json({ members: [] });
    if (url.endsWith("/tasks/a/runs"))
      return Response.json({
        runs: [
          { id: "run-a", result_state: "submitted", activity: "inactive", resource_version: 1 },
        ],
      });
    if (url.endsWith("/runs/run-a/results"))
      return Response.json({
        submissions: [
          {
            id: "submission",
            version: 1,
            summary: "Synthetic result",
            limitations: "",
            evidence_refs: [],
            git_branch: null,
            git_commit: null,
            git_dirty: null,
            submitted_by_kind: "human",
            submitted_at: "2026-10-06T12:00:00Z",
            superseded: false,
            outdated: false,
            outdated_reasons: [],
          },
        ],
      });
    throw new Error(`Unexpected synthetic request: ${method} ${url}`);
  };
}

async function flush() {
  for (let index = 0; index < 20; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(fetchImpl: typeof fetch) {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const onChanged = vi.fn();
  let props: WorkMutationsProps = {
    workspaceId: "workspace",
    selectedTaskId: "a",
    humanId: "human",
    role: "owner",
    agentProfiles: [],
    fetchImpl,
    csrfToken: "synthetic-csrf",
    onChanged,
    onClose: vi.fn(),
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
  return { container, render, section, onChanged };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
}

function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function audience(container: HTMLElement, value: string) {
  const select = container.querySelector<HTMLSelectElement>("[data-testid=context-audience]")!;
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(async () => {
  await flush();
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

describe("task disclosure retained state", () => {
  it("does not let a late previous-task review invalidate the selected task read", async () => {
    const review = deferred<Response>();
    const selected = deferred<Response>();
    const view = mount(
      responses((url, method) => {
        if (method === "POST" && url.endsWith("/runs/run-a/review")) return review.promise;
        if (method === "GET" && url.endsWith("/tasks/b")) return selected.promise;
        return undefined;
      }),
    );
    await flush();
    view.section("results");
    await flush();
    act(() =>
      view.container.querySelector<HTMLButtonElement>("[data-testid=accept-result]")!.click(),
    );
    view.render({ selectedTaskId: "b" });
    await flush();
    await act(async () => review.resolve(Response.json({ ok: true })));
    await flush();
    await act(async () => selected.resolve(Response.json({ task: task("b") })));
    await flush();
    expect(view.container.querySelector("h2")?.textContent).toBe("Task b");
    expect(view.container.querySelector(".sheet-loading")).toBeNull();
  });

  it("does not let an old review reload the task after returning through another selection", async () => {
    const review = deferred<Response>();
    let taskReads = 0;
    const view = mount(
      responses((url, method) => {
        if (method === "POST" && url.endsWith("/runs/run-a/review")) return review.promise;
        if (method === "GET" && url.endsWith("/tasks/a")) taskReads += 1;
        return undefined;
      }),
    );
    await flush();
    view.section("results");
    await flush();
    act(() =>
      view.container.querySelector<HTMLButtonElement>("[data-testid=accept-result]")!.click(),
    );
    view.render({ selectedTaskId: "b" });
    await flush();
    view.render({ selectedTaskId: "a" });
    await flush();
    await act(async () => review.resolve(Response.json({ ok: true })));
    await flush();
    expect(taskReads).toBe(2);
    expect(view.onChanged).not.toHaveBeenCalled();
    expect(view.container.querySelector("h2")?.textContent).toBe("Task a");
  });

  it("does not let an old successful comment clear the returned task's current draft", async () => {
    const comment = deferred<Response>();
    const view = mount(
      responses((url, method) => {
        if (method === "POST" && url.endsWith("/tasks/a/comments")) return comment.promise;
        return undefined;
      }),
    );
    await flush();
    view.section("comments");
    act(() => button(view.container, "Add comment").click());
    fill(
      view.container.querySelector<HTMLTextAreaElement>("[data-testid=comment-body]")!,
      "Synthetic same draft",
    );
    act(() =>
      view.container
        .querySelector("[data-testid=comment-form]")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    view.render({ selectedTaskId: "b" });
    await flush();
    view.render({ selectedTaskId: "a" });
    await flush();
    view.section("comments");
    act(() => button(view.container, "Add comment").click());
    await act(async () => comment.resolve(Response.json({ ok: true })));
    await flush();
    expect(
      view.container.querySelector<HTMLTextAreaElement>("[data-testid=comment-body]")?.value,
    ).toBe("Synthetic same draft");
    expect(view.container.querySelector("[data-testid=mutation-status]")).toBeNull();
    expect(view.onChanged).not.toHaveBeenCalled();
  });

  it("retains the context audience with its draft when returning from another task", async () => {
    const view = mount(responses());
    await flush();
    view.section("context");
    act(() => button(view.container, "Add context").click());
    audience(view.container, "human");
    fill(
      view.container.querySelector<HTMLTextAreaElement>("[data-testid=context-body]")!,
      "Synthetic human-only draft",
    );
    view.render({ selectedTaskId: "b" });
    await flush();
    view.section("context");
    act(() => button(view.container, "Add context").click());
    audience(view.container, "agent");
    fill(
      view.container.querySelector<HTMLTextAreaElement>("[data-testid=context-body]")!,
      "Synthetic agent draft",
    );
    view.render({ selectedTaskId: "a" });
    await flush();
    view.section("context");
    act(() => button(view.container, "Add context").click());
    await flush();
    expect(
      view.container.querySelector<HTMLTextAreaElement>("[data-testid=context-body]")?.value,
    ).toBe("Synthetic human-only draft");
    expect(
      view.container.querySelector<HTMLSelectElement>("[data-testid=context-audience]")?.value,
    ).toBe("human");
  });

  it("does not clear an audience changed while the same context body is submitting", async () => {
    const context = deferred<Response>();
    let submitted: Record<string, unknown> | undefined;
    const view = mount(
      responses((url, method, init) => {
        if (method !== "POST" || !url.endsWith("/tasks/a/context")) return undefined;
        submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return context.promise;
      }),
    );
    await flush();
    view.section("context");
    act(() => button(view.container, "Add context").click());
    audience(view.container, "human");
    fill(
      view.container.querySelector<HTMLTextAreaElement>("[data-testid=context-body]")!,
      "Synthetic unchanged context",
    );
    act(() =>
      view.container
        .querySelector("[data-testid=context-form]")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    audience(view.container, "agent");
    await act(async () => context.resolve(Response.json({ ok: true })));
    await flush();
    expect(submitted).toMatchObject({ audience: "human", body: "Synthetic unchanged context" });
    expect(
      view.container.querySelector<HTMLTextAreaElement>("[data-testid=context-body]")?.value,
    ).toBe("Synthetic unchanged context");
    expect(
      view.container.querySelector<HTMLSelectElement>("[data-testid=context-audience]")?.value,
    ).toBe("agent");
  });

  it("retains an edit draft when a comment succeeds in another revealed section", async () => {
    const view = mount(responses());
    await flush();
    view.section("edit");
    fill(
      view.container.querySelector<HTMLInputElement>("[data-testid=stale-edit-title]")!,
      "Synthetic unsaved task title",
    );
    view.section("comments");
    act(() => button(view.container, "Add comment").click());
    fill(
      view.container.querySelector<HTMLTextAreaElement>("[data-testid=comment-body]")!,
      "Synthetic committed comment",
    );
    await act(async () => {
      view.container
        .querySelector("[data-testid=comment-form]")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    view.section("edit");
    expect(
      view.container.querySelector<HTMLInputElement>("[data-testid=stale-edit-title]")?.value,
    ).toBe("Synthetic unsaved task title");
  });

  it("keeps the edit draft's original version after an unrelated refresh until explicit reload", async () => {
    let version = 1;
    const edits: Array<Record<string, unknown>> = [];
    const view = mount(
      responses((url, method, init) => {
        if (url.endsWith("/tasks/a") && method === "GET")
          return Promise.resolve(
            Response.json({
              task: {
                ...task("a"),
                title: `Committed title ${version}`,
                resource_version: version,
              },
            }),
          );
        if (url.endsWith("/tasks/a/comments") && method === "POST") {
          version = 2;
          return Promise.resolve(Response.json({ ok: true }));
        }
        if (url.endsWith("/tasks/a") && method === "PATCH") {
          edits.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return Promise.resolve(
            Response.json(
              { error: { code: "stale_version", message: "Synthetic task version conflict" } },
              { status: 409 },
            ),
          );
        }
        return undefined;
      }),
    );
    await flush();
    view.section("edit");
    fill(
      view.container.querySelector<HTMLInputElement>("[data-testid=stale-edit-title]")!,
      "Synthetic original-version draft",
    );
    view.section("comments");
    act(() => button(view.container, "Add comment").click());
    fill(
      view.container.querySelector<HTMLTextAreaElement>("[data-testid=comment-body]")!,
      "Synthetic unrelated comment",
    );
    await act(async () =>
      view.container
        .querySelector("[data-testid=comment-form]")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await flush();
    view.section("edit");
    await act(async () =>
      view.container
        .querySelector("[data-testid=stale-edit-form]")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await flush();
    expect(edits[0]).toMatchObject({
      expected_version: 1,
      title: "Synthetic original-version draft",
    });
    expect(view.container.querySelector("[data-testid=mutation-error]")?.textContent).toContain(
      "This task changed.",
    );
    act(() => button(view.container, "Reload current version").click());
    await flush();
    expect(
      view.container.querySelector<HTMLInputElement>("[data-testid=stale-edit-title]")?.value,
    ).toBe("Committed title 2");
    fill(
      view.container.querySelector<HTMLInputElement>("[data-testid=stale-edit-title]")!,
      "Synthetic refreshed-version draft",
    );
    await act(async () =>
      view.container
        .querySelector("[data-testid=stale-edit-form]")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await flush();
    expect(edits[1]).toMatchObject({
      expected_version: 2,
      title: "Synthetic refreshed-version draft",
    });
  });

  it("retains a handoff draft and its base version across unrelated refresh, close, and reopen", async () => {
    let version = 1;
    let submitted: Record<string, unknown> | undefined;
    const view = mount(
      responses((url, method, init) => {
        if (url.endsWith("/tasks/a") && method === "GET")
          return Promise.resolve(
            Response.json({ task: { ...task("a"), resource_version: version } }),
          );
        if (url.includes("/members?"))
          return Promise.resolve(
            Response.json({
              members: [
                { id: "human", display_name: "Synthetic owner", role: "owner" },
                { id: "another-human", display_name: "Synthetic member", role: "member" },
              ],
            }),
          );
        if (url.endsWith("/tasks/a/comments") && method === "POST") {
          version = 2;
          return Promise.resolve(Response.json({ ok: true }));
        }
        if (url.endsWith("/tasks/a") && method === "PATCH") {
          submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Promise.resolve(
            Response.json(
              { error: { code: "stale_version", message: "Synthetic handoff version conflict" } },
              { status: 409 },
            ),
          );
        }
        return undefined;
      }),
    );
    await flush();
    view.section("handoff");
    const human = view.container.querySelector<HTMLSelectElement>("[data-testid=handoff-human]")!;
    act(() => {
      human.value = "another-human";
      human.dispatchEvent(new Event("change", { bubbles: true }));
    });
    fill(
      view.container.querySelector<HTMLInputElement>("[data-testid=handoff-form] input")!,
      "Synthetic retained handoff reason",
    );
    view.section("comments");
    act(() => button(view.container, "Add comment").click());
    fill(
      view.container.querySelector<HTMLTextAreaElement>("[data-testid=comment-body]")!,
      "Synthetic unrelated handoff comment",
    );
    await act(async () =>
      view.container
        .querySelector("[data-testid=comment-form]")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await flush();
    view.render({ selectedTaskId: null });
    view.render({ selectedTaskId: "a" });
    await flush();
    view.section("handoff");
    expect(
      view.container.querySelector<HTMLSelectElement>("[data-testid=handoff-human]")?.value,
    ).toBe("another-human");
    expect(
      view.container.querySelector<HTMLInputElement>("[data-testid=handoff-form] input")?.value,
    ).toBe("Synthetic retained handoff reason");
    await act(async () =>
      view.container
        .querySelector("[data-testid=handoff-form]")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await flush();
    expect(submitted).toMatchObject({
      expected_version: 1,
      next_owner_type: "human",
      next_owner_id: "another-human",
      next_action_reason: "Synthetic retained handoff reason",
    });
  });

  it("surfaces a late hidden result failure as a label-only disclosure and focuses its selector", async () => {
    const review = deferred<Response>();
    const view = mount(
      responses((url, method) => {
        if (url.endsWith("/runs/run-a/review") && method === "POST") return review.promise;
        return undefined;
      }),
    );
    await flush();
    view.section("results");
    await flush();
    act(() =>
      view.container.querySelector<HTMLButtonElement>("[data-testid=accept-result]")!.click(),
    );
    view.section("overview");
    await act(async () =>
      review.resolve(
        Response.json(
          { error: { code: "forbidden", message: "Synthetic hidden review failure body" } },
          { status: 403 },
        ),
      ),
    );
    await flush();
    const notice = view.container.querySelector<HTMLElement>("[data-testid=hidden-section-alert]");
    expect(notice).not.toBeNull();
    expect(notice?.closest("[hidden]")).toBeNull();
    expect(notice?.textContent).not.toContain("Synthetic hidden review failure body");
    expect(
      view.container.querySelector<HTMLSelectElement>("[data-testid=task-section]")?.value,
    ).toBe("overview");
    act(() => button(notice!, "Show section error").click());
    await flush();
    expect(
      view.container.querySelector<HTMLSelectElement>("[data-testid=task-section]")?.value,
    ).toBe("results");
    expect(view.container.querySelector("[data-panel=results]")?.hasAttribute("hidden")).toBe(
      false,
    );
    expect(document.activeElement).toBe(view.container.querySelector("[data-testid=task-section]"));
    expect(view.container.querySelector("[data-testid=result-error]")?.textContent).toContain(
      "Synthetic hidden review failure body",
    );
    view.render({ selectedTaskId: "b" });
    await flush();
    expect(view.container.querySelector("[data-testid=hidden-section-alert]")).toBeNull();
  });

  it("returns focus to comment entry after cancelling its disclosed composer", async () => {
    const view = mount(responses());
    await flush();
    view.section("comments");
    act(() => button(view.container, "Add comment").click());
    act(() => {
      button(view.container, "Cancel").focus();
      button(view.container, "Cancel").click();
    });
    await flush();
    expect(document.activeElement).toBe(
      view.container.querySelector("[data-testid=comment-compose-toggle]"),
    );
  });

  it("moves focus into the context composer after requesting it", async () => {
    const view = mount(responses());
    await flush();
    view.section("context");
    act(() => {
      button(view.container, "Add context").focus();
      button(view.container, "Add context").click();
    });
    await flush();
    expect(document.activeElement).toBe(view.container.querySelector("[data-testid=context-body]"));
  });
});
