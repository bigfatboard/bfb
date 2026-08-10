// ABOUTME: Covers C03 action-bound step-up proof issue/consume negatives.
// ABOUTME: Stolen/stale/replayed/cross-boundary proofs fail through consumeStepUpProof.

import { describe, expect, it } from "vitest";

import { DomainError } from "../src/hub.js";
import { issueStepUpProof, consumeStepUpProof } from "../src/step-up.js";
import { FIX } from "../src/fixtures.js";
import { openDomainDb } from "./helpers.js";

describe("passkey step-up", () => {
  const action = {
    action: "oauth.delegation.create",
    clientId: FIX.client,
    resource: "https://bfb.example.test/mcp",
    workspaceId: FIX.workspace,
    projectId: FIX.projectA,
    scopes: ["bfb:read", "bfb:task:write"],
    authorizationEpoch: 1,
    expiresAt: "2026-08-07T13:00:00Z",
  };

  it("consumes a fresh matching proof once", () => {
    const db = openDomainDb();
    const proofId = issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    consumeStepUpProof(db, proofId, action, "2026-08-07T12:01:00Z");
    expect(() => consumeStepUpProof(db, proofId, action, "2026-08-07T12:02:00Z")).toThrow(
      /already consumed/,
    );
  });

  it("rejects stale and mismatched proofs", () => {
    const db = openDomainDb();
    const proofId = issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    expect(() => consumeStepUpProof(db, proofId, action, "2026-08-07T14:00:00Z")).toThrow(
      DomainError,
    );
    const other = issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    expect(() =>
      consumeStepUpProof(
        db,
        other,
        { ...action, clientId: "other-client" },
        "2026-08-07T12:01:00Z",
      ),
    ).toThrow(/client mismatch/);
    const wide = issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    expect(() =>
      consumeStepUpProof(
        db,
        wide,
        { ...action, scopes: ["bfb:read", "bfb:task:write", "bfb:admin"] },
        "2026-08-07T12:01:00Z",
      ),
    ).toThrow(/scope/);
  });
});
