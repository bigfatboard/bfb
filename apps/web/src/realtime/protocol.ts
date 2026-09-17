// ABOUTME: Freezes the E02 browser realtime wire constants and closed message shapes.
// ABOUTME: Every server frame is validated before it can move the resync machine.

export const REALTIME_PROTOCOL = "bfb.browser.v1";
export const REALTIME_PATH = (workspaceId: string): string =>
  `/realtime/workspaces/${workspaceId}/subscribe`;
/** Clients send a heartbeat every interval; the server tolerates one per 10 seconds. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** Live signals older than this threshold render as stale without changing run state. */
export const STALE_THRESHOLD_MS = 45_000;
/** Replay page size for the subscribe-first drain. */
export const REPLAY_LIMIT = 100;

export type ServerFrame =
  | {
      kind: "ready";
      workspaceId: string;
      connectionId: string;
      highWater: number;
      serverTime: string;
    }
  | { kind: "invalidation"; workspaceId: string; highWater: number }
  | { kind: "alive"; workspaceId: string; connectionId: string; serverTime: string }
  | { kind: "close"; workspaceId: string; reason: string };

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function cursor(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function exactKeys(frame: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(frame).length === keys.length && keys.every((key) => key in frame);
}

/** Validates one server frame; hostile or malformed input yields null, never an exception. */
export function parseServerFrame(raw: unknown): ServerFrame | null {
  const frame = record(raw);
  if (!frame || frame.schema_version !== 1) return null;
  if (typeof frame.workspace_id !== "string" || frame.workspace_id.length === 0) return null;
  const workspaceId = frame.workspace_id;
  switch (frame.kind) {
    case "browser.realtime.ready": {
      if (
        !exactKeys(frame, [
          "schema_version",
          "kind",
          "workspace_id",
          "connection_id",
          "high_water_cursor",
          "server_time",
        ])
      ) {
        return null;
      }
      if (typeof frame.connection_id !== "string" || frame.connection_id.length === 0) return null;
      const highWater = cursor(frame.high_water_cursor);
      if (highWater === null || typeof frame.server_time !== "string") return null;
      return {
        kind: "ready",
        workspaceId,
        connectionId: frame.connection_id,
        highWater,
        serverTime: frame.server_time,
      };
    }
    case "event.committed": {
      if (!exactKeys(frame, ["schema_version", "kind", "workspace_id", "high_water_cursor"])) {
        return null;
      }
      const highWater = cursor(frame.high_water_cursor);
      if (highWater === null) return null;
      return { kind: "invalidation", workspaceId, highWater };
    }
    case "browser.realtime.alive": {
      if (
        !exactKeys(frame, [
          "schema_version",
          "kind",
          "workspace_id",
          "connection_id",
          "server_time",
        ])
      ) {
        return null;
      }
      if (typeof frame.connection_id !== "string" || frame.connection_id.length === 0) return null;
      if (typeof frame.server_time !== "string") return null;
      return {
        kind: "alive",
        workspaceId,
        connectionId: frame.connection_id,
        serverTime: frame.server_time,
      };
    }
    case "browser.realtime.close": {
      if (!exactKeys(frame, ["schema_version", "kind", "workspace_id", "reason"])) return null;
      if (
        typeof frame.reason !== "string" ||
        (frame.reason !== "session_expired" &&
          frame.reason !== "session_revoked" &&
          frame.reason !== "authorization_revoked")
      ) {
        return null;
      }
      return { kind: "close", workspaceId, reason: frame.reason };
    }
    default:
      return null;
  }
}

export function heartbeatFrame(workspaceId: string, connectionId: string): string {
  return JSON.stringify({
    schema_version: 1,
    kind: "browser.realtime.heartbeat",
    workspace_id: workspaceId,
    connection_id: connectionId,
  });
}

/** Minimal committed-envelope surface the timeline and presence projections consume. */
export interface ReplayEnvelope {
  event_id: string;
  workspace_cursor: number;
  run_id: string;
  run_execution_id: string;
  assignment_generation: number;
  provider_session_id?: string;
  actor: { type: string; id: string };
  source: { type: string; id: string; provider?: string };
  kind: string;
  occurred_at: string;
  received_at: string;
}

function text(value: unknown, max = 256): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= max ? value : null;
}

/** Validates one replay envelope; malformed rows are rejected, never rendered. */
export function parseReplayEnvelope(raw: unknown): ReplayEnvelope | null {
  const row = record(raw);
  if (!row) return null;
  const eventId = text(row.event_id, 64);
  const runId = text(row.run_id, 64);
  const executionId = text(row.run_execution_id, 64);
  const kind = text(row.kind, 64);
  const actor = record(row.actor);
  const source = record(row.source);
  const actorType = actor ? text(actor.type, 32) : null;
  const actorId = actor ? text(actor.id, 256) : null;
  const sourceType = source ? text(source.type, 32) : null;
  const sourceId = source ? text(source.id, 256) : null;
  const at = text(row.occurred_at, 64);
  const received = text(row.received_at, 64);
  const cursorValue = cursor(row.workspace_cursor);
  if (
    !eventId ||
    !runId ||
    !executionId ||
    !kind ||
    !actorType ||
    !actorId ||
    !sourceType ||
    !sourceId ||
    !at ||
    !received ||
    cursorValue === null ||
    cursorValue < 1 ||
    !Number.isFinite(Date.parse(at))
  ) {
    return null;
  }
  if (typeof row.assignment_generation !== "number" || !Number.isSafeInteger(row.assignment_generation)) {
    return null;
  }
  const envelope: ReplayEnvelope = {
    event_id: eventId,
    workspace_cursor: cursorValue,
    run_id: runId,
    run_execution_id: executionId,
    assignment_generation: row.assignment_generation,
    actor: { type: actorType, id: actorId },
    source: { type: sourceType, id: sourceId },
    kind,
    occurred_at: at,
    received_at: received,
  };
  if (row.provider_session_id !== undefined) {
    const sessionId = text(row.provider_session_id, 256);
    if (!sessionId) return null;
    envelope.provider_session_id = sessionId;
  }
  if (source.provider !== undefined) {
    if (typeof source.provider !== "string") return null;
    envelope.source = { type: sourceType, id: sourceId, provider: source.provider };
  }
  return envelope;
}
