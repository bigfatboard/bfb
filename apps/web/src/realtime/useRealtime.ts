// ABOUTME: Drives one run-scoped realtime session from socket invalidations to replay entries.
// ABOUTME: Entries render only from authoritative HTTP replay; invalidations only schedule fetches.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  deriveActivity,
  deriveConnectivity,
  deriveHumanPresence,
  deriveProcessPresence,
  relativeTime,
  type Connectivity,
  type HumanPresence,
  type ProcessPresence,
  type RunActivity,
} from "./presence.js";
import {
  HEARTBEAT_INTERVAL_MS,
  REALTIME_PATH,
  REPLAY_LIMIT,
  heartbeatFrame,
  parseReplayEnvelope,
  parseServerFrame,
  type ReplayEnvelope,
} from "./protocol.js";
import { createResyncMachine } from "./resync.js";
import { buildTimelineEntries, type TimelineEntry } from "./timeline.js";

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

const TRANSIENT_CLOSE = new Set([1006, 1011, 1012, 1013]);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export interface CommentNote {
  id: string;
  created_at: string;
  author_human_id: string | null;
}

export interface RunRealtime {
  entries: TimelineEntry[];
  connectivity: Connectivity;
  process: ProcessPresence;
  activity: RunActivity;
  human: HumanPresence;
  humanText: string;
  memberOnly: boolean;
  notice: string | null;
  retryCount: number;
  reconnect(): void;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function useRunRealtime(options: {
  workspaceId: string;
  taskId: string;
  runId: string | null;
  fetchImpl?: typeof fetch;
  transport?: RealtimeTransport;
  nowImpl?: () => number;
}): RunRealtime {
  // Seams stay in refs so the socket lifecycle below runs once per run and
  // never reconnects just because an inline default was recreated on render.
  // The fetch wrapper preserves a bare call: window.fetch throws when it is
  // invoked as a method on a foreign receiver.
  const seams = useRef({
    fetchFn: (...args: Parameters<typeof fetch>) => (options.fetchImpl ?? fetch)(...args),
    nowImpl: options.nowImpl ?? (() => Date.now()),
    transport: options.transport,
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  seams.current.fetchFn = (...args: Parameters<typeof fetch>) => fetchImpl(...args);
  seams.current.nowImpl = options.nowImpl ?? (() => Date.now());
  seams.current.transport = options.transport;
  const [envelopes, setEnvelopes] = useState<ReplayEnvelope[]>([]);
  const [comments, setComments] = useState<CommentNote[]>([]);
  const [memberOnly, setMemberOnly] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [socketOpen, setSocketOpen] = useState(false);
  const [lastSignalAt, setLastSignalAt] = useState<number | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const machine = useRef(createResyncMachine(0));
  const channel = useRef<RealtimeChannel | null>(null);
  const connectionId = useRef<string | null>(null);
  const readyReceived = useRef(false);
  const fallbackTried = useRef(false);
  const mounted = useRef(true);
  const state = useRef({ runId: options.runId, workspaceId: options.workspaceId });
  state.current = { runId: options.runId, workspaceId: options.workspaceId };

  const markSignal = useCallback(() => {
    if (mounted.current) setLastSignalAt(seams.current.nowImpl());
  }, []);

  const runFetch = useCallback(
    async (after: number, through: number): Promise<void> => {
      const { runId, workspaceId } = state.current;
      if (!runId || !mounted.current) return;
      const response = await seams.current.fetchFn(
        `/api/v1/workspaces/${workspaceId}/events?after_cursor=${after}&through_cursor=${through}&limit=${REPLAY_LIMIT}`,
      );
      if (response.status === 403) {
        if (mounted.current) setMemberOnly(true);
        machine.current.dispatch({ type: "replay-failed", error: "member-only replay" });
        return;
      }
      if (!response.ok) {
        machine.current.dispatch({ type: "replay-failed", error: `replay ${response.status}` });
        if (mounted.current) setNotice("Committed history is temporarily unavailable.");
        return;
      }
      const body = await readJson(response);
      const rows = Array.isArray(body.events) ? body.events : [];
      const parsed: ReplayEnvelope[] = [];
      for (const row of rows) {
        const envelope = parseReplayEnvelope(row);
        if (!envelope) {
          machine.current.dispatch({ type: "replay-failed", error: "invalid replay envelope" });
          if (mounted.current) setNotice("Committed history failed validation.");
          return;
        }
        if (envelope.run_id === runId) parsed.push(envelope);
      }
      if (mounted.current) {
        markSignal();
        setEnvelopes((current) => {
          const seen = new Set(current.map((entry) => entry.event_id));
          return [...current, ...parsed.filter((entry) => !seen.has(entry.event_id))].sort(
            (left, right) => left.workspace_cursor - right.workspace_cursor,
          );
        });
      }
      const pending = machine.current.dispatch({
        type: "replay-done",
        envelopes: parsed,
        requestedThrough: through,
        hasMore: body.has_more === true,
      });
      // Self-recursion is safe: stable deps keep one callback instance alive.
      for (const effect of pending) await runFetch(effect.after, effect.through);
    },
    [markSignal],
  );

  /**
   * HTTP fallback when the socket dies before the first ready mark. The
   * response carries the authoritative high-water cursor, which re-enters
   * the machine as a synthetic ready so ordering and dedupe stay
   * single-pathed. A 403 here is the reviewer fence, not a retryable fault.
   */
  const fallbackLoad = useCallback(async (): Promise<void> => {
    const { runId, workspaceId } = state.current;
    if (!runId || !mounted.current) return;
    let response: Response;
    try {
      response = await seams.current.fetchFn(
        `/api/v1/workspaces/${workspaceId}/events?after_cursor=0&through_cursor=${Number.MAX_SAFE_INTEGER}&limit=1`,
      );
    } catch {
      return;
    }
    if (!mounted.current) return;
    if (response.status === 403) {
      setMemberOnly(true);
      setRetryCount(MAX_RETRIES);
      machine.current.dispatch({ type: "replay-failed", error: "member-only replay" });
      return;
    }
    if (!response.ok) return;
    const body = await readJson(response);
    const highWater = typeof body.high_water_cursor === "number" ? body.high_water_cursor : 0;
    markSignal();
    const effects = machine.current.dispatch({ type: "ready", highWater });
    for (const effect of effects) await runFetch(effect.after, effect.through);
  }, [markSignal, runFetch]);

  const connect = useCallback(() => {
    const { runId, workspaceId } = state.current;
    if (!runId) return;
    const url = socketUrl(workspaceId);
    const transport = seams.current.transport ?? browserTransport();
    if (!url) return;
    channel.current?.close();
    channel.current = null;
    connectionId.current = null;
    readyReceived.current = false;
    fallbackTried.current = false;
    machine.current = createResyncMachine(
      machine.current.snapshot().appliedThrough,
    );
    setSocketOpen(false);
    const next = transport.open(url, "bfb.browser.v1");
    channel.current = next;
    next.onmessage = (data: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data) as unknown;
      } catch {
        return;
      }
      const frame = parseServerFrame(parsed);
      if (!frame || frame.workspaceId !== state.current.workspaceId) return;
      markSignal();
      if (frame.kind === "ready") {
        readyReceived.current = true;
        connectionId.current = frame.connectionId;
        setSocketOpen(true);
        const effects = machine.current.dispatch({ type: "ready", highWater: frame.highWater });
        void (async () => {
          for (const effect of effects) await runFetch(effect.after, effect.through);
        })();
      } else if (frame.kind === "invalidation") {
        const effects = machine.current.dispatch({ type: "invalidation", cursor: frame.highWater });
        void (async () => {
          for (const effect of effects) await runFetch(effect.after, effect.through);
        })();
      } else if (frame.kind === "close") {
        if (frame.reason === "session_expired") {
          setNotice("Session expired. Sign in again to resume live updates.");
        } else {
          setNotice("Workspace access changed. Reload to resume live updates.");
        }
        setSocketOpen(false);
      }
    };
    next.onclose = ({ code }) => {
      if (!mounted.current) return;
      setSocketOpen(false);
      connectionId.current = null;
      if (code === 4401) {
        setNotice("Session expired. Sign in again to resume live updates.");
        return;
      }
      if (code === 4403) {
        setNotice("Workspace access changed. Reload to resume live updates.");
        return;
      }
      if (!readyReceived.current && !fallbackTried.current) {
        fallbackTried.current = true;
        void fallbackLoad();
      }
      setRetryCount((count) => {
        if (TRANSIENT_CLOSE.has(code) && count < MAX_RETRIES && typeof window !== "undefined") {
          window.setTimeout(() => {
            if (mounted.current) connect();
          }, RETRY_DELAY_MS);
          return count + 1;
        }
        if (!TRANSIENT_CLOSE.has(code) || count >= MAX_RETRIES) {
          setNotice("Realtime offline. Committed history below stays authoritative.");
        }
        return count;
      });
    };
  }, [fallbackLoad, markSignal, runFetch]);

  const reconnect = useCallback(() => {
    setNotice(null);
    setRetryCount(0);
    connect();
  }, [connect]);

  useEffect(() => {
    mounted.current = true;
    setEnvelopes([]);
    setComments([]);
    setMemberOnly(false);
    setNotice(null);
    setRetryCount(0);
    machine.current = createResyncMachine(0);
    const { runId, workspaceId } = state.current;
    if (!runId) return undefined;
    void (async () => {
      try {
        const response = await seams.current.fetchFn(
          `/api/v1/workspaces/${workspaceId}/tasks/${options.taskId}/comments?limit=100`,
        );
        if (!response.ok || !mounted.current) return;
        const body = await readJson(response);
        if (Array.isArray(body.comments) && mounted.current) {
          setComments(
            (body.comments as CommentNote[]).filter(
              (comment) => comment && typeof comment.id === "string",
            ),
          );
        }
      } catch {
        /* Human presence stays honestly unknown when comments cannot load. */
      }
    })();
    connect();
    const heartbeat = window.setInterval(() => {
      const id = connectionId.current;
      if (id && channel.current) {
        try {
          channel.current.send(heartbeatFrame(state.current.workspaceId, id));
        } catch {
          /* A failed heartbeat surfaces as a socket close. */
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    const ticker = window.setInterval(() => {
      if (mounted.current) setClock(seams.current.nowImpl());
    }, 5000);
    return () => {
      mounted.current = false;
      window.clearInterval(heartbeat);
      window.clearInterval(ticker);
      channel.current?.close();
      channel.current = null;
    };
  }, [connect, options.runId, options.taskId, options.workspaceId]);

  const entries = useMemo(() => buildTimelineEntries(envelopes), [envelopes]);
  const connectivity = deriveConnectivity({ socketOpen, lastSignalAt, now: clock });
  const process = deriveProcessPresence(envelopes, clock);
  const activity = deriveActivity(envelopes, clock);
  const human = useMemo(() => deriveHumanPresence(comments), [comments]);
  const humanText = useMemo(() => {
    if (human.kind === "note") return `Last human note ${relativeTime(human.at, clock)}`;
    return "No committed human activity yet";
  }, [human, clock]);

  return {
    entries,
    connectivity,
    process,
    activity,
    human,
    humanText,
    memberOnly,
    notice,
    retryCount,
    reconnect,
  };
}
