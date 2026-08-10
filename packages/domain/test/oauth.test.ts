// ABOUTME: Verifies X03A OAuth delegation creation, resolution, revocation, and credential confusion.
// ABOUTME: Browser cookie and reserved credential formats never authenticate MCP.

import { describe, expect, it } from "vitest";

import {
  createDelegation,
  resolveAccessToken,
  revokeDelegation,
  MCP_RESOURCE,
} from "../src/oauth.js";
import { issueStepUpProof } from "../src/step-up.js";
import { FIX } from "../src/fixtures.js";
import { openDomainDb } from "./helpers.js";

describe("oauth delegations", () => {
  it("creates delegation with step-up and resolves opaque tokens", async () => {
    const db = await openDomainDb();
    const action = {
      action: "oauth.delegation.create",
      clientId: FIX.client,
      resource: MCP_RESOURCE,
      workspaceId: FIX.workspace,
      projectId: FIX.projectA,
      scopes: ["bfb:read", "bfb:task:write"],
      authorizationEpoch: 1,
      expiresAt: "2026-08-07T13:00:00Z",
    };
    const proofId = await issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    const { accessToken, delegationId } = await createDelegation(db, {
      ...action,
      humanId: FIX.owner,
      now: "2026-08-07T12:00:01Z",
      stepUpProofId: proofId,
      scopes: action.scopes,
    });
    const resolved = await resolveAccessToken(db, accessToken, "2026-08-07T12:05:00Z");
    expect(resolved.delegationId).toBe(delegationId);
    expect(resolved.humanId).toBe(FIX.owner);

    await revokeDelegation(db, FIX.workspace, delegationId, "2026-08-07T12:06:00Z");
    await expect(resolveAccessToken(db, accessToken, "2026-08-07T12:07:00Z")).rejects.toThrow(
      /revoked/,
    );
  });

  it("rejects browser cookies and reserved credential classes", async () => {
    const db = await openDomainDb();
    await expect(resolveAccessToken(db, "bfb_session_abc", "2026-08-07T12:00:00Z")).rejects.toThrow(
      /cookie/,
    );
    await expect(resolveAccessToken(db, "bfb_cli_secret", "2026-08-07T12:00:00Z")).rejects.toThrow(
      /reserved/,
    );
    await expect(
      resolveAccessToken(db, "bfb_runner_secret", "2026-08-07T12:00:00Z"),
    ).rejects.toThrow(/reserved/);
  });
});
