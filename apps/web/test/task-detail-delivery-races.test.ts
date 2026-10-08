// ABOUTME: Exercises task-detail presentation races with mounted result, measurement and artifact-review panels.
// ABOUTME: Deferred synthetic HTTP and body replies prove UI suppression independently of server-authority witnesses.

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewPanel } from "../src/artifacts/ArtifactReview.js";
import { MeasurementsPanel, type TaskMeasurementsView } from "../src/work/measurements.js";
import { WorkMutations } from "../src/work/mutations.js";
import { ResultPanel } from "../src/work/result.js";

type Panel = "result" | "measurements" | "review";
const panels: Panel[] = ["result", "measurements", "review"];
const mounted: Array<{ root: Root; container: HTMLElement; unmounted: boolean }> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function delayedBody(promise: Promise<unknown>): Response {
  const response = Response.json({});
  Object.defineProperty(response, "json", { value: () => promise });
  return response;
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

const canary = (taskId: string, tag = "CURRENT") => `SYNTHETIC-${taskId}-${tag}-CONTENT`;
const runId = (taskId: string, tag = "CURRENT") => `run-${taskId}-${tag}`;
const artifactId = (taskId: string, tag = "CURRENT", slot = "two") =>
  `artifact-${taskId}-${tag}-${slot}`;

function run(taskId: string, tag = "CURRENT") {
  return {
    id: runId(taskId, tag),
    result_state: "submitted",
    activity: "idle",
    resource_version: 1,
  };
}

function submission(taskId: string, tag = "CURRENT") {
  return {
    id: `submission-${taskId}-${tag}`,
    version: 1,
    summary: canary(taskId, tag),
    limitations: "",
    evidence_refs: [],
    git_branch: null,
    git_commit: null,
    git_dirty: null,
    submitted_by_kind: "human",
    submitted_at: "2026-10-07T12:00:00Z",
    superseded: false,
    outdated: false,
    outdated_reasons: [],
  };
}

function timer(taskId: string, tag = "CURRENT") {
  return {
    id: `timer-${taskId}-${tag}`,
    started_by_human_id: "synthetic-human",
    started_at: "2026-10-07T12:00:00Z",
    stopped_at: null,
    state: "open" as const,
    resource_version: 1,
  };
}

function measurement(taskId: string, tag = "CURRENT"): TaskMeasurementsView {
  const emptyTokens = {
    input: null,
    output: null,
    cache_read: null,
    cache_write: null,
    reasoning: null,
  };
  return {
    runs: [],
    totals: {
      active_ms: 0,
      process_elapsed_ms: 0,
      process_alive_ms: 0,
      offline_ms: 0,
      external_wait_ms: null,
      idle_ms: null,
      unknown_run_counts: { process: 0, active: 0, external_wait: 0, idle: 0 },
      legacy_estimated_runs: 0,
      exact_overflow_fields: [],
      estimated_overflow_fields: [],
      attention_wait_ms: 0,
      exact_tokens: emptyTokens,
      estimated_tokens: emptyTokens,
      unavailable_token_reports: 0,
    },
    review: { timers: [timer(taskId, tag)], stopped_total_ms: 0, open_ms: 0 },
    // This visibly synthetic presentation label is not an attention producer fixture.
    attention: [
      {
        request_id: `attention-${taskId}-${tag}`,
        kind: canary(taskId, tag),
        blocking: false,
        state: "answered",
        first_response_ms: 1000,
        resolution_ms: 2000,
        open: false,
      },
    ],
    browser_activity: [],
    interventions: { runs: 1, restarts: 0, submission_versions: 1 },
  };
}

function version(id: string) {
  return {
    id: `version-${id}`,
    state: "available",
    format: "html",
    content_hash: "a".repeat(64),
    created_at: "2026-10-07T12:00:00Z",
    available_at: "2026-10-07T12:00:01Z",
    approvals: 0,
    changes_requested: 0,
  };
}

function artifact(taskId: string, tag = "CURRENT", slot = "two") {
  const id = artifactId(taskId, tag, slot);
  return {
    artifact_id: id,
    run_id: runId(taskId, tag),
    format: "html",
    role: "review",
    created_at: "2026-10-07T12:00:00Z",
    version_count: 1,
    latest_version: version(id),
    approved: false,
    changes_requested: false,
    review_count: 1,
  };
}

function status(id: string, taskId = "task-a", tag = "CURRENT") {
  return {
    artifact_id: id,
    run_id: runId(taskId, tag),
    latest_version: version(id),
    approved: false,
    changes_requested: false,
    review_count: 1,
    historical_count: 0,
    linked_submissions: [],
    reviews: [
      {
        id: `review-${id}-${tag}`,
        version_id: `version-${id}`,
        content_hash: "a".repeat(64),
        reviewer_human_id: "synthetic-human",
        decision: "comment",
        comment: canary(taskId, tag),
        git_commit: null,
        config_hash: null,
        review_timer_observation_id: null,
        created_at: "2026-10-07T12:00:02Z",
        historical: false,
        outdated: false,
        outdated_reasons: [],
      },
    ],
  };
}

function task(id: string) {
  return {
    id,
    project_id: "synthetic-project",
    title: `Synthetic ${id}`,
    state: "review",
    priority: "P2",
    next_owner_type: "human",
    next_owner_id: "synthetic-human",
    next_action_reason: "Review synthetic records",
    punchline: "Synthetic task",
    resource_version: 1,
  };
}

interface Call {
  path: string;
  method: string;
}
type Override = (path: string, method: string, init?: RequestInit) => Promise<Response> | undefined;

function responseFor(path: string, tag = "CURRENT"): Response {
  const url = new URL(path, "https://bfb.synthetic.invalid"),
    pathname = url.pathname;
  if (pathname === "/api/v1/_substrate")
    return Response.json({
      ok: true,
      artifact_origin: "https://artifacts.synthetic.invalid",
      features: { artifact_viewer: true, artifact_review: true },
    });
  if (pathname.endsWith("/members")) return Response.json({ members: [] });
  if (pathname.endsWith("/comments")) return Response.json({ comments: [] });
  if (pathname.endsWith("/context")) return Response.json({ context: [] });
  const taskMatch = pathname.match(/\/tasks\/(task-[ab])(.*)$/u);
  if (taskMatch) {
    const taskId = taskMatch[1]!;
    if (taskMatch[2] === "") return Response.json({ task: task(taskId) });
    if (taskMatch[2] === "/runs") return Response.json({ runs: [run(taskId, tag)] });
    if (taskMatch[2] === "/measurements")
      return Response.json({ measurements: measurement(taskId, tag) });
    if (taskMatch[2] === "/review-timers") return Response.json({ timers: [timer(taskId, tag)] });
  }
  const results = pathname.match(/\/runs\/run-(task-[ab])-(\w+)\/results$/u);
  if (results) return Response.json({ submissions: [submission(results[1]!, results[2]!)] });
  if (pathname.endsWith("/artifacts")) {
    const parent = url.searchParams.get("run_id")?.match(/^run-(task-[ab])-(\w+)$/u);
    if (parent)
      return Response.json({
        artifacts: [
          artifact(parent[1]!, parent[2]!, "one"),
          artifact(parent[1]!, parent[2]!, "two"),
        ],
      });
  }
  const reviews = pathname.match(
    /\/artifacts\/(artifact-(task-[ab])-(\w+)-(?:one|two))\/reviews$/u,
  );
  if (reviews) return Response.json(status(reviews[1]!, reviews[2]!, reviews[3]!));
  throw new Error(`Unexpected synthetic read: ${path}`);
}

function backend(override: Override = () => undefined, tag = "CURRENT") {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = String(input),
      method = init?.method ?? "GET";
    calls.push({ path, method });
    const custom = override(path, method, init);
    if (custom) return custom;
    return method === "GET"
      ? responseFor(path, tag)
      : Response.json({ ok: true, result: { id: "synthetic-committed" }, replayed: false });
  };
  return { fetchImpl, calls };
}

