// ABOUTME: W02 browser reads for runner checkouts and launch/execution status.
// ABOUTME: Sanitized projections only; command authority stays with C09 and L05.

import type { SqlDatabase } from "@bfb/db";
import {
  assertProjectAccess,
  DomainError,
  listRunners,
  type AuthzPrincipal,
} from "@bfb/domain";
import { decodeWireDocument, type RunnerInventory } from "@bfb/protocol";

export interface CheckoutStatus {
  runner_id: string;
  device_label: string;
  owner_human_id: string;
  status: "enrolled" | "revoked";
  inventory_revision: number | null;
  inventory_received_at: string | null;
  inventory_valid: boolean;
  checkouts: RunnerInventory["checkouts"];
  providers: RunnerInventory["providers"];
}

export interface LaunchStatus {
  launch_id: string;
  run_id: string;
  run_execution_id: string;
  assignment_generation: number;
  task_id: string;
  project_id: string;
  runner_id: string;
  checkout_id: string;
  requesting_human_id: string;
  state: "pending" | "claimed" | "started" | "rejected" | "expired";
  expires_at: string;
  cancelled: boolean;
  end_reason: "launch_blocked" | "launch_expired" | "terminated" | null;
  execution_state: "queued" | "launching" | "attached" | "detached" | "ended";
  execution_end_reason:
    | "launch_blocked"
    | "launch_expired"
    | "process_exit"
    | "terminated"
    | "lost"
    | null;
  result_state: "open" | "submitted" | "changes_requested" | "accepted" | "failed" | "cancelled";
  activity:
    | "working"
    | "needs_human"
    | "waiting_user_submit"
    | "waiting_external"
    | "idle"
    | "offline"
    | "unknown";
  lease_state: "reserved" | "live" | "containment_unknown" | "released" | null;
  containment_reason:
    | "escaped_descendant"
    | "identity_ambiguous"
    | "evidence_missing"
    | "recovery_incomplete"
    | null;
  agent_profile_id: string | null;
  provider: "claude" | "codex" | "grok" | "fake" | null;
  model: string | null;
  execution_mode: "interactive" | "headless" | null;
}

/** Visible runners only; null when the caller holds no grant for this runner. */
export async function checkoutStatusForRunner(
  db: SqlDatabase,
  principal: AuthzPrincipal,
  runnerId: string,
): Promise<CheckoutStatus | null> {
  const runners = await listRunners(db, principal);
  const runner = runners.find((item) => item.runner_id === runnerId);
  if (!runner) {
    return null;
  }
  const row = (await db
    .prepare(
      `SELECT inventory_json, revision, received_at FROM runner_inventories
       WHERE workspace_id = ? AND runner_id = ?`,
    )
    .get(principal.workspaceId, runnerId)) as
    | { inventory_json: string; revision: number; received_at: string }
    | undefined;
  if (!row) {
    return {
      runner_id: runner.runner_id,
      device_label: runner.device_label,
      owner_human_id: runner.owner_human_id,
      status: runner.status,
      inventory_revision: null,
      inventory_received_at: null,
      inventory_valid: false,
      checkouts: [],
      providers: [],
    };
  }
  let inventory: RunnerInventory | null = null;
  try {
    const decoded = decodeWireDocument("runner-inventory", Buffer.from(row.inventory_json));
    if (decoded.ok) {
      inventory = decoded.value as RunnerInventory;
    }
  } catch {
    inventory = null;
  }
  if (!inventory || inventory.runner_id !== runnerId || inventory.workspace_id !== principal.workspaceId) {
    return {
      runner_id: runner.runner_id,
      device_label: runner.device_label,
      owner_human_id: runner.owner_human_id,
      status: runner.status,
      inventory_revision: row.revision,
      inventory_received_at: row.received_at,
      inventory_valid: false,
      checkouts: [],
      providers: [],
    };
  }
  const ownsRunner = runner.owner_human_id === principal.humanId;
  const visible = ownsRunner
    ? inventory.checkouts
    : inventory.checkouts.filter((checkout) => principal.projectIds.includes(checkout.project_id));
  return {
    runner_id: runner.runner_id,
    device_label: runner.device_label,
    owner_human_id: runner.owner_human_id,
    status: runner.status,
    inventory_revision: row.revision,
    inventory_received_at: row.received_at,
    inventory_valid: true,
    checkouts: visible,
    providers: inventory.providers,
  };
}

interface StatusRow {
  launch_id: string;
  run_id: string;
  run_execution_id: string;
  assignment_generation: number;
  task_id: string;
  project_id: string;
  runner_id: string;
  checkout_id: string;
  requesting_human_id: string;
  state: LaunchStatus["state"];
  expires_at: string;
  cancelled_at: string | null;
  end_reason: LaunchStatus["end_reason"];
  execution_state: LaunchStatus["execution_state"];
  execution_end_reason: LaunchStatus["execution_end_reason"];
  result_state: LaunchStatus["result_state"];
  activity: LaunchStatus["activity"];
  lease_state: LaunchStatus["lease_state"];
  containment_reason: LaunchStatus["containment_reason"];
  canonical_json: string;
}

