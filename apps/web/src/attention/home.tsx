// ABOUTME: Renders the ranked cross-project Attention home with answer and resolve actions.
// ABOUTME: Provider-native permission dialogs stay visibly separate; answers never grant authority.

import { useCallback, useEffect, useState } from "react";

export type AttentionKind =
  "clarification" | "review" | "credential" | "capability" | "destructive_action" | "blocker";

export type AttentionState = "open" | "answered" | "resolved";

export interface AttentionHomeItem {
  id: string;
  kind: AttentionKind;
  required_role: "owner" | "member" | "reviewer";
  reference_kind: string | null;
  reference_id: string | null;
  question: string;
  blocking: boolean;
  state: AttentionState;
  answer: string | null;
  task_title: string;
  project_name: string;
  run_result_state: string;
  run_activity: string;
  rank_reason: string;
  resource_version: number;
  requested_at: string;
  answered_at: string | null;
  resolved_at: string | null;
}

export const KIND_LABELS: Record<AttentionKind, string> = {
  clarification: "Clarification",
  review: "Review",
  credential: "Credential approval",
  capability: "Capability request",
  destructive_action: "Destructive action",
  blocker: "Blocker",
};

export const STATE_LABELS: Record<AttentionState, string> = {
  open: "Needs an answer",
  answered: "Answered",
  resolved: "Resolved",
};

export function requiredRoleLabel(role: AttentionHomeItem["required_role"]): string {
  return role === "owner"
    ? "Needs an owner"
    : role === "member"
      ? "Needs a member"
      : "Reviewer can answer";
}

export const NATIVE_PERMISSION_NOTICE =
  "Provider-native permission dialogs stay separate. A Claude Code, Codex, or Grok prompt " +
  "inside the terminal can only be answered there; an attention answer never approves a " +
  "native provider permission and never grants workspace authority.";

