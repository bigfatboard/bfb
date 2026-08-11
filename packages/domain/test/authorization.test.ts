// ABOUTME: Covers C04 workspace role and project grant boundaries with real loadPrincipal.
// ABOUTME: Reviewers use orthogonal project grants; owners and members see all projects.

import { describe, expect, it } from "vitest";

import {
  loadPrincipal,
  assertProjectAccess,
  assertTaskChildAccess,
  bumpMemberEpoch,
} from "../src/authorization.js";
import { DomainError } from "../src/hub.js";
import { createTaskCommand } from "../src/work-commands.js";
import { WorkspaceHub } from "../src/hub.js";
import { FIX } from "../src/fixtures.js";
import { openDomainDb } from "./helpers.js";

describe("workspace authorization", () => {
  it("implements owner/member/reviewer with orthogonal project grants", async () => {
    const db = await openDomainDb();
    const owner = await loadPrincipal(db, FIX.workspace, FIX.owner);
    expect(owner.role).toBe("owner");
    expect(owner.projectIds.sort()).toEqual([FIX.projectA, FIX.projectB].sort());
    const member = await loadPrincipal(db, FIX.workspace, FIX.member);
    expect(member.role).toBe("member");
    expect(member.projectIds.sort()).toEqual([FIX.projectA, FIX.projectB].sort());
    const reviewer = await loadPrincipal(db, FIX.workspace, FIX.reviewer);
    expect(reviewer.role).toBe("reviewer");
    expect(reviewer.projectIds).toEqual([FIX.projectA]);
    expect(() => assertProjectAccess(reviewer, FIX.projectB)).toThrow(DomainError);
  });

  it("authorizes task-child reads from the parent task project grant", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const created = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "authz-task-1",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      now: "2026-08-07T12:00:00Z",
      input: { projectId: FIX.projectB, title: "Beta only", priority: "P2" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const reviewer = await loadPrincipal(db, FIX.workspace, FIX.reviewer);
    await expect(assertTaskChildAccess(db, reviewer, created.result.id)).rejects.toThrow(
      DomainError,
    );
    const owner = await loadPrincipal(db, FIX.workspace, FIX.owner);
    await expect(assertTaskChildAccess(db, owner, created.result.id)).resolves.toBeUndefined();
  });

  it("bumps authorization epoch for revocation", async () => {
    const db = await openDomainDb();
    const next = await bumpMemberEpoch(db, FIX.workspace, FIX.member);
    expect(next).toBe(2);
    const member = await loadPrincipal(db, FIX.workspace, FIX.member);
    expect(member.authorizationEpoch).toBe(2);
  });
});
