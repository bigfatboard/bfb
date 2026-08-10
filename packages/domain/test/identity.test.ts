// ABOUTME: Covers C02 human identity/session fixture records used by browser auth tests.
// ABOUTME: Sessions are synthetic D1 rows; Better Auth product config remains C02-owned and separate.

import { describe, expect, it } from "vitest";

import { FIX } from "../src/fixtures.js";
import { openDomainDb } from "./helpers.js";
import { syntheticUlid } from "../src/ids.js";

describe("human identity sessions", () => {
  it("stores browser sessions distinct from MCP tokens", () => {
    const db = openDomainDb();
    const sessionId = syntheticUlid("SESSION1");
    db.prepare(
      `INSERT INTO human_sessions (session_id, human_id, workspace_id, created_at, expires_at)
       VALUES (?, ?, ?, '2026-08-07T12:00:00Z', '2026-08-08T12:00:00Z')`,
    ).run(sessionId, FIX.owner, FIX.workspace);
    const row = db
      .prepare(`SELECT human_id, revoked_at FROM human_sessions WHERE session_id = ?`)
      .get(sessionId) as { human_id: string; revoked_at: string | null };
    expect(row.human_id).toBe(FIX.owner);
    expect(row.revoked_at).toBeNull();
    expect(sessionId.startsWith("mcp_")).toBe(false);
  });
});
