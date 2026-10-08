// ABOUTME: Reviews one immutable artifact version with provenance, evidence, and timer.
// ABOUTME: Bytes stay in the sandboxed V02 viewer; comments render as inert text only.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { client } from "../work/mutations.js";
import { MeasurementsPanel } from "../work/measurements.js";
import {
  isPanelAuthorityDenied,
  usePanelDelivery,
  type PanelDeliveryCheck,
} from "../work/panel-delivery.js";
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
  loading?: boolean;
  unavailable?: boolean;
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
    <section
      className="artifact-review"
      aria-labelledby="artifact-review-heading"
      aria-busy={props.loading || props.pending}
    >
      <h3 id="artifact-review-heading">Artifact review</h3>
      {props.loading ? <p role="status">Loading artifact details…</p> : null}
      {props.artifacts.length === 0 ? (
        !props.error && !props.loading ? (
          <p data-testid="review-empty">No review artifacts yet.</p>
        ) : null
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
          key={latest.id}
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
                {shortHash(review.config_hash ? review.config_hash.replace(/^sha256:/, "") : null)}
              </code>
            </div>
          ) : null}
          {review.comment ? (
            <p className="artifact-review-note" data-testid="review-comment">
              {review.comment}
            </p>
          ) : null}
        </article>
      ))}
      {props.error ? (
        <div className="inline-error" role="alert" data-testid="review-error">
          <strong>
            {props.conflict
              ? "This version changed."
              : props.unavailable
                ? "Artifact details unavailable."
                : "Review failed."}
          </strong>
          <span>{props.error}</span>
          {props.conflict || props.onReload ? (
            <button
              type="button"
              className="button-secondary"
              data-testid="review-reload"
              disabled={props.pending || props.loading}
              onClick={() => props.onReload?.()}
            >
              {props.conflict ? "Reload current version" : "Try again"}
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
              data-testid="review-note"
              value={props.comment}
              onChange={(event) => props.onCommentChange?.(event.target.value)}
              maxLength={2048}
              rows={3}
            />
          </label>
          <div className="artifact-review-actions">
            <button
              type="button"
              className="button-primary"
              data-testid="review-approve"
              disabled={props.pending || props.loading}
              onClick={() => props.onDecide?.("approve")}
            >
              Approve version
            </button>
            <button
              type="button"
              className="button-secondary"
              data-testid="review-request-changes"
              disabled={props.pending || props.loading}
              onClick={() => props.onDecide?.("request_changes")}
            >
              Request changes
            </button>
            <button
              type="button"
              className="button-secondary"
              data-testid="review-comment-submit"
              disabled={props.pending || props.loading}
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

interface ReviewSnapshot {
  artifacts: ArtifactSummaryView[];
  selectedArtifactId: string | null;
  status: ArtifactStatusView | null;
  artifactOrigin: string | null;
}

interface ReviewPanelState {
  selection: object;
  snapshot: ReviewSnapshot | null;
  comment: string;
  commentRevision: number;
  commentArtifactId: string | null;
  pending: boolean;
  loading: boolean;
  error: string | null;
  conflict: boolean;
}

function emptyReviewPanel(selection: object): ReviewPanelState {
  return {
    selection,
    snapshot: null,
    comment: "",
    commentRevision: 0,
    commentArtifactId: null,
    pending: false,
    loading: true,
    error: null,
    conflict: false,
  };
}

export function ReviewPanel(props: ReviewPanelProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  const api = useMemo(() => client(fetchFn, props.csrfToken ?? ""), [fetchFn, props.csrfToken]);
  const selection = useMemo(() => ({}), [api, props.workspaceId, props.taskId, props.role]);
  const begin = usePanelDelivery(selection);
  const drafts = useMemo(
    () => new Map<string, { comment: string; revision: number }>(),
    [selection],
  );
  const [state, setState] = useState(() => emptyReviewPanel(selection));
  const currentState = useRef(state);
  currentState.current = state;
  const mutation = useRef<PanelDeliveryCheck | null>(null);
  const visible = state.selection === selection ? state : emptyReviewPanel(selection);

  const readSnapshot = useCallback(
    async (
      isCurrent: PanelDeliveryCheck,
      preferredId: string | null,
    ): Promise<ReviewSnapshot | null> => {
      if (!isCurrent()) return null;
      const runBody = await api.get(
        `/api/v1/workspaces/${props.workspaceId}/tasks/${props.taskId}/runs`,
      );
      if (!isCurrent()) return null;
      const runs = ((runBody.runs ?? []) as Array<{ id: string }>).filter((run) => run.id);
      const artifacts: ArtifactSummaryView[] = [];
      for (const run of runs) {
        const list = await api.get(
          `/api/v1/workspaces/${props.workspaceId}/artifacts?run_id=${run.id}`,
        );
        if (!isCurrent()) return null;
        for (const entry of (list.artifacts ?? []) as ArtifactSummaryView[]) {
          if (entry.artifact_id && !artifacts.some((row) => row.artifact_id === entry.artifact_id))
            artifacts.push(entry);
        }
      }
      let artifactOrigin: string | null = null;
      try {
        const substrate = await api.get("/api/v1/_substrate");
        if (!isCurrent()) return null;
        if (typeof substrate.artifact_origin === "string" && substrate.artifact_origin)
          artifactOrigin = substrate.artifact_origin;
      } catch {
        if (!isCurrent()) return null;
        // Optional origin discovery can fail without rendering any artifact bytes.
      }
      const selectedArtifactId =
        preferredId && artifacts.some((row) => row.artifact_id === preferredId)
          ? preferredId
          : (artifacts[artifacts.length - 1]?.artifact_id ?? null);
      const status = selectedArtifactId
        ? ((await api.get(
            `/api/v1/workspaces/${props.workspaceId}/artifacts/${selectedArtifactId}/reviews`,
          )) as unknown as ArtifactStatusView)
        : null;
      if (!isCurrent()) return null;
      return { artifacts, selectedArtifactId, status, artifactOrigin };
    },
    [api, props.taskId, props.workspaceId],
  );

  const showFailure = useCallback((cause: unknown) => {
    const denied = isPanelAuthorityDenied(cause);
    const coded = cause as { code?: unknown; status?: unknown } | null;
    setState((current) => ({
      ...current,
      snapshot: denied ? null : current.snapshot,
      error: cause instanceof Error ? cause.message : "Request failed",
      conflict:
        !denied &&
        (coded?.code === "stale_version" ||
          coded?.code === "version_mismatch" ||
          coded?.status === 409),
    }));
  }, []);

  const reload = useCallback(async () => {
    const isCurrent = begin();
    if (!isCurrent) return;
    const previous = currentState.current.selection === selection ? currentState.current : null;
    const preferredId =
      previous?.snapshot?.selectedArtifactId ?? previous?.commentArtifactId ?? null;
    setState((current) => ({
      ...(current.selection === selection ? current : emptyReviewPanel(selection)),
      loading: true,
      pending: false,
      error: null,
      conflict: false,
    }));
    try {
      const snapshot = await readSnapshot(isCurrent, preferredId);
      if (!isCurrent() || !snapshot) return;
      const draft = snapshot.selectedArtifactId ? drafts.get(snapshot.selectedArtifactId) : null;
      setState((current) => ({
        ...current,
        snapshot,
        comment: draft?.comment ?? "",
        commentRevision: draft?.revision ?? 0,
        commentArtifactId: snapshot.selectedArtifactId,
      }));
    } catch (cause) {
      if (isCurrent()) showFailure(cause);
    } finally {
      if (isCurrent()) setState((current) => ({ ...current, loading: false }));
    }
  }, [begin, drafts, readSnapshot, selection, showFailure]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function selectArtifact(artifactId: string): Promise<void> {
    const snapshot = visible.snapshot;
    if (!snapshot?.artifacts.some((row) => row.artifact_id === artifactId)) return;
    const isCurrent = begin();
    if (!isCurrent) return;
    const draft = drafts.get(artifactId);
    setState((current) => ({
      ...current,
      snapshot: { ...snapshot, selectedArtifactId: artifactId, status: null },
      comment: draft?.comment ?? "",
      commentRevision: draft?.revision ?? 0,
      commentArtifactId: artifactId,
      pending: false,
      loading: true,
      error: null,
      conflict: false,
    }));
    try {
      const body = await api.get(
        `/api/v1/workspaces/${props.workspaceId}/artifacts/${artifactId}/reviews`,
      );
      if (!isCurrent()) return;
      setState((current) => ({
        ...current,
        snapshot: {
          ...snapshot,
          selectedArtifactId: artifactId,
          status: body as unknown as ArtifactStatusView,
        },
      }));
    } catch (cause) {
      if (isCurrent()) showFailure(cause);
    } finally {
      if (isCurrent()) setState((current) => ({ ...current, loading: false }));
    }
  }

  async function decide(decision: "approve" | "request_changes" | "comment"): Promise<void> {
    const snapshot = visible.snapshot;
    const latest = snapshot?.status?.latest_version;
    const selectedArtifactId = snapshot?.selectedArtifactId;
    if (!latest || !selectedArtifactId || visible.loading || mutation.current?.()) return;
    const isCurrent = begin();
    if (!isCurrent) return;
    if (decision !== "approve" && visible.comment.trim().length === 0) {
      setState((current) => ({
        ...current,
        error: "A note is required to request changes or comment.",
        conflict: false,
      }));
      return;
    }
    mutation.current = isCurrent;
    const submitted = visible.comment;
    const submittedRevision = visible.commentRevision;
    setState((current) => ({ ...current, pending: true, error: null, conflict: false }));
    try {
      await api.post(
        `/api/v1/workspaces/${props.workspaceId}/artifacts/${selectedArtifactId}/reviews`,
        {
          version_id: latest.id,
          expected_content_hash: latest.content_hash,
          expected_latest_version_id: latest.id,
          decision,
          ...(submitted.trim() ? { comment: submitted.trim() } : {}),
          request_id: requestId("web-review"),
        },
      );
      if (!isCurrent()) return;
      const refreshed = await readSnapshot(isCurrent, selectedArtifactId);
      if (!isCurrent() || !refreshed) return;
      if ((drafts.get(selectedArtifactId)?.revision ?? 0) === submittedRevision)
        drafts.set(selectedArtifactId, { comment: "", revision: submittedRevision + 1 });
      const draft = refreshed.selectedArtifactId ? drafts.get(refreshed.selectedArtifactId) : null;
      setState((current) => ({
        ...current,
        snapshot: refreshed,
        comment: draft?.comment ?? "",
        commentRevision: draft?.revision ?? 0,
        commentArtifactId: refreshed.selectedArtifactId,
      }));
      props.onReviewed?.();
    } catch (cause) {
      if (isCurrent()) showFailure(cause);
    } finally {
      if (isCurrent()) {
        mutation.current = null;
        setState((current) => ({ ...current, pending: false }));
      }
    }
  }

  return (
    <div data-testid="review-panel">
      <ReviewView
        artifacts={visible.snapshot?.artifacts ?? []}
        selectedArtifactId={visible.snapshot?.selectedArtifactId ?? null}
        status={visible.snapshot?.status ?? null}
        artifactOrigin={visible.snapshot?.artifactOrigin ?? null}
        workspaceId={props.workspaceId}
        csrfToken={props.csrfToken ?? ""}
        taskId={props.taskId}
        role={props.role}
        pending={visible.pending}
        loading={visible.loading}
        unavailable={!visible.snapshot}
        error={visible.error}
        conflict={visible.conflict}
        comment={visible.comment}
        onSelectArtifact={(artifactId) => void selectArtifact(artifactId)}
        onCommentChange={(comment) => {
          const current = currentState.current;
          if (current.selection !== selection || !current.commentArtifactId) return;
          const revision = (drafts.get(current.commentArtifactId)?.revision ?? 0) + 1;
          drafts.set(current.commentArtifactId, { comment, revision });
          setState((latest) => ({ ...latest, comment, commentRevision: revision }));
        }}
        onDecide={(decision) => void decide(decision)}
        onReload={() => void reload()}
      />
      {visible.snapshot && visible.snapshot.artifacts.length > 0 ? (
        <MeasurementsPanel
          key={`${props.workspaceId}:review-timers-${props.taskId}`}
          workspaceId={props.workspaceId}
          taskId={props.taskId}
          fetchImpl={fetchFn}
          csrfToken={props.csrfToken ?? ""}
        />
      ) : null}
    </div>
  );
}