function toStatus(row: StatusRow): LaunchStatus {
  let agentProfileId: LaunchStatus["agent_profile_id"] = null;
  let provider: LaunchStatus["provider"] = null;
  let model: LaunchStatus["model"] = null;
  let executionMode: LaunchStatus["execution_mode"] = null;
  try {
    const snapshot = JSON.parse(row.canonical_json) as {
      agent_profile_id?: string;
      execution_config?: { provider?: string; model?: string; mode?: string };
    };
    if (typeof snapshot.agent_profile_id === "string") {
      agentProfileId = snapshot.agent_profile_id;
    }
    const config = snapshot.execution_config;
    if (config && typeof config === "object") {
      if (config.provider === "claude" || config.provider === "codex" || config.provider === "grok" || config.provider === "fake") {
        provider = config.provider;
      }
      if (typeof config.model === "string") {
        model = config.model;
      }
      if (config.mode === "interactive" || config.mode === "headless") {
        executionMode = config.mode;
      }
    }
  } catch {
    agentProfileId = null;
  }
  return {
    launch_id: row.launch_id,
    run_id: row.run_id,
    run_execution_id: row.run_execution_id,
    assignment_generation: row.assignment_generation,
    task_id: row.task_id,
    project_id: row.project_id,
    runner_id: row.runner_id,
    checkout_id: row.checkout_id,
    requesting_human_id: row.requesting_human_id,
    state: row.state,
    expires_at: row.expires_at,
    cancelled: row.cancelled_at !== null,
    end_reason: row.end_reason,
    execution_state: row.execution_state,
    execution_end_reason: row.execution_end_reason,
    result_state: row.result_state,
    activity: row.activity,
    lease_state: row.lease_state,
    containment_reason: row.containment_reason,
    agent_profile_id: agentProfileId,
    provider,
    model,
    execution_mode: executionMode,
  };
}

const STATUS_SELECT = `SELECT launch.id AS launch_id, launch.run_id, launch.execution_id AS run_execution_id,
  launch.assignment_generation, assignment.task_id, assignment.project_id, assignment.runner_id,
  assignment.checkout_id, assignment.requesting_human_id, launch.state, launch.expires_at,
  launch.cancelled_at, launch.end_reason, execution.state AS execution_state,
  execution.end_reason AS execution_end_reason, run.result_state, run.activity,
  lease.state AS lease_state, lease.containment_reason, snapshot.canonical_json
  FROM launch_commands AS launch
  JOIN execution_assignments AS assignment
    ON assignment.workspace_id = launch.workspace_id AND assignment.execution_id = launch.execution_id
  JOIN run_executions AS execution
    ON execution.workspace_id = launch.workspace_id AND execution.id = launch.execution_id
  JOIN runs AS run
    ON run.workspace_id = launch.workspace_id AND run.id = launch.run_id
  JOIN run_configuration_snapshots AS snapshot
    ON snapshot.workspace_id = launch.workspace_id AND snapshot.id = launch.snapshot_id
  LEFT JOIN checkout_leases AS lease
    ON lease.workspace_id = launch.workspace_id AND lease.runner_id = assignment.runner_id
    AND lease.physical_worktree_hash = assignment.physical_worktree_hash
  WHERE launch.workspace_id = ? AND run.purpose = 'work'`;

async function taskProject(
  db: SqlDatabase,
  workspaceId: string,
  taskId: string,
): Promise<string> {
  const task = (await db
    .prepare(`SELECT project_id FROM tasks WHERE workspace_id = ? AND id = ?`)
    .get(workspaceId, taskId)) as { project_id: string } | undefined;
  if (!task) {
    throw new DomainError("not_found", "task is not available");
  }
  return task.project_id;
}

export async function launchStatusForTask(
  db: SqlDatabase,
  principal: AuthzPrincipal,
  taskId: string,
  limit = 20,
): Promise<{ launches: LaunchStatus[] }> {
  const projectId = await taskProject(db, principal.workspaceId, taskId);
  assertProjectAccess(principal, projectId);
  const bounded = Math.min(Math.max(limit, 1), 50);
  const rows = (await db
    .prepare(
      `${STATUS_SELECT} AND assignment.task_id = ?
       ORDER BY launch.created_at DESC, launch.id DESC LIMIT ?`,
    )
    .all(principal.workspaceId, taskId, bounded)) as StatusRow[];
  return { launches: rows.map(toStatus) };
}

export async function launchStatusById(
  db: SqlDatabase,
  principal: AuthzPrincipal,
  launchId: string,
): Promise<{ launch: LaunchStatus }> {
  const row = (await db
    .prepare(`${STATUS_SELECT} AND launch.id = ?`)
    .get(principal.workspaceId, launchId)) as StatusRow | undefined;
  if (!row) {
    throw new DomainError("not_found", "launch is not available");
  }
  assertProjectAccess(principal, row.project_id);
  return { launch: toStatus(row) };
}
