// ABOUTME: Renders the run-scoped timeline with separate connectivity and presence.
// ABOUTME: Every event-controlled string is React text; raw HTML can never enter this surface.

import { useEffect, useState } from "react";

import { shortId } from "./timeline.js";
import { useRunRealtime, type RealtimeTransport } from "./useRealtime.js";

export interface RunTimelineProps {
  workspaceId: string;
  taskId: string;
  fetchImpl?: typeof fetch | undefined;
  transport?: RealtimeTransport | undefined;
  nowImpl?: (() => number) | undefined;
}

interface RunRecord {
  id: string;
  result_state: string;
}

const CONNECTIVITY_COPY: Record<string, string> = {
  live: "Realtime live",
  stale: "Signal stale — showing committed history",
  offline: "Realtime offline — showing committed history",
};

export function RunTimeline(props: RunTimelineProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [runsFailed, setRunsFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setRuns([]);
    setRunId(null);
    setRunsFailed(false);
    void (async () => {
      try {
        const response = await fetchFn(
          `/api/v1/workspaces/${props.workspaceId}/tasks/${props.taskId}/runs?limit=50`,
        );
        if (!response.ok || !active) {
          if (active && response.status !== 404) setRunsFailed(true);
          return;
        }
        const body = (await response.json()) as { runs?: RunRecord[] };
        const next = Array.isArray(body.runs) ? body.runs : [];
        if (!active) return;
        setRuns(next);
        setRunId(next.length > 0 ? (next[next.length - 1]?.id ?? null) : null);
      } catch {
        if (active) setRunsFailed(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [fetchFn, props.taskId, props.workspaceId]);

  const realtime = useRunRealtime({
    workspaceId: props.workspaceId,
    taskId: props.taskId,
    runId,
    fetchImpl: fetchFn,
    transport: props.transport,
    nowImpl: props.nowImpl,
  });

  if (realtime.memberOnly) {
    return (
      <section
        className="run-timeline"
        aria-label="Run timeline"
        data-testid="run-timeline-section"
      >
        <p className="section-label">RUN TIMELINE</p>
        <p data-testid="timeline-member-only">
          Run history is limited to workspace members. Reviewers keep project-scoped access.
        </p>
      </section>
    );
  }

  return (
    <section className="run-timeline" aria-label="Run timeline" data-testid="run-timeline-section">
      <p className="section-label">RUN TIMELINE</p>
      <div
        className={`truth-status${realtime.connectivity === "live" ? "" : " is-offline"}`}
        data-testid="realtime-connectivity"
      >
        {CONNECTIVITY_COPY[realtime.connectivity] ?? realtime.connectivity}
      </div>
      {realtime.notice ? (
        <p role="alert" className="inline-error" data-testid="realtime-notice">
          {realtime.notice}{" "}
          <button
            type="button"
            className="button-secondary"
            data-testid="realtime-reconnect"
            onClick={realtime.reconnect}
          >
            Reconnect
          </button>
        </p>
      ) : null}
      {runs.length > 1 ? (
        <label className="timeline-run-picker">
          <span>Run</span>
          <select
            data-testid="timeline-run-select"
            value={runId ?? ""}
            onChange={(event) => setRunId(event.target.value || null)}
          >
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {run.id}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="presence-row" data-testid="run-presence">
        <span>{`Process: ${realtime.process}`}</span>
        <span>{`Activity: ${realtime.activity}`}</span>
        <span>{realtime.humanText}</span>
      </div>
      {runsFailed ? (
        <p className="inline-error" role="alert">
          Run records are unavailable.
        </p>
      ) : runId === null ? (
        <p className="lane-empty">No runs yet. The timeline appears with the first attempt.</p>
      ) : realtime.entries.length === 0 ? (
        <p className="lane-empty">No committed run events yet.</p>
      ) : (
        <ol className="record-list" data-testid="run-timeline">
          {realtime.entries.map((entry) => (
            <li key={entry.eventId} data-cursor={entry.cursor} data-kind={entry.kind}>
              <strong>{entry.summary}</strong>
              <span>{`${entry.actorLabel} · ${entry.sourceLabel} · ${entry.provenance}`}</span>
              <span>{`Execution ${shortId(entry.executionId)} · generation ${entry.assignmentGeneration}`}</span>
              {entry.sessionId ? <span>{`Session ${shortId(entry.sessionId)}`}</span> : null}
              <span>{`Committed event ${entry.cursor} · ${entry.occurredAt}`}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
