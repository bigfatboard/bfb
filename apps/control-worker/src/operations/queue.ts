// ABOUTME: Acknowledges quarantined diagnostic jobs without inspecting or delivering stored inventories.
// ABOUTME: Retention and malformed poison messages retain per-message isolation and retry behavior.

import type { SqlDatabase } from "@bfb/db";
import { DomainError, type DiagnosticBundleRecord, type OpsQueueMessage } from "@bfb/domain";

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
    ...("bundle_id" in message ? { bundle_id: message.bundle_id } : {}),
    attempt: message.attempt,
    error,
  };
}

/** Held jobs acknowledge; retention messages still expire pending diagnostic consent. */
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
    (body.kind !== "diagnostic.upload" && body.kind !== "retention.sweep") ||
    typeof body.workspace_id !== "string" ||
    (body.kind === "diagnostic.upload" && typeof body.bundle_id !== "string")
  ) {
    handle.retry();
    return;
  }
  const message = body as OpsQueueMessage;
  if (message.kind === "retention.sweep") {
    const { runRetentionSweep } = await import("./sweep.js");
    try {
      await runRetentionSweep(deps.db, deps.r2, now);
      handle.ack();
    } catch {
      if (handle.attempts + 1 >= maxAttempts) {
        await deps.sendDlq(dlqCopy(message, "retention_exhausted"));
        handle.ack();
        return;
      }
      handle.retry();
    }
    return;
  }
  handle.ack();
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

export function renderBundleBody(_bundle: DiagnosticBundleRecord): string {
  throw new DomainError("request_rejected", "diagnostic bundles are unavailable");
}
