// ABOUTME: Sends bounded artifact recovery and audit work through jurisdiction-scoped WorkspaceHub commands.
// ABOUTME: Cron scans are read-only; stale candidates never directly mutate artifact business state.

import { createAuthorizationContext, type Jurisdiction, type SqlDatabase } from "@bfb/db";
import {
  ARTIFACT_RECOVERY_SYSTEM_ID,
  dispatchArtifactAuditCommand,
  listAbandonedArtifactUploads,
  listArtifactAuditCandidates,
  markArtifactFailedCommand,
  type CommandRequest,
  type HubCommand,
} from "@bfb/domain";
import { executeWorkspaceCommand } from "../hub-client.js";

async function execute<T, R>(
  db: SqlDatabase,
  namespace: DurableObjectNamespace | undefined,
  workspaceId: string,
  command: HubCommand<T, R>,
  request: Pick<CommandRequest<T>, "input" | "idempotencyKey">,
) {
  const workspace = (await db
    .prepare(`SELECT jurisdiction FROM workspaces WHERE id = ?`)
    .get(workspaceId)) as { jurisdiction: Jurisdiction } | undefined;
  if (!workspace) return null;
  const authorization = createAuthorizationContext({
    workspaceId,
    principalId: ARTIFACT_RECOVERY_SYSTEM_ID,
    authorizationEpoch: 1,
    jurisdiction: workspace.jurisdiction,
  });
  return executeWorkspaceCommand({ db, authorization, workspaceHubNs: namespace }, command, {
    ...request,
    workspaceId,
    actorSystemId: ARTIFACT_RECOVERY_SYSTEM_ID,
    authorizationEpoch: 1,
  });
}

/** Namespace omission is solely the existing unit-test FIFO fallback; production always passes its binding. */
export async function runArtifactSweep(
  db: SqlDatabase,
  now: string,
  workspaceHubNs?: DurableObjectNamespace,
): Promise<{ marked: string[] }> {
  const candidates = await listAbandonedArtifactUploads(db, now, { limit: 50 });
  const marked: string[] = [];
  for (const candidate of candidates) {
    const outcome = await execute(
      db,
      workspaceHubNs,
      candidate.workspace_id,
      markArtifactFailedCommand,
      { input: { versionId: candidate.id }, idempotencyKey: `artifact-expire:${candidate.id}` },
    );
    if (outcome?.ok && !outcome.replayed) marked.push(candidate.id);
  }
  return { marked };
}

/** A bounded failure remains undispatched and is retried on a later Cron tick. */
export async function runArtifactAuditDispatch(
  db: SqlDatabase,
  workspaceHubNs?: DurableObjectNamespace,
): Promise<{ dispatched: number }> {
  const candidates = await listArtifactAuditCandidates(db, 100);
  let dispatched = 0;
  for (const candidate of candidates) {
    const outcome = await execute(
      db,
      workspaceHubNs,
      candidate.workspace_id,
      dispatchArtifactAuditCommand,
      { input: { outboxId: candidate.id }, idempotencyKey: `artifact-audit:${candidate.id}` },
    );
    if (outcome?.ok && !outcome.replayed) dispatched++;
  }
  return { dispatched };
}
