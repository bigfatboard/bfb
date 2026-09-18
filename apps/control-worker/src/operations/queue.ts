// ABOUTME: Consumes consented diagnostic-upload jobs with per-message isolation.
// ABOUTME: Poison jobs land in visible bundle state plus the OPS DLQ without replaying siblings.

import type { SqlDatabase } from "@bfb/db";
import {
  diagnosticR2Key,
  scanDiagnosticText,
  type DiagnosticBundleRecord,
  type OpsQueueMessage,
} from "@bfb/domain";

export interface OpsQueueDeps {
  db: SqlDatabase;
  r2: { put(key: string, body: string): Promise<unknown>; delete(key: string): Promise<unknown> };
  sendDlq: (copy: Record<string, unknown>) => Promise<void>;
  maxAttempts?: number;
}

export interface OpsQueueHandle {
  body: unknown;
  attempts: number;
  ack: () => void;
  retry: (options?: { delaySeconds?: number }) => void;
}

function dlqCopy(message: OpsQueueMessage, error: string): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: message.kind,
    workspace_id: message.workspace_id,
    bundle_id: message.bundle_id,
    attempt: message.attempt,
    error,
  };
}

async function markBundle(
  db: SqlDatabase,
  workspaceId: string,
  bundleId: string,
  state: "uploaded" | "failed",
  fields: { r2Key?: string; error?: string; now: string },
): Promise<void> {
  if (state === "uploaded") {
    await db
      .prepare(
        `UPDATE diagnostic_bundles SET state = 'uploaded', uploaded_at = ?, r2_key = ?, last_error = NULL
         WHERE workspace_id = ? AND id = ? AND state = 'consented'`,
      )
      .run(fields.now, fields.r2Key ?? null, workspaceId, bundleId);
    return;
  }
  await db
    .prepare(
      `UPDATE diagnostic_bundles SET state = 'failed', last_error = ?
         WHERE workspace_id = ? AND id = ? AND state = 'consented'`,
    )
    .run((fields.error ?? "upload_failed").slice(0, 128), workspaceId, bundleId);
}

/**
 * Uploads one consented bundle to the workspace diagnostics prefix. The body
 * is the stored redacted inventory re-scanned before every write; anything
 * failing the scan parks the bundle without an upload.
 */
export async function consumeOpsQueueMessage(
  handle: OpsQueueHandle,
  deps: OpsQueueDeps,
  now: string = new Date().toISOString(),
): Promise<void> {
  const maxAttempts = deps.maxAttempts ?? 5;
  const body = handle.body as Partial<OpsQueueMessage>;
  if (
    !body ||
    body.schema_version !== 1 ||
    body.kind !== "diagnostic.upload" ||
    typeof body.workspace_id !== "string" ||
    typeof body.bundle_id !== "string"
  ) {
    handle.retry();
    return;
  }
  const message = body as OpsQueueMessage;
  const bundle = (await deps.db
    .prepare(`SELECT * FROM diagnostic_bundles WHERE workspace_id = ? AND id = ?`)
    .get(message.workspace_id, message.bundle_id)) as DiagnosticBundleRecord | undefined;
  if (!bundle) {
    await deps.sendDlq(dlqCopy(message, "unknown_bundle"));
    handle.ack();
    return;
  }
  if (bundle.state === "uploaded") {
    handle.ack();
    return;
  }
  if (bundle.state !== "consented") {
    await deps.sendDlq(dlqCopy(message, `bundle_state_${bundle.state}`));
    handle.ack();
    return;
  }
  if (scanDiagnosticText(bundle.inventory_json).length > 0) {
    await markBundle(deps.db, message.workspace_id, message.bundle_id, "failed", { error: "redaction_failed", now });
    await deps.sendDlq(dlqCopy(message, "redaction_failed"));
    handle.ack();
    return;
  }
  try {
    const key = diagnosticR2Key(message.workspace_id, message.bundle_id);
    await deps.r2.put(key, bundle.inventory_json);
    await markBundle(deps.db, message.workspace_id, message.bundle_id, "uploaded", { r2Key: key, now });
    handle.ack();
  } catch {
    if (handle.attempts + 1 >= maxAttempts) {
      await markBundle(deps.db, message.workspace_id, message.bundle_id, "failed", { error: "upload_exhausted", now });
      await deps.sendDlq(dlqCopy(message, "upload_exhausted"));
      handle.ack();
      return;
    }
    handle.retry();
  }
}

/** Per-message isolation: one poison job never replays successful siblings. */
export async function consumeOpsQueueBatch(
  handles: OpsQueueHandle[],
  deps: OpsQueueDeps,
  now: string = new Date().toISOString(),
): Promise<void> {
  for (const handle of handles) {
    try {
      await consumeOpsQueueMessage(handle, deps, now);
    } catch {
      try {
        handle.retry();
      } catch {
        // The platform redelivers an unacknowledged message on handler throw.
      }
    }
  }
}

export function renderBundleBody(bundle: DiagnosticBundleRecord): string {
  return bundle.inventory_json;
}
