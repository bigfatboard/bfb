// ABOUTME: Shows run result state and human review actions on the task sheet.
// ABOUTME: Lists every immutable submission version with computed outdated flags; renders no artifact content.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { client } from "./mutations.js";
import {
  isPanelAuthorityDenied,
  usePanelDelivery,
  type PanelDeliveryCheck,
} from "./panel-delivery.js";

export type ResultRole = "owner" | "member" | "reviewer";

export interface RunRow {
  id: string;
  result_state: string;
  activity: string;
  resource_version: number;
}

export interface EvidenceRefView {
  kind: string;
  ref: string;
  version?: string;
}

export interface SubmissionView {
  id: string;
  version: number;
  summary: string;
  limitations: string;
  evidence_refs: EvidenceRefView[];
  git_branch: string | null;
  git_commit: string | null;
  git_dirty: boolean | null;
  submitted_by_kind: "agent_run" | "human";
  submitted_at: string;
  superseded: boolean;
  outdated: boolean;
  outdated_reasons: string[];
}

export interface ResultPanelProps {
  workspaceId: string;
  taskId: string;
  taskState: string;
  taskVersion: number;
  role: ResultRole;
  fetchImpl?: typeof fetch;
  csrfToken?: string;
  onReviewed: () => void;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function reasonText(reason: string): string {
  if (reason === "superseded") {
    return "a newer version exists";
  }
  if (reason === "config_changed") {
    return "run configuration changed after submission";
  }
  return "referenced evidence changed after submission";
}

export interface ResultViewProps {
  runs: readonly RunRow[];
  submissions: readonly SubmissionView[];
  taskState: string;
  role: ResultRole;
  pending: boolean;
  error: string | null;
  loading?: boolean;
  onRetry?: () => void;
  comment: string;
  onCommentChange?: (value: string) => void;
  onRequestChanges?: () => void;
  onAccept?: () => void;
}

export function ResultView(props: ResultViewProps) {
  const latest = props.submissions[0] ?? null;
  const reviewable = props.taskState === "review" && latest !== null && latest.outdated === false;
  const canRequestChanges =
    props.role === "owner" || props.role === "member" || props.role === "reviewer";
  const canAccept = props.role === "owner" || props.role === "member";
  return (
    <section aria-labelledby="result-review-heading" data-testid="result-panel">
      <h3 id="result-review-heading">Result and review</h3>
      {props.loading ? <p data-testid="result-loading">Loading results…</p> : null}
      {props.runs.length === 0 && !props.loading && !props.error ? (
        <p data-testid="result-empty">No runs yet.</p>
      ) : null}
      {props.runs.map((run) => (
        <div className="truth-row" key={run.id} data-testid="run-result-row">
          <span>Run {shortId(run.id)}</span>
          <strong>
            {run.result_state.replaceAll("_", " ")} · {run.activity.replaceAll("_", " ")}
          </strong>
        </div>
      ))}
      {props.submissions.map((submission) => (
        <article
          className="task-truth"
          key={submission.id}
          data-testid={submission.version === latest?.version ? "result-latest" : "result-version"}
        >
          <div className="truth-row">
            <span>Version {submission.version}</span>
            {submission.outdated ? (
              <strong data-testid="result-outdated">
                Outdated · {submission.outdated_reasons.map(reasonText).join("; ")}
              </strong>
            ) : (
              <strong data-testid="result-current">Current</strong>
            )}
          </div>
          <p data-testid="result-summary">{submission.summary}</p>
          {submission.limitations ? <p>Limitations: {submission.limitations}</p> : null}
          <div className="truth-row">
            <span>Evidence</span>
            <strong data-testid="result-evidence-count">
              {submission.evidence_refs.length} reference
              {submission.evidence_refs.length === 1 ? "" : "s"}
            </strong>
          </div>
          {submission.git_commit ? (
            <div className="truth-row">
              <span>Observed commit</span>
              <code>
                {submission.git_branch ?? "unknown"}@{submission.git_commit.slice(0, 12)}
                {submission.git_dirty ? " · dirty" : ""}
              </code>
            </div>
          ) : null}
          <div className="truth-row">
            <span>Submitted</span>
            <strong>
              {submission.submitted_by_kind === "agent_run" ? "agent run" : "human"} ·{" "}
              {submission.submitted_at}
            </strong>
          </div>
        </article>
      ))}
      {props.error ? (
        <div className="inline-error" role="alert" data-testid="result-error">
          <strong>Review failed.</strong>
          <span>{props.error}</span>
          {props.onRetry ? (
            <button
              type="button"
              className="button-secondary"
              data-testid="result-retry"
              disabled={props.loading}
              onClick={props.onRetry}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {reviewable && canRequestChanges ? (
        <form
          data-testid="request-changes-form"
          className="stacked-form"
          onSubmit={(event) => {
            event.preventDefault();
            props.onRequestChanges?.();
          }}
        >
          <label>
            Change request note
            <textarea
              data-testid="request-changes-comment"
              value={props.comment}
              onChange={(event) => props.onCommentChange?.(event.target.value)}
              maxLength={2048}
              rows={3}
            />
          </label>
          <button
            type="submit"
            className="button-secondary"
            data-testid="request-changes-submit"
            disabled={props.pending || props.loading}
          >
            Request changes
          </button>
        </form>
      ) : null}
      {reviewable && canAccept ? (
        <button
          type="button"
          className="button-primary"
          data-testid="accept-result"
          disabled={props.pending || props.loading}
          onClick={() => props.onAccept?.()}
        >
          Accept result
        </button>
      ) : null}
      {props.taskState === "review" && latest && latest.outdated ? (
        <p className="unavailable-copy" data-testid="result-stale-note">
          The latest submission is outdated. A newer submission or configuration change needs review
          before acceptance.
        </p>
      ) : null}
    </section>
  );
}

function requestId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

interface ResultSnapshot {
  selection: object;
  runs: RunRow[];
  submissions: SubmissionView[];
  pending: boolean;
  loading: boolean;
  error: string | null;
}

function emptyResultSnapshot(selection: object): ResultSnapshot {
  return { selection, runs: [], submissions: [], pending: false, loading: false, error: null };
}

interface ResultDraft {
  selection: object;
  value: string;
  revision: number;
}

export function ResultPanel(props: ResultPanelProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  const api = useMemo(() => client(fetchFn, props.csrfToken ?? ""), [fetchFn, props.csrfToken]);
  const selection = useMemo(
    () => ({ api, workspaceId: props.workspaceId, taskId: props.taskId }),
    [api, props.workspaceId, props.taskId],
  );
  const begin = usePanelDelivery(selection);
  const mutation = useRef<PanelDeliveryCheck | null>(null);
  const [snapshot, setSnapshot] = useState<ResultSnapshot | null>(null);
  const [draft, setDraft] = useState<ResultDraft | null>(null);
  const draftRef = useRef<ResultDraft | null>(null);
  const current = snapshot?.selection === selection ? snapshot : null;
  const comment = draft?.selection === selection ? draft.value : "";

  useLayoutEffect(() => {
    const next = { selection, value: "", revision: 0 };
    draftRef.current = next;
    setDraft(next);
    return () => {
      draftRef.current = null;
    };
  }, [selection]);

  const failed = useCallback(
    (cause: unknown, check: PanelDeliveryCheck) => {
      if (!check()) return;
      setSnapshot((previous) => ({
        ...(previous?.selection === selection ? previous : emptyResultSnapshot(selection)),
        ...(isPanelAuthorityDenied(cause) ? { runs: [], submissions: [] } : {}),
        loading: false,
        error: cause instanceof Error ? cause.message : "Request failed",
      }));
    },
    [selection],
  );

  const load = useCallback(
    async (origin?: PanelDeliveryCheck): Promise<boolean> => {
      const check = origin ?? begin();
      if (!check || !check()) return false;
      setSnapshot((previous) => ({
        ...(previous?.selection === selection ? previous : emptyResultSnapshot(selection)),
        pending: origin !== undefined && previous?.selection === selection && previous.pending,
        loading: true,
        error: null,
      }));
      try {
        const runBody = await api.get(
          `/api/v1/workspaces/${props.workspaceId}/tasks/${props.taskId}/runs`,
        );
        if (!check()) return false;
        const runs = ((runBody.runs ?? []) as RunRow[]).filter((run) => run.id);
        const latestRun = runs[runs.length - 1];
        const resultBody = latestRun
          ? await api.get(`/api/v1/workspaces/${props.workspaceId}/runs/${latestRun.id}/results`)
          : null;
        if (!check()) return false;
        setSnapshot((previous) => ({
          ...(previous?.selection === selection ? previous : emptyResultSnapshot(selection)),
          runs,
          submissions: (resultBody?.submissions ?? []) as SubmissionView[],
          loading: false,
          error: null,
        }));
        return true;
      } catch (cause) {
        failed(cause, check);
        return false;
      }
    },
    [api, begin, failed, props.taskId, props.workspaceId, selection],
  );

  useEffect(() => {
    void load();
  }, [load]);

  function changeComment(value: string): void {
    const previous = draftRef.current;
    if (previous?.selection !== selection) return;
    const next = { selection, value, revision: previous.revision + 1 };
    draftRef.current = next;
    setDraft(next);
  }

  async function review(decision: "request_changes" | "accept"): Promise<void> {
    if (!current || current.pending || current.loading) return;
    if (mutation.current?.()) return;
    const latest = current.submissions[0];
    const latestRun = current.runs[current.runs.length - 1];
    if (!latest || !latestRun) return;
    const check = begin();
    if (!check) return;
    mutation.current = check;
    const submittedDraft = draftRef.current;
    setSnapshot({ ...current, pending: true, error: null });
    try {
      await api.post(`/api/v1/workspaces/${props.workspaceId}/runs/${latestRun.id}/review`, {
        decision,
        submission_id: latest.id,
        expected_run_version: latestRun.resource_version,
        expected_task_version: props.taskVersion,
        ...(decision === "request_changes" && submittedDraft?.value.trim()
          ? { comment: submittedDraft.value.trim() }
          : {}),
        request_id: requestId(`web-${decision.replace("_", "-")}`),
      });
      if (!check()) return;
      if (!(await load(check)) || !check()) return;
      if (
        submittedDraft?.selection === selection &&
        draftRef.current?.selection === selection &&
        draftRef.current.revision === submittedDraft.revision
      ) {
        changeComment("");
      }
      props.onReviewed();
    } catch (cause) {
      failed(cause, check);
    } finally {
      if (mutation.current === check) mutation.current = null;
      if (check()) {
        setSnapshot((previous) =>
          previous?.selection === selection ? { ...previous, pending: false } : previous,
        );
      }
    }
  }

  return (
    <ResultView
      runs={current?.runs ?? []}
      submissions={current?.submissions ?? []}
      taskState={props.taskState}
      role={props.role}
      pending={current?.pending ?? false}
      loading={current?.loading ?? true}
      error={current?.error ?? null}
      comment={comment}
      onRetry={() => void load()}
      onCommentChange={changeComment}
      onRequestChanges={() => void review("request_changes")}
      onAccept={() => void review("accept")}
    />
  );
}
