// ABOUTME: Covers normalized human identity records independently from browser credentials.
// ABOUTME: Workspace authority remains an explicit membership relationship, never auth state.

import { describe, expect, it } from "vitest";

import { FIX } from "../src/fixtures.js";
import { openDomainDb } from "./helpers.js";

describe("normalized human identity", () => {
  it("stores humans independently from provider sessions and workspace authority", async () => {
    const db = await openDomainDb();
    const owner = (await db
      .prepare("SELECT id, email, better_auth_user_id FROM humans WHERE id = ?")
      .get(FIX.owner)) as {
      id: string;
      email: string;
      better_auth_user_id: string | null;
    };
    expect(owner).toEqual({
      id: FIX.owner,
      email: "owner@synthetic.test",
      better_auth_user_id: null,
    });

    const authTables = (await db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'better_auth_%'
         ORDER BY name`,
      )
      .all()) as Array<{ name: string }>;
    expect(authTables.map((row) => row.name)).toEqual([
      "better_auth_accounts",
      "better_auth_oauth_access_tokens",
      "better_auth_oauth_clients",
      "better_auth_oauth_consents",
      "better_auth_oauth_refresh_tokens",
      "better_auth_passkeys",
      "better_auth_sessions",
      "better_auth_users",
      "better_auth_verifications",
    ]);
  });
});
