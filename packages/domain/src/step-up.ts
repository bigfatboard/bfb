// ABOUTME: Issues and consumes action-bound passkey step-up proofs for sensitive commands.
// ABOUTME: Stolen, stale, replayed, or boundary-mismatched proofs fail closed.

import type { SqlDatabase } from "@bfb/db";

import { DomainError } from "./hub.js";
import { randomUlid } from "./ids.js";

/** Maximum step-up proof lifetime from issuance (seconds). */
export const STEP_UP_MAX_TTL_SECONDS = 15 * 60;

export interface StepUpAction {
  action: string;
  clientId?: string | undefined;
  resource?: string | undefined;
  workspaceId?: string | undefined;
  projectId?: string | undefined;
  taskId?: string | undefined;
  targetId?: string | undefined;
  scopes: string[];
  authorizationEpoch: number;
  expiresAt: string;
}

export async function issueStepUpProof(
  db: SqlDatabase,
  humanId: string,
  action: StepUpAction,
  nowIso: string,
): Promise<string> {
  if (!humanId) {
    throw new DomainError("step_up_unauthenticated", "human required for step-up proof");
  }
  const now = Date.parse(nowIso);
  const expires = Date.parse(action.expiresAt);
  if (Number.isNaN(now) || Number.isNaN(expires)) {
    throw new DomainError("step_up_invalid", "invalid proof timestamps");
  }
  if (expires <= now) {
    throw new DomainError("step_up_invalid", "proof expiry must be in the future");
  }
  if (expires - now > STEP_UP_MAX_TTL_SECONDS * 1000) {
    throw new DomainError("step_up_invalid", "proof expiry exceeds maximum bound");
  }
  const proofId = randomUlid();
  await db
    .prepare(
      `INSERT INTO passkey_step_up_proofs (
      proof_id, human_id, action, client_id, resource, boundary_json, scopes_json,
      authorization_epoch, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      proofId,
      humanId,
      action.action,
      action.clientId ?? null,
      action.resource ?? null,
      JSON.stringify({
        workspaceId: action.workspaceId ?? null,
        projectId: action.projectId ?? null,
        taskId: action.taskId ?? null,
        targetId: action.targetId ?? null,
      }),
      JSON.stringify([...action.scopes].sort()),
      action.authorizationEpoch,
      action.expiresAt,
      nowIso,
    );
  return proofId;
}

export async function consumeStepUpProof(
  db: SqlDatabase,
  proofId: string,
  expected: StepUpAction,
  nowIso: string,
  humanId?: string,
  onConsumed?: ((tx: SqlDatabase, consumptionStamp: string) => Promise<void>) | undefined,
): Promise<void> {
  // Unique per-attempt stamp lets concurrent D1 batch consumers identify the
  // conditional UPDATE winner without relying on a pre-commit change count.
  const consumeStamp = `${nowIso}#${randomUlid()}`;
  await db.withTransaction(async (tx) => {
    const row = (await tx
      .prepare(`SELECT * FROM passkey_step_up_proofs WHERE proof_id = ?`)
      .get(proofId)) as
      | {
          human_id: string;
          action: string;
          client_id: string | null;
          resource: string | null;
          boundary_json: string;
          scopes_json: string;
          authorization_epoch: number;
          expires_at: string;
          consumed_at: string | null;
        }
      | undefined;
    if (!row) {
      throw new DomainError("step_up_invalid", "proof not found");
    }
    if (row.consumed_at) {
      throw new DomainError("step_up_replayed", "proof already consumed");
    }
    if (Date.parse(row.expires_at) <= Date.parse(nowIso)) {
      throw new DomainError("step_up_stale", "proof expired");
    }
    if (humanId && row.human_id !== humanId) {
      throw new DomainError("step_up_mismatch", "human mismatch");
    }
    if (row.action !== expected.action) {
      throw new DomainError("step_up_mismatch", "action mismatch");
    }
    if ((row.client_id ?? undefined) !== expected.clientId) {
      throw new DomainError("step_up_mismatch", "client mismatch");
    }
    if ((row.resource ?? undefined) !== expected.resource) {
      throw new DomainError("step_up_mismatch", "resource mismatch");
    }
    if (row.authorization_epoch !== expected.authorizationEpoch) {
      throw new DomainError("step_up_mismatch", "epoch mismatch");
    }
    if (row.expires_at !== expected.expiresAt) {
      throw new DomainError("step_up_mismatch", "expiry mismatch");
    }
    const boundary = JSON.parse(row.boundary_json) as {
      workspaceId: string | null;
      projectId: string | null;
      taskId: string | null;
      targetId?: string | null;
    };
    if ((boundary.workspaceId ?? undefined) !== expected.workspaceId) {
      throw new DomainError("step_up_mismatch", "workspace mismatch");
    }
    if ((boundary.projectId ?? undefined) !== expected.projectId) {
      throw new DomainError("step_up_mismatch", "project mismatch");
    }
    if ((boundary.taskId ?? undefined) !== expected.taskId) {
      throw new DomainError("step_up_mismatch", "task mismatch");
    }
    if ((boundary.targetId ?? undefined) !== expected.targetId) {
      throw new DomainError("step_up_mismatch", "target mismatch");
    }
    const scopes = JSON.parse(row.scopes_json) as string[];
    if (JSON.stringify(scopes) !== JSON.stringify([...expected.scopes].sort())) {
      throw new DomainError("step_up_mismatch", "scope mismatch");
    }
    // Unique stamp so concurrent D1 batch consumers can detect which UPDATE won.
    // Only the winner's stamp is visible post-commit; losers fail closed.
    await tx
      .prepare(
        `UPDATE passkey_step_up_proofs
         SET consumed_at = ?
         WHERE proof_id = ? AND consumed_at IS NULL`,
      )
      .run(consumeStamp, proofId);
    await onConsumed?.(tx, consumeStamp);
  });
  // Post-commit ownership check works for interactive sqlite TX and D1 batch flush.
  const after = (await db
    .prepare(`SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id = ?`)
    .get(proofId)) as { consumed_at: string | null } | undefined;
  if (after?.consumed_at !== consumeStamp) {
    throw new DomainError("step_up_replayed", "proof already consumed");
  }
}
