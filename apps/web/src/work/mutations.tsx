// ABOUTME: Provides compact task creation and a selected-task detail sheet for W01.
// ABOUTME: Role-aware forms use optimistic versions and show human and agent context separately.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { DiscussionSection } from "../discussion/DiscussionSection.js";
import { ReviewPanel } from "../artifacts/ArtifactReview.js";
import { LaunchSection } from "../launch/operations.js";
import type { AgentProfileSummary } from "./board.js";
import { MeasurementsPanel } from "./measurements.js";
import { ResultPanel } from "./result.js";
import { TaskSharingPanel } from "./sharing.js";
import { PrivateCheckpointsPanel } from "./private-checkpoints.js";
import { RunTimeline } from "../realtime/RunTimeline.js";

type WorkspaceRole = "owner" | "member" | "reviewer";

interface ProjectOption {
  id: string;
  name: string;
}

interface TaskDetail {
  id: string;
  project_id: string;
  title: string;
  state: string;
  priority: "P0" | "P1" | "P2" | "P3";
  next_owner_type: "human" | "agent_profile" | "unassigned";
  next_owner_id: string | null;
  next_action_reason: string | null;
  punchline: string;
  resource_version: number;
}

interface CommentRecord {
  id: string;
  body: string;
  kind: string;
  created_at: string;
  author_human_id: string | null;
  author_delegation_id: string | null;
  author_kind: "human" | "delegated_human" | "agent_run" | "unknown";
  author_run_id: string | null;
  author_execution_id: string | null;
  author_provider_session_id: string | null;
  percent: number | null;
  confidence: number | null;
}

export function CommentAuthor({
  comment,
}: {
  comment: Pick<CommentRecord, "author_kind" | "author_run_id">;
}) {
  return (
    <span>
      {comment.author_kind === "agent_run"
        ? `Agent run ${comment.author_run_id ?? ""}`.trim()
        : comment.author_kind === "delegated_human"
          ? "Delegated client"
          : comment.author_kind === "human"
            ? "Human"
            : "Unknown"}
    </span>
  );
}

export function ProgressMetadata({
  comment,
}: {
  comment: Pick<CommentRecord, "kind" | "author_kind" | "percent" | "confidence">;
}) {
  if (comment.kind !== "progress" || (comment.percent === null && comment.confidence === null))
    return null;
  return (
    <span className="comment-attribution">
      {comment.author_kind === "agent_run" ? "Agent-reported" : "Reported"}
      {comment.percent !== null ? ` progress ${comment.percent}%` : " progress"}
      {comment.confidence !== null ? ` · Confidence ${comment.confidence}` : ""}
    </span>
  );
}

interface ContextRecord {
  id: string;
  kind: string;
  body: string;
  audience: "human" | "agent" | "both";
  version: number;
}

interface HumanTarget {
  id: string;
  display_name: string;
  role: WorkspaceRole;
}

interface RequestError extends Error {
  status: number;
  code?: string;
}

function requestId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorMessage(status: number, body: Record<string, unknown>): RequestError {
  const nested =
    body.error && typeof body.error === "object"
      ? (body.error as { code?: unknown; message?: unknown })
      : null;
  const code =
    typeof body.error === "string"
      ? body.error
      : typeof nested?.code === "string"
        ? nested.code
        : undefined;
  const message =
    typeof body.message === "string"
      ? body.message
      : typeof nested?.message === "string"
        ? nested.message
        : `Request failed (${status})`;
  const error = new Error(code ? `${code}: ${message}` : message) as RequestError;
  error.status = status;
  if (code) {
    error.code = code;
  }
  return error;
}

interface MutationClient {
  get(path: string): Promise<Record<string, unknown>>;
  post(path: string, body: unknown): Promise<Record<string, unknown>>;
  patch(path: string, body: unknown): Promise<Record<string, unknown>>;
}

export function client(fetchFn: typeof fetch, csrfToken: string): MutationClient {
  async function send(method: string, path: string, body?: unknown) {
    const response = await fetchFn(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: {
              "content-type": "application/json",
              ...(csrfToken ? { "x-bfb-csrf": csrfToken } : {}),
            },
            body: JSON.stringify(body),
          }),
    });
    const parsed = await responseBody(response);
    if (!response.ok || parsed.ok === false) {
      throw errorMessage(response.status, parsed);
    }
    return parsed;
  }
  return {
    get: (path) => send("GET", path),
    post: (path, body) => send("POST", path, body),
    patch: (path, body) => send("PATCH", path, body),
  };
}

export interface TaskComposerProps {
  workspaceId: string;
  projects: readonly ProjectOption[];
  fetchImpl?: typeof fetch;
  csrfToken?: string;
  onCreated: (taskId: string) => void;
  onCancel: () => void;
}

