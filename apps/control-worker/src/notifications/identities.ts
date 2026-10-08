// ABOUTME: Assigns missing recipient notification identities through the workspace command lane.
// ABOUTME: Bounded legacy scans preserve internal dedupe keys and never contact a recipient.

import { randomUUID } from "node:crypto";

import { createAuthorizationContext, type Jurisdiction, type SqlDatabase } from "@bfb/db";
import {
  DomainError,
  ensureNotificationPublicIdsCommand,
  isUlid,
  listNotificationIdentityCandidates,
  NOTIFICATION_IDENTITY_SYSTEM_ID,
} from "@bfb/domain";

import { executeWorkspaceCommand } from "../hub-client.js";

/** Production callers supply the Hub binding; omission is the existing unit-test FIFO fallback. */
export async function ensureNotificationIdentities(
  db: SqlDatabase,
  workspaceId: string,
  deliveryIds: readonly string[],
  workspaceHubNs?: DurableObjectNamespace,
): Promise<void> {
  if (
    workspaceId.length !== 26 ||
    !isUlid(workspaceId) ||
    deliveryIds.length > 500 ||
    deliveryIds.some((id) => id.length !== 26 || !isUlid(id)) ||
    new Set(deliveryIds).size !== deliveryIds.length
  ) {
    throw new DomainError("request_rejected", "request rejected");
  }
  if (deliveryIds.length === 0) return;
  const workspace = (await db
    .prepare("SELECT jurisdiction FROM workspaces WHERE id = ?")
    .get(workspaceId)) as { jurisdiction: Jurisdiction } | undefined;
  if (!workspace) throw new DomainError("request_rejected", "request rejected");
  const authorization = createAuthorizationContext({
    workspaceId,
    principalId: NOTIFICATION_IDENTITY_SYSTEM_ID,
    authorizationEpoch: 1,
    jurisdiction: workspace.jurisdiction,
  });
  for (let offset = 0; offset < deliveryIds.length; offset += 100) {
    const batch = deliveryIds.slice(offset, offset + 100);
    const missing = (await db
      .prepare(
        `SELECT delivery_id FROM notification_deliveries
         WHERE workspace_id = ? AND public_id IS NULL
           AND delivery_id IN (SELECT value FROM json_each(?))
         ORDER BY delivery_id`,
      )
      .all(workspaceId, JSON.stringify(batch))) as Array<{ delivery_id: string }>;
    if (missing.length === 0) continue;
    const outcome = await executeWorkspaceCommand(
      { db, authorization, workspaceHubNs },
      ensureNotificationPublicIdsCommand,
      {
        workspaceId,
        actorSystemId: NOTIFICATION_IDENTITY_SYSTEM_ID,
        authorizationEpoch: 1,
        // A new maintenance request must not reuse a stale no-op receipt if a
        // legacy producer has recreated the logical row since an earlier scan.
        idempotencyKey: `notification-identities:${randomUUID()}`,
        input: { deliveryIds: missing.map((row) => row.delivery_id) },
      },
    );
    if (!outcome.ok) throw new DomainError("request_rejected", "request rejected");
  }
}

/** The next tick resumes at remaining NULL rows, across every historical delivery state. */
export async function runNotificationIdentitySweep(
  db: SqlDatabase,
  workspaceHubNs?: DurableObjectNamespace,
): Promise<void> {
  const candidates = await listNotificationIdentityCandidates(db, 100);
  const workspaces = new Map<string, string[]>();
  for (const candidate of candidates) {
    const ids = workspaces.get(candidate.workspace_id) ?? [];
    ids.push(candidate.delivery_id);
    workspaces.set(candidate.workspace_id, ids);
  }
  for (const [workspaceId, deliveryIds] of workspaces) {
    await ensureNotificationIdentities(db, workspaceId, deliveryIds, workspaceHubNs);
  }
}
