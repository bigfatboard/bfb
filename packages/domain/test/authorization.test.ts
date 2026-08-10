// ABOUTME: Covers C04 workspace role and project grant boundaries with real loadPrincipal.
// ABOUTME: Restricted members cannot see ungranted projects; owners can.

import { describe, expect, it } from "vitest";

import { loadPrincipal, assertProjectAccess, bumpMemberEpoch } from "../src/authorization.js";
import { DomainError } from "../src/hub.js";
import { FIX } from "../src/fixtures.js";
import { openDomainDb } from "./helpers.js";

describe("workspace authorization", () => {
  it("gives owners all projects and restricts restricted members", async () => {
    const db = await openDomainDb();
    const owner = await loadPrincipal(db, FIX.workspace, FIX.owner);
    expect(owner.projectIds.sort()).toEqual([FIX.projectA, FIX.projectB].sort());
    const restricted = await loadPrincipal(db, FIX.workspace, FIX.restricted);
    expect(restricted.projectIds).toEqual([FIX.projectA]);
    expect(() => assertProjectAccess(restricted, FIX.projectB)).toThrow(DomainError);
  });

  it("bumps authorization epoch for revocation", async () => {
    const db = await openDomainDb();
    const next = await bumpMemberEpoch(db, FIX.workspace, FIX.member);
    expect(next).toBe(2);
    const member = await loadPrincipal(db, FIX.workspace, FIX.member);
    expect(member.authorizationEpoch).toBe(2);
  });
});
