// ABOUTME: Reveals author-private checkpoints only inside an explicitly visited task section.
// ABOUTME: Keeps local drafts and asynchronous delivery scoped to the current human and task.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  isPanelAuthorityDenied,
  usePanelDelivery,
  type PanelDeliveryCheck,
} from "./panel-delivery.js";

interface Checkpoint {
  id: string;
  body: string;
  content_hash: string;
  created_at: string;
  origin: "human" | "delegation";
}

interface ProgressView {
  task_id: string;
  checkpoints: Checkpoint[];
  has_more: boolean;
}

interface Props {
  workspaceId: string;
  taskId: string;
  humanId: string;
  api: {
    get(path: string): Promise<Record<string, unknown>>;
    post(path: string, body: unknown): Promise<Record<string, unknown>>;
  };
}

interface State {
  selection: object;
  data: ProgressView | null;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  status: string | null;
}

interface CheckpointDraft {
  body: string;
  revision: number;
}

function progressView(body: Record<string, unknown>, taskId: string): ProgressView {
  const value = body.progress as ProgressView | undefined;
  if (
    !value ||
    value.task_id !== taskId ||
    !Array.isArray(value.checkpoints) ||
    value.checkpoints.length > 100 ||
    typeof value.has_more !== "boolean" ||
    value.checkpoints.some(
      (row) =>
        !row ||
        typeof row.id !== "string" ||
        typeof row.body !== "string" ||
        typeof row.content_hash !== "string" ||
        typeof row.created_at !== "string" ||
        !["human", "delegation"].includes(row.origin),
    )
  )
    throw new Error("Private checkpoints could not be loaded. Try again.");
  return value;
}

