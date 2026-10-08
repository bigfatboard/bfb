// ABOUTME: Runs notification outbox dispatch and revocation hygiene on the Worker Cron cadence.
// ABOUTME: Each step is isolated; a notification failure never blocks the artifact sweep or commands.

import { adaptD1 } from "@bfb/db";
import { purgeAckedMacosInbox, purgeRevokedNotificationState } from "@bfb/domain";

import { dispatchNotificationOutbox } from "./dispatch.js";

/** Production Cron sweep: dispatch new events, purge revoked state, retain acked inbox rows. */
export async function runNotificationSweep(
  env: { DB: D1Database; NOTIFY_JOBS?: Queue | undefined },
  now: string = new Date().toISOString(),
): Promise<{ sent: number; purgedEndpoints: number; purgedPreferences: number }> {
  const db = adaptD1(env.DB);
  let sent = 0;
  const jobs = env.NOTIFY_JOBS;
  if (jobs) {
    const dispatched = await dispatchNotificationOutbox(
      db,
      async (message) => {
        await jobs.send(message, { contentType: "json" });
      },
      now,
    );
    sent = dispatched.sent;
  }
  let purgedEndpoints = 0;
  let purgedPreferences = 0;
  const workspaces = (await db.prepare(`SELECT id FROM workspaces`).all()) as Array<{ id: string }>;
  for (const workspace of workspaces) {
    const purged = await purgeRevokedNotificationState(db, workspace.id);
    purgedEndpoints += purged.endpoints;
    purgedPreferences += purged.preferences;
    await purgeAckedMacosInbox(db, workspace.id, now);
  }
  return { sent, purgedEndpoints, purgedPreferences };
}