export function AttentionList(props: {
  items: AttentionHomeItem[];
  onAnswer: (id: string, expectedVersion: number, answer: string) => void;
  onResolve: (id: string, expectedVersion: number) => void;
  actionError: string | null;
  pendingId: string | null;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (props.items.length === 0) {
    return (
      <div className="attention-empty" data-testid="attention-empty">
        <strong>No open attention.</strong>
        <span>Agents have not asked for a human decision.</span>
      </div>
    );
  }
  return (
    <ol className="attention-list" data-testid="attention-list">
      {props.items.map((item, index) => (
        <li
          key={item.id}
          id={`attention-${item.id}`}
          className="attention-item"
          data-testid="attention-item"
          data-kind={item.kind}
          data-state={item.state}
          data-blocking={item.blocking ? "yes" : "no"}
          data-rank={index + 1}
        >
          <div className="attention-rank">
            <span>{`#${index + 1}`}</span>
            <span>{item.rank_reason}</span>
          </div>
          <p className="attention-kind">
            <strong>{KIND_LABELS[item.kind]}</strong>
            <span>{item.blocking ? "Blocking the run" : "Non-blocking"}</span>
            <span>{requiredRoleLabel(item.required_role)}</span>
            <span>{STATE_LABELS[item.state]}</span>
          </p>
          <p className="attention-question">{item.question}</p>
          {item.answer ? <p className="attention-answer">{`Answer: ${item.answer}`}</p> : null}
          <p className="attention-context">
            {`${item.project_name} · ${item.task_title} · run ${item.run_result_state} · ${item.run_activity}`}
          </p>
          <p className="attention-times">
            {`Requested ${item.requested_at}`}
            {item.answered_at ? ` · answered ${item.answered_at}` : ""}
            {item.resolved_at ? ` · resolved ${item.resolved_at}` : ""}
          </p>
          {item.state === "open" ? (
            <form
              data-testid={`answer-form-${item.id}`}
              onSubmit={(event) => {
                event.preventDefault();
                props.onAnswer(item.id, item.resource_version, drafts[item.id] ?? "");
              }}
            >
              <label>
                {`Answer as a human decision (version ${item.resource_version})`}
                <textarea
                  data-testid={`answer-input-${item.id}`}
                  value={drafts[item.id] ?? ""}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [item.id]: event.target.value }))
                  }
                />
              </label>
              <button type="submit" disabled={props.pendingId === item.id}>
                Answer
              </button>
            </form>
          ) : null}
          {item.state === "answered" ? (
            <button
              type="button"
              data-testid={`resolve-button-${item.id}`}
              disabled={props.pendingId === item.id}
              onClick={() => props.onResolve(item.id, item.resource_version)}
            >
              Mark resolved
            </button>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function AttentionHome(props: {
  workspaceId: string;
  role: "owner" | "member" | "reviewer";
  fetchImpl?: typeof fetch;
  csrfToken: string;
}) {
  const fetchFn = props.fetchImpl ?? fetch;
  const [items, setItems] = useState<AttentionHomeItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const response = await fetchFn(`/api/v1/workspaces/${props.workspaceId}/attention`);
      if (!response.ok) {
        setError("Attention is unavailable.");
        setItems(null);
        return;
      }
      const body = (await response.json()) as { attention: AttentionHomeItem[] };
      setItems(body.attention);
      setUpdatedAt(new Date().toISOString());
      setError(null);
    } catch {
      setError("Attention is offline. No cached state is presented as current.");
      setItems(null);
    }
  }, [fetchFn, props.workspaceId]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      void reload();
    }, 15_000);
    return () => clearInterval(timer);
  }, [reload]);

  async function act(
    id: string,
    path: "answer" | "resolve",
    body: Record<string, unknown>,
  ): Promise<void> {
    setPendingId(id);
    setActionError(null);
    try {
      const response = await fetchFn(
        `/api/v1/workspaces/${props.workspaceId}/attention/${id}/${path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(props.csrfToken ? { "x-bfb-csrf": props.csrfToken } : {}),
          },
          body: JSON.stringify({ ...body, request_id: `attention-ui-${id}-${Date.now()}` }),
        },
      );
      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as {
          error?: { code?: string };
        };
        setActionError(
          failure.error?.code === "already_answered"
            ? "Already answered. The committed answer is shown; it was not overwritten."
            : failure.error?.code === "forbidden"
              ? "Your role cannot answer this request."
              : failure.error?.code === "stale_version"
                ? "Someone else answered first. Reloaded the committed state."
                : "The action failed.",
        );
      }
      await reload();
    } catch {
      setActionError("The action failed.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="attention-home" data-testid="attention-home">
      <section className="attention-native-notice" aria-label="Native permissions">
        <p>{NATIVE_PERMISSION_NOTICE}</p>
      </section>
      {error && !items ? (
        <section className="workspace-empty">
          <p className="section-label">ATTENTION UNAVAILABLE</p>
          <h1>{error}</h1>
          <button type="button" className="button-secondary" onClick={() => void reload()}>
            Try again
          </button>
        </section>
      ) : null}
      {items ? (
        <AttentionList
          items={items}
          actionError={actionError}
          pendingId={pendingId}
          onAnswer={(id, expectedVersion, answer) =>
            void act(id, "answer", { expected_version: expectedVersion, answer })
          }
          onResolve={(id, expectedVersion) =>
            void act(id, "resolve", { expected_version: expectedVersion })
          }
        />
      ) : null}
      {actionError && items ? (
        <p role="alert" className="inline-error" data-testid="attention-action-error">
          {actionError}
        </p>
      ) : null}
      <p className="attention-poll" data-testid="attention-poll">
        {updatedAt
          ? `Committed state as of ${updatedAt}. Refreshes automatically; realtime sockets arrive with E02.`
          : "Loading committed attention…"}
      </p>
      <span data-testid="attention-role" hidden>
        {props.role}
      </span>
    </div>
  );
}
