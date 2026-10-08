// ABOUTME: Covers C03 action-bound step-up proof issue/consume negatives.
// ABOUTME: Stolen/stale/replayed/cross-boundary proofs fail through consumeStepUpProof.

import { describe, expect, it } from "vitest";

import { DomainError } from "../src/hub.js";
import { issueStepUpProof, consumeStepUpProof, STEP_UP_MAX_TTL_SECONDS } from "../src/step-up.js";
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
    expiresAt: "2026-08-07T12:10:00Z",
  };

  it("consumes a fresh matching proof once", async () => {
    const db = await openDomainDb();
    const proofId = await issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    await consumeStepUpProof(db, proofId, action, "2026-08-07T12:01:00Z", FIX.owner);
    await expect(
      consumeStepUpProof(db, proofId, action, "2026-08-07T12:02:00Z", FIX.owner),
    ).rejects.toThrow(/already consumed/);
  });

  it("rejects a proof before its server-issued timestamp", async () => {
    const db = await openDomainDb();
    const proof = await issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:01:00Z");
    await expect(
      consumeStepUpProof(db, proof, action, "2026-08-07T12:00:00Z", FIX.owner),
    ).rejects.toThrow(/time boundary/);
  });

  it("allows only one winner under concurrent consume races", async () => {
    const db = await openDomainDb();
    const proofId = await issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    const results = await Promise.allSettled(
      [0, 1, 2, 3, 4].map(() =>
        consumeStepUpProof(db, proofId, action, "2026-08-07T12:01:00Z", FIX.owner),
      ),
    );
    const wins = results.filter((result) => result.status === "fulfilled").length;
    const losses = results.filter((result) => result.status === "rejected").length;
    expect(wins).toBe(1);
    expect(losses).toBe(4);
  });

  it("rejects stale, mismatched, wrong-human, and over-max-ttl proofs", async () => {
    const db = await openDomainDb();
    const proofId = await issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    await expect(
      consumeStepUpProof(db, proofId, action, "2026-08-07T14:00:00Z", FIX.owner),
    ).rejects.toThrow(DomainError);

    const other = await issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    await expect(
      consumeStepUpProof(
        db,
        other,
        { ...action, clientId: "other-client" },
        "2026-08-07T12:01:00Z",
        FIX.owner,
      ),
    ).rejects.toThrow(/client mismatch/);

    const actionMismatch = await issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    await expect(
      consumeStepUpProof(
        db,
        actionMismatch,
        { ...action, action: "other.action" },
        "2026-08-07T12:01:00Z",
        FIX.owner,
      ),
    ).rejects.toThrow(/action mismatch/);

    const humanMismatch = await issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    await expect(
      consumeStepUpProof(db, humanMismatch, action, "2026-08-07T12:01:00Z", FIX.member),
    ).rejects.toThrow(/human mismatch/);

    const wide = await issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    await expect(
      consumeStepUpProof(
        db,
        wide,
        { ...action, scopes: ["bfb:read", "bfb:task:write", "bfb:admin"] },
        "2026-08-07T12:01:00Z",
        FIX.owner,
      ),
    ).rejects.toThrow(/scope/);

    await expect(
      issueStepUpProof(
        db,
        FIX.owner,
        {
          ...action,
          expiresAt: new Date(
            Date.parse("2026-08-07T12:00:00Z") + (STEP_UP_MAX_TTL_SECONDS + 60) * 1000,
          ).toISOString(),
        },
        "2026-08-07T12:00:00Z",
      ),
    ).rejects.toThrow(/maximum bound/);
  });

  it("rejects proofs that do not cover task boundary", async () => {
    const db = await openDomainDb();
    const withTask = {
      ...action,
      taskId: "01JBFB0TASKXXXX00000000000",
    };
    const proofId = await issueStepUpProof(db, FIX.owner, withTask, "2026-08-07T12:00:00Z");
    await expect(
      consumeStepUpProof(
        db,
        proofId,
        { ...withTask, taskId: "01JBFB0TASKYYYY00000000000" },
        "2026-08-07T12:01:00Z",
        FIX.owner,
      ),
    ).rejects.toThrow(/task mismatch/);
  });

  it("binds expiry, exact scopes, and identity targets", async () => {
    const db = await openDomainDb();
    const expiryProof = await issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    await expect(
      consumeStepUpProof(
        db,
        expiryProof,
        { ...action, expiresAt: "2026-08-07T12:09:00Z" },
        "2026-08-07T12:01:00Z",
        FIX.owner,
      ),
    ).rejects.toThrow(/expiry mismatch/);

    const scopeProof = await issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    await expect(
      consumeStepUpProof(
        db,
        scopeProof,
        { ...action, scopes: ["bfb:read"] },
        "2026-08-07T12:01:00Z",
        FIX.owner,
      ),
    ).rejects.toThrow(/scope mismatch/);

    const identityAction = {
      action: "passkey.remove",
      targetId: "credential-a",
      scopes: [],
      authorizationEpoch: 0,
      expiresAt: "2026-08-07T12:10:00Z",
    };
    const targetProof = await issueStepUpProof(
      db,
      FIX.owner,
      identityAction,
      "2026-08-07T12:00:00Z",
    );
    await expect(
      consumeStepUpProof(
        db,
        targetProof,
        { ...identityAction, targetId: "credential-b" },
        "2026-08-07T12:01:00Z",
        FIX.owner,
      ),
    ).rejects.toThrow(/target mismatch/);
  });
});
