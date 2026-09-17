// ABOUTME: Reviews one immutable artifact version with provenance, evidence, and timer.
// ABOUTME: Bytes stay in the sandboxed V02 viewer; comments render as inert text only.

import { useCallback, useEffect, useMemo, useState } from "react";

import { client } from "../work/mutations.js";
import { MeasurementsPanel } from "../work/measurements.js";
import { ArtifactViewer } from "./ArtifactViewer.js";

export type ReviewRole = "owner" | "member" | "reviewer";

export interface ReviewVersionView {
  id: string;
  state: string;
  format: string;
  content_hash: string | null;
  created_at: string;
  available_at: string | null;
  approvals: number;
  changes_requested: number;
}

export interface ReviewEntryView {
  id: string;
  version_id: string;
  content_hash: string;
  reviewer_human_id: string;
  decision: "approve" | "request_changes" | "comment";
  comment: string | null;
  git_commit: string | null;
  config_hash: string | null;
  review_timer_observation_id: string | null;
  created_at: string;
  historical: boolean;
  outdated: boolean;
  outdated_reasons: string[];
}

export interface LinkedSubmissionEntry {
  submission_id: string;
  run_id: string;
  submission_version: number;
  result_state: string;
  bound_version: string | null;
  references_current_version: boolean;
}

export interface ArtifactStatusView {
  artifact_id: string;
  run_id: string | null;
  latest_version: ReviewVersionView | null;
  approved: boolean;
  changes_requested: boolean;
  review_count: number;
  historical_count: number;
  linked_submissions: LinkedSubmissionEntry[];
  reviews: ReviewEntryView[];
}

export interface ArtifactSummaryView {
  artifact_id: string;
  run_id: string | null;
  format: string;
  role: string;
  created_at: string;
  version_count: number;
  latest_version: ReviewVersionView | null;
  approved: boolean;
  changes_requested: boolean;
  review_count: number;
}

