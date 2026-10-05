// ABOUTME: Derives local agent-run authority from possession-authenticated immutable assignments.
// ABOUTME: Serves bounded task/context reads with current authority checked before idempotent replay.

import { createHash } from "node:crypto";
import {
  decodeWireDocument,
  type AgentWorkRequest,
  type AgentAuthorityResult,
  type AgentTaskResult,
} from "@bfb/protocol";
import { assertEpoch, loadPrincipal } from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import {
  canonicalLaunchJson,
  assertLeaseBinding,
  readLease,
  type AssignmentRow,
} from "./launch-state.js";
import { launchRunner } from "./launch-state.js";
import { assertRunnerLaunchAuthority, type RunnerPrincipal } from "./runners.js";
import { deliverAgentContext, getTask, type RunContextResult } from "./work-commands.js";

export const AGENT_CONTEXT_RESULT_BYTES = 61_440;

export interface AgentWorkInput {
  principal: RunnerPrincipal;
  request: AgentWorkRequest;
}
export interface BoundRun extends AssignmentRow {
  launch_id: string;
  execution_state: string;
  result_state: string;
  purpose: string;
  launch_state: string;
  final_authorized_at: string | null;
}

function checkedRequest(input: AgentWorkInput): AgentWorkRequest {
  const decoded = decodeWireDocument(
    "agent-work-request",
    Buffer.from(JSON.stringify(input.request)),
  );
  if (!decoded.ok) throw new DomainError("request_rejected", "invalid agent work reference");
  return decoded.value as AgentWorkRequest;
}

export function agentWorkKey(tool: string, request: AgentWorkRequest): string {
  return `agent:${createHash("sha256")
    .update(
      canonicalLaunchJson({
        tool,
        schema_version: request.schema_version,
        run_execution_id: request.run_execution_id,
        assignment_generation: request.assignment_generation,
        request_id: request.request_id,
      }),
    )
    .digest("hex")}`;
}

async function boundRun(input: AgentWorkInput, ctx: HubContext): Promise<BoundRun> {
  const request = checkedRequest(input);
  let principal: RunnerPrincipal;
  try {
    principal = await launchRunner(ctx, input.principal);
  } catch (error) {
    authorityFailure(error);
  }
  const row = (await ctx.db
    .prepare(
      `SELECT assignment.*, execution.state AS execution_state,
    run.result_state, run.purpose, launch.id AS launch_id, launch.state AS launch_state, launch.final_authorized_at
    FROM execution_assignments assignment
    JOIN run_executions execution ON execution.workspace_id = assignment.workspace_id
      AND execution.id = assignment.execution_id AND execution.run_id = assignment.run_id
    JOIN runs run ON run.workspace_id = assignment.workspace_id AND run.id = assignment.run_id
      AND run.task_id = assignment.task_id AND run.project_id = assignment.project_id
    JOIN launch_commands launch ON launch.workspace_id = assignment.workspace_id
      AND launch.execution_id = assignment.execution_id
    WHERE assignment.workspace_id = ? AND assignment.execution_id = ?
      AND assignment.assignment_generation = ?`,
    )
    .get(ctx.workspaceId, request.run_execution_id, request.assignment_generation)) as
    BoundRun | undefined;
  if (!row || row.runner_id !== principal.runnerId || row.purpose !== "work") {
    throw new DomainError("boundary_escape", "execution is not owned by this runner");
  }
  if (
    row.runner_authorization_epoch !== principal.authorizationEpoch ||
    row.runner_grant_epoch !== principal.grantEpoch ||
    row.runner_key_thumbprint !== principal.keyThumbprint
  ) {
    throw new DomainError("revoked", "assignment authority changed");
  }
  try {
    const requester = await loadPrincipal(ctx.db, ctx.workspaceId, row.requesting_human_id);
    assertEpoch(requester, row.requesting_human_epoch);
    await assertRunnerLaunchAuthority(ctx.db, requester, row.runner_id, row.project_id);
  } catch (error) {
    authorityFailure(error);
  }
  return row;
}

