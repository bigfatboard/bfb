// ABOUTME: Issues and consumes action-bound passkey step-up proofs for sensitive commands.
// ABOUTME: Stolen, stale, replayed, or boundary-mismatched proofs fail closed.

import type { SqlDatabase } from "@bfb/db";

import { DomainError } from "./hub.js";
import { randomUlid } from "./ids.js";

export interface StepUpAction {
  action: string;
  clientId?: string | undefined;
  resource?: string | undefined;
  workspaceId: string;
  projectId?: string | undefined;
  taskId?: string | undefined;
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
        workspaceId: action.workspaceId,
        projectId: action.projectId ?? null,
        taskId: action.taskId ?? null,
      }),
      JSON.stringify(action.scopes),
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
): Promise<void> {
  const row = (await db
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
  const boundary = JSON.parse(row.boundary_json) as {
    workspaceId: string;
    projectId: string | null;
    taskId: string | null;
  };
  if (boundary.workspaceId !== expected.workspaceId) {
    throw new DomainError("step_up_mismatch", "workspace mismatch");
  }
  if ((boundary.projectId ?? undefined) !== expected.projectId) {
    throw new DomainError("step_up_mismatch", "project mismatch");
  }
  if ((boundary.taskId ?? undefined) !== expected.taskId) {
    throw new DomainError("step_up_mismatch", "task mismatch");
  }
  const scopes = JSON.parse(row.scopes_json) as string[];
  for (const scope of expected.scopes) {
    if (!scopes.includes(scope)) {
      throw new DomainError("step_up_mismatch", "scope not covered by proof");
    }
  }
  await db
    .prepare(`UPDATE passkey_step_up_proofs SET consumed_at = ? WHERE proof_id = ?`)
    .run(nowIso, proofId);
}
