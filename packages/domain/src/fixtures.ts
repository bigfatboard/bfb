// ABOUTME: Seeds synthetic multi-role workspace fixtures for domain, web, and MCP tests.
// ABOUTME: All data is labelled synthetic through stable IDs and test-only helpers.

import type { SqlDatabase } from "@bfb/db";

import { syntheticUlid } from "./ids.js";
import { hashPassword, SYNTHETIC_PASSWORD } from "./passwords.js";

export const FIX = {
  workspace: syntheticUlid("WORKSPACE"),
  owner: syntheticUlid("OWNERHUM"),
  member: syntheticUlid("MEMBERHM"),
  /** Reviewer human fixture (project-grant scoped). */
  restricted: syntheticUlid("RESTRCT"),
  reviewer: syntheticUlid("RESTRCT"),
  projectA: syntheticUlid("PROJA"),
  projectB: syntheticUlid("PROJB"),
  profileCodex: syntheticUlid("PROFCX"),
  profileGrok: syntheticUlid("PROFGR"),
  client: "bfb-mcp-synthetic-client",
  /** Known fixture password for all synthetic humans. */
  password: SYNTHETIC_PASSWORD,
};

export async function seedSyntheticWorkspace(
  db: SqlDatabase,
  now = "2026-08-07T12:00:00Z",
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
     VALUES (?, 'synthetic', 'eu', ?, 1)`,
    )
    .run(FIX.workspace, now);

  const passwordHash = hashPassword(SYNTHETIC_PASSWORD, "synthetic-fixture-salt");

  for (const [id, email, name] of [
    [FIX.owner, "owner@synthetic.test", "Synthetic Owner"],
    [FIX.member, "member@synthetic.test", "Synthetic Member"],
    [FIX.restricted, "restricted@synthetic.test", "Synthetic Restricted"],
  ] as const) {
    await db
      .prepare(`INSERT INTO humans (id, email, display_name, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, email, name, now);
    await db
      .prepare(
        `INSERT INTO human_credentials (human_id, password_hash, algorithm, updated_at)
       VALUES (?, ?, 'scrypt', ?)`,
      )
      .run(id, passwordHash, now);
  }

  await db
    .prepare(
      `INSERT INTO workspace_members (workspace_id, human_id, role, authorization_epoch, created_at)
     VALUES (?, ?, 'owner', 1, ?), (?, ?, 'member', 1, ?), (?, ?, 'reviewer', 1, ?)`,
    )
    .run(
      FIX.workspace,
      FIX.owner,
      now,
      FIX.workspace,
      FIX.member,
      now,
      FIX.workspace,
      FIX.restricted,
      now,
    );

  await db
    .prepare(
      `INSERT INTO projects (workspace_id, id, name, slug, tint, resource_version, created_at)
     VALUES (?, ?, 'Alpha', 'alpha', '#3B82F6', 1, ?),
            (?, ?, 'Beta', 'beta', '#10B981', 1, ?)`,
    )
    .run(FIX.workspace, FIX.projectA, now, FIX.workspace, FIX.projectB, now);

  await db
    .prepare(`INSERT INTO project_access (workspace_id, project_id, human_id) VALUES (?, ?, ?)`)
    .run(FIX.workspace, FIX.projectA, FIX.restricted);

  await db
    .prepare(
      `INSERT INTO agent_profiles (workspace_id, id, name, provider)
     VALUES (?, ?, 'Codex Refactor', 'codex'), (?, ?, 'Grok Explore', 'grok')`,
    )
    .run(FIX.workspace, FIX.profileCodex, FIX.workspace, FIX.profileGrok);

  await db
    .prepare(
      `INSERT INTO project_policies (workspace_id, project_id, allow_agent_root_propose, allow_pass_to_agent, resource_version)
     VALUES (?, ?, 1, 1, 1), (?, ?, 1, 1, 1)`,
    )
    .run(FIX.workspace, FIX.projectA, FIX.workspace, FIX.projectB);

  await db
    .prepare(
      `INSERT INTO preregistered_oauth_clients (client_id, redirect_uri, name, public_client)
     VALUES (?, 'http://127.0.0.1:9999/callback', 'Synthetic MCP Client', 1)`,
    )
    .run(FIX.client);
}
