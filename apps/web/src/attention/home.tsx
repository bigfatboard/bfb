// ABOUTME: Renders the ranked cross-project Attention home with answer and resolve actions.
// ABOUTME: Provider-native permission dialogs stay visibly separate; answers never grant authority.

import { useCallback, useEffect, useRef, useState } from "react";

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
  "Provider-native permission dialogs stay separate. Answer terminal prompts in the terminal; " +
  "an attention answer never approves native provider permissions and never grants workspace authority.";

export function AttentionList(props: {
  items: AttentionHomeItem[];
  onAnswer: (id: string, expectedVersion: number, answer: string) => void | Promise<boolean>;
  onResolve: (id: string, expectedVersion: number) => void;
  actionError: string | null;
  pendingId: string | null;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, boolean>>({});
  const answerButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocusId = useRef<string | null>(null);
  useEffect(() => {
    if (answeringId !== null || returnFocusId.current === null) return;
    answerButtons.current.get(returnFocusId.current)?.focus();
    returnFocusId.current = null;
  }, [answeringId]);
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
          className="attention-item attention-request"
          data-testid="attention-item"
          data-kind={item.kind}
          data-state={item.state}
          data-blocking={item.blocking ? "yes" : "no"}
          data-rank={index + 1}
        >
          <div className="attention-request-heading">
            <p className="attention-question">{item.question}</p>
            <p className="attention-request-context">{`${item.project_name} · ${item.task_title}`}</p>
          </div>
          <p className="attention-kind">
            <strong>{KIND_LABELS[item.kind]}</strong>
            <span>{item.blocking ? "Blocking the run" : "Non-blocking"}</span>
            <span>{requiredRoleLabel(item.required_role)}</span>
            <span>{STATE_LABELS[item.state]}</span>
          </p>
          {item.answer ? <p className="attention-answer">{`Answer: ${item.answer}`}</p> : null}
          <div className="attention-request-actions">
            {item.state === "open" && answeringId !== item.id ? (
              <button
                type="button"
                className="button-primary"
                data-testid={`answer-trigger-${item.id}`}
                ref={(button) => {
                  if (button) answerButtons.current.set(item.id, button);
                  else answerButtons.current.delete(item.id);
                }}
                aria-expanded={false}
                aria-controls={`answer-form-${item.id}`}
                onClick={() => setAnsweringId(item.id)}
              >
                Answer
              </button>
            ) : null}
            {item.state === "answered" ? (
              <button
                type="button"
                className="button-primary"
                data-testid={`resolve-button-${item.id}`}
                disabled={props.pendingId === item.id}
                onClick={() => props.onResolve(item.id, item.resource_version)}
              >
                Mark resolved
              </button>
            ) : null}
            <button
              type="button"
              className="button-quiet"
              aria-expanded={details[item.id] === true}
              aria-controls={`attention-details-${item.id}`}
              onClick={() =>
                setDetails((current) => ({ ...current, [item.id]: !current[item.id] }))
              }
            >
              Details
            </button>
          </div>
          {details[item.id] ? (
            <div id={`attention-details-${item.id}`} className="attention-details">
              <p className="attention-rank">{`#${index + 1} · ${item.rank_reason}`}</p>
              <p className="attention-context">
                {`Run ${item.run_result_state} · ${item.run_activity} · version ${item.resource_version}`}
              </p>
              <p className="attention-times">
                {`Requested ${item.requested_at}`}
                {item.answered_at ? ` · answered ${item.answered_at}` : ""}
                {item.resolved_at ? ` · resolved ${item.resolved_at}` : ""}
              </p>
            </div>
          ) : null}
          {item.state === "open" && answeringId === item.id ? (
            <form
              id={`answer-form-${item.id}`}
              className="attention-answer-form"
              data-testid={`answer-form-${item.id}`}
              onSubmit={(event) => {
                event.preventDefault();
                void (async () => {
                  const succeeded = await props.onAnswer(
                    item.id,
                    item.resource_version,
                    drafts[item.id] ?? "",
                  );
                  if (succeeded !== true) return;
                  setDrafts((current) => ({ ...current, [item.id]: "" }));
                  setAnsweringId((current) => (current === item.id ? null : current));
                })();
              }}
            >
              <p className="section-help attention-decision-notice">{NATIVE_PERMISSION_NOTICE}</p>
              <label>
                Your human decision
                <textarea
                  autoFocus
                  required
                  data-testid={`answer-input-${item.id}`}
                  value={drafts[item.id] ?? ""}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [item.id]: event.target.value }))
                  }
                />
              </label>
              <div className="attention-request-actions">
                <button
                  type="submit"
                  className="button-primary"
                  disabled={props.pendingId === item.id}
                >
                  Answer
                </button>
                <button
                  type="button"
                  className="button-quiet"
                  disabled={props.pendingId === item.id}
                  onClick={() => {
                    returnFocusId.current = item.id;
                    setAnsweringId(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
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
  ): Promise<boolean> {
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
      return response.ok;
    } catch {
      setActionError("The action failed.");
      return false;
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
      <div hidden={items === null}>
        <AttentionList
          items={items ?? []}
          actionError={actionError}
          pendingId={pendingId}
          onAnswer={(id, expectedVersion, answer) =>
            act(id, "answer", { expected_version: expectedVersion, answer })
          }
          onResolve={(id, expectedVersion) =>
            void act(id, "resolve", { expected_version: expectedVersion })
          }
        />
      </div>
      {actionError && items ? (
        <p role="alert" className="inline-error" data-testid="attention-action-error">
          {actionError}
        </p>
      ) : null}
      <p className="attention-poll" data-testid="attention-poll">
        {updatedAt
          ? `Committed state as of ${updatedAt}. Refreshes automatically.`
          : "Loading committed attention…"}
      </p>
      <span data-testid="attention-role" hidden>
        {props.role}
      </span>
    </div>
  );
}