function authorityFailure(error: unknown): never {
  if (
    error instanceof DomainError &&
    ["request_rejected", "forbidden", "not_found", "stale_authorization"].includes(error.code)
  ) {
    throw new DomainError("revoked", "current execution authority rejected");
  }
  throw error;
}

function disposition(row: BoundRun): AgentAuthorityResult {
  return {
    revoked: false,
    execution_ended: row.execution_state === "ended",
    result_terminal: ["accepted", "failed", "cancelled"].includes(row.result_state),
  };
}

export async function liveRun(input: AgentWorkInput, ctx: HubContext): Promise<BoundRun> {
  const row = await boundRun(input, ctx),
    state = disposition(row);
  if (state.execution_ended) throw new DomainError("assignment_ended", "execution ended");
  if (state.result_terminal) throw new DomainError("capability_closed", "run result is terminal");
  if (
    !row.final_authorized_at ||
    !["claimed", "started"].includes(row.launch_state) ||
    !["launching", "attached", "detached"].includes(row.execution_state)
  ) {
    throw new DomainError("forbidden", "execution has no final launch authority");
  }
  const lease = await readLease(ctx.db, row);
  try {
    assertLeaseBinding(lease, row);
  } catch {
    throw new DomainError("capability_closed", "execution lease no longer matches");
  }
  if (
    !["reserved", "live"].includes(lease.state) ||
    Date.parse(lease.expires_at) <= Date.parse(ctx.now)
  ) {
    throw new DomainError("capability_closed", "execution lease is not live");
  }
  return row;
}

const auditInput = (input: AgentWorkInput) => ({
  executionId: input.request.run_execution_id,
  generation: input.request.assignment_generation,
  requestId: input.request.request_id,
});
const inputFingerprint = (input: AgentWorkInput) =>
  createHash("sha256")
    .update(canonicalLaunchJson(checkedRequest(input)))
    .digest("hex");
const authorize = async (input: AgentWorkInput, ctx: HubContext) => {
  await liveRun(input, ctx);
};

export const agentRunAuthorityCommand: HubCommand<AgentWorkInput, AgentAuthorityResult> = {
  name: "agent_run.authority",
  auditInput,
  inputFingerprint,
  authorize,
  async run(input, ctx) {
    const row = await boundRun(input, ctx),
      state = disposition(row);
    if (!state.execution_ended && !state.result_terminal) await liveRun(input, ctx);
    return state;
  },
};

export const agentRunContextCommand: HubCommand<AgentWorkInput, RunContextResult> = {
  name: "agent_run.context",
  authorize,
  auditInput,
  inputFingerprint,
  auditResult: (result) => ({
    context: result.context.map((item) => ({
      id: item.id,
      version: item.version,
      content_hash: item.content_hash,
    })),
    deliveries: result.deliveries,
  }),
  async run(input, ctx) {
    const row = await liveRun(input, ctx);
    return deliverAgentContext(
      ctx.db,
      ctx.workspaceId,
      row.task_id,
      { kind: "run", runId: row.run_id },
      ctx.now,
      AGENT_CONTEXT_RESULT_BYTES,
    );
  },
};

export const agentRunTaskCommand: HubCommand<AgentWorkInput, AgentTaskResult> = {
  name: "agent_run.task",
  authorize,
  auditInput,
  inputFingerprint,
  auditResult: (result) => ({
    id: result.id,
    project_id: result.project_id,
    state: result.state,
    priority: result.priority,
    resource_version: result.resource_version,
  }),
  async run(input, ctx) {
    const row = await liveRun(input, ctx),
      task = await getTask(ctx.db, ctx.workspaceId, row.task_id);
    if (!task) throw new DomainError("not_found", "task unavailable");
    return {
      id: task.id,
      project_id: task.project_id,
      state: task.state,
      priority: task.priority,
      title: task.title,
      punchline: task.punchline,
      resource_version: task.resource_version,
    };
  },
};
