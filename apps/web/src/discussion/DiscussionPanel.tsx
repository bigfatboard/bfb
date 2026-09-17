// ABOUTME: Renders one task-linked discussion with attributed history and human decisions.
// ABOUTME: Agent text stays React text; refreshes come from authoritative reads, never prose.

import { useCallback, useEffect, useRef, useState } from "react";

import { deriveConnectivity } from "../realtime/presence.js";
import {
  HEARTBEAT_INTERVAL_MS,
  REALTIME_PATH,
  REALTIME_PROTOCOL,
  heartbeatFrame,
  parseServerFrame,
  type ServerFrame,
} from "../realtime/protocol.js";
import {
  createDiscussionClient,
  newDiscussionKey,
  type DecisionInput,
  type DiscussionMessageSummary,
  type DiscussionView,
} from "./api.js";
import {
  completedTurns,
  currentSpeaker,
  decisionSummary,
  describeDeadline,
  describeDelivery,
  describeStop,
  humanQuestions,
  independentPositions,
  openDisagreements,
  participantName,
  totalRounds,
} from "./presentation.js";

export interface DiscussionSync {
  connectivity: "live" | "stale" | "offline";
  refreshCount: number;
  notice: string | null;
  reconnect(): void;
}

interface SyncOptions {
  workspaceId: string;
  onInvalidate: () => void;
  transport?: RealtimeTransport | undefined;
  nowImpl?: (() => number) | undefined;
}

export interface RealtimeChannel {
  onmessage: ((data: string) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface RealtimeTransport {
  open(url: string, protocol: string): RealtimeChannel;
}

function browserTransport(): RealtimeTransport {
  return {
    open(url: string, protocol: string): RealtimeChannel {
      const socket = new WebSocket(url, protocol);
      const channel: RealtimeChannel = {
        onmessage: null,
        onclose: null,
        send: (data: string) => socket.send(data),
        close: () => socket.close(),
      };
      socket.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data === "string") channel.onmessage?.(event.data);
      });
      socket.addEventListener("close", (event: CloseEvent) => {
        channel.onclose?.({ code: event.code, reason: event.reason });
      });
      return channel;
    },
  };
}

