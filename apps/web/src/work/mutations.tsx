// ABOUTME: Work-surface mutation forms for tasks, comments, context, and agent proposals.
// ABOUTME: Calls the real /api/v1 work endpoints; never invents completion or agent activity.

import { useState } from "react";

export interface WorkMutationsProps {
  workspaceId: string;
  projectIds: string[];
  fetchImpl?: typeof fetch;
  /** Session-bound CSRF token from /auth/sign-in or /auth/session. */
  csrfToken?: string;
  onChanged: () => void;
}

export function WorkMutations(props: WorkMutationsProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  const [projectId, setProjectId] = useState(props.projectIds[0] ?? "");
  const [title, setTitle] = useState("");
  const [taskId, setTaskId] = useState("");
  const [comment, setComment] = useState("");
  const [contextBody, setContextBody] = useState("");
  const [contextAudience, setContextAudience] = useState<"human" | "agent" | "both">("agent");
  const [editTitle, setEditTitle] = useState("");
  const [expectedVersion, setExpectedVersion] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function failureMessage(
    status: number,
    json: { ok?: boolean; error?: unknown; message?: string },
  ): string {
    if (typeof json.message === "string" && json.message.length > 0) {
      return json.message;
    }
    if (typeof json.error === "string" && json.error.length > 0) {
      return json.error;
    }
    if (json.error && typeof json.error === "object") {
      const nested = json.error as { code?: string; message?: string };
      if (typeof nested.message === "string" && nested.message.length > 0) {
        return nested.code ? `${nested.code}: ${nested.message}` : nested.message;
      }
      if (typeof nested.code === "string") {
        return nested.code;
      }
    }
    return `request failed (${status})`;
  }

  function mutationHeaders(): HeadersInit {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (props.csrfToken) {
      headers["x-bfb-csrf"] = props.csrfToken;
    }
    return headers;
  }

  async function post(path: string, body: unknown): Promise<unknown> {
    const response = await fetchFn(path, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as { ok?: boolean; error?: unknown; message?: string };
    if (!response.ok || json.ok === false) {
      throw new Error(failureMessage(response.status, json));
    }
    return json;
  }

  async function patch(path: string, body: unknown): Promise<unknown> {
    const response = await fetchFn(path, {
      method: "PATCH",
      headers: mutationHeaders(),
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as { ok?: boolean; error?: unknown; message?: string };
    if (!response.ok || json.ok === false) {
      throw new Error(failureMessage(response.status, json));
    }
    return json;
  }

  return (
    <section aria-label="Work mutations" data-testid="work-mutations">
      <h2>Manage work</h2>
      {error ? (
        <p role="alert" data-testid="mutation-error">
          {error}
        </p>
      ) : null}
      {status ? <p data-testid="mutation-status">{status}</p> : null}

      <form
        data-testid="create-task-form"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            try {
              setError(null);
              await post(`/api/v1/workspaces/${props.workspaceId}/tasks`, {
                project_id: projectId,
                title,
                priority: "P1",
                request_id: `web-create-${Date.now()}`,
              });
              setTitle("");
              setStatus("Task created");
              props.onChanged();
            } catch (err) {
              setError(err instanceof Error ? err.message : "create failed");
            }
          })();
        }}
      >
        <h3>Create task</h3>
        <label>
          Project
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            data-testid="create-task-project"
          >
            {props.projectIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            data-testid="create-task-title"
            required
          />
        </label>
        <button type="submit">Create task</button>
      </form>

      <form
        data-testid="propose-task-form"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            try {
              setError(null);
              // Agent proposals use the same create endpoint with actorIsAgent via dedicated API.
              await post(`/api/v1/workspaces/${props.workspaceId}/tasks/propose`, {
                project_id: projectId,
                title: title || "Agent proposal",
                priority: "P2",
                request_id: `web-propose-${Date.now()}`,
              });
              setStatus("Task proposed (remains proposed until promoted)");
              props.onChanged();
            } catch (err) {
              setError(err instanceof Error ? err.message : "propose failed");
            }
          })();
        }}
      >
        <h3>Propose agent task</h3>
        <button type="submit">Propose task</button>
      </form>

      <form
        data-testid="comment-form"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            try {
              setError(null);
              await post(`/api/v1/workspaces/${props.workspaceId}/tasks/${taskId}/comments`, {
                body: comment,
                kind: "discussion",
                request_id: `web-comment-${Date.now()}`,
              });
              setComment("");
              setStatus("Comment added");
              props.onChanged();
            } catch (err) {
              setError(err instanceof Error ? err.message : "comment failed");
            }
          })();
        }}
      >
        <h3>Add comment</h3>
        <label>
          Task id
          <input
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
            data-testid="comment-task-id"
            required
          />
        </label>
        <label>
          Comment
          <input
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            data-testid="comment-body"
            required
          />
        </label>
        <button type="submit">Add comment</button>
      </form>

      <form
        data-testid="context-form"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            try {
              setError(null);
              await post(`/api/v1/workspaces/${props.workspaceId}/tasks/${taskId}/context`, {
                audience: contextAudience,
                body: contextBody,
                request_id: `web-context-${Date.now()}`,
              });
              setContextBody("");
              setStatus("Context version added");
              props.onChanged();
            } catch (err) {
              setError(err instanceof Error ? err.message : "context failed");
            }
          })();
        }}
      >
        <h3>Add context</h3>
        <label>
          Audience
          <select
            value={contextAudience}
            onChange={(event) =>
              setContextAudience(event.target.value as "human" | "agent" | "both")
            }
            data-testid="context-audience"
          >
            <option value="agent">agent</option>
            <option value="human">human</option>
            <option value="both">both</option>
          </select>
        </label>
        <label>
          Body
          <input
            value={contextBody}
            onChange={(event) => setContextBody(event.target.value)}
            data-testid="context-body"
            required
          />
        </label>
        <button type="submit">Add context</button>
      </form>

      <form
        data-testid="promote-form"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            try {
              setError(null);
              // Load current version first.
              const getResponse = await fetchFn(
                `/api/v1/workspaces/${props.workspaceId}/tasks/${taskId}`,
              );
              const getBody = (await getResponse.json()) as {
                task?: { resource_version: number };
              };
              if (!getBody.task) {
                throw new Error("task not found");
              }
              await patch(`/api/v1/workspaces/${props.workspaceId}/tasks/${taskId}`, {
                expected_version: getBody.task.resource_version,
                promote: true,
                request_id: `web-promote-${Date.now()}`,
              });
              setStatus("Task promoted from proposed");
              props.onChanged();
            } catch (err) {
              setError(err instanceof Error ? err.message : "promote failed");
            }
          })();
        }}
      >
        <h3>Promote proposed task</h3>
        <button type="submit">Promote</button>
      </form>

      <form
        data-testid="stale-edit-form"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            try {
              setError(null);
              await patch(`/api/v1/workspaces/${props.workspaceId}/tasks/${taskId}`, {
                expected_version: Number(expectedVersion),
                title: editTitle || "stale edit",
                request_id: `web-stale-${Date.now()}`,
              });
              setStatus("Task updated");
              props.onChanged();
            } catch (err) {
              setError(err instanceof Error ? err.message : "update failed");
            }
          })();
        }}
      >
        <h3>Edit task (optimistic version)</h3>
        <label>
          Task id
          <input
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
            data-testid="stale-edit-task-id"
            required
          />
        </label>
        <label>
          Expected version
          <input
            value={expectedVersion}
            onChange={(event) => setExpectedVersion(event.target.value)}
            data-testid="stale-edit-version"
            required
          />
        </label>
        <label>
          Title
          <input
            value={editTitle}
            onChange={(event) => setEditTitle(event.target.value)}
            data-testid="stale-edit-title"
          />
        </label>
        <button type="submit">Save edit</button>
      </form>
    </section>
  );
}
