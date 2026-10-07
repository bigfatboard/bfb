// ABOUTME: Assigns immutable random recipient identities to notification delivery records.
// ABOUTME: Legacy repair is a bounded system-only Hub command that preserves source and lifecycle metadata.

import { createHash, randomBytes } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";

import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, syntheticUlid } from "./ids.js";

export const NOTIFICATION_IDENTITY_SYSTEM_ID = syntheticUlid("NOTIFICATIONIDENTITY");

export type EnsureNotificationIdentities = (deliveryIds: readonly string[]) => Promise<void>;

/** The entire 128-bit value is random; the encoding carries no timestamp or source input. */
export function createNotificationPublicId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = BigInt(`0x${randomBytes(16).toString("hex")}`);
  let result = "";
  for (let index = 0; index < 26; index += 1) {
    result = alphabet[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}

function rejectIdentityRequest(): never {
  throw new DomainError("request_rejected", "notification identities are unavailable");
}

function validateInput(input: { deliveryIds: string[] }): string[] {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !Array.isArray(input.deliveryIds) ||
    input.deliveryIds.length < 1 ||
    input.deliveryIds.length > 100 ||
    input.deliveryIds.some((id) => typeof id !== "string" || id.length !== 26 || !isUlid(id)) ||
    new Set(input.deliveryIds).size !== input.deliveryIds.length
  )
    rejectIdentityRequest();
  return [...input.deliveryIds].sort();
}

function authorizeIdentityRequest(input: { deliveryIds: string[] }, ctx: HubContext): void {
  if (
    ctx.actorSystemId !== NOTIFICATION_IDENTITY_SYSTEM_ID ||
    ctx.actorHumanId ||
    ctx.actorRunnerId ||
    ctx.actorDelegationId ||
    ctx.authorizationEpoch !== 1
  )
    rejectIdentityRequest();
  validateInput(input);
}

export const ensureNotificationPublicIdsCommand: HubCommand<
  { deliveryIds: string[] },
  { selected: number }
> = {
  name: "notification.public_ids.ensure",
  authorize: async (input, ctx) => authorizeIdentityRequest(input, ctx),
  inputFingerprint: (input) =>
    createHash("sha256")
      .update(JSON.stringify(validateInput(input)))
      .digest("hex"),
  auditInput: (input) => ({ requested: input.deliveryIds.length }),
  auditResult: (result) => ({ selected: result.selected }),
  async run(input, ctx) {
    authorizeIdentityRequest(input, ctx);
    const rows = (await ctx.db
      .prepare(
        `SELECT delivery_id FROM notification_deliveries
         WHERE workspace_id = ? AND public_id IS NULL
           AND delivery_id IN (SELECT value FROM json_each(?))
         ORDER BY delivery_id`,
      )
      .all(ctx.workspaceId, JSON.stringify(validateInput(input)))) as Array<{
      delivery_id: string;
    }>;
    const assignments = rows.map((row) => ({ ...row, publicId: createNotificationPublicId() }));
    // All source reads precede queued writes in the production D1 transaction.
    // A concurrent assignment wins its CAS; no identity or bookkeeping is rewritten.
    for (const assignment of assignments) {
      await ctx.db
        .prepare(
          `UPDATE notification_deliveries SET public_id = ?
           WHERE workspace_id = ? AND delivery_id = ? AND public_id IS NULL`,
        )
        .run(assignment.publicId, ctx.workspaceId, assignment.delivery_id);
    }
    return { selected: assignments.length };
  },
};

/** Read-only resumable maintenance scan, including pending, terminal and historical rows. */
export async function listNotificationIdentityCandidates(
  db: SqlDatabase,
  limit = 100,
): Promise<Array<{ workspace_id: string; delivery_id: string }>> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) rejectIdentityRequest();
  return (await db
    .prepare(
      `SELECT workspace_id, delivery_id FROM notification_deliveries
       WHERE public_id IS NULL ORDER BY workspace_id, delivery_id LIMIT ?`,
    )
    .all(limit)) as Array<{ workspace_id: string; delivery_id: string }>;
}
