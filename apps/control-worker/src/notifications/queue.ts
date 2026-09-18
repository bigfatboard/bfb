// ABOUTME: Consumes notification event messages with per-message isolation and visible DLQ state.
// ABOUTME: Retries stay idempotent on stable delivery IDs; poison lands in D1 plus the DLQ binding.

import type { SqlDatabase } from "@bfb/db";
import {
  buildPushPayload,
  deletePushEndpoint,
  fanoutNotificationEvent,
  loadPushAttempt,
  NOTIFICATION_QUEUE_MAX_ATTEMPTS,
  notificationJobId,
  recordDeliveryOutcome,
  type DeliveryOutcome,
} from "@bfb/domain";

import { PUSH_TTL_SECONDS, sendPushMessage, type VapidSecrets } from "./push.js";

export interface NotifyQueueDeps {
  db: SqlDatabase;
  sendDlq: (copy: DlqCopy) => Promise<void>;
  appOrigin: string;
  vapid: VapidSecrets | null;
}

export interface NotifyMessage {
  schema_version: 1;
  job_id: string;
  workspace_id: string;
  event_cursor: number;
  event_kind: string;
}

export interface DlqCopy {
  schema_version: 1;
  job_id: string;
  workspace_id: string;
  event_cursor: number;
  delivery_id: string;
  channel: string;
  category: string;
  attempts: number;
  code: string;
}

function readMessage(body: unknown): NotifyMessage | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "event_cursor,event_kind,job_id,schema_version,workspace_id") return null;
  if (
    record.schema_version !== 1 ||
    typeof record.job_id !== "string" ||
    typeof record.workspace_id !== "string" ||
    !Number.isSafeInteger(record.event_cursor) ||
    (record.event_cursor as number) < 1 ||
    typeof record.event_kind !== "string" ||
    (record.event_kind as string).length < 1 ||
    (record.event_kind as string).length > 64
  ) {
    return null;
  }
  return body as NotifyMessage;
}

async function sendDlqCopy(deps: NotifyQueueDeps, copy: DlqCopy): Promise<void> {
  try {
    await deps.sendDlq(copy);
  } catch {
    // The D1 dead_lettered row is the durable record; the DLQ copy is monitoring.
  }
}

/**
 * Handles one queue message: fan-out (idempotent), push attempts with fresh
 * access rechecks, bounded retry, and visible dead-lettering. Never throws
 * for a well-formed message: every outcome ends in an explicit ack/retry.
 */
export async function handleNotifyMessage(
  message: { body: NotifyMessage; attempts: number; ack: () => void; retry: () => void },
  deps: NotifyQueueDeps,
  now: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const db = deps.db;
  const body = message.body;
  if (
    body.job_id !== notificationJobId(body.workspace_id, body.event_cursor) ||
    body.event_kind.length === 0
  ) {
    message.ack();
    return;
  }
  const fanout = await fanoutNotificationEvent(db, {
    workspaceId: body.workspace_id,
    eventCursor: body.event_cursor,
    eventKind: body.event_kind,
    now,
  });
  if (fanout.status !== "notified") {
    message.ack();
    return;
  }
  const pending = (await db
    .prepare(
      `SELECT delivery_id FROM notification_deliveries
       WHERE workspace_id = ? AND event_cursor = ? AND channel = 'browser_push' AND state = 'pending'
       ORDER BY delivery_id ASC LIMIT 500`,
    )
    .all(body.workspace_id, body.event_cursor)) as Array<{ delivery_id: string }>;
  let needsRetry = false;
  const exhausted = message.attempts >= NOTIFICATION_QUEUE_MAX_ATTEMPTS;
  for (const row of pending) {
    const loaded = await loadPushAttempt(db, {
      workspaceId: body.workspace_id,
      deliveryId: row.delivery_id,
    });
    if (!loaded.ok) {
      await recordDeliveryOutcome(db, {
        workspaceId: body.workspace_id,
        deliveryId: row.delivery_id,
        outcome: loaded.outcome,
        now,
      });
      continue;
    }
    const secrets = deps.vapid;
    if (!secrets) {
      await recordDeliveryOutcome(db, {
        workspaceId: body.workspace_id,
        deliveryId: row.delivery_id,
        outcome: { terminal: true, state: "failed", code: "push_unconfigured" },
        now,
      });
      continue;
    }
    const payload = buildPushPayload({
      appOrigin: deps.appOrigin,
      workspaceId: body.workspace_id,
      subject: loaded.subject,
      category: loaded.delivery.category,
      deliveryId: row.delivery_id,
      eventCursor: body.event_cursor,
    });
    let status: number;
    try {
      const sent = await sendPushMessage(
        {
          endpoint: loaded.endpoint,
          p256dh: loaded.p256dh,
          auth: loaded.auth,
          plaintext: new TextEncoder().encode(JSON.stringify(payload)),
          vapid: secrets,
          ttlSeconds: PUSH_TTL_SECONDS,
          nowMs: Date.parse(now),
        },
        fetchImpl,
      );
      status = sent.status;
    } catch {
      status = 0;
    }
    if (status === 200 || status === 201) {
      await recordDeliveryOutcome(db, {
        workspaceId: body.workspace_id,
        deliveryId: row.delivery_id,
        outcome: { terminal: true, state: "delivered", code: "sent" },
        now,
      });
      continue;
    }
    if (status === 404 || status === 410) {
      await deletePushEndpoint(db, body.workspace_id, loaded.delivery.human_id);
      await recordDeliveryOutcome(db, {
        workspaceId: body.workspace_id,
        deliveryId: row.delivery_id,
        outcome: { terminal: true, state: "failed", code: "endpoint_expired" },
        now,
      });
      continue;
    }
    const code = status === 0 ? "network_error" : `push_status_${status}`;
    if (exhausted) {
      const outcome: DeliveryOutcome = { terminal: true, state: "dead_lettered", code };
      await recordDeliveryOutcome(db, {
        workspaceId: body.workspace_id,
        deliveryId: row.delivery_id,
        outcome,
        now,
      });
      await sendDlqCopy(deps, {
        schema_version: 1,
        job_id: body.job_id,
        workspace_id: body.workspace_id,
        event_cursor: body.event_cursor,
        delivery_id: row.delivery_id,
        channel: "browser_push",
        category: loaded.delivery.category,
        attempts: message.attempts,
        code,
      });
      continue;
    }
    await recordDeliveryOutcome(db, {
      workspaceId: body.workspace_id,
      deliveryId: row.delivery_id,
      outcome: { terminal: false, code },
      now,
    });
    needsRetry = true;
  }
  if (needsRetry) {
    message.retry();
  } else {
    message.ack();
  }
}

/** Queue entrypoint: isolates every message so one poison batch never replays successes. */
export async function handleNotifyQueue(
  batch: MessageBatch<NotifyMessage>,
  deps: NotifyQueueDeps,
  now: string = new Date().toISOString(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const body = readMessage(message.body);
      if (!body) {
        message.ack();
        continue;
      }
      await handleNotifyMessage(
        {
          body,
          attempts: message.attempts,
          ack: () => message.ack(),
          retry: () => message.retry(),
        },
        deps,
        now,
        fetchImpl,
      );
    } catch {
      // A single message must never replay the whole batch: retry it alone.
      try {
        message.retry();
      } catch {
        /* The runtime redelivers unhandled messages per consumer config. */
      }
    }
  }
}
