// ABOUTME: Shows separated provenance-labelled measurements on the task sheet.
// ABOUTME: Human, agent, wait, token, and provenance sections never collapse into one total.

import { useCallback, useEffect, useMemo, useState } from "react";

import { client } from "./mutations.js";

export interface MeasurementsTokenFields {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  reasoning: number | null;
}

export interface MeasurementsTokens {
  exact: MeasurementsTokenFields;
  estimated: MeasurementsTokenFields;
  unavailable_count: number;
  costs: Array<{ model: string | null; amount_usd: number | null; reason: string | null }>;
  costs_total_usd: number | null;
  catalog_version: string;
}

export interface MeasurementsTimes {
  launch_latency_ms: number | null;
  launch_latency_reason: string | null;
  process_elapsed_ms: number | null;
  process_alive_ms: number;
  active_ms: number;
  attention_wait_ms: number;
  external_wait_ms: number | null;
  idle_ms: number | null;
  offline_ms: number;
  open_intervals: number;
  live_execution: boolean;
  attention_open: boolean;
}

export interface MeasurementsAttention {
  request_id: string;
  kind: string;
  blocking: boolean;
  state: string;
  first_response_ms: number | null;
  resolution_ms: number | null;
  open: boolean;
}

export interface ReviewTimerView {
  id: string;
  started_by_human_id: string;
  started_at: string;
  stopped_at: string | null;
  state: "open" | "stopped";
  resource_version: number;
}

export interface TaskMeasurementsView {
  totals: {
    active_ms: number;
    process_elapsed_ms: number;
    attention_wait_ms: number;
    exact_tokens: MeasurementsTokenFields;
    estimated_tokens: MeasurementsTokenFields;
    unavailable_token_reports: number;
  };
  review: {
    timers: ReviewTimerView[];
    stopped_total_ms: number;
    open_ms: number;
  };
  attention: MeasurementsAttention[];
  browser_activity: Array<{
    human_id: string;
    observed_ms: number;
    capped_observations: number;
    quality: string;
  }>;
  interventions: {
    runs: number;
    restarts: number;
    submission_versions: number;
  };
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return "unknown";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

export function formatCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "unavailable";
  }
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function tokenFieldRows(fields: MeasurementsTokenFields): Array<[string, number | null]> {
  return [
    ["input", fields.input],
    ["output", fields.output],
    ["cache read", fields.cache_read],
    ["cache write", fields.cache_write],
    ["reasoning", fields.reasoning],
  ];
}

export interface MeasurementsViewProps {
  measurements: TaskMeasurementsView | null;
  timers: ReviewTimerView[];
  pending: boolean;
  error: string | null;
  onStartTimer?: () => void;
  onStopTimer?: (timer: ReviewTimerView) => void;
}

