// ABOUTME: Issues audit continuations through the real registered human Hub command in delivery regressions.
// ABOUTME: Test traversal retains the original workspace principal and keeps plaintext handles outside Hub inputs.

import type { SqlDatabase } from "@bfb/db";
import { DomainError, WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { issueSecurityAuditPositionCommand } from "../src/operations.js";
import type { IssueSecurityAuditPosition } from "../src/security-audit-positions.js";
import type { TaskAccessContext } from "../src/task-access.js";

export function auditPositionIssuer(
  db: SqlDatabase,
  access: TaskAccessContext,
): IssueSecurityAuditPosition {
  const hub = new WorkspaceHub(db);
  return async (input) => {
    const outcome = await hub.execute(issueSecurityAuditPositionCommand, {
      workspaceId: access.workspaceId,
      actorHumanId: access.humanId,
      authorizationEpoch: access.authorizationEpoch,
      idempotencyKey: randomUlid(),
      input,
    });
    if (!outcome.ok) throw new DomainError(outcome.error.code, outcome.error.message);
  };
}
