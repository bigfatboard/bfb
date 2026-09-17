// ABOUTME: Projects committed replay envelopes into inert Run timeline entries.
// ABOUTME: Summaries are fixed per-kind templates; event-controlled strings stay data.

import type { ReplayEnvelope } from "./protocol.js";

export type Provenance = "daemon-observed" | "agent-reported";

export interface TimelineEntry {
  eventId: string;
  cursor: number;
  kind: string;
  summary: string;
  actorType: string;
  actorLabel: string;
  actorId: string;
  sourceLabel: string;
  provider: string | null;
  provenance: Provenance;
  executionId: string;
  assignmentGeneration: number;
  sessionId: string | null;
  occurredAt: string;
}

const SUMMARIES: Record<string, string> = {
  launch_claimed: "Launch claimed by the runner",
  launch_blocked: "Launch blocked before execution",
  execution_attached: "Runner attached to the execution",
  execution_detached: "Runner detached from the execution",
  execution_ended: "Execution ended",
  session_started: "Provider session started",
  session_resumed: "Provider session resumed",
  session_ended: "Provider session ended",
  turn_started: "Agent turn started",
  turn_stopped: "Agent turn ended",
  turn_failed: "Agent turn failed",
  tool_started: "Tool call started",
  tool_finished: "Tool call finished",
  tool_failed: "Tool call failed",
  progress_reported: "Progress reported",
  attention_requested: "Human attention requested",
  subagent_started: "Subagent started",
  subagent_ended: "Subagent ended",
  context_compacted: "Context compacted",
  artifact_published: "Artifact published",
  result_submitted: "Result submitted for review",
  run_failed: "Run failed",
  run_cancelled: "Run cancelled",
  heartbeat: "Runner heartbeat observed",
};

/** Fixed per-kind summary; unknown kinds stay a neutral record, never a claim. */
export function summarizeEventKind(kind: string): string {
  return SUMMARIES[kind] ?? "Recorded run event";
}

/** Shortens opaque IDs for display; the full value remains available as data. */
export function shortId(id: string): string {
  return id.length > 32 ? `${id.slice(0, 32)}…` : id;
}

function actorLabel(actorType: string): string {
  if (actorType === "runner") return "Runner";
  if (actorType === "agent_run") return "Agent run";
  return "Recorded actor";
}

function provenanceOf(actorType: string): Provenance {
  return actorType === "runner" ? "daemon-observed" : "agent-reported";
}

/** Projects envelopes in cursor order; the caller supplies replay-authoritative rows only. */
export function buildTimelineEntries(envelopes: readonly ReplayEnvelope[]): TimelineEntry[] {
  return [...envelopes]
    .sort((left, right) => left.workspace_cursor - right.workspace_cursor)
    .map((envelope) => {
      const provider =
        typeof envelope.source.provider === "string" && envelope.source.provider.length > 0
          ? envelope.source.provider
          : null;
      return {
        eventId: envelope.event_id,
        cursor: envelope.workspace_cursor,
        kind: envelope.kind,
        summary: summarizeEventKind(envelope.kind),
        actorType: envelope.actor.type,
        actorLabel: actorLabel(envelope.actor.type),
        actorId: envelope.actor.id,
        sourceLabel: provider ? `Runner via ${provider}` : "Runner",
        provider,
        provenance: provenanceOf(envelope.actor.type),
        executionId: envelope.run_execution_id,
        assignmentGeneration: envelope.assignment_generation,
        sessionId: envelope.provider_session_id ?? null,
        occurredAt: envelope.occurred_at,
      };
    });
}