function mountPanel(kind: Panel, fetchImpl: typeof fetch) {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const entry = { root: createRoot(container), container, unmounted: false };
  mounted.push(entry);
  const onReviewed = vi.fn();
  let props = { workspaceId: "workspace-a", taskId: "task-a", fetchImpl };
  function render(next: Partial<typeof props> = {}) {
    props = { ...props, ...next };
    const element =
      kind === "result"
        ? createElement(ResultPanel, {
            ...props,
            taskState: "review",
            taskVersion: 1,
            role: "owner",
            onReviewed,
          })
        : kind === "measurements"
          ? createElement(MeasurementsPanel, props)
          : createElement(ReviewPanel, { ...props, role: "owner", onReviewed });
    act(() => entry.root.render(element));
  }
  function unmount() {
    act(() => entry.root.unmount());
    entry.unmounted = true;
  }
  render();
  return { container, render, unmount, onReviewed };
}

function query<T extends Element = HTMLElement>(container: HTMLElement, id: string) {
  return container.querySelector<T>(`[data-testid="${id}"]`);
}

function button(container: HTMLElement, id: string) {
  const found = query<HTMLButtonElement>(container, id);
  if (!found) throw new Error(`Missing synthetic interaction control: ${id}`);
  return found;
}

function click(container: HTMLElement, id: string) {
  act(() => button(container, id).click());
}

