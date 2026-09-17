// ABOUTME: Dispatches newly committed actionable events to the notification queue exactly once per cursor.
// ABOUTME: Sends carry stable job IDs over an idempotent consumer, so redelivery converges safely.

import type { SqlDatabase } from "@bfb/db";
import { notificationJobId, selectNotificationEvent } from "@bfb/domain";

import type { NotifyMessage } from "./queue.js";

const DISPATCH_BATCH_LIMIT = 100;

/**
 * Scans semantic events past the per-workspace watermark and sends one
 * message per actionable event. The watermark advances only past scanned
 * rows; a crash between send and advance converges by idempotent redelivery.
 */
export async function dispatchNotificationOutbox(
  db: SqlDatabase,
  send: (message: NotifyMessage) => Promise<void>,
  now: string,
  limit = DISPATCH_BATCH_LIMIT,
): Promise<{ workspaces: number; scanned: number; sent: number }> {
  const bounded = Number.isSafeInteger(limit) && limit >= 1 && limit <= 500 ? limit : DISPATCH_BATCH_LIMIT;
  const workspaces = (await db
    .prepare(`SELECT id FROM workspaces ORDER BY id ASC LIMIT 1000`)
    .all()) as Array<{ id: string }>;
  let scanned = 0;
  let sent = 0;
  for (const workspace of workspaces) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO notification_dispatch_state (workspace_id, last_cursor, updated_at)
         VALUES (?, 0, ?)`,
      )
      .run(workspace.id, now);
    const state = (await db
      .prepare(
        `SELECT last_cursor FROM notification_dispatch_state WHERE workspace_id = ?`,
      )
      .get(workspace.id)) as { last_cursor: number };
    const rows = (await db
      .prepare(
        `SELECT workspace_cursor, kind, payload_json FROM semantic_events
         WHERE workspace_id = ? AND workspace_cursor > ?
         ORDER BY workspace_cursor ASC LIMIT ?`,
      )
      .all(workspace.id, state.last_cursor, bounded)) as Array<{
      workspace_cursor: number;
      kind: string;
      payload_json: string;
    }>;
    let advanced = state.last_cursor;
    for (const row of rows) {
      scanned += 1;
      let payload: unknown = null;
      try {
        payload = JSON.parse(row.payload_json) as unknown;
      } catch {
        payload = null;
      }
      const selected = payload ? selectNotificationEvent(row.kind, payload) : null;
      if (selected) {
        const message: NotifyMessage = {
          schema_version: 1,
          job_id: notificationJobId(workspace.id, row.workspace_cursor),
          workspace_id: workspace.id,
          event_cursor: row.workspace_cursor,
          event_kind: row.kind,
        };
        await send(message);
        sent += 1;
      }
      advanced = row.workspace_cursor;
    }
    if (advanced !== state.last_cursor) {
      await db
        .prepare(
          `UPDATE notification_dispatch_state SET last_cursor = ?, updated_at = ?
           WHERE workspace_id = ?`,
        )
        .run(advanced, now, workspace.id);
    }
  }
  return { workspaces: workspaces.length, scanned, sent };
}
