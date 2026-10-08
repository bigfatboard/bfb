// ABOUTME: Expires pending diagnostic consent while automatic raw-log deletion is paused.
// ABOUTME: The beta hold preserves stored objects, artifact state, policies, and purge history.

import type { SqlDatabase } from "@bfb/db";

export interface RetentionR2 {
  delete(key: string): Promise<unknown>;
}

export interface OperationsSweepResult {
  workspaces: number;
  examined: number;
  deleted_objects: number;
  deleted_bytes: number;
  expired_bundles: number;
  errors: string[];
}

/**
 * Automatic raw-log cleanup is uniformly paused for beta. Do not select
 * candidates, access R2, mark versions purged, or record retention runs.
 * Existing diagnostic-consent expiry remains independent of that hold.
 */
export async function runRetentionSweep(
  db: SqlDatabase,
  _r2: RetentionR2,
  now: string,
): Promise<OperationsSweepResult> {
  const result: OperationsSweepResult = {
    workspaces: 0,
    examined: 0,
    deleted_objects: 0,
    deleted_bytes: 0,
    expired_bundles: 0,
    errors: [],
  };
  const expired = await db
    .prepare(
      `UPDATE diagnostic_bundles SET state = 'expired', last_error = 'consent_expired'
       WHERE state = 'pending_consent' AND datetime(expires_at) <= datetime(?)`,
    )
    .run(now);
  result.expired_bundles = Number(expired.changes ?? 0);
  return result;
}