export function MeasurementsView(props: MeasurementsViewProps) {
  const measurements = props.measurements;
  return (
    <section aria-labelledby="measurements-heading" data-testid="measurements-panel">
      <h3 id="measurements-heading">Time and token measurements</h3>
      {props.error ? (
        <div className="inline-error" role="alert" data-testid="measurements-error">
          <strong>Measurements failed.</strong>
          <span>{props.error}</span>
        </div>
      ) : null}
      {!measurements && !props.error ? <p data-testid="measurements-loading">Loading measurements…</p> : null}
      {measurements ? (
        <>
          <div className="truth-row" data-testid="measurements-human">
            <span>Human review</span>
            <strong>
              {formatDuration(measurements.review.stopped_total_ms)} reviewed
              {measurements.review.open_ms > 0
                ? ` · timer running ${formatDuration(measurements.review.open_ms)}`
                : ""}
            </strong>
          </div>
          <div className="truth-row" data-testid="measurements-attention-latency">
            <span>Attention latency</span>
            <strong>
              {measurements.attention.length === 0
                ? "no attention requests"
                : measurements.attention
                    .map((entry) =>
                      entry.resolution_ms !== null
                        ? `${entry.kind} resolved in ${formatDuration(entry.resolution_ms)}`
                        : `${entry.kind} awaiting response`,
                    )
                    .join("; ")}
            </strong>
          </div>
          <div className="truth-row" data-testid="measurements-browser">
            <span>Observed browser activity (estimated)</span>
            <strong>
              {measurements.browser_activity.length === 0
                ? "no observations"
                : measurements.browser_activity
                    .map((entry) => formatDuration(entry.observed_ms))
                    .join("; ")}
            </strong>
          </div>
          <div className="truth-row" data-testid="measurements-agent">
            <span>Agent active / elapsed</span>
            <strong>
              {formatDuration(measurements.totals.active_ms)} active ·{" "}
              {formatDuration(measurements.totals.process_elapsed_ms)} elapsed
            </strong>
          </div>
          <div className="truth-row" data-testid="measurements-waiting">
            <span>Attention wait</span>
            <strong>{formatDuration(measurements.totals.attention_wait_ms)} waiting</strong>
          </div>
          <div className="truth-row" data-testid="measurements-tokens">
            <span>Tokens (exact / estimated / unavailable)</span>
            <strong>
              {tokenFieldRows(measurements.totals.exact_tokens)
                .filter(([, value]) => value !== null)
                .map(([label, value]) => `${label} ${formatCount(value)}`)
                .join(", ") || "no exact tokens"}
              {" · estimated "}
              {tokenFieldRows(measurements.totals.estimated_tokens)
                .filter(([, value]) => value !== null)
                .map(([label, value]) => `${label} ${formatCount(value)}`)
                .join(", ") || "none"}
              {` · ${measurements.totals.unavailable_token_reports} unavailable`}
            </strong>
          </div>
          <div className="truth-row" data-testid="measurements-provenance">
            <span>Provenance</span>
            <strong>
              {measurements.interventions.runs} run
              {measurements.interventions.runs === 1 ? "" : "s"} ·{" "}
              {measurements.interventions.submission_versions} submission
              {measurements.interventions.submission_versions === 1 ? "" : "s"} ·{" "}
              {measurements.review.timers.length} review timer
              {measurements.review.timers.length === 1 ? "" : "s"}
            </strong>
          </div>
          {props.timers.map((timer) => (
            <div className="truth-row" key={timer.id} data-testid="review-timer-row">
              <span>
                Review timer · {timer.state}
              </span>
              {timer.state === "open" ? (
                <button
                  type="button"
                  className="button-secondary"
                  data-testid="review-timer-stop"
                  disabled={props.pending}
                  onClick={() => props.onStopTimer?.(timer)}
                >
                  Stop timer
                </button>
              ) : (
                <strong>stopped</strong>
              )}
            </div>
          ))}
          <button
            type="button"
            className="button-secondary"
            data-testid="review-timer-start"
            disabled={props.pending}
            onClick={() => props.onStartTimer?.()}
          >
            Start review timer
          </button>
        </>
      ) : null}
    </section>
  );
}

export interface MeasurementsPanelProps {
  workspaceId: string;
  taskId: string;
  fetchImpl?: typeof fetch;
  csrfToken?: string;
}

function requestId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function MeasurementsPanel(props: MeasurementsPanelProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  const api = useMemo(() => client(fetchFn, props.csrfToken ?? ""), [fetchFn, props.csrfToken]);
  const [measurements, setMeasurements] = useState<TaskMeasurementsView | null>(null);
  const [timers, setTimers] = useState<ReviewTimerView[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const measured = await api.get(
        `/api/v1/workspaces/${props.workspaceId}/tasks/${props.taskId}/measurements`,
      );
      setMeasurements(measured.measurements as TaskMeasurementsView);
      const timerBody = await api.get(
        `/api/v1/workspaces/${props.workspaceId}/tasks/${props.taskId}/review-timers`,
      );
      setTimers((timerBody.timers ?? []) as ReviewTimerView[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    }
  }, [api, props.taskId, props.workspaceId]);

  useEffect(() => {
    setMeasurements(null);
    setTimers([]);
    setError(null);
    void load();
  }, [load]);

  async function startTimer(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await api.post(`/api/v1/workspaces/${props.workspaceId}/tasks/${props.taskId}/review-timers`, {
        request_id: requestId("web-review-timer"),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      setPending(false);
    }
  }

  async function stopTimer(timer: ReviewTimerView): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await api.post(`/api/v1/workspaces/${props.workspaceId}/review-timers/${timer.id}/stop`, {
        expected_version: timer.resource_version,
        request_id: requestId("web-review-timer"),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <MeasurementsView
      measurements={measurements}
      timers={timers}
      pending={pending}
      error={error}
      onStartTimer={() => void startTimer()}
      onStopTimer={(timer) => void stopTimer(timer)}
    />
  );
}
