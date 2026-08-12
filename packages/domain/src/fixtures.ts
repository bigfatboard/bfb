// ABOUTME: Seeds synthetic multi-role workspace fixtures for domain, web, and MCP tests.
// ABOUTME: All data is labelled synthetic through stable IDs and test-only helpers.

import type { SqlDatabase } from "@bfb/db";

import { syntheticUlid } from "./ids.js";

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
  taskAttention: syntheticUlid("TASKATTN"),
  taskProposed: syntheticUlid("TASKPROP"),
  taskDelegable: syntheticUlid("TASKDELG"),
  contextHuman: syntheticUlid("CTXHUMAN"),
  contextAgent: syntheticUlid("CTXAGENT"),
  runDelegable: syntheticUlid("RUNDELG"),
  eventAttention: syntheticUlid("EVTATTN"),
  client: "bfb-mcp-synthetic-client",
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

  for (const [id, email, name] of [
    [FIX.owner, "owner@synthetic.test", "Synthetic Owner"],
    [FIX.member, "member@synthetic.test", "Synthetic Member"],
    [FIX.restricted, "restricted@synthetic.test", "Synthetic Restricted"],
  ] as const) {
    await db
      .prepare(`INSERT INTO humans (id, email, display_name, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, email, name, now);
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
      `INSERT INTO workspace_authorization_epochs
       (workspace_id, human_id, authorization_epoch, revoked_at, updated_at)
       VALUES (?, ?, 1, NULL, ?), (?, ?, 1, NULL, ?), (?, ?, 1, NULL, ?)`,
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
    .prepare(
      `INSERT INTO project_access (workspace_id, project_id, human_id)
       VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
    )
    .run(
      FIX.workspace,
      FIX.projectA,
      FIX.owner,
      FIX.workspace,
      FIX.projectA,
      FIX.member,
      FIX.workspace,
      FIX.projectA,
      FIX.restricted,
      FIX.workspace,
      FIX.projectB,
      FIX.owner,
      FIX.workspace,
      FIX.projectB,
      FIX.member,
    );

  await db
    .prepare(
      `INSERT INTO agent_profiles (workspace_id, id, name, provider)
     VALUES (?, ?, 'Codex Refactor', 'codex'), (?, ?, 'Grok Explore', 'grok')`,
    )
    .run(FIX.workspace, FIX.profileCodex, FIX.workspace, FIX.profileGrok);

  await db
    .prepare(
      `INSERT INTO agent_profile_versions
       (workspace_id, profile_id, version, name, provider, model,
        execution_mode, harness_mode, created_by_human_id, created_at)
       VALUES (?, ?, 1, 'Codex Refactor', 'codex', NULL, 'interactive', 'standard', NULL, ?),
              (?, ?, 1, 'Grok Explore', 'grok', NULL, 'interactive', 'standard', NULL, ?)`,
    )
    .run(FIX.workspace, FIX.profileCodex, now, FIX.workspace, FIX.profileGrok, now);

  await db
    .prepare(
      `INSERT INTO better_auth_oauth_clients (
         id, client_id, client_secret, disabled, skip_consent, enable_end_session,
         subject_type, scopes, user_id, created_at, updated_at, name,
         redirect_uris, token_endpoint_auth_method, grant_types, response_types,
         public, type, require_pkce
       ) VALUES (?, ?, NULL, 0, 0, 0, 'public', ?, NULL, ?, ?, ?, ?, 'none', ?, ?, 1, 'native', 1)`,
    )
    .run(
      FIX.client,
      FIX.client,
      JSON.stringify(["bfb:read", "bfb:task:write", "offline_access"]),
      now,
      now,
      "Synthetic MCP Client",
      JSON.stringify(["http://127.0.0.1:9999/callback"]),
      JSON.stringify(["authorization_code", "refresh_token"]),
      JSON.stringify(["code"]),
    );
}