function socketUrl(workspaceId: string): string | null {
  if (typeof window === "undefined" || typeof window.location === "undefined") return null;
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${REALTIME_PATH(workspaceId)}`;
}

/**
 * Subscribe-first discussion sync. The socket carries cursor-only
 * invalidations; every visible row comes from an authoritative discussion
 * read. A higher cursor schedules a refetch, never durable state.
 */
export function useDiscussionSync(options: SyncOptions): DiscussionSync {
  const onInvalidate = useRef(options.onInvalidate);
  onInvalidate.current = options.onInvalidate;
  const [socketOpen, setSocketOpen] = useState(false);
  const [lastSignalAt, setLastSignalAt] = useState<number | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const channel = useRef<RealtimeChannel | null>(null);
  const connectionId = useRef<string | null>(null);
  const mounted = useRef(true);
  const nowImpl = useRef(options.nowImpl ?? (() => Date.now()));
  nowImpl.current = options.nowImpl ?? (() => Date.now());
  const transport = useRef(options.transport);
  transport.current = options.transport;

  const markSignal = useCallback(() => {
    if (mounted.current) setLastSignalAt(nowImpl.current());
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (!mounted.current) return;
    markSignal();
    setRefreshCount((count) => count + 1);
    onInvalidate.current();
  }, [markSignal]);

  const connect = useCallback(() => {
    const url = socketUrl(options.workspaceId);
    if (!url) {
      setNotice("Realtime unavailable in this browser. Committed history below stays authoritative.");
      return;
    }
    channel.current?.close();
    channel.current = null;
    connectionId.current = null;
    setSocketOpen(false);
    const next = (transport.current ?? browserTransport()).open(url, REALTIME_PROTOCOL);
    channel.current = next;
    next.onmessage = (data: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data) as unknown;
      } catch {
        return;
      }
      const frame: ServerFrame | null = parseServerFrame(parsed);
      if (!frame || frame.workspaceId !== options.workspaceId) return;
      markSignal();
      if (frame.kind === "ready") {
        connectionId.current = frame.connectionId;
        setSocketOpen(true);
        setNotice(null);
      } else if (frame.kind === "invalidation") {
        scheduleRefresh();
      } else if (frame.kind === "close") {
        setSocketOpen(false);
        setNotice(
          frame.reason === "session_expired"
            ? "Session expired. Sign in again to resume live updates."
            : "Workspace access changed. Reload to resume live updates.",
        );
      }
    };
    next.onclose = ({ code }) => {
      if (!mounted.current) return;
      setSocketOpen(false);
      connectionId.current = null;
      if (code === 4401) {
        setNotice("Session expired. Sign in again to resume live updates.");
      } else if (code === 4403) {
        setNotice("Workspace access changed. Reload to resume live updates.");
      } else {
        setNotice("Realtime offline. Committed history below stays authoritative.");
      }
    };
  }, [markSignal, options.workspaceId, scheduleRefresh]);

  const reconnect = useCallback(() => {
    setNotice(null);
    scheduleRefresh();
    connect();
  }, [connect, scheduleRefresh]);

  useEffect(() => {
    mounted.current = true;
    connect();
    const heartbeat = window.setInterval(() => {
      const id = connectionId.current;
      if (id && channel.current) {
        try {
          channel.current.send(heartbeatFrame(options.workspaceId, id));
        } catch {
          /* A failed heartbeat surfaces as a socket close. */
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    const ticker = window.setInterval(() => {
      if (mounted.current) setClock(nowImpl.current());
    }, 5000);
    const onFocus = (): void => {
      scheduleRefresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      window.clearInterval(heartbeat);
      window.clearInterval(ticker);
      window.removeEventListener("focus", onFocus);
      channel.current?.close();
      channel.current = null;
    };
  }, [connect, options.workspaceId, scheduleRefresh]);

  const connectivity = deriveConnectivity({ socketOpen, lastSignalAt, now: clock });
  return { connectivity, refreshCount, notice, reconnect };
}

export interface DiscussionPanelProps {
  workspaceId: string;
  discussionId: string;
  humanId: string;
  humanDisplayName: string;
  role: "owner" | "member" | "reviewer";
  fetchImpl?: typeof fetch | undefined;
  csrfToken?: string | undefined;
  transport?: RealtimeTransport | undefined;
  nowImpl?: (() => number) | undefined;
  onChanged?: () => void;
}

function MessageCard(props: { view: DiscussionView; message: DiscussionMessageSummary }) {
  const { view, message } = props;
  if (message.kind === "intervention") {
    return (
      <li className="discussion-message is-intervention" data-kind="intervention">
        <p className="message-attribution">
          <strong>{message.author_human_id === view.decision?.human_id ? "Deciding human" : "Human intervention"}</strong>
          <span>{message.created_at}</span>
        </p>
        <p className="message-text">{message.text ?? ""}</p>
      </li>
    );
  }
  const output = message.output;
  const speaker = participantName(view, message.participant_id);
  return (
    <li className="discussion-message is-recommendation" data-kind="recommendation">
      <p className="message-attribution">
        <strong>{speaker}</strong>
        <span>{message.session_id ? `Session ${message.session_id.slice(0, 8)}…` : "Session unbound"}</span>
        <span>{message.created_at}</span>
      </p>
      {output ? (
        <div className="recommendation-body">
          <p className="message-text">{output.recommendation}</p>
          {output.reasons.length > 0 ? (
            <div>
              <p className="message-subhead">Reasons</p>
              <ul>
                {output.reasons.map((reason, index) => (
                  <li key={`${message.id}-reason-${index}`}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {output.evidence.length > 0 ? (
            <div>
              <p className="message-subhead">Evidence</p>
              <ul>
                {output.evidence.map((item, index) => (
                  <li key={`${message.id}-evidence-${index}`}>
                    {item.kind === "context"
                      ? `Context ${item.context_id ?? "unknown"}`
                      : `Repository ${item.repository_path ?? "unknown"}@${(item.git_revision ?? "").slice(0, 8)}`}
                    {` — ${item.explanation}`}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {output.agreement.length > 0 ? (
            <div>
              <p className="message-subhead">Agrees with</p>
              <ul>
                {output.agreement.map((item, index) => (
                  <li key={`${message.id}-agree-${index}`}>
                    {`Agrees with ${participantName(view, view.messages.find((candidate) => candidate.id === item.message_id)?.participant_id)} — ${item.reason}`}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {output.disagreements.length > 0 ? (
            <div>
              <p className="message-subhead">Disagrees with</p>
              <ul>
                {output.disagreements.map((item, index) => (
                  <li key={`${message.id}-disagree-${index}`}>
                    {`Disagrees with ${participantName(view, view.messages.find((candidate) => candidate.id === item.message_id)?.participant_id)} — ${item.reason}`}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {output.human_questions.length > 0 ? (
            <div>
              <p className="message-subhead">Open human questions</p>
              <ul>
                {output.human_questions.map((question, index) => (
                  <li key={`${message.id}-question-${index}`}>{question}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="message-text">Recommendation payload unavailable.</p>
      )}
    </li>
  );
}

export function DiscussionPanel(props: DiscussionPanelProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  const client = createDiscussionClient(fetchFn, props.workspaceId, props.csrfToken ?? "");
  const [view, setView] = useState<DiscussionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [intervention, setIntervention] = useState("");
  const [decisionKind, setDecisionKind] = useState<DecisionInput["kind"]>("record_recommendation");
  const [decisionSummaryText, setDecisionSummaryText] = useState("");
  const [decisionRefs, setDecisionRefs] = useState<string[]>([]);
  const [clock, setClock] = useState(() => (props.nowImpl ?? (() => Date.now()))());

  const load = useCallback(async () => {
    setError(null);
    try {
      const body = await client.read(props.discussionId);
      setView(body.discussion);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Discussion is unavailable.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.discussionId, props.workspaceId]);

  const sync = useDiscussionSync({
    workspaceId: props.workspaceId,
    onInvalidate: () => {
      void load();
    },
    transport: props.transport,
    nowImpl: props.nowImpl,
  });

  useEffect(() => {
    setLoading(true);
    setView(null);
    void load();
  }, [load]);

  useEffect(() => {
    const ticker = window.setInterval(() => {
      setClock((props.nowImpl ?? (() => Date.now()))());
    }, 5000);
    return () => window.clearInterval(ticker);
  }, [props.nowImpl]);

  async function submit(
    body: Record<string, unknown>,
    success: string,
    reset?: () => void,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const response = await client.change(props.discussionId, body);
      if (!response.ok) {
        const parsed = (await response.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string };
        };
        const code = parsed.error?.code;
        throw new Error(
          code === "stale_version"
            ? "This discussion changed. Reload and retry."
            : (parsed.error?.message ?? `Discussion action failed (${response.status})`),
        );
      }
      reset?.();
      setStatus(success);
      await load();
      props.onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Discussion action failed.");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !view) {
    return (
      <section className="discussion-panel" aria-label="Discussion" data-testid="discussion-panel">
        <div className="sheet-loading" role="status">
          Loading committed discussion state…
        </div>
      </section>
    );
  }

  if (!view) {
    return (
      <section className="discussion-panel" aria-label="Discussion" data-testid="discussion-panel">
        <p className="inline-error" role="alert" data-testid="discussion-error">
          {error ?? "Discussion is unavailable."}{" "}
          <button type="button" className="button-secondary" onClick={() => void load()}>
            Retry
          </button>
        </p>
      </section>
    );
  }

  const speaker = currentSpeaker(view);
  const stop = describeStop(view);
  const deadline = describeDeadline(view.deadline, clock);
  const positions = independentPositions(view);
  const disagreements = openDisagreements(view);
  const questions = humanQuestions(view);
  const decided = decisionSummary(view);
  const canManage = props.role === "owner" || props.role === "member";
  const recommendations = view.messages.filter(
    (message) => message.kind === "recommendation" && message.output,
  );

  function toggleDecisionRef(id: string): void {
    setDecisionRefs((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  }

  return (
    <section className="discussion-panel" aria-label="Discussion" data-testid="discussion-panel">
      <div className="panel-title-row">
        <div>
          <p className="section-label">DISCUSSION</p>
          <h3>{view.brief.question}</h3>
        </div>
        <span className="discussion-state" data-testid="discussion-state" data-state={view.state}>
          {view.state}
          {view.reason ? ` · ${view.reason.replaceAll("_", " ")}` : ""}
        </span>
      </div>

      <div
        className={`truth-status${sync.connectivity === "live" ? "" : " is-offline"}`}
        data-testid="discussion-connectivity"
      >
        {sync.connectivity === "live"
          ? "Discussion live"
          : sync.connectivity === "stale"
            ? "Signal stale — showing committed history"
            : "Discussion offline — showing committed history"}
      </div>
      {sync.notice ? (
        <p role="alert" className="inline-error" data-testid="discussion-notice">
          {sync.notice}{" "}
          <button
            type="button"
            className="button-secondary"
            data-testid="discussion-reconnect"
            onClick={sync.reconnect}
          >
            Reconnect
          </button>
        </p>
      ) : null}

      <dl className="discussion-facts" data-testid="discussion-facts">
        <div>
          <dt>Round</dt>
          <dd>
            {speaker
              ? `Round ${speaker.round} of ${totalRounds(view)} · ${speaker.participantName} (${speaker.provider}) to speak`
              : stop.stopped
                ? stop.headline
                : `Round ${totalRounds(view)} of ${totalRounds(view)}`}
          </dd>
        </div>
        <div>
          <dt>Turns</dt>
          <dd>{`${completedTurns(view)} of ${view.turns.length} completed`}</dd>
        </div>
        <div>
          <dt>Deadline</dt>
          <dd data-testid="discussion-deadline">{deadline.headline}</dd>
        </div>
        <div>
          <dt>Brief</dt>
          <dd>{`Frozen at ${view.brief.git_revision.slice(0, 8)} · ${view.brief.context.length} shared items`}</dd>
        </div>
      </dl>

      {view.dispatch_block_reason ? (
        <p className="inline-error" role="alert" data-testid="discussion-blocked">
          {`Dispatch blocked: ${view.dispatch_block_reason.replaceAll("_", " ")}.`}
        </p>
      ) : null}
      {stop.stopped ? (
        <p className="inline-status" role="status" data-testid="discussion-stopped">
          {`${stop.headline}. ${stop.detail}`}
        </p>
      ) : null}

      <ol className="discussion-turns" data-testid="discussion-turns">
        {view.turns.map((turn) => {
          const owner = view.participants.find((entry) => entry.id === turn.participant_id);
          const delivery = turn.delivery ? describeDelivery(turn.delivery.state) : null;
          return (
            <li
              key={turn.id}
              data-ordinal={turn.ordinal}
              data-turn-state={turn.state}
              data-delivery-state={turn.delivery?.state ?? "none"}
            >
              <strong>{`Turn ${turn.ordinal} · ${owner?.name ?? "Unknown"} (${owner?.provider ?? "?"})`}</strong>
              <span>{`Turn ${turn.state}`}</span>
              {turn.delivery && delivery ? (
                <span data-testid={`delivery-${turn.ordinal}`}>{`${delivery.headline} — ${delivery.detail}`}</span>
              ) : (
                <span>Not yet accepted for dispatch.</span>
              )}
            </li>
          );
        })}
      </ol>

      {view.messages.length === 0 ? (
        <p className="compact-empty" data-testid="discussion-empty">
          No committed messages yet. The first independent positions appear here.
        </p>
      ) : (
        <ol className="record-list" data-testid="discussion-messages">
          {view.messages.map((message) => (
            <MessageCard key={message.id} view={view} message={message} />
          ))}
        </ol>
      )}

      {positions.length > 0 ? (
        <section aria-labelledby="positions-heading" data-testid="discussion-positions">
          <h4 id="positions-heading">Independent initial positions</h4>
          <ul>
            {positions.map((position) => (
              <li key={position.messageId}>
                <strong>{`${position.participantName} (${position.provider})`}</strong>
                <p>{position.recommendation}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {disagreements.length > 0 ? (
        <section aria-labelledby="disagreements-heading" data-testid="discussion-disagreements">
          <h4 id="disagreements-heading">Preserved disagreements</h4>
          <ul>
            {disagreements.map((item, index) => (
              <li key={`${item.fromMessageId}-${index}`}>
                {`${item.fromParticipantName} disagrees with ${item.targetParticipantName} — ${item.reason}`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {questions.length > 0 ? (
        <section aria-labelledby="questions-heading" data-testid="discussion-questions">
          <h4 id="questions-heading">Open human questions</h4>
          <ul>
            {questions.map((item, index) => (
              <li key={`${item.messageId}-${index}`}>{item.question}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.conclusion ? (
        <section aria-labelledby="conclusion-heading" data-testid="discussion-conclusion">
          <h4 id="conclusion-heading">Frozen conclusion</h4>
          <p>{`References the final recommendations: ${view.conclusion.recommendation_ids.join(", ")}.`}</p>
          <p>Agreement was not synthesized. Disagreements above remain authoritative.</p>
        </section>
      ) : null}

      {decided ? (
        <section aria-labelledby="decision-heading" data-testid="discussion-decision">
          <h4 id="decision-heading">Human decision</h4>
          <p>{decided}</p>
          <p>{`Decided by ${props.humanDisplayName}. This decision does not complete the task or authorize implementation.`}</p>
        </section>
      ) : null}

      {error ? (
        <p className="inline-error" role="alert" data-testid="discussion-error">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="inline-status" role="status" data-testid="discussion-status">
          {status}
        </p>
      ) : null}

      {canManage && !stop.stopped ? (
        <form
          data-testid="intervene-form"
          className="stacked-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!intervention.trim()) {
              return;
            }
            void submit(
              {
                schema_version: 1,
                idempotency_key: newDiscussionKey(),
                discussion_id: view.discussion_id,
                expected_version: view.version,
                action: "intervene",
                text: intervention.trim(),
              },
              "Intervention recorded as the signed-in human.",
              () => setIntervention(""),
            );
          }}
        >
          <label>
            Intervene as {props.humanDisplayName}
            <textarea
              data-testid="intervene-text"
              value={intervention}
              onChange={(event) => setIntervention(event.target.value)}
              maxLength={4096}
              rows={3}
              required
            />
          </label>
          <button type="submit" className="button-secondary" disabled={busy || !intervention.trim()}>
            Add intervention
          </button>
        </form>
      ) : null}

      {canManage && !stop.stopped ? (
        <button
          type="button"
          className="button-attention"
          data-testid="discussion-cancel"
          disabled={busy}
          onClick={() =>
            void submit(
              {
                schema_version: 1,
                idempotency_key: newDiscussionKey(),
                discussion_id: view.discussion_id,
                expected_version: view.version,
                action: "cancel",
              },
              "Discussion cancelled. No later turn is accepted.",
            )
          }
        >
          Stop discussion
        </button>
      ) : null}

      {canManage && stop.stopped && !view.decision ? (
        <form
          data-testid="decide-form"
          className="stacked-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!decisionSummaryText.trim()) {
              return;
            }
            const decision: DecisionInput = {
              kind: decisionKind,
              summary: decisionSummaryText.trim(),
              recommendationIds: decisionRefs,
            };
            void submit(
              {
                schema_version: 1,
                idempotency_key: newDiscussionKey(),
                discussion_id: view.discussion_id,
                expected_version: view.version,
                action: "decide",
                decision: {
                  kind: decision.kind,
                  summary: decision.summary,
                  recommendation_ids: decision.recommendationIds,
                },
              },
              "Human decision recorded. The task state is unchanged.",
              () => {
                setDecisionSummaryText("");
                setDecisionRefs([]);
              },
            );
          }}
        >
          <h4>Record a human decision</h4>
          <p className="section-help">
            A decision references stored recommendations. It never completes the task or
            authorizes implementation.
          </p>
          <label>
            Decision
            <select
              data-testid="decide-kind"
              value={decisionKind}
              onChange={(event) => setDecisionKind(event.target.value as DecisionInput["kind"])}
            >
              <option value="record_recommendation">Record recommendation</option>
              <option value="decline">Decline</option>
              <option value="needs_more_context">Needs more context</option>
            </select>
          </label>
          <fieldset>
            <legend>Referenced recommendations</legend>
            {recommendations.length === 0 ? (
              <p className="compact-empty">No recommendations to reference yet.</p>
            ) : (
              recommendations.map((message) => (
                <label key={message.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={decisionRefs.includes(message.id)}
                    onChange={() => toggleDecisionRef(message.id)}
                  />
                  {`${participantName(view, message.participant_id)} — ${(message.output?.recommendation ?? "").slice(0, 80)}`}
                </label>
              ))
            )}
          </fieldset>
          <label>
            Summary
            <textarea
              data-testid="decide-summary"
              value={decisionSummaryText}
              onChange={(event) => setDecisionSummaryText(event.target.value)}
              maxLength={4096}
              rows={3}
              required
            />
          </label>
          <button
            type="submit"
            className="button-primary"
            disabled={
              busy ||
              !decisionSummaryText.trim() ||
              (decisionKind === "record_recommendation" && decisionRefs.length === 0)
            }
          >
            Record decision as {props.humanDisplayName}
          </button>
        </form>
      ) : null}
      <span data-testid="discussion-refresh-count" hidden>
        {sync.refreshCount}
      </span>
      <span hidden>{props.humanId}</span>
    </section>
  );
}