export function PrivateCheckpointsPanel(props: Props) {
  const key = JSON.stringify([props.workspaceId, props.taskId, props.humanId]);
  const selection = useMemo(() => ({ key, api: props.api }), [key, props.api]);
  const beginDelivery = usePanelDelivery(selection);
  const mutation = useRef<PanelDeliveryCheck | null>(null);
  const [stored, setStored] = useState<State | null>(null);
  const drafts = useRef(new Map<string, CheckpointDraft>());
  const [draft, setDraft] = useState({ key, body: "" });
  const [composing, setComposing] = useState<object | null>(null);
  const pendingIntent = useRef<{ signature: string; requestId: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const state = stored?.selection === selection ? stored : null;
  const data = state?.data ?? null;
  const loading = state?.loading ?? true;
  const body = draft.key === key ? draft.body : (drafts.current.get(key)?.body ?? "");
  const base = `/api/v1/workspaces/${props.workspaceId}/tasks/${props.taskId}/checkpoints`;

  function changeDraft(next: string) {
    drafts.current.set(key, {
      body: next,
      revision: (drafts.current.get(key)?.revision ?? 0) + 1,
    });
    setDraft({ key, body: next });
  }

  const failure = useCallback(
    (cause: unknown) => {
      const denied = isPanelAuthorityDenied(cause);
      setStored({
        selection,
        data: null,
        loading: false,
        unavailable: denied,
        status: null,
        error: denied
          ? null
          : cause instanceof Error
            ? cause.message
            : "Private checkpoints could not be loaded. Try again.",
      });
      if (denied) setComposing(null);
    },
    [selection],
  );

  const load = useCallback(async () => {
    const isCurrent = beginDelivery();
    if (!isCurrent) return;
    setStored({
      selection,
      data: null,
      loading: true,
      error: null,
      unavailable: false,
      status: null,
    });
    try {
      const next = progressView(await props.api.get(base), props.taskId);
      if (!isCurrent()) return;
      setStored({
        selection,
        data: next,
        loading: false,
        error: null,
        unavailable: false,
        status: null,
      });
    } catch (cause) {
      if (isCurrent()) failure(cause);
    }
  }, [base, beginDelivery, failure, props.api, props.taskId, selection]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (composing === selection) field.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      trigger.current?.focus();
    }
  }, [composing, selection]);
  useEffect(() => {
    if (state?.status && composing !== selection) heading.current?.focus({ preventScroll: true });
  }, [state?.status, composing, selection]);

  async function save() {
    if (!data || loading) return;
    if (mutation.current?.()) return;
    const submitted = body;
    const submittedRevision = drafts.current.get(key)?.revision ?? 0;
    const characters = Array.from(submitted.trim());
    if (
      !characters.length ||
      characters.length > 2048 ||
      characters.some((character) => {
        const code = character.codePointAt(0)!;
        return code <= 0x1f || code === 0x7f;
      })
    ) {
      setStored({
        selection,
        data,
        loading: false,
        error: "Enter a checkpoint of 1–2,048 characters without control characters.",
        unavailable: false,
        status: null,
      });
      field.current?.focus();
      return;
    }
    const isCurrent = beginDelivery();
    if (!isCurrent) return;
    const signature = JSON.stringify([key, submitted]);
    if (pendingIntent.current?.signature !== signature) {
      pendingIntent.current = { signature, requestId: `web-checkpoint-${crypto.randomUUID()}` };
    }
    mutation.current = isCurrent;
    setStored({ selection, data, loading: true, error: null, unavailable: false, status: null });
    try {
      const receipt = await props.api.post(base, {
        body: submitted,
        request_id: pendingIntent.current.requestId,
      });
      if (!isCurrent()) return;
      if (receipt.ok !== true) throw new Error("The private checkpoint was not saved. Try again.");
      const next = progressView(await props.api.get(base), props.taskId);
      if (!isCurrent()) return;
      pendingIntent.current = null;
      // Preserve edits made while saving; an earlier save never clears newer text.
      if ((drafts.current.get(key)?.revision ?? 0) === submittedRevision) {
        changeDraft("");
        setComposing(null);
      }
      setStored({
        selection,
        data: next,
        loading: false,
        error: null,
        unavailable: false,
        status: "Private checkpoint saved. Not published to the task.",
      });
    } catch (cause) {
      if (isCurrent()) failure(cause);
    } finally {
      if (mutation.current === isCurrent) mutation.current = null;
    }
  }

  return (
    <section
      aria-labelledby="private-checkpoints-heading"
      data-testid="private-checkpoints-panel"
      aria-busy={loading}
    >
      <div className="panel-title-row">
        <h3 id="private-checkpoints-heading" ref={heading} tabIndex={-1}>
          Private checkpoints
        </h3>
        {data && composing !== selection ? (
          <button
            type="button"
            className="button-primary"
            ref={trigger}
            disabled={loading}
            onClick={() => setComposing(selection)}
          >
            Add checkpoint
          </button>
        ) : null}
      </div>
      <p className="section-help">
        Only you and the OAuth delegation that wrote a checkpoint can read it. Sharing this task
        does not share these notes. Local-run checkpoints and publication are not available yet.
      </p>
      {loading && !data ? <p role="status">Loading your private checkpoints…</p> : null}
      {state?.status ? <p role="status">{state.status}</p> : null}
      {state?.unavailable ? (
        <p role="alert">Private checkpoints are unavailable for this task.</p>
      ) : null}
      {state?.error ? (
        <p role="alert" id="private-checkpoint-error">
          {state.error}
        </p>
      ) : null}
      {!loading && !data ? (
        <button type="button" className="button-secondary" onClick={() => void load()}>
          Retry private checkpoints
        </button>
      ) : null}
      {data ? (
        <>
          {composing === selection ? (
            <form
              className="private-checkpoint-form"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label htmlFor="private-checkpoint-body">Your private checkpoint</label>
              <textarea
                id="private-checkpoint-body"
                ref={field}
                value={body}
                maxLength={4096}
                rows={5}
                aria-describedby={state?.error ? "private-checkpoint-error" : undefined}
                onChange={(event) => changeDraft(event.target.value)}
              />
              <div className="comment-actions">
                <button type="submit" className="button-primary" disabled={loading}>
                  {loading ? "Saving checkpoint…" : "Save private checkpoint"}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={loading}
                  onClick={() => {
                    returnFocus.current = true;
                    setComposing(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
          {data.checkpoints.length ? (
            <ol className="private-checkpoint-list" aria-label="Your private checkpoint history">
              {data.checkpoints.map((row) => (
                <li key={row.id}>
                  <p className="comment-body">{row.body}</p>
                  <p className="comment-attribution">
                    {row.origin === "human" ? "Written by you" : "Written by your OAuth delegation"}{" "}
                    ·{" "}
                    <time dateTime={row.created_at}>
                      {new Date(row.created_at).toLocaleString()}
                    </time>
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p>No private checkpoints yet. Add a note without publishing it to the task.</p>
          )}
          {data.has_more ? (
            <p className="section-help">
              Showing your newest 100 checkpoints. Older notes are retained; browsing them is not
              available yet.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
