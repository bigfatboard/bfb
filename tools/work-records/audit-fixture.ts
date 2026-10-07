// ABOUTME: Traverses real opaque audit positions for synthetic acceptance-fixture assertions.
// ABOUTME: Audit IDs identify returned business records and never enter the public pagination input.

import assert from "node:assert/strict";
import type { SqlDatabase } from "@bfb/db";
import {
  readSecurityAudit,
  type IssueSecurityAuditPosition,
  type SecurityAuditEntry,
  type TaskAccessContext,
} from "@bfb/domain";

/** A fixed one-record page size lets fixtures locate an observed business receipt. */
export async function auditPositionAfter(
  db: SqlDatabase,
  workspaceId: string,
  access: TaskAccessContext,
  auditId: string,
  issue: IssueSecurityAuditPosition,
): Promise<string> {
  let after: string | undefined;
  const seen = new Set<string>();
  for (let pages = 0; pages < 500; pages += 1) {
    const page = await readSecurityAudit(
      db,
      workspaceId,
      { access, limit: 1, ...(after === undefined ? {} : { after }) },
      issue,
    );
    assert.equal(page.entries.length, 1, "synthetic audit marker must be a visible receipt");
    assert.equal(
      page.has_more,
      page.next_cursor !== null,
      "opaque continuation must agree with has_more",
    );
    assert(!seen.has(page.entries[0]!.audit_id), "opaque traversal must not repeat a receipt");
    seen.add(page.entries[0]!.audit_id);
    if (page.entries[0]!.audit_id === auditId) {
      assert(page.next_cursor, "the marker must have a visible continuation");
      return page.next_cursor;
    }
    assert(page.next_cursor, "synthetic audit marker must occur before the terminal page");
    after = page.next_cursor;
  }
  throw new Error("synthetic audit traversal exceeded its bounded fixture size");
}

/** Aggregates returned business rows after a marker using only issued, fixed-size positions. */
export async function readAuditSegment(
  db: SqlDatabase,
  workspaceId: string,
  options: { access: TaskAccessContext; marker: string; limit: number },
  issue: IssueSecurityAuditPosition,
): Promise<{ entries: SecurityAuditEntry[]; has_more: boolean; next_cursor: string | null }> {
  let after = await auditPositionAfter(db, workspaceId, options.access, options.marker, issue);
  const entries: SecurityAuditEntry[] = [];
  for (let pages = 0; pages < options.limit; pages += 1) {
    const page = await readSecurityAudit(
      db,
      workspaceId,
      { access: options.access, limit: 1, after },
      issue,
    );
    entries.push(...page.entries);
    assert.equal(
      page.has_more,
      page.next_cursor !== null,
      "opaque continuation must agree with has_more",
    );
    if (!page.next_cursor) return { entries, has_more: false, next_cursor: null };
    after = page.next_cursor;
  }
  return { entries, has_more: true, next_cursor: after };
}