function fill(container: HTMLElement, id: string, value: string) {
  const input = query<HTMLTextAreaElement>(container, id);
  if (!input) throw new Error(`Missing synthetic note field: ${id}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const retryId = (kind: Panel) => (kind === "review" ? "review-reload" : `${kind}-retry`);
const noteId = (kind: Panel) => (kind === "review" ? "review-note" : "request-changes-comment");
const actionId = (kind: Panel) =>
  kind === "result"
    ? "request-changes-submit"
    : kind === "review"
      ? "review-comment-submit"
      : "review-timer-start";

function mutate(kind: Panel, container: HTMLElement, note = "Synthetic retained draft") {
  if (kind !== "measurements") fill(container, noteId(kind), note);
  if (kind === "result")
    act(() =>
      query(container, "request-changes-form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
  else click(container, actionId(kind));
}

function denied(statusCode = 403, code = "forbidden") {
  return Response.json(
    { ok: false, error: { code, message: "Synthetic current authority denial" } },
    { status: statusCode },
  );
}

function firstRead(kind: Panel, path: string) {
  return kind === "measurements"
    ? path.endsWith("/tasks/task-a/measurements")
    : path.endsWith("/tasks/task-a/runs");
}

function assertDenied(kind: Panel, container: HTMLElement) {
  const records =
    kind === "result"
      ? ["run-result-row", "result-latest", "request-changes-form", "accept-result", "result-empty"]
      : kind === "measurements"
        ? [
            "measurements-human",
            "review-timer-row",
            "review-timer-start",
            "review-timer-stop",
            "measurements-loading",
          ]
        : [
            "review-artifact-select",
            "review-provenance",
            "review-record",
            "artifact-viewer",
            "review-decide-form",
            "review-empty",
          ];
  expect(query(container, kind === "review" ? "review-error" : `${kind}-error`)).not.toBeNull();
  for (const id of records)
    expect(query(container, id), `denied ${kind} still exposes ${id}`).toBeNull();
  expect(container.textContent).not.toContain("-CONTENT");
}

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    if (!entry.unmounted) act(() => entry.root.unmount());
    entry.container.remove();
  }
  await flush();
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

describe("task-detail mounted delivery", () => {
  // These additional cases target the hardened components; the original 25-case OLD log remains separate.
  it("expanded artifact notes stay bound to their selected artifact through A→B→A", async () => {
    const f = backend(),
      view = mountPanel("review", f.fetchImpl);
    await flush();
    const idA = artifactId("task-a"),
      idB = artifactId("task-a", "CURRENT", "one");
    const choose = (id: string) =>
      act(() => {
        const select = query<HTMLSelectElement>(view.container, "review-artifact-select")!;
        select.value = id;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    fill(view.container, "review-note", "Synthetic unsent artifact A note");
    choose(idB);
    await flush();
    expect(query<HTMLTextAreaElement>(view.container, "review-note")?.value).toBe("");
    fill(view.container, "review-note", "Synthetic unsent artifact B note");
    choose(idA);
    await flush();
    expect(query<HTMLTextAreaElement>(view.container, "review-note")?.value).toBe(
      "Synthetic unsent artifact A note",
    );
    choose(idB);
    await flush();
    expect(query<HTMLTextAreaElement>(view.container, "review-note")?.value).toBe(
      "Synthetic unsent artifact B note",
    );
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it.each(["result", "review"] as const)(
    "expanded %s preserves notes edited during POST, including value A→B→A revisions",
    async (kind) => {
      for (const returnToSubmitted of [false, true]) {
        const pending = deferred<Response>();
        let submitted: Record<string, unknown> | undefined;
        const f = backend((_path, method, init) => {
          if (method !== "POST") return undefined;
          submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return pending.promise;
        });
        const view = mountPanel(kind, f.fetchImpl);
        await flush();
        mutate(kind, view.container, "Synthetic submitted A");
        await flush();
        expect(submitted?.comment).toBe("Synthetic submitted A");
        fill(view.container, noteId(kind), "Synthetic edited B");
        if (returnToSubmitted) fill(view.container, noteId(kind), "Synthetic submitted A");
        await act(async () => pending.resolve(Response.json({ ok: true, result: {} })));
        await flush();
        expect(query<HTMLTextAreaElement>(view.container, noteId(kind))?.value).toBe(
          returnToSubmitted ? "Synthetic submitted A" : "Synthetic edited B",
        );
        expect(view.onReviewed).toHaveBeenCalledTimes(1);
        view.unmount();
      }
    },
  );

  it.each(panels)("expanded %s rapid double mutation admits only one POST", async (kind) => {
    const pending = deferred<Response>();
    const f = backend((_path, method) => (method === "POST" ? pending.promise : undefined));
    const view = mountPanel(kind, f.fetchImpl);
    await flush();
    if (kind !== "measurements") fill(view.container, noteId(kind), "Synthetic single dispatch");
    act(() => {
      if (kind === "result") {
        const form = query(view.container, "request-changes-form")!;
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      } else {
        const control = button(view.container, actionId(kind));
        control.click();
        control.click();
      }
    });
    await flush();
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    await act(async () => pending.resolve(Response.json({ ok: true, result: {} })));
    await flush();
    expect(view.onReviewed).toHaveBeenCalledTimes(kind === "measurements" ? 0 : 1);
  });

  it.each(panels)(
    "expanded %s mutation follow-up denial withholds bodies/actions and the parent callback",
    async (kind) => {
      let committed = false;
      const f = backend((path, method) => {
        if (method === "POST") {
          committed = true;
          return Promise.resolve(Response.json({ ok: true, result: {} }));
        }
        if (committed && firstRead(kind, path)) return Promise.resolve(denied(404, "not_found"));
        return undefined;
      });
      const view = mountPanel(kind, f.fetchImpl);
      await flush();
      expect(view.container.textContent).toContain(canary("task-a"));
      mutate(kind, view.container);
      await flush();
      expect(committed).toBe(true);
      assertDenied(kind, view.container);
      expect(view.onReviewed).not.toHaveBeenCalled();
      expect(button(view.container, retryId(kind)).disabled).toBe(false);
    },
  );

  it.each(panels)("%s healthy synthetic records and actions remain reachable", async (kind) => {
    const f = backend(),
      view = mountPanel(kind, f.fetchImpl);
    await flush();
    expect(view.container.textContent).toContain(canary("task-a"));
    expect(button(view.container, actionId(kind)).disabled).toBe(false);
    if (kind === "review") {
      expect(query(view.container, "artifact-viewer")).not.toBeNull();
      expect(f.calls.some((call) => call.method === "POST")).toBe(false);
    }
  });

  it.each(panels)("%s task A→B→A does not revive the first A HTTP reply", async (kind) => {
    const old = deferred<Response>();
    let intercepted = false;
    const f = backend((path, method) => {
      if (method === "GET" && firstRead(kind, path) && !intercepted) {
        intercepted = true;
        return old.promise;
      }
      return undefined;
    });
    const view = mountPanel(kind, f.fetchImpl);
    await flush();
    expect(intercepted).toBe(true);
    view.render({ taskId: "task-b" });
    await flush();
    view.render({ taskId: "task-a" });
    await flush();
    expect(view.container.textContent).toContain(canary("task-a"));
    await act(async () =>
      old.resolve(
        responseFor(
          kind === "measurements"
            ? "/api/v1/workspaces/workspace-a/tasks/task-a/measurements"
            : "/api/v1/workspaces/workspace-a/tasks/task-a/runs",
          "OLD",
        ),
      ),
    );
    await flush();
    expect(view.container.textContent).not.toContain(canary("task-a", "OLD"));
    expect(view.container.textContent).toContain(canary("task-a"));
  });

  it.each(panels)(
    "%s newer API-incarnation body wins over old body/error (test-only fetch trigger)",
    async (kind) => {
      for (const outcome of ["body", "error"] as const) {
        const old = deferred<unknown>();
        let intercepted = false;
        const f = backend((path, method) => {
          if (method === "GET" && firstRead(kind, path) && !intercepted) {
            intercepted = true;
            return Promise.resolve(delayedBody(old.promise));
          }
          return undefined;
        });
        const view = mountPanel(kind, f.fetchImpl);
        await flush();
        const newer = backend(() => undefined, "NEW");
        view.render({ fetchImpl: newer.fetchImpl });
        await flush();
        expect(view.container.textContent).toContain(canary("task-a", "NEW"));
        await act(async () => {
          if (outcome === "error") old.reject(new Error("Synthetic old body failure"));
          else
            old.resolve(
              kind === "measurements"
                ? { measurements: measurement("task-a", "OLD") }
                : { runs: [run("task-a", "OLD")] },
            );
        });
        await flush();
        expect(view.container.textContent).not.toContain(canary("task-a", "OLD"));
        expect(view.container.textContent).not.toContain("Synthetic old body failure");
        expect(view.container.textContent).toContain(canary("task-a", "NEW"));
        view.unmount();
      }
    },
  );

  it.each(["result", "measurements"] as const)(
    "%s does not install a partial snapshot before the second body",
    async (kind) => {
      const second = deferred<Response>();
      let held = false;
      const f = backend((path, method) => {
        if (
          method === "GET" &&
          (kind === "result" ? path.endsWith("/results") : path.endsWith("/review-timers"))
        ) {
          held = true;
          return second.promise;
        }
        return undefined;
      });
      const view = mountPanel(kind, f.fetchImpl);
      await flush();
      expect(held).toBe(true);
      expect(
        query(view.container, kind === "result" ? "run-result-row" : "measurements-human"),
      ).toBeNull();
      await act(async () => second.resolve(denied(404, "not_found")));
      await flush();
      assertDenied(kind, view.container);
    },
  );

  it("artifact A→B→A clears status immediately and never revives the first selected-A body", async () => {
    const old = deferred<unknown>(),
      idA = artifactId("task-a", "CURRENT", "one");
    let intercepted = false;
    const f = backend((path, method) => {
      if (method === "GET" && path.endsWith(`/artifacts/${idA}/reviews`) && !intercepted) {
        intercepted = true;
        return Promise.resolve(delayedBody(old.promise));
      }
      return undefined;
    });
    const view = mountPanel("review", f.fetchImpl);
    await flush();
    const select = () => query<HTMLSelectElement>(view.container, "review-artifact-select")!;
    const choose = (id: string) =>
      act(() => {
        select().value = id;
        select().dispatchEvent(new Event("change", { bubbles: true }));
      });
    choose(idA);
    expect(query(view.container, "review-provenance")).toBeNull();
    await flush();
    expect(intercepted).toBe(true);
    choose(artifactId("task-a"));
    await flush();
    choose(idA);
    await flush();
    expect(view.container.textContent).toContain(canary("task-a"));
    await act(async () => old.resolve(status(idA, "task-a", "OLD")));
    await flush();
    expect(select().value).toBe(idA);
    expect(view.container.textContent).not.toContain(canary("task-a", "OLD"));
  });

  it.each(panels)(
    "%s current denied mutation clears a healthy body/actions, with retry and retained local draft",
    async (kind) => {
      let denyMutation = true;
      const f = backend((_path, method) =>
        method === "POST" && denyMutation
          ? Promise.resolve(
              kind === "result"
                ? denied(403, "forbidden")
                : kind === "measurements"
                  ? denied(404, "not_found")
                  : denied(409, "stale_authorization"),
            )
          : undefined,
      );
      const view = mountPanel(kind, f.fetchImpl);
      await flush();
      expect(view.container.textContent).toContain(canary("task-a"));
      mutate(kind, view.container);
      await flush();
      // Assert stale records separately from the new Retry control's absence in OLD source.
      assertDenied(kind, view.container);
      const retry = button(view.container, retryId(kind));
      act(() => retry.focus());
      expect(document.activeElement).toBe(retry);
      denyMutation = false;
      click(view.container, retryId(kind));
      await flush();
      expect(view.container.textContent).toContain(canary("task-a"));
      if (kind !== "measurements")
        expect(query<HTMLTextAreaElement>(view.container, noteId(kind))?.value).toBe(
          "Synthetic retained draft",
        );
      expect(view.onReviewed).not.toHaveBeenCalled();
    },
  );

  it("current 401 suppresses a healthy result snapshot, not only a retry control", async () => {
    const f = backend((_path, method) =>
      method === "POST" ? Promise.resolve(denied(401, "unauthenticated")) : undefined,
    );
    const view = mountPanel("result", f.fetchImpl);
    await flush();
    mutate("result", view.container);
    await flush();
    assertDenied("result", view.container);
  });

  it.each(panels)(
    "%s stale mutation success/failure/finally cannot affect re-entered A or its pending action",
    async (kind) => {
      for (const outcome of ["success", "failure"] as const) {
        const first = deferred<Response>(),
          latest = deferred<Response>();
        let posts = 0;
        const f = backend((_path, method) =>
          method === "POST" ? (++posts === 1 ? first.promise : latest.promise) : undefined,
        );
        const view = mountPanel(kind, f.fetchImpl);
        await flush();
        mutate(kind, view.container, "Synthetic old draft");
        await flush();
        view.render({ taskId: "task-b" });
        await flush();
        view.render({ taskId: "task-a" });
        await flush();
        mutate(kind, view.container, "Synthetic current draft");
        await flush();
        expect(button(view.container, actionId(kind)).disabled).toBe(true);
        const callsBefore = f.calls.length;
        await act(async () =>
          first.resolve(outcome === "success" ? Response.json({ ok: true, result: {} }) : denied()),
        );
        await flush();
        expect(f.calls.length, "old completion started follow-up reads").toBe(callsBefore);
        expect(view.onReviewed).not.toHaveBeenCalled();
        expect(button(view.container, actionId(kind)).disabled).toBe(true);
        expect(view.container.textContent).not.toContain("Synthetic current authority denial");
        if (kind !== "measurements")
          expect(query<HTMLTextAreaElement>(view.container, noteId(kind))?.value).toBe(
            "Synthetic current draft",
          );
        await act(async () => latest.resolve(Response.json({ ok: true, result: {} })));
        await flush();
        expect(button(view.container, actionId(kind)).disabled).toBe(false);
        expect(view.onReviewed).toHaveBeenCalledTimes(kind === "measurements" ? 0 : 1);
        view.unmount();
      }
    },
  );

  it.each(panels)(
    "%s unmounted mutation completion starts no reads or parent callbacks",
    async (kind) => {
      const pending = deferred<Response>();
      const f = backend((_path, method) => (method === "POST" ? pending.promise : undefined));
      const view = mountPanel(kind, f.fetchImpl);
      await flush();
      mutate(kind, view.container);
      await flush();
      view.unmount();
      const count = f.calls.length;
      await act(async () => pending.resolve(Response.json({ ok: true, result: {} })));
      await flush();
      expect(f.calls.length).toBe(count);
      expect(view.onReviewed).not.toHaveBeenCalled();
    },
  );

  it("ordinary result validation/transient failures preserve the draft and readable history", async () => {
    for (const failure of [
      Response.json(
        { error: { code: "invalid_argument", message: "Synthetic validation failure" } },
        { status: 400 },
      ),
      Response.json(
        { error: { code: "service_unavailable", message: "Synthetic transient failure" } },
        { status: 503 },
      ),
    ]) {
      const f = backend((_path, method) =>
        method === "POST" ? Promise.resolve(failure) : undefined,
      );
      const view = mountPanel("result", f.fetchImpl);
      await flush();
      mutate("result", view.container);
      await flush();
      expect(view.container.textContent).toContain(canary("task-a"));
      expect(query<HTMLTextAreaElement>(view.container, noteId("result"))?.value).toBe(
        "Synthetic retained draft",
      );
      expect(button(view.container, actionId("result")).disabled).toBe(false);
      expect(view.onReviewed).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it("artifact version conflict keeps the local note and explicit current-version reload", async () => {
    const f = backend((_path, method) =>
      method === "POST"
        ? Promise.resolve(
            Response.json(
              {
                error: { code: "version_mismatch", message: "Synthetic immutable version changed" },
              },
              { status: 409 },
            ),
          )
        : undefined,
    );
    const view = mountPanel("review", f.fetchImpl);
    await flush();
    mutate("review", view.container);
    await flush();
    expect(view.container.textContent).toContain(canary("task-a"));
    expect(query<HTMLTextAreaElement>(view.container, "review-note")?.value).toBe(
      "Synthetic retained draft",
    );
    expect(button(view.container, "review-reload").textContent).toContain("Reload current version");
    click(view.container, "review-reload");
    await flush();
    expect(query<HTMLTextAreaElement>(view.container, "review-note")?.value).toBe(
      "Synthetic retained draft",
    );
    expect(view.onReviewed).not.toHaveBeenCalled();
  });

  it("a hidden visited result denial removes records but only exposes the label-only section notice", async () => {
    const reply = deferred<Response>();
    const f = backend((path, method) =>
      method === "POST" && path.endsWith("/review") ? reply.promise : undefined,
    );
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const entry = { root: createRoot(container), container, unmounted: false };
    mounted.push(entry);
    act(() =>
      entry.root.render(
        createElement(WorkMutations, {
          workspaceId: "workspace-a",
          selectedTaskId: "task-a",
          humanId: "synthetic-human",
          role: "owner",
          agentProfiles: [],
          fetchImpl: f.fetchImpl,
          csrfToken: "synthetic-csrf",
          onChanged: vi.fn(),
          onClose: vi.fn(),
        }),
      ),
    );
    await flush();
    const section = (value: string) =>
      act(() => {
        const select = query<HTMLSelectElement>(container, "task-section")!;
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    section("results");
    await flush();
    expect(container.textContent).toContain(canary("task-a"));
    click(container, "accept-result");
    section("overview");
    await act(async () => reply.resolve(denied()));
    await flush();
    const notice = query(container, "hidden-section-alert");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).not.toContain(canary("task-a"));
    expect(notice!.textContent).not.toContain("Synthetic current authority denial");
    expect(query<HTMLSelectElement>(container, "task-section")!.value).toBe("overview");
    expect(container.querySelector("[data-panel=results]")!.hasAttribute("hidden")).toBe(true);
    expect(query(container, "result-summary")).toBeNull();
    expect(query(container, "request-changes-form")).toBeNull();
    const reveal = [...notice!.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Show section error",
    )!;
    act(() => reveal.click());
    await flush();
    expect(query<HTMLSelectElement>(container, "task-section")!.value).toBe("results");
    expect(document.activeElement).toBe(query(container, "task-section"));
    expect(button(container, "result-retry")).not.toBeNull();
  });
});
