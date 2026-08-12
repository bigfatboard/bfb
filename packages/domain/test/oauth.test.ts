// ABOUTME: Verifies provider-token binding, delegation resolution, revocation, and credential separation.
// ABOUTME: Every remote MCP token remains constrained by resource, membership epoch, and sponsor session.

import { describe, expect, it } from "vitest";

import { FIX } from "../src/fixtures.js";
import {
  mcpResource,
  resolveAccessToken,
  revokeDelegation,
  revokeProviderTokenDelegation,
} from "../src/oauth.js";
import { issueSyntheticMcpAccess, openDomainDb } from "./helpers.js";

const resource = mcpResource("https://bfb.example.test");

describe("oauth delegations", () => {
  it("resolves an opaque provider token through its BFB delegation", async () => {
    const db = await openDomainDb();
    const { accessToken, delegationId } = await issueSyntheticMcpAccess(db);
    const resolved = await resolveAccessToken(
      db,
      accessToken,
      "2026-08-07T12:05:00.000Z",
      resource,
    );
    expect(resolved).toMatchObject({
      delegationId,
      humanId: FIX.owner,
      clientId: FIX.client,
      projectId: FIX.projectA,
    });
    expect(resolved.scopes).toEqual(["bfb:read", "bfb:task:write", "offline_access"]);
  });

  it("blocks revocation, resource confusion, and membership epoch changes", async () => {
    const db = await openDomainDb();
    const first = await issueSyntheticMcpAccess(db);
    await expect(
      resolveAccessToken(db, first.accessToken, "2026-08-07T12:01:00.000Z", resource + "/x"),
    ).rejects.toThrow(/resource/);
    await revokeDelegation(db, FIX.workspace, first.delegationId, "2026-08-07T12:02:00.000Z");
    await expect(
      resolveAccessToken(db, first.accessToken, "2026-08-07T12:03:00.000Z", resource),
    ).rejects.toThrow(/revoked/);

    const second = await issueSyntheticMcpAccess(db);
    await db
      .prepare(
        `UPDATE workspace_members SET authorization_epoch = 2
         WHERE workspace_id = ? AND human_id = ?`,
      )
      .run(FIX.workspace, FIX.owner);
    await expect(
      resolveAccessToken(db, second.accessToken, "2026-08-07T12:03:00.000Z", resource),
    ).rejects.toThrow(/epoch|revoked/);
  });

  it("revokes BFB authority before provider-token cleanup", async () => {
    const db = await openDomainDb();
    const issued = await issueSyntheticMcpAccess(db);
    expect(
      await revokeProviderTokenDelegation(
        db,
        issued.accessToken,
        FIX.client,
        "2026-08-07T12:02:00.000Z",
      ),
    ).toBe(true);
    await expect(
      resolveAccessToken(db, issued.accessToken, "2026-08-07T12:03:00.000Z", resource),
    ).rejects.toThrow(/revoked/);
    expect(
      await revokeProviderTokenDelegation(
        db,
        issued.accessToken,
        "wrong-client",
        "2026-08-07T12:04:00.000Z",
      ),
    ).toBe(false);
  });

  it("rejects browser cookies and reserved credential classes", async () => {
    const db = await openDomainDb();
    for (const token of [
      "bfb_session_abc",
      "bfb_cli_secret",
      "bfb_runner_secret",
      "bfb_agent_secret",
      "bfb_integration_secret",
    ]) {
      await expect(
        resolveAccessToken(db, token, "2026-08-07T12:00:00.000Z", resource),
      ).rejects.toThrow(/cookie|reserved/);
    }
  });
});
