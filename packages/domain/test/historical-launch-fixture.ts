// ABOUTME: Seeds synthetic retained launch claims in schemas that predate private-task authority.
// ABOUTME: Migration history setup does not invoke or certify current launch authorization on an old schema.

import type { SqlDatabase } from "@bfb/db";
import type { LaunchClaimResult } from "@bfb/protocol";
import { launchDeadline, LEASE_TTL_MS, readLaunch, snapshotOf } from "../src/launch-state.js";
import { runnerHash } from "../src/runner-crypto.js";

export async function seedHistoricalLaunchClaim(
  db: SqlDatabase,
  workspaceId: string,
  launchId: string,
  claimKey: string,
  now: string,
): Promise<LaunchClaimResult> {
  if (await db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_privacy'").get())
    throw new Error("historical launch fixture requires pre-private-authority schema");
  const row = await readLaunch(db, workspaceId, launchId);
  if (row.state !== "pending") throw new Error("historical launch must be pending");
  const snapshot = snapshotOf(row),
    expires = launchDeadline(now, LEASE_TTL_MS);
  await db
    .prepare(
      `INSERT INTO checkout_leases
    (workspace_id,runner_id,physical_worktree_hash,execution_id,assignment_generation,fencing_generation,state,expires_at)
    VALUES (?,?,?,?,?,1,'reserved',?)`,
    )
    .run(
      workspaceId,
      row.runner_id,
      row.physical_worktree_hash,
      row.execution_id,
      row.assignment_generation,
      expires,
    );
  await db
    .prepare(
      "UPDATE launch_commands SET state='claimed',claimed_at=?,claim_key_hash=? WHERE workspace_id=? AND id=?",
    )
    .run(now, runnerHash(claimKey), workspaceId, launchId);
  await db
    .prepare(
      "UPDATE run_executions SET state='launching',resource_version=resource_version+1 WHERE workspace_id=? AND id=?",
    )
    .run(workspaceId, row.execution_id);
  return {
    schema_version: 1,
    assignment: {
      schema_version: 1,
      workspace_id: workspaceId,
      project_id: row.project_id,
      task_id: row.task_id,
      run_id: row.run_id,
      run_execution_id: row.execution_id,
      assignment_generation: row.assignment_generation,
      runner_id: row.runner_id,
      checkout_id: row.checkout_id,
      created_at: row.created_at,
    },
    snapshot,
    specification: {
      schema_version: 1,
      launch_id: row.id,
      run_id: row.run_id,
      run_execution_id: row.execution_id,
      assignment_generation: row.assignment_generation,
      task_id: row.task_id,
      runner_id: row.runner_id,
      checkout_id: row.checkout_id,
      agent_profile_id: snapshot.agent_profile_id,
      config_snapshot_id: row.snapshot_id,
      config_snapshot_hash: row.snapshot_hash,
      execution_config: snapshot.execution_config,
      expires_at: row.expires_at,
    },
    fencing_generation: 1,
    lease_expires_at: expires,
  };
}
