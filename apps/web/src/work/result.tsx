// ABOUTME: Shows run result state and human review actions on the task sheet.
// ABOUTME: Lists every immutable submission version with computed outdated flags; renders no artifact content.

import { useCallback, useEffect, useMemo, useState } from "react";

import { client } from "./mutations.js";

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
      {props.runs.length === 0 ? <p data-testid="result-empty">No runs yet.</p> : null}
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
            disabled={props.pending}
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
          disabled={props.pending}
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

export function ResultPanel(props: ResultPanelProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  const api = useMemo(() => client(fetchFn, props.csrfToken ?? ""), [fetchFn, props.csrfToken]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [submissions, setSubmissions] = useState<SubmissionView[]>([]);
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const runBody = await api.get(
        `/api/v1/workspaces/${props.workspaceId}/tasks/${props.taskId}/runs`,
      );
      const nextRuns = ((runBody.runs ?? []) as RunRow[]).filter((run) => run.id);
      setRuns(nextRuns);
      const latestRun = nextRuns[nextRuns.length - 1];
      if (!latestRun) {
        setSubmissions([]);
        return;
      }
      const resultBody = await api.get(
        `/api/v1/workspaces/${props.workspaceId}/runs/${latestRun.id}/results`,
      );
      setSubmissions((resultBody.submissions ?? []) as SubmissionView[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    }
  }, [api, props.taskId, props.workspaceId]);

  useEffect(() => {
    setComment("");
    setError(null);
    void load();
  }, [load]);

  async function review(decision: "request_changes" | "accept"): Promise<void> {
    const latest = submissions[0];
    const latestRun = runs[runs.length - 1];
    if (!latest || !latestRun) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.post(`/api/v1/workspaces/${props.workspaceId}/runs/${latestRun.id}/review`, {
        decision,
        submission_id: latest.id,
        expected_run_version: latestRun.resource_version,
        expected_task_version: props.taskVersion,
        ...(decision === "request_changes" && comment.trim() ? { comment: comment.trim() } : {}),
        request_id: requestId(`web-${decision.replace("_", "-")}`),
      });
      setComment("");
      await load();
      props.onReviewed();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <ResultView
      runs={runs}
      submissions={submissions}
      taskState={props.taskState}
      role={props.role}
      pending={pending}
      error={error}
      comment={comment}
      onCommentChange={setComment}
      onRequestChanges={() => void review("request_changes")}
      onAccept={() => void review("accept")}
    />
  );
}