export function TaskComposer(props: TaskComposerProps) {
  const [projectId, setProjectId] = useState(props.projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<TaskDetail["priority"]>("P2");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const api = useMemo(
    () => client(props.fetchImpl ?? fetch, props.csrfToken ?? ""),
    [props.fetchImpl, props.csrfToken],
  );

  return (
    <section className="task-composer" aria-labelledby="task-composer-title">
      <div className="panel-title-row">
        <div>
          <p className="section-label">NEW WORK</p>
          <h2 id="task-composer-title">Create a task</h2>
        </div>
        <button type="button" className="button-quiet" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      <form
        data-testid="create-task-form"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            setSubmitting(true);
            setError(null);
            try {
              const body = await api.post(`/api/v1/workspaces/${props.workspaceId}/tasks`, {
                project_id: projectId,
                title,
                priority,
                request_id: requestId("web-create"),
              });
              const result = body.result as { id?: string } | undefined;
              if (!result?.id) {
                throw new Error("Task was created without an id");
              }
              props.onCreated(result.id);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Task creation failed");
            } finally {
              setSubmitting(false);
            }
          })();
        }}
      >
        <label>
          Project
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            data-testid="create-task-project"
            required
          >
            {props.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="composer-title-field">
          Task title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            data-testid="create-task-title"
            maxLength={512}
            autoFocus
            required
          />
        </label>
        <label>
          Priority
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as TaskDetail["priority"])}
          >
            <option value="P0">P0 Blocking</option>
            <option value="P1">P1 High</option>
            <option value="P2">P2 Normal</option>
            <option value="P3">P3 Low</option>
          </select>
        </label>
        <button type="submit" className="button-primary" disabled={submitting || !projectId}>
          {submitting ? "Creating…" : "Create task"}
        </button>
      </form>
      {error ? (
        <p className="inline-error" role="alert" data-testid="mutation-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export interface WorkMutationsProps {
  workspaceId: string;
  selectedTaskId: string | null;
  humanId: string;
  humanDisplayName?: string;
  role: WorkspaceRole;
  agentProfiles: readonly AgentProfileSummary[];
  fetchImpl?: typeof fetch;
  csrfToken?: string;
  onChanged: () => void;
  onClose: () => void;
}

type TaskPanel =
  | "overview"
  | "comments"
  | "context"
  | "edit"
  | "handoff"
  | "results"
  | "artifacts"
  | "activity"
  | "measurements"
  | "sharing"
  | "checkpoints"
  | "launch"
  | "discussion";

interface TaskEditDraft {
  title: string;
  punchline: string;
  priority: TaskDetail["priority"];
  baseVersion: number;
}

interface HandoffDraft {
  kind: "human" | "agent_profile";
  profile: string;
  human: string;
  reason: string;
  baseVersion: number;
}

export function WorkMutations(props: WorkMutationsProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  const api = useMemo(() => client(fetchFn, props.csrfToken ?? ""), [fetchFn, props.csrfToken]);
  const canManage = props.role === "owner" || props.role === "member";
  const [loadedTask, setTask] = useState<TaskDetail | null>(null);
  const selection = `${props.workspaceId}:${props.selectedTaskId ?? ""}`;
  const loadedSelection = useRef<string | null>(null);
  const task =
    loadedTask?.id === props.selectedTaskId && loadedSelection.current === selection
      ? loadedTask
      : null;
  const currentSelection = useRef(selection);
  const selectionGeneration = useRef(0);
  if (currentSelection.current !== selection) selectionGeneration.current += 1;
  currentSelection.current = selection;
  const selectedGeneration = selectionGeneration.current;
  const loadGeneration = useRef(0);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const commentTrigger = useRef<HTMLButtonElement>(null);
  const contextRef = useRef<HTMLTextAreaElement>(null);
  const contextTrigger = useRef<HTMLButtonElement>(null);
  const sectionSelector = useRef<HTMLSelectElement>(null);
  const returnCommentFocus = useRef(false);
  const returnContextFocus = useRef(false);
  const editDrafts = useRef<Record<string, TaskEditDraft>>({});
  const handoffDrafts = useRef<Record<string, HandoffDraft>>({});
  const commentDrafts = useRef<Record<string, string>>({});
  const contextDrafts = useRef<
    Record<string, { body: string; audience: "human" | "agent" | "both" }>
  >({});
  const [activePanel, setActivePanel] = useState<TaskPanel>("overview");
  const [visitedPanels, setVisitedPanels] = useState<Set<TaskPanel>>(() => new Set());
  const [sectionAlerts, setSectionAlerts] = useState<TaskPanel[]>([]);
  const [composingComment, setComposingComment] = useState(false);
  const [composingContext, setComposingContext] = useState(false);
  const [compactSheet, setCompactSheet] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 720px)").matches,
  );
  const [comments, setComments] = useState<CommentRecord[]>([]);
  const [context, setContext] = useState<ContextRecord[]>([]);
  const [agentContext, setAgentContext] = useState<ContextRecord[]>([]);
  const [humanTargets, setHumanTargets] = useState<HumanTarget[]>([]);
  const [contextView, setContextView] = useState<"human" | "agent">("human");
  const [comment, setComment] = useState("");
  const [contextBody, setContextBody] = useState("");
  const [contextAudience, setContextAudience] = useState<"human" | "agent" | "both">("agent");
  const [editTitle, setEditTitle] = useState("");
  const [editPunchline, setEditPunchline] = useState("");
  const [editPriority, setEditPriority] = useState<TaskDetail["priority"]>("P2");
  const [handoffProfile, setHandoffProfile] = useState("");
  const [handoffHuman, setHandoffHuman] = useState("");
  const [handoffKind, setHandoffKind] = useState<"human" | "agent_profile">("agent_profile");
  const [handoffReason, setHandoffReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<RequestError | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [features, setFeatures] = useState({
    artifactViewer: false,
    artifactReview: false,
    discussions: false,
  });

  useEffect(() => {
    const controller = new AbortController();
    setFeatures({ artifactViewer: false, artifactReview: false, discussions: false });
    void (async () => {
      try {
        const response = await fetchFn("/api/v1/_substrate", { signal: controller.signal });
        if (!response.ok) return;
        const body = (await response.json()) as {
          ok?: unknown;
          features?: {
            artifact_viewer?: unknown;
            artifact_review?: unknown;
            discussions?: unknown;
          };
        };
        if (controller.signal.aborted || body?.ok !== true) return;
        setFeatures({
          artifactViewer: body.features?.artifact_viewer === true,
          artifactReview: body.features?.artifact_review === true,
          discussions: body.features?.discussions === true,
        });
      } catch {
        // Unavailable configuration must not mount uncertified surfaces.
      }
    })();
    return () => controller.abort();
  }, [fetchFn]);

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 720px)");
    if (!media) return;
    const update = () => setCompactSheet(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!compactSheet || !props.selectedTaskId || !sheet) return;
    const background = [...(sheet.closest("main")?.children ?? [])].filter(
      (element) => !element.contains(sheet) && !element.hasAttribute("inert"),
    );
    for (const element of background) element.setAttribute("inert", "");
    return () => {
      for (const element of background) element.removeAttribute("inert");
    };
  }, [compactSheet, props.selectedTaskId]);

  const loadTask = useCallback(async () => {
    const selected = `${props.workspaceId}:${props.selectedTaskId ?? ""}`;
    if (selected !== currentSelection.current || selectedGeneration !== selectionGeneration.current)
      return;
    const generation = ++loadGeneration.current;
    const isCurrent = () =>
      selected === currentSelection.current &&
      selectedGeneration === selectionGeneration.current &&
      generation === loadGeneration.current;
    if (!props.selectedTaskId) {
      setTask(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const base = `/api/v1/workspaces/${props.workspaceId}/tasks/${props.selectedTaskId}`;
      const [taskBody, commentBody, contextBodyResult, agentContextBody] = await Promise.all([
        api.get(base),
        api.get(`${base}/comments?limit=100`),
        api.get(`${base}/context?audience=all`),
        api.get(`${base}/context?audience=agent`),
      ]);
      const nextTask = taskBody.task as TaskDetail;
      if (!isCurrent()) return;
      const memberBody = await api.get(
        `/api/v1/workspaces/${props.workspaceId}/members?project_id=${encodeURIComponent(nextTask.project_id)}`,
      );
      if (!isCurrent()) return;
      loadedSelection.current = selected;
      setTask(nextTask);
      setComments((commentBody.comments ?? []) as CommentRecord[]);
      setContext((contextBodyResult.context ?? []) as ContextRecord[]);
      setAgentContext((agentContextBody.context ?? []) as ContextRecord[]);
      const nextHumanTargets = (memberBody.members ?? []) as HumanTarget[];
      setHumanTargets(nextHumanTargets);
      const editDraft = editDrafts.current[selected];
      const handoffDraft = handoffDrafts.current[selected];
      setEditTitle(editDraft?.title ?? nextTask.title);
      setEditPunchline(editDraft?.punchline ?? nextTask.punchline);
      setEditPriority(editDraft?.priority ?? nextTask.priority);
      setHandoffProfile(
        handoffDraft?.profile ??
          (nextTask.next_owner_type === "agent_profile" ? (nextTask.next_owner_id ?? "") : ""),
      );
      setHandoffHuman(
        handoffDraft?.human ??
          (nextTask.next_owner_type === "human" ? (nextTask.next_owner_id ?? "") : ""),
      );
      setHandoffKind(
        handoffDraft?.kind ?? (nextTask.next_owner_type === "human" ? "human" : "agent_profile"),
      );
      setHandoffReason(handoffDraft?.reason ?? nextTask.next_action_reason ?? "");
    } catch (cause) {
      if (isCurrent()) {
        setTask(null);
        setError(cause as RequestError);
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [api, props.selectedTaskId, props.workspaceId, selectedGeneration]);

  useEffect(() => {
    setActivePanel("overview");
    setVisitedPanels(new Set());
    setComposingComment(false);
    setComposingContext(false);
    setContextView("human");
    setComment(commentDrafts.current[selection] ?? "");
    setContextBody(contextDrafts.current[selection]?.body ?? "");
    setContextAudience(contextDrafts.current[selection]?.audience ?? "agent");
    setStatus(null);
    setSaving(false);
    void loadTask();
  }, [loadTask, selection]);

  useEffect(() => {
    if (props.selectedTaskId) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && !sheetRef.current?.contains(active)) {
        openerRef.current = active;
      }
      titleRef.current?.focus({ preventScroll: true });
    } else if (openerRef.current?.isConnected) {
      openerRef.current.focus({ preventScroll: true });
    }
  }, [props.selectedTaskId]);

  useEffect(() => {
    if (activePanel === "comments" && composingComment) {
      commentRef.current?.focus({ preventScroll: true });
    } else if (activePanel === "comments" && returnCommentFocus.current) {
      commentTrigger.current?.focus({ preventScroll: true });
      returnCommentFocus.current = false;
    }
  }, [activePanel, composingComment]);

  useEffect(() => {
    if (activePanel === "context" && composingContext) {
      contextRef.current?.focus({ preventScroll: true });
    } else if (activePanel === "context" && returnContextFocus.current) {
      contextTrigger.current?.focus({ preventScroll: true });
      returnContextFocus.current = false;
    }
  }, [activePanel, composingContext]);

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) {
      setSectionAlerts([]);
      return;
    }
    // Existing panels own their error state. Keep a label-only notice reachable
    // when a late response adds an alert inside a section the human has hidden.
    const readAlerts = () => {
      const next = [...sheet.querySelectorAll<HTMLElement>(".task-panel-section[hidden]")]
        .filter((section) =>
          [...section.querySelectorAll('[role="alert"]')].some((alert) =>
            alert.textContent?.trim(),
          ),
        )
        .map((section) => section.dataset.panel as TaskPanel);
      setSectionAlerts((current) => (current.join(",") === next.join(",") ? current : next));
    };
    const observer = new MutationObserver(readAlerts);
    observer.observe(sheet, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden", "role"],
    });
    readAlerts();
    return () => observer.disconnect();
  }, [activePanel, selectedGeneration, props.selectedTaskId]);

  function selectPanel(next: TaskPanel): void {
    setActivePanel(next);
    setVisitedPanels((current) => new Set([...current, next]));
  }

  function panel(name: TaskPanel, content: ReactNode): ReactNode {
    return visitedPanels.has(name) ? (
      <div className="task-panel-section" data-panel={name} hidden={activePanel !== name}>
        {content}
      </div>
    ) : null;
  }

  async function mutate(
    action: () => Promise<unknown>,
    success: string,
    onCommitted?: () => void,
  ): Promise<boolean> {
    const selected = selection;
    const generation = selectionGeneration.current;
    const isCurrent = () =>
      selected === currentSelection.current && generation === selectionGeneration.current;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await action();
      if (!isCurrent()) return false;
      onCommitted?.();
      setStatus(success);
      await loadTask();
      if (!isCurrent()) return false;
      props.onChanged();
      return true;
    } catch (cause) {
      if (isCurrent()) setError(cause as RequestError);
      return false;
    } finally {
      if (isCurrent()) setSaving(false);
    }
  }

  function onReviewed(): void {
    if (
      selection !== currentSelection.current ||
      selectedGeneration !== selectionGeneration.current
    )
      return;
    void loadTask();
    props.onChanged();
  }

  function updateEditDraft(update: Partial<TaskEditDraft>): void {
    if (!task) return;
    const draft = {
      title: editTitle,
      punchline: editPunchline,
      priority: editPriority,
      baseVersion: editDrafts.current[selection]?.baseVersion ?? task.resource_version,
      ...update,
    };
    editDrafts.current[selection] = draft;
    setEditTitle(draft.title);
    setEditPunchline(draft.punchline);
    setEditPriority(draft.priority);
  }

  function updateHandoffDraft(update: Partial<HandoffDraft>): void {
    if (!task) return;
    const draft = {
      kind: handoffKind,
      profile: handoffProfile,
      human: handoffHuman,
      reason: handoffReason,
      baseVersion: handoffDrafts.current[selection]?.baseVersion ?? task.resource_version,
      ...update,
    };
    handoffDrafts.current[selection] = draft;
    setHandoffKind(draft.kind);
    setHandoffProfile(draft.profile);
    setHandoffHuman(draft.human);
    setHandoffReason(draft.reason);
  }

  function reloadCurrentVersion(): void {
    delete editDrafts.current[selection];
    delete handoffDrafts.current[selection];
    void loadTask();
  }

  if (!props.selectedTaskId) {
    return null;
  }

  return (
    <aside
      ref={sheetRef}
      className="task-sheet"
      aria-labelledby="task-detail-title"
      role={compactSheet ? "dialog" : undefined}
      aria-modal={compactSheet ? true : undefined}
      data-testid="task-detail"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          props.onClose();
        }
        if (event.key === "Tab" && compactSheet && !event.defaultPrevented) {
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled),summary,select:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])',
            ),
          ].filter((element) => element.getClientRects().length > 0);
          const index = controls.indexOf(document.activeElement as HTMLElement);
          if (
            (event.shiftKey && index <= 0) ||
            (!event.shiftKey && index === controls.length - 1)
          ) {
            event.preventDefault();
            (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
          }
        }
      }}
    >
      <div className="sheet-header">
        <div>
          <p className="section-label">TASK DETAIL</p>
          <h2 id="task-detail-title" ref={titleRef} tabIndex={-1}>
            {task?.title ?? "Loading task"}
          </h2>
        </div>
        <button
          type="button"
          className="sheet-close"
          onClick={props.onClose}
          aria-label="Close task"
        >
          ×
        </button>
      </div>

      {loading ? (
        <div className="sheet-loading" role="status">
          <span />
          <span />
          <span />
          Loading committed task state…
        </div>
      ) : null}

      {error ? (
        <div className="inline-error" role="alert" data-testid="mutation-error">
          <strong>
            {error.code === "stale_version" ? "This task changed." : "Action failed."}
          </strong>
          <span>{error.message}</span>
          {error.code === "stale_version" ? (
            <button type="button" className="button-secondary" onClick={reloadCurrentVersion}>
              Reload current version
            </button>
          ) : null}
          {!task && !loading && error.code !== "stale_version" ? (
            <button type="button" className="button-secondary" onClick={() => void loadTask()}>
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      {status ? (
        <p className="inline-status" role="status" data-testid="mutation-status">
          {status}
        </p>
      ) : null}

      {task ? (
        <div className="sheet-content">
          <div className="task-panel-actions">
            {activePanel === "overview" && task.state === "proposed" && canManage ? (
              <button
                type="button"
                className="button-primary"
                data-testid="promote-task"
                disabled={saving}
                onClick={() =>
                  void mutate(
                    () =>
                      api.patch(`/api/v1/workspaces/${props.workspaceId}/tasks/${task.id}`, {
                        expected_version: task.resource_version,
                        promote: true,
                        request_id: requestId("web-promote"),
                      }),
                    "Proposed task promoted",
                  )
                }
              >
                Promote task
              </button>
            ) : activePanel === "overview" && task.state === "review" ? (
              <button
                type="button"
                className="button-primary"
                onClick={() => selectPanel("results")}
              >
                Review result
              </button>
            ) : (activePanel === "overview" || activePanel === "comments") && !composingComment ? (
              <button
                type="button"
                className="button-primary"
                ref={commentTrigger}
                data-testid="comment-compose-toggle"
                onClick={() => {
                  selectPanel("comments");
                  setComposingComment(true);
                }}
              >
                Add comment
              </button>
            ) : activePanel === "context" && canManage && !composingContext ? (
              <button
                type="button"
                className="button-primary"
                ref={contextTrigger}
                onClick={() => setComposingContext(true)}
              >
                Add context
              </button>
            ) : null}
            <label className="panel-selector">
              <span>Task section</span>
              <select
                ref={sectionSelector}
                data-testid="task-section"
                value={activePanel}
                onChange={(event) => selectPanel(event.target.value as TaskPanel)}
              >
                <option value="overview">Overview</option>
                <option value="comments">Comments</option>
                <option value="checkpoints">Private checkpoints</option>
                <option value="context">Context</option>
                {canManage ? <option value="edit">Edit task</option> : null}
                {canManage ? <option value="handoff">Handoff</option> : null}
                {canManage ? <option value="sharing">Sharing</option> : null}
                <option value="results">Results</option>
                <option value="artifacts">Artifacts</option>
                <option value="activity">Activity</option>
                <option value="measurements">Measurements</option>
                <option value="launch">Launch controls</option>
                <option value="discussion">Agent discussions</option>
              </select>
            </label>
          </div>
          {sectionAlerts.length ? (
            <div className="inline-error" role="alert" data-testid="hidden-section-alert">
              <p>{`${sectionAlerts.map((name) => name.charAt(0).toUpperCase() + name.slice(1)).join(", ")}: a hidden task section reports an error. Open it to review the failure.`}</p>
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  selectPanel(sectionAlerts[0]!);
                  sectionSelector.current?.focus({ preventScroll: true });
                }}
              >
                Show section error
              </button>
            </div>
          ) : null}
          {panel(
            "checkpoints",
            <PrivateCheckpointsPanel
              workspaceId={props.workspaceId}
              taskId={task.id}
              humanId={props.humanId}
              api={api}
            />,
          )}
          {canManage
            ? panel(
                "sharing",
                <TaskSharingPanel
                  workspaceId={props.workspaceId}
                  taskId={task.id}
                  humanId={props.humanId}
                  members={humanTargets}
                  api={api}
                  onChanged={props.onChanged}
                />,
              )
            : null}
          <section
            className="task-overview"
            aria-label="Current task truth"
            hidden={activePanel !== "overview"}
          >
            <p className="task-state-line">
              <span>{task.state.replaceAll("_", " ")}</span>
              <span>{task.priority}</span>
            </p>
            <p className="task-overview-now">{task.punchline}</p>
            {task.next_action_reason ? (
              <p className="section-summary">{task.next_action_reason}</p>
            ) : null}
            <p className="section-summary">
              {task.next_owner_type === "human"
                ? `Next: ${humanTargets.find((human) => human.id === task.next_owner_id)?.display_name ?? "assigned human"}`
                : task.next_owner_type === "agent_profile"
                  ? `Next: ${props.agentProfiles.find((profile) => profile.id === task.next_owner_id)?.name ?? "assigned agent profile"}`
                  : "No intended owner"}
            </p>
          </section>
          {panel(
            "measurements",
            <section className="task-truth" aria-label="Task measurements">
              <div className="truth-row">
                <span>State</span>
                <strong>{task.state.replaceAll("_", " ")}</strong>
              </div>
              <div className="truth-row">
                <span>Now</span>
                <strong>{task.punchline}</strong>
              </div>
              <div className="truth-row">
                <span>Version</span>
                <code>{task.resource_version}</code>
              </div>
              <MeasurementsPanel
                key={`measurements-${task.id}`}
                workspaceId={props.workspaceId}
                taskId={task.id}
                fetchImpl={fetchFn}
                csrfToken={props.csrfToken ?? ""}
              />
            </section>,
          )}

          {panel(
            "results",
            <ResultPanel
              key={`${task.id}:${task.resource_version}`}
              workspaceId={props.workspaceId}
              taskId={task.id}
              taskState={task.state}
              taskVersion={task.resource_version}
              role={props.role}
              fetchImpl={fetchFn}
              csrfToken={props.csrfToken ?? ""}
              onReviewed={onReviewed}
            />,
          )}
          {panel(
            "artifacts",
            features.artifactViewer && features.artifactReview ? (
              <ReviewPanel
                key={`review-${task.id}:${task.resource_version}`}
                workspaceId={props.workspaceId}
                taskId={task.id}
                role={props.role}
                fetchImpl={fetchFn}
                csrfToken={props.csrfToken ?? ""}
                onReviewed={onReviewed}
              />
            ) : (
              <section data-testid="artifact-features-unavailable">
                <h3>Artifact preview and approval</h3>
                <p className="section-help">
                  Not enabled in this private pilot. Artifact publication remains available through
                  the run-scoped MCP or CLI.
                </p>
              </section>
            ),
          )}
          {panel(
            "activity",
            <RunTimeline
              workspaceId={props.workspaceId}
              taskId={task.id}
              fetchImpl={props.fetchImpl}
            />,
          )}

          {panel(
            "edit",
            canManage ? (
              <section aria-labelledby="edit-task-heading">
                <h3 id="edit-task-heading">Edit current truth</h3>
                <form
                  data-testid="stale-edit-form"
                  className="stacked-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const submitted = editDrafts.current[selection];
                    void mutate(
                      () =>
                        api.patch(`/api/v1/workspaces/${props.workspaceId}/tasks/${task.id}`, {
                          expected_version: submitted?.baseVersion ?? task.resource_version,
                          title: editTitle,
                          punchline: editPunchline,
                          priority: editPriority,
                          request_id: requestId("web-edit"),
                        }),
                      "Task updated",
                      () => {
                        if (editDrafts.current[selection] === submitted)
                          delete editDrafts.current[selection];
                      },
                    );
                  }}
                >
                  <label>
                    Title
                    <input
                      data-testid="stale-edit-title"
                      value={editTitle}
                      onChange={(event) => updateEditDraft({ title: event.target.value })}
                      maxLength={512}
                      required
                    />
                  </label>
                  <label>
                    Now punchline
                    <textarea
                      value={editPunchline}
                      onChange={(event) => updateEditDraft({ punchline: event.target.value })}
                      maxLength={512}
                      rows={2}
                      required
                    />
                  </label>
                  <label>
                    Priority
                    <select
                      value={editPriority}
                      onChange={(event) =>
                        updateEditDraft({ priority: event.target.value as TaskDetail["priority"] })
                      }
                    >
                      <option value="P0">P0 Blocking</option>
                      <option value="P1">P1 High</option>
                      <option value="P2">P2 Normal</option>
                      <option value="P3">P3 Low</option>
                    </select>
                  </label>
                  <button type="submit" className="button-primary" disabled={saving}>
                    Save current truth
                  </button>
                </form>
              </section>
            ) : null,
          )}

          {panel(
            "launch",
            <LaunchSection
              key={task.id}
              workspaceId={props.workspaceId}
              taskId={task.id}
              humanId={props.humanId}
              role={props.role}
              csrfToken={props.csrfToken ?? ""}
              fetchImpl={fetchFn}
            />,
          )}

          {panel(
            "discussion",
            features.discussions ? (
              <DiscussionSection
                workspaceId={props.workspaceId}
                taskId={task.id}
                taskVersion={task.resource_version}
                projectId={task.project_id}
                humanId={props.humanId}
                humanDisplayName={props.humanDisplayName ?? "the signed-in human"}
                role={props.role}
                fetchImpl={props.fetchImpl}
                csrfToken={props.csrfToken}
              />
            ) : (
              <section data-testid="discussions-unavailable">
                <h3>Agent discussions</h3>
                <p className="section-help">Not enabled in this private pilot.</p>
              </section>
            ),
          )}

          {panel(
            "handoff",
            canManage ? (
              <section aria-labelledby="handoff-heading">
                <h3 id="handoff-heading">Intended handoff</h3>
                <p className="section-help">
                  This changes ownership only. It does not start a run or claim the agent is
                  working.
                </p>
                <form
                  className="stacked-form"
                  data-testid="handoff-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const nextOwnerId =
                      handoffKind === "agent_profile" ? handoffProfile : handoffHuman;
                    if (!nextOwnerId) {
                      return;
                    }
                    const submitted = handoffDrafts.current[selection];
                    void mutate(
                      () =>
                        api.patch(`/api/v1/workspaces/${props.workspaceId}/tasks/${task.id}`, {
                          expected_version: submitted?.baseVersion ?? task.resource_version,
                          next_owner_type: handoffKind,
                          next_owner_id: nextOwnerId,
                          next_action_reason: handoffReason,
                          request_id: requestId("web-handoff"),
                        }),
                      "Intended owner updated. No run was started.",
                      () => {
                        if (handoffDrafts.current[selection] === submitted)
                          delete handoffDrafts.current[selection];
                      },
                    );
                  }}
                >
                  <label>
                    Pass to
                    <select
                      data-testid="handoff-kind"
                      value={handoffKind}
                      onChange={(event) =>
                        updateHandoffDraft({
                          kind: event.target.value as "human" | "agent_profile",
                        })
                      }
                    >
                      <option value="agent_profile">Agent profile</option>
                      <option value="human">Human</option>
                    </select>
                  </label>
                  {handoffKind === "agent_profile" ? (
                    <label>
                      Agent profile
                      <select
                        value={handoffProfile}
                        onChange={(event) => updateHandoffDraft({ profile: event.target.value })}
                        required
                      >
                        <option value="">Choose a profile</option>
                        {props.agentProfiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name} · {profile.provider}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label>
                      Human
                      <select
                        data-testid="handoff-human"
                        value={handoffHuman}
                        onChange={(event) => updateHandoffDraft({ human: event.target.value })}
                        required
                      >
                        <option value="">Choose a human</option>
                        {humanTargets.map((human) => (
                          <option key={human.id} value={human.id}>
                            {human.display_name} · {human.role}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    Why this handoff
                    <input
                      value={handoffReason}
                      onChange={(event) => updateHandoffDraft({ reason: event.target.value })}
                      maxLength={512}
                      required
                    />
                  </label>
                  <button type="submit" className="button-secondary" disabled={saving}>
                    Pass work
                  </button>
                </form>
              </section>
            ) : null,
          )}

          {panel(
            "comments",
            <section aria-labelledby="comments-heading">
              <h3 id="comments-heading">Comments</h3>
              {comments.length === 0 ? (
                <p className="compact-empty">No comments yet.</p>
              ) : (
                <ol className="record-list">
                  {comments.map((item) => (
                    <li key={item.id}>
                      <p>{item.body}</p>
                      <CommentAuthor comment={item} />
                      <ProgressMetadata comment={item} />
                    </li>
                  ))}
                </ol>
              )}
              {composingComment ? (
                <form
                  data-testid="comment-form"
                  className="stacked-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const submitted = comment;
                    void mutate(
                      () =>
                        api.post(
                          `/api/v1/workspaces/${props.workspaceId}/tasks/${task.id}/comments`,
                          {
                            body: submitted,
                            kind: "discussion",
                            request_id: requestId("web-comment"),
                          },
                        ),
                      "Comment added",
                    ).then((succeeded) => {
                      if (!succeeded || commentDrafts.current[selection] !== submitted) return;
                      setComment("");
                      commentDrafts.current[selection] = "";
                      setComposingComment(false);
                    });
                  }}
                >
                  <label>
                    Add a comment
                    <textarea
                      data-testid="comment-body"
                      ref={commentRef}
                      value={comment}
                      onChange={(event) => {
                        setComment(event.target.value);
                        commentDrafts.current[selection] = event.target.value;
                      }}
                      maxLength={2048}
                      rows={3}
                      required
                    />
                  </label>
                  <div className="comment-actions">
                    <button type="submit" className="button-primary" disabled={saving}>
                      Add comment
                    </button>
                    <button
                      type="button"
                      className="button-quiet"
                      disabled={saving}
                      onClick={() => {
                        returnCommentFocus.current = true;
                        setComposingComment(false);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}
            </section>,
          )}

          {panel(
            "context",
            <section aria-labelledby="context-heading">
              <div className="context-heading-row">
                <h3 id="context-heading">Context</h3>
                <div className="segmented-control" aria-label="Context view">
                  <button
                    type="button"
                    aria-pressed={contextView === "human"}
                    onClick={() => setContextView("human")}
                  >
                    Human view
                  </button>
                  <button
                    type="button"
                    aria-pressed={contextView === "agent"}
                    onClick={() => setContextView("agent")}
                    data-testid="agent-context-preview"
                  >
                    Agent preview
                  </button>
                </div>
              </div>
              <p className="section-help">
                {contextView === "agent"
                  ? "Human-only context is excluded from this preview."
                  : "Authorized human view includes every audience."}
              </p>
              {(contextView === "agent" ? agentContext : context).length === 0 ? (
                <p className="compact-empty">No context for this audience.</p>
              ) : (
                <ol className="record-list" data-testid="context-list">
                  {(contextView === "agent" ? agentContext : context).map((item) => (
                    <li key={item.id} data-audience={item.audience}>
                      <span>{`${item.kind} · ${item.audience} · v${item.version}`}</span>
                      <p>{item.body}</p>
                    </li>
                  ))}
                </ol>
              )}
              {canManage && composingContext ? (
                <form
                  data-testid="context-form"
                  className="stacked-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const submitted = contextBody;
                    const submittedAudience = contextAudience;
                    void mutate(
                      () =>
                        api.post(
                          `/api/v1/workspaces/${props.workspaceId}/tasks/${task.id}/context`,
                          {
                            kind: "note",
                            audience: submittedAudience,
                            body: submitted,
                            request_id: requestId("web-context"),
                          },
                        ),
                      "Context version added",
                    ).then((succeeded) => {
                      if (
                        !succeeded ||
                        contextDrafts.current[selection]?.body !== submitted ||
                        contextDrafts.current[selection]?.audience !== submittedAudience
                      )
                        return;
                      setContextBody("");
                      contextDrafts.current[selection] = { body: "", audience: submittedAudience };
                      setComposingContext(false);
                    });
                  }}
                >
                  <label>
                    Audience
                    <select
                      value={contextAudience}
                      onChange={(event) => {
                        const audience = event.target.value as "human" | "agent" | "both";
                        setContextAudience(audience);
                        contextDrafts.current[selection] = { body: contextBody, audience };
                      }}
                      data-testid="context-audience"
                    >
                      <option value="agent">Agent</option>
                      <option value="human">Human only</option>
                      <option value="both">Both</option>
                    </select>
                  </label>
                  <label>
                    Add context
                    <textarea
                      ref={contextRef}
                      data-testid="context-body"
                      value={contextBody}
                      onChange={(event) => {
                        setContextBody(event.target.value);
                        contextDrafts.current[selection] = {
                          body: event.target.value,
                          audience: contextAudience,
                        };
                      }}
                      rows={3}
                      maxLength={16_384}
                      required
                    />
                  </label>
                  <button type="submit" className="button-secondary" disabled={saving}>
                    Add context version
                  </button>
                  <button
                    type="button"
                    className="button-quiet"
                    disabled={saving}
                    onClick={() => {
                      returnContextFocus.current = true;
                      setComposingContext(false);
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : null}
            </section>,
          )}
        </div>
      ) : null}
    </aside>
  );
}
