// ABOUTME: Runs retention, bundle expiry, and recovery redelivery on the Worker Cron cadence.
// ABOUTME: Each step is isolated; an operations failure never blocks artifact, GitHub, or notify sweeps.

import type { SqlDatabase } from "@bfb/db";
import { listRetentionEligibleChunks, randomUlid } from "@bfb/domain";

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
 * Applies the workspace retention policy: deletes only eligible per-run raw
 * log R2 objects and records one retention_runs row per workspace. D1 rows,
 * hashes, metadata, review artifacts, and shared content-addressed bytes are
 * never touched; a failed object delete is recorded, never retried blindly.
 */
export async function runRetentionSweep(
  db: SqlDatabase,
  r2: RetentionR2,
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
  const workspaces = (await db.prepare(`SELECT id FROM workspaces`).all()) as Array<{ id: string }>;
  for (const workspace of workspaces) {
    result.workspaces += 1;
    let examined = 0;
    let deleted = 0;
    let bytes = 0;
    let error: string | null = null;
    try {
      const policy = (await db
        .prepare(`SELECT version FROM retention_policies WHERE workspace_id = ?`)
        .get(workspace.id)) as { version: number } | undefined;
      if (!policy) {
        continue;
      }
      const listed = await listRetentionEligibleChunks(db, workspace.id, now);
      examined = listed.examined;
      for (const chunk of listed.eligible) {
        try {
          await r2.delete(chunk.r2_key);
          deleted += 1;
          bytes += chunk.declared_size;
        } catch {
          error = "r2_delete_failed";
        }
      }
      await db
        .prepare(
          `INSERT INTO retention_runs
           (workspace_id, id, policy_version, started_at, finished_at,
            examined, deleted_objects, deleted_bytes, skipped, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workspace.id,
          randomUlid(),
          policy.version,
          now,
          new Date().toISOString(),
          examined,
          deleted,
          bytes,
          listed.examined - listed.eligible.length,
          error,
        );
    } catch {
      error = error ?? "retention_failed";
    }
    result.examined += examined;
    result.deleted_objects += deleted;
    result.deleted_bytes += bytes;
    if (error) {
      result.errors.push(`${workspace.id}:${error}`);
    }
  }
  const expired = await db
    .prepare(
      `UPDATE diagnostic_bundles SET state = 'expired', last_error = 'consent_expired'
       WHERE state = 'pending_consent' AND datetime(expires_at) <= datetime(?)`,
    )
    .run(now);
  result.expired_bundles = Number(expired.changes ?? 0);
  return result;
}
