// ABOUTME: Projects bounded artifact publication and view audits through the workspace command lane.
// ABOUTME: Source identities make dispatch atomic and replay-safe without copying private payloads.

import { assertUtcTimestamp, type SqlDatabase } from "@bfb/db";
import { ARTIFACT_RECOVERY_SYSTEM_ID, rejectArtifactRequest } from "./artifacts.js";
import type { HubCommand, HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";

export const ARTIFACT_AUDIT_ACTIONS = [
  "artifact.grant_issued",
  "artifact.grant_reissued",
  "artifact.grant_consumed",
  "artifact.upload_verified",
  "artifact.finalized",
  "artifact.abandoned",
  "artifact.view_issued",
  "artifact.view_redeemed",
] as const;
const actions = new Set<string>(ARTIFACT_AUDIT_ACTIONS);
const actionPlaceholders = ARTIFACT_AUDIT_ACTIONS.map(() => "?").join(", ");

interface ArtifactAuditRow {
  id: string;
  workspace_id: string;
  version_id: string | null;
  grant_id: string | null;
  action: string;
  created_at: string;
  dispatched_at: string | null;
}

export interface ArtifactAuditProjection {
  schema_version: 1;
  outbox_id: string;
  version_id: string | null;
  grant_id: string | null;
  source_action: string;
  occurred_at: string;
}

async function source(input: { outboxId: string }, ctx: HubContext): Promise<ArtifactAuditRow> {
  if (
    ctx.actorSystemId !== ARTIFACT_RECOVERY_SYSTEM_ID ||
    ctx.actorHumanId ||
    ctx.actorDelegationId ||
    ctx.actorRunnerId ||
    ctx.authorizationEpoch !== 1 ||
    !input ||
    typeof input !== "object" ||
    Object.keys(input).length !== 1 ||
    !isUlid(input.outboxId)
  )
    rejectArtifactRequest();
  const row = (await ctx.db
    .prepare(
      `SELECT id, workspace_id, version_id, grant_id, action, created_at, dispatched_at FROM artifact_audit_outbox WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, input.outboxId)) as ArtifactAuditRow | undefined;
  if (
    !row ||
    !actions.has(row.action) ||
    (row.version_id !== null && !isUlid(row.version_id)) ||
    (row.grant_id !== null && !isUlid(row.grant_id))
  )
    rejectArtifactRequest();
  try {
    assertUtcTimestamp(row.created_at, "artifact audit time");
  } catch {
    rejectArtifactRequest();
  }
  return row;
}

export const dispatchArtifactAuditCommand: HubCommand<
  { outboxId: string },
  ArtifactAuditProjection
> = {
  name: "artifact.dispatch_audit",
  authorize: async (input, ctx) => {
    await source(input, ctx);
  },
  inputFingerprint: (input) => input.outboxId,
  auditInput: (input) => ({ outbox_id: input.outboxId }),
  extraCursors: () => 1,
  async run(input, ctx) {
    const row = await source(input, ctx);
    if (row.dispatched_at !== null) rejectArtifactRequest();
    const result: ArtifactAuditProjection = {
      schema_version: 1,
      outbox_id: row.id,
      version_id: row.version_id,
      grant_id: row.grant_id,
      source_action: row.action,
      occurred_at: row.created_at,
    };
    const payload = JSON.stringify(result);
    // The source ID is a unique backstop independent of timestamps and transient
    // idempotency records. Hub command receipts use their own separate IDs.
    await ctx.db
      .prepare(
        `INSERT INTO audit_events (workspace_id, audit_id, actor_principal_id, action, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ctx.workspaceId, row.id, ARTIFACT_RECOVERY_SYSTEM_ID, row.action, payload, ctx.now);
    await ctx.db
      .prepare(
        `INSERT INTO semantic_events (workspace_id, event_id, workspace_cursor, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ctx.workspaceId, row.id, ctx.cursorBase, row.action, payload, ctx.now);
    await ctx.db
      .prepare(
        `UPDATE artifact_audit_outbox SET dispatched_at = ? WHERE workspace_id = ? AND id = ? AND dispatched_at IS NULL`,
      )
      .run(ctx.now, ctx.workspaceId, row.id);
    const guardId = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO artifact_mutation_guards (id, valid) VALUES (?, (SELECT COUNT(*) = 1 FROM artifact_audit_outbox WHERE workspace_id = ? AND id = ? AND dispatched_at = ?))`,
      )
      .run(guardId, ctx.workspaceId, row.id, ctx.now);
    await ctx.db.prepare(`DELETE FROM artifact_mutation_guards WHERE id = ?`).run(guardId);
    return result;
  },
};

/** Read-only bounded backlog scan; review/retention actions stay with their owning packages. */
export async function listArtifactAuditCandidates(
  db: SqlDatabase,
  limit = 100,
): Promise<Array<{ workspace_id: string; id: string }>> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) rejectArtifactRequest();
  return (await db
    .prepare(
      `SELECT workspace_id, id FROM artifact_audit_outbox WHERE dispatched_at IS NULL AND action IN (${actionPlaceholders}) ORDER BY created_at, id LIMIT ?`,
    )
    .all(...ARTIFACT_AUDIT_ACTIONS, limit)) as Array<{ workspace_id: string; id: string }>;
}