export interface ReviewPanelProps {
  workspaceId: string;
  taskId: string;
  role: ReviewRole;
  fetchImpl?: typeof fetch;
  csrfToken?: string;
  onReviewed?: () => void;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function shortHash(hash: string | null): string {
  if (!hash) return "unknown";
  return hash.slice(0, 12);
}

function reasonText(reason: string): string {
  if (reason === "newer_version") {
    return "a newer version exists";
  }
  if (reason === "config_changed") {
    return "run configuration changed after this review";
  }
  return "submission commit changed after this review";
}

export interface ReviewViewProps {
  artifacts: readonly ArtifactSummaryView[];
  selectedArtifactId: string | null;
  status: ArtifactStatusView | null;
  artifactOrigin: string | null;
  workspaceId: string;
  csrfToken: string;
  taskId: string;
  role: ReviewRole;
  pending: boolean;
  error: string | null;
  conflict: boolean;
  comment: string;
  onSelectArtifact?: (artifactId: string) => void;
  onCommentChange?: (value: string) => void;
  onDecide?: (decision: "approve" | "request_changes" | "comment") => void;
  onReload?: () => void;
}

export function ReviewView(props: ReviewViewProps) {
  const latest = props.status?.latest_version ?? null;
  return (
    <section aria-labelledby="artifact-review-heading" data-testid="review-panel">
      <h3 id="artifact-review-heading">Artifact review</h3>
      {props.artifacts.length === 0 ? (
        <p data-testid="review-empty">No review artifacts yet.</p>
      ) : (
        <label>
          Artifact
          <select
            data-testid="review-artifact-select"
            value={props.selectedArtifactId ?? ""}
            onChange={(event) => props.onSelectArtifact?.(event.target.value)}
          >
            {props.artifacts.map((artifact) => (
              <option key={artifact.artifact_id} value={artifact.artifact_id}>
                {shortId(artifact.artifact_id)} · {artifact.format} ·{" "}
                {artifact.approved ? "approved" : "unapproved"} · {artifact.review_count} review
                {artifact.review_count === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </label>
      )}
      {props.status && latest ? (
        <div className="task-truth" data-testid="review-provenance">
          <div className="truth-row">
            <span>Latest version</span>
            <strong data-testid="review-version">{shortId(latest.id)}</strong>
          </div>
          <div className="truth-row">
            <span>Content hash</span>
            <code data-testid="review-hash">{shortHash(latest.content_hash)}</code>
          </div>
          <div className="truth-row">
            <span>Approval</span>
            {props.status.approved ? (
              <strong data-testid="review-approved">Approved</strong>
            ) : (
              <strong data-testid="review-unapproved">Unapproved</strong>
            )}
          </div>
          {props.status.changes_requested ? (
            <p className="unavailable-copy" data-testid="review-changes-note">
              Changes were requested on this version.
            </p>
          ) : null}
          {props.status.linked_submissions.length > 0 ? (
            <div className="truth-row">
              <span>Linked submissions</span>
              <strong data-testid="review-linked-count">
                {props.status.linked_submissions.length} submission
                {props.status.linked_submissions.length === 1 ? "" : "s"}
              </strong>
            </div>
          ) : null}
          {props.status.linked_submissions.map((linked) => (
            <div className="truth-row" key={linked.submission_id} data-testid="review-linked-row">
              <span>
                Run {shortId(linked.run_id)} v{linked.submission_version}
              </span>
              <strong>
                {linked.result_state.replaceAll("_", " ")}
                {linked.references_current_version ? "" : " · older version"}
              </strong>
            </div>
          ))}
        </div>
      ) : null}
      {props.status && latest && props.artifactOrigin ? (
        <ArtifactViewer
          workspaceId={props.workspaceId}
          versionId={latest.id}
          format={latest.format}
          {...(latest.content_hash ? { contentHash: latest.content_hash } : {})}
          csrfToken={props.csrfToken}
          artifactOrigin={props.artifactOrigin}
        />
      ) : null}
      {props.status?.reviews.map((review) => (
        <article className="task-truth" key={review.id} data-testid="review-record">
          <div className="truth-row">
            <span>
              {review.decision.replaceAll("_", " ")} · {shortId(review.reviewer_human_id)}
            </span>
            <strong>{review.created_at}</strong>
          </div>
          <div className="truth-row">
            <span>Version</span>
            <code>
              {shortId(review.version_id)}@{shortHash(review.content_hash)}
              {review.historical ? " · historical" : ""}
            </code>
          </div>
          {review.outdated ? (
            <p className="unavailable-copy" data-testid="review-outdated">
              Outdated · {review.outdated_reasons.map(reasonText).join("; ")}
            </p>
          ) : null}
          {review.git_commit || review.config_hash ? (
            <div className="truth-row">
              <span>Bindings</span>
              <code data-testid="review-bindings">
                {review.git_commit ? review.git_commit.slice(0, 12) : "no commit"} ·{" "}
                {shortHash(
                  review.config_hash ? review.config_hash.replace(/^sha256:/, "") : null,
                )}
              </code>
            </div>
          ) : null}
          {review.comment ? <p data-testid="review-comment">{review.comment}</p> : null}
        </article>
      ))}
      {props.error ? (
        <div className="inline-error" role="alert" data-testid="review-error">
          <strong>{props.conflict ? "This version changed." : "Review failed."}</strong>
          <span>{props.error}</span>
          {props.conflict ? (
            <button
              type="button"
              className="button-secondary"
              data-testid="review-reload"
              onClick={() => props.onReload?.()}
            >
              Reload current version
            </button>
          ) : null}
        </div>
      ) : null}
      {props.status && latest ? (
        <form
          data-testid="review-decide-form"
          className="stacked-form"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <label>
            Review note
            <textarea
              data-testid="review-comment"
              value={props.comment}
              onChange={(event) => props.onCommentChange?.(event.target.value)}
              maxLength={2048}
              rows={3}
            />
          </label>
          <div className="truth-row">
            <button
              type="button"
              className="button-primary"
              data-testid="review-approve"
              disabled={props.pending}
              onClick={() => props.onDecide?.("approve")}
            >
              Approve version
            </button>
            <button
              type="button"
              className="button-secondary"
              data-testid="review-request-changes"
              disabled={props.pending}
              onClick={() => props.onDecide?.("request_changes")}
            >
              Request changes
            </button>
            <button
              type="button"
              className="button-secondary"
              data-testid="review-comment-submit"
              disabled={props.pending}
              onClick={() => props.onDecide?.("comment")}
            >
              Comment
            </button>
          </div>
        </form>
      ) : null}
      <p className="unavailable-copy" data-testid="review-authority-note">
        Artifact approval never accepts the run result and never grants launch, policy, or
        credential authority.
      </p>
    </section>
  );
}

function requestId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function ReviewPanel(props: ReviewPanelProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  const api = useMemo(() => client(fetchFn, props.csrfToken ?? ""), [fetchFn, props.csrfToken]);
  const [artifacts, setArtifacts] = useState<ArtifactSummaryView[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [status, setStatus] = useState<ArtifactStatusView | null>(null);
  const [artifactOrigin, setArtifactOrigin] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const loadArtifacts = useCallback(async () => {
    const runBody = await api.get(
      `/api/v1/workspaces/${props.workspaceId}/tasks/${props.taskId}/runs`,
    );
    const runs = ((runBody.runs ?? []) as Array<{ id: string }>).filter((run) => run.id);
    const collected: ArtifactSummaryView[] = [];
    for (const run of runs) {
      const list = await api.get(
        `/api/v1/workspaces/${props.workspaceId}/artifacts?run_id=${run.id}`,
      );
      for (const entry of (list.artifacts ?? []) as ArtifactSummaryView[]) {
        if (entry.artifact_id && !collected.some((row) => row.artifact_id === entry.artifact_id)) {
          collected.push(entry);
        }
      }
    }
    try {
      const substrate = (await api.get("/api/v1/_substrate")) as {
        artifact_origin?: string;
      };
      if (typeof substrate.artifact_origin === "string" && substrate.artifact_origin) {
        setArtifactOrigin(substrate.artifact_origin);
      }
    } catch {
      setArtifactOrigin(null);
    }
    setArtifacts(collected);
    setSelectedArtifactId((current) => {
      if (current && collected.some((row) => row.artifact_id === current)) return current;
      return collected[collected.length - 1]?.artifact_id ?? null;
    });
  }, [api, props.taskId, props.workspaceId]);

  const loadStatus = useCallback(
    async (artifactId: string) => {
      const body = await api.get(
        `/api/v1/workspaces/${props.workspaceId}/artifacts/${artifactId}/reviews`,
      );
      setStatus(body as unknown as ArtifactStatusView);
    },
    [api, props.workspaceId],
  );

  useEffect(() => {
    setComment("");
    setError(null);
    setConflict(false);
    setStatus(null);
    void loadArtifacts().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Request failed");
    });
  }, [loadArtifacts]);

  useEffect(() => {
    if (!selectedArtifactId) {
      setStatus(null);
      return;
    }
    void loadStatus(selectedArtifactId).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Request failed");
    });
  }, [loadStatus, selectedArtifactId]);

  async function reload(): Promise<void> {
    setError(null);
    setConflict(false);
    try {
      await loadArtifacts();
      if (selectedArtifactId) {
        await loadStatus(selectedArtifactId);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    }
  }

  async function decide(decision: "approve" | "request_changes" | "comment"): Promise<void> {
    if (!status?.latest_version || !selectedArtifactId) return;
    if (decision !== "approve" && comment.trim().length === 0) {
      setError("A note is required to request changes or comment.");
      setConflict(false);
      return;
    }
    setPending(true);
    setError(null);
    setConflict(false);
    try {
      await api.post(
        `/api/v1/workspaces/${props.workspaceId}/artifacts/${selectedArtifactId}/reviews`,
        {
          version_id: status.latest_version.id,
          expected_content_hash: status.latest_version.content_hash,
          expected_latest_version_id: status.latest_version.id,
          decision,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
          request_id: requestId("web-review"),
        },
      );
      setComment("");
      await loadArtifacts();
      await loadStatus(selectedArtifactId);
      props.onReviewed?.();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Request failed";
      setError(message);
      const coded = cause as { code?: unknown; status?: unknown };
      setConflict(coded.code === "stale_version" || coded.code === "version_mismatch" || coded.status === 409);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <ReviewView
        artifacts={artifacts}
        selectedArtifactId={selectedArtifactId}
        status={status}
        artifactOrigin={artifactOrigin}
        workspaceId={props.workspaceId}
        csrfToken={props.csrfToken ?? ""}
        taskId={props.taskId}
        role={props.role}
        pending={pending}
        error={error}
        conflict={conflict}
        comment={comment}
        onSelectArtifact={setSelectedArtifactId}
        onCommentChange={setComment}
        onDecide={(decision) => void decide(decision)}
        onReload={() => void reload()}
      />
      <MeasurementsPanel
        key={`review-timers-${props.taskId}`}
        workspaceId={props.workspaceId}
        taskId={props.taskId}
        fetchImpl={fetchFn}
        csrfToken={props.csrfToken ?? ""}
      />
    </>
  );
}
