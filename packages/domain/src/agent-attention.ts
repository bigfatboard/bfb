// ABOUTME: Projects authenticated attention results and fresh current-run attention reads.
// ABOUTME: Keeps original attention provenance separate from the calling assignment's session authority.

import type { SqlDatabase } from "@bfb/db";
import {
  decodeWireDocument,
  type AgentAttentionReadRequest,
  type AgentAttentionResult,
  type AgentSessionReference,
} from "@bfb/protocol";
import { getAttention, requireAttentionRun, type AttentionRecord } from "./attention.js";
import { DomainError, type HubContext } from "./hub.js";
import { runnerObject } from "./runner-crypto.js";
import type { RunnerPrincipal } from "./runners.js";
import { agentTaskAccess } from "./agent-work.js";

export interface ReadAgentAttentionInput {
  principal: RunnerPrincipal;
  request: AgentAttentionReadRequest;
}

/** Only this bounded projection crosses the local agent transport. */
export function agentAttentionResult(
  record: AttentionRecord,
  binding: AgentSessionReference | null,
): AgentAttentionResult {
  const result: AgentAttentionResult = {
    attention: {
      id: record.id,
      kind: record.kind,
      required_role: record.required_role,
      question: record.question,
      blocking: record.blocking,
      state: record.state,
      answer: record.answer,
      resource_version: record.resource_version,
      requested_at: record.requested_at,
      first_response_at: record.first_response_at,
      answered_at: record.answered_at,
      resolved_at: record.resolved_at,
    },
    origin: {
      run_id: record.run_id,
      run_execution_id: record.run_execution_id,
      assignment_generation: record.assignment_generation,
    },
    authority_binding: binding,
  };
  const bytes = Buffer.from(JSON.stringify(result));
  if (bytes.length > 61_440 || !decodeWireDocument("agent-attention-result", bytes).ok)
    throw new DomainError("request_rejected", "invalid attention result");
  return result;
}

/** Read-only: no Hub outcome, binding, observation or replay work is created. */
export async function readAgentAttention(
  db: SqlDatabase,
  workspaceId: string,
  input: ReadAgentAttentionInput,
): Promise<AgentAttentionResult> {
  runnerObject(input, ["principal", "request"]);
  const bytes = Buffer.from(JSON.stringify(input.request));
  const decoded = decodeWireDocument("agent-attention-read-request", bytes);
  if (bytes.length > 16_384 || !decoded.ok)
    throw new DomainError("request_rejected", "invalid attention read");
  const request = decoded.value as AgentAttentionReadRequest;
  return db.withTransaction(async (tx) => {
    const context: HubContext = {
      db: tx,
      workspaceId,
      now: new Date().toISOString(),
      actorRunnerId: input.principal.runnerId,
      authorizationEpoch: input.principal.authorizationEpoch,
      cursorBase: 0,
    };
    const { row, binding } = await requireAttentionRun(
      { principal: input.principal, request: request.reference },
      context,
      request.binding,
    );
    const record = await getAttention(
      tx,
      workspaceId,
      [row.project_id],
      request.attention_id,
      agentTaskAccess(row),
    );
    if (!record || record.run_id !== row.run_id || record.task_id !== row.task_id)
      throw new DomainError("not_found", "attention request not found");
    return agentAttentionResult(record, binding);
  });
}
