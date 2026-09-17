// ABOUTME: Provides compact task creation and a selected-task detail sheet for W01.
// ABOUTME: Role-aware forms use optimistic versions and show human and agent context separately.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { AgentProfileSummary } from "./board.js";
import { ResultPanel } from "./result.js";

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
  role: WorkspaceRole;
  agentProfiles: readonly AgentProfileSummary[];
  fetchImpl?: typeof fetch;
  csrfToken?: string;
  onChanged: () => void;
  onClose: () => void;
}

export function WorkMutations(props: WorkMutationsProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  const api = useMemo(() => client(fetchFn, props.csrfToken ?? ""), [fetchFn, props.csrfToken]);
  const canManage = props.role === "owner" || props.role === "member";
  const [task, setTask] = useState<TaskDetail | null>(null);
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

  const loadTask = useCallback(async () => {
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
      setTask(nextTask);
      setComments((commentBody.comments ?? []) as CommentRecord[]);
      setContext((contextBodyResult.context ?? []) as ContextRecord[]);
      setAgentContext((agentContextBody.context ?? []) as ContextRecord[]);
      const memberBody = await api.get(
        `/api/v1/workspaces/${props.workspaceId}/members?project_id=${encodeURIComponent(nextTask.project_id)}`,
      );
      const nextHumanTargets = (memberBody.members ?? []) as HumanTarget[];
      setHumanTargets(nextHumanTargets);
      setEditTitle(nextTask.title);
      setEditPunchline(nextTask.punchline);
      setEditPriority(nextTask.priority);
      setHandoffProfile(
        nextTask.next_owner_type === "agent_profile" ? (nextTask.next_owner_id ?? "") : "",
      );
      setHandoffHuman(nextTask.next_owner_type === "human" ? (nextTask.next_owner_id ?? "") : "");
      setHandoffKind(nextTask.next_owner_type === "human" ? "human" : "agent_profile");
      setHandoffReason(nextTask.next_action_reason ?? "");
    } catch (cause) {
      setError(cause as RequestError);
    } finally {
      setLoading(false);
    }
  }, [api, props.selectedTaskId, props.workspaceId]);

  useEffect(() => {
    void loadTask();
  }, [loadTask]);

  async function mutate(action: () => Promise<unknown>, success: string): Promise<void> {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await action();
      setStatus(success);
      await loadTask();
      props.onChanged();
    } catch (cause) {
      setError(cause as RequestError);
    } finally {
      setSaving(false);
    }
  }

  if (!props.selectedTaskId) {
    return null;
  }

  return (
    <aside className="task-sheet" aria-labelledby="task-detail-title" data-testid="task-detail">
      <div className="sheet-header">
        <div>
          <p className="section-label">TASK DETAIL</p>
          <h2 id="task-detail-title">{task?.title ?? "Loading task"}</h2>
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
            <button type="button" className="button-secondary" onClick={() => void loadTask()}>
              Reload current version
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
          <section className="task-truth" aria-label="Current task truth">
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
            <p className="unavailable-copy">Time and token measurements are unavailable.</p>
          </section>

          {task ? (
            <ResultPanel
              key={`${task.id}:${task.resource_version}`}
              workspaceId={props.workspaceId}
              taskId={task.id}
              taskState={task.state}
              taskVersion={task.resource_version}
              role={props.role}
              fetchImpl={fetchFn}
              csrfToken={props.csrfToken ?? ""}
              onReviewed={() => {
                void loadTask();
                props.onChanged();
              }}
            />
          ) : null}

          {canManage ? (
            <section aria-labelledby="edit-task-heading">
              <h3 id="edit-task-heading">Edit current truth</h3>
              <form
                data-testid="stale-edit-form"
                className="stacked-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate(
                    () =>
                      api.patch(`/api/v1/workspaces/${props.workspaceId}/tasks/${task.id}`, {
                        expected_version: task.resource_version,
                        title: editTitle,
                        punchline: editPunchline,
                        priority: editPriority,
                        request_id: requestId("web-edit"),
                      }),
                    "Task updated",
                  );
                }}
              >
                <label>
                  Title
                  <input
                    data-testid="stale-edit-title"
                    value={editTitle}
                    onChange={(event) => setEditTitle(event.target.value)}
                    maxLength={512}
                    required
                  />
                </label>
                <label>
                  Now punchline
                  <textarea
                    value={editPunchline}
                    onChange={(event) => setEditPunchline(event.target.value)}
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
                      setEditPriority(event.target.value as TaskDetail["priority"])
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
              {task.state === "proposed" ? (
                <button
                  type="button"
                  className="button-attention"
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
                  Promote proposed task
                </button>
              ) : null}
            </section>
          ) : null}

          {canManage ? (
            <section aria-labelledby="handoff-heading">
              <h3 id="handoff-heading">Intended handoff</h3>
              <p className="section-help">
                This changes ownership only. It does not start a run or claim the agent is working.
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
                  void mutate(
                    () =>
                      api.patch(`/api/v1/workspaces/${props.workspaceId}/tasks/${task.id}`, {
                        expected_version: task.resource_version,
                        next_owner_type: handoffKind,
                        next_owner_id: nextOwnerId,
                        next_action_reason: handoffReason,
                        request_id: requestId("web-handoff"),
                      }),
                    "Intended owner updated. No run was started.",
                  );
                }}
              >
                <label>
                  Pass to
                  <select
                    data-testid="handoff-kind"
                    value={handoffKind}
                    onChange={(event) =>
                      setHandoffKind(event.target.value as "human" | "agent_profile")
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
                      onChange={(event) => setHandoffProfile(event.target.value)}
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
                      onChange={(event) => setHandoffHuman(event.target.value)}
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
                    onChange={(event) => setHandoffReason(event.target.value)}
                    maxLength={512}
                    required
                  />
                </label>
                <button type="submit" className="button-secondary" disabled={saving}>
                  Pass work
                </button>
              </form>
            </section>
          ) : null}

          <section aria-labelledby="comments-heading">
            <h3 id="comments-heading">Comments</h3>
            {comments.length === 0 ? (
              <p className="compact-empty">No comments yet.</p>
            ) : (
              <ol className="record-list">
                {comments.map((item) => (
                  <li key={item.id}>
                    <p>{item.body}</p>
                    <span>{item.author_delegation_id ? "Delegated client" : "Human"}</span>
                  </li>
                ))}
              </ol>
            )}
            <form
              data-testid="comment-form"
              className="stacked-form"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate(
                  () =>
                    api.post(`/api/v1/workspaces/${props.workspaceId}/tasks/${task.id}/comments`, {
                      body: comment,
                      kind: "discussion",
                      request_id: requestId("web-comment"),
                    }),
                  "Comment added",
                ).then(() => setComment(""));
              }}
            >
              <label>
                Add a comment
                <textarea
                  data-testid="comment-body"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  maxLength={2048}
                  rows={3}
                  required
                />
              </label>
              <button type="submit" className="button-secondary" disabled={saving}>
                Add comment
              </button>
            </form>
          </section>

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
            {canManage ? (
              <form
                data-testid="context-form"
                className="stacked-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate(
                    () =>
                      api.post(`/api/v1/workspaces/${props.workspaceId}/tasks/${task.id}/context`, {
                        kind: "note",
                        audience: contextAudience,
                        body: contextBody,
                        request_id: requestId("web-context"),
                      }),
                    "Context version added",
                  ).then(() => setContextBody(""));
                }}
              >
                <label>
                  Audience
                  <select
                    value={contextAudience}
                    onChange={(event) =>
                      setContextAudience(event.target.value as "human" | "agent" | "both")
                    }
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
                    data-testid="context-body"
                    value={contextBody}
                    onChange={(event) => setContextBody(event.target.value)}
                    rows={3}
                    maxLength={16_384}
                    required
                  />
                </label>
                <button type="submit" className="button-secondary" disabled={saving}>
                  Add context version
                </button>
              </form>
            ) : null}
          </section>
        </div>
      ) : null}
    </aside>
  );
}
