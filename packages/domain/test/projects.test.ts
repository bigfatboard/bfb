// ABOUTME: Proves C07 project identity, grants, policies, profiles, and immutable versions.
// ABOUTME: Negative cases cover cross-project access, aliases, widening, stale writes, and local paths.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  changeProjectAccessCommand,
  createAgentProfileCommand,
  createProjectCommand,
  evaluateEffectivePolicy,
  FIX,
  getProjectPolicy,
  listAgentProfilesPage,
  listProjectsPage,
  listVersionRows,
  loadPrincipal,
  normalizeRepositoryHost,
  normalizeRepositorySubpath,
  reportRepositoryConfigCommand,
  updateProjectCommand,
  updateAgentProfileCommand,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  workspaceHub,
  type HubCommand,
} from "../src/index.js";
import { openDomainDb } from "./helpers.js";

const NOW = "2026-08-12T08:00:00Z";

async function fixture() {
  return openDomainDb();
}

async function execute<TInput, TResult>(
  db: Awaited<ReturnType<typeof fixture>>,
  command: HubCommand<TInput, TResult>,
  input: TInput,
  options: { actor?: string; epoch?: number; key?: string } = {},
) {
  return workspaceHub(db, FIX.workspace).execute(command, {
    workspaceId: FIX.workspace,
    idempotencyKey: options.key ?? `${command.name}-${Math.random()}`,
    actorHumanId: options.actor ?? FIX.owner,
    authorizationEpoch: options.epoch ?? 1,
    now: NOW,
    input,
  });
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

describe("projects, access, and repository identity", () => {
  it("lists only granted projects and rejects repository aliases and duplicate identities", async () => {
    const db = await fixture();
    const owner = await loadPrincipal(db, FIX.workspace, FIX.owner);
    const reviewer = await loadPrincipal(db, FIX.workspace, FIX.reviewer);
    expect(owner.projectIds.sort()).toEqual([FIX.projectA, FIX.projectB].sort());
    expect(reviewer.projectIds).toEqual([FIX.projectA]);
    expect((await listProjectsPage(db, reviewer)).projects.map((project) => project.id)).toEqual([
      FIX.projectA,
    ]);

    expect(() => normalizeRepositoryHost("https://github.com/qdis/bfb")).toThrow(/repository host/);
    expect(() => normalizeRepositoryHost("git@github.com:qdis/bfb.git")).toThrow(/repository host/);
    expect(() => normalizeRepositorySubpath("/Users/synthetic/bfb")).toThrow(/subpath/);
    expect(() => normalizeRepositorySubpath("packages/../secrets")).toThrow(/subpath/);

    const input = {
      name: "API",
      slug: "api",
      tint: "#AABBCC",
      accessMode: "restricted" as const,
      repositoryHost: "github.com",
      hostedRepositoryId: "987654321",
      repositorySubpath: "packages/api",
    };
    const created = await execute(db, createProjectCommand, input, {
      key: "project-create-replay",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const replay = await execute(db, createProjectCommand, input, { key: "project-create-replay" });
    expect(replay).toMatchObject({ ok: true, replayed: true, result: created.result });

    const duplicate = await execute(db, createProjectCommand, {
      name: "API Alias",
      slug: "api-alias",
      tint: "#112233",
      accessMode: "restricted",
      repositoryHost: "GITHUB.COM",
      hostedRepositoryId: "987654321",
      repositorySubpath: "packages/api",
    });
    expect(duplicate).toMatchObject({ ok: false, error: { code: "already_exists" } });
  });

  it("changes restricted grants through the hub and fences the previous epoch", async () => {
    const db = await fixture();
    const created = await execute(db, createProjectCommand, {
      name: "Restricted",
      slug: "restricted",
      tint: "#334455",
      accessMode: "restricted",
      repositoryHost: "github.com",
      hostedRepositoryId: "project-restricted",
      repositorySubpath: ".",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    expect((await loadPrincipal(db, FIX.workspace, FIX.reviewer)).projectIds).not.toContain(
      created.result.id,
    );
    const finalOwner = await execute(db, changeProjectAccessCommand, {
      projectId: created.result.id,
      humanId: FIX.owner,
      grant: false,
    });
    expect(finalOwner).toMatchObject({
      ok: false,
      error: { code: "final_project_owner" },
    });
    const memberAttempt = await execute(
      db,
      changeProjectAccessCommand,
      { projectId: created.result.id, humanId: FIX.reviewer, grant: true },
      { actor: FIX.member },
    );
    expect(memberAttempt).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const malformedGrant = await execute(
      db,
      changeProjectAccessCommand,
      { projectId: created.result.id, humanId: FIX.reviewer, grant: "false" as never },
      { key: "project-malformed-grant" },
    );
    expect(malformedGrant).toMatchObject({
      ok: false,
      error: { code: "invalid_argument" },
    });
    expect((await loadPrincipal(db, FIX.workspace, FIX.reviewer)).projectIds).not.toContain(
      created.result.id,
    );

    const granted = await execute(db, changeProjectAccessCommand, {
      projectId: created.result.id,
      humanId: FIX.reviewer,
      grant: true,
    });
    expect(granted).toMatchObject({
      ok: true,
      result: { granted: true, authorizationEpoch: 2 },
    });
    const afterGrant = await loadPrincipal(db, FIX.workspace, FIX.reviewer);
    expect(afterGrant.projectIds).toContain(created.result.id);
    expect(afterGrant.authorizationEpoch).toBe(2);

    const stale = await execute(
      db,
      changeProjectAccessCommand,
      { projectId: created.result.id, humanId: FIX.member, grant: true },
      { actor: FIX.reviewer, epoch: 1 },
    );
    expect(stale).toMatchObject({ ok: false, error: { code: "stale_authorization" } });

    const revoked = await execute(db, changeProjectAccessCommand, {
      projectId: created.result.id,
      humanId: FIX.reviewer,
      grant: false,
    });
    expect(revoked).toMatchObject({
      ok: true,
      result: { granted: false, authorizationEpoch: 3 },
    });
    expect((await loadPrincipal(db, FIX.workspace, FIX.reviewer)).projectIds).not.toContain(
      created.result.id,
    );

    const workspaceVisible = await execute(db, updateProjectCommand, {
      projectId: created.result.id,
      expectedVersion: 1,
      accessMode: "workspace",
    });
    expect(workspaceVisible).toMatchObject({
      ok: true,
      result: { access_mode: "workspace", resource_version: 2 },
    });
    expect((await loadPrincipal(db, FIX.workspace, FIX.reviewer)).projectIds).toContain(
      created.result.id,
    );

    const restrictedAgain = await execute(
      db,
      updateProjectCommand,
      {
        projectId: created.result.id,
        expectedVersion: 2,
        accessMode: "restricted",
      },
      { epoch: 2 },
    );
    expect(restrictedAgain).toMatchObject({
      ok: true,
      result: { access_mode: "restricted", resource_version: 3 },
    });
    expect((await loadPrincipal(db, FIX.workspace, FIX.reviewer)).projectIds).not.toContain(
      created.result.id,
    );
  });
});

describe("policy and configuration history", () => {
  it("rejects widening and retains immutable workspace/project/config versions", async () => {
    const db = await fixture();
    const malformed = await execute(
      db,
      updateWorkspacePolicyCommand,
      {
        expectedVersion: 1,
        allowedProviders: ["codex"],
        allowAgentRootPropose: "false" as never,
        allowPassToAgent: false,
        allowRunOverrides: false,
      },
      { key: "workspace-policy-malformed" },
    );
    expect(malformed).toMatchObject({ ok: false, error: { code: "invalid_policy" } });
    const workspace = await execute(db, updateWorkspacePolicyCommand, {
      expectedVersion: 1,
      allowedProviders: ["codex"],
      allowAgentRootPropose: true,
      allowPassToAgent: false,
      allowRunOverrides: false,
    });
    expect(workspace).toMatchObject({ ok: true, result: { resourceVersion: 2 } });

    const widening = await execute(db, updateProjectPolicyCommand, {
      projectId: FIX.projectA,
      expectedVersion: 1,
      allowedProviders: ["codex", "grok"],
      allowAgentRootPropose: true,
      allowPassToAgent: false,
      allowRunOverrides: false,
    });
    expect(widening).toMatchObject({ ok: false, error: { code: "policy_widening" } });

    const project = await execute(db, updateProjectPolicyCommand, {
      projectId: FIX.projectA,
      expectedVersion: 1,
      allowedProviders: ["codex"],
      allowAgentRootPropose: false,
      allowPassToAgent: false,
      allowRunOverrides: false,
    });
    expect(project).toMatchObject({ ok: true, result: { resourceVersion: 2 } });
    expect((await getProjectPolicy(db, FIX.workspace, FIX.projectA)).allowPassToAgent).toBe(false);

    const config = {
      allowed_providers: ["codex"],
      allow_agent_root_propose: false,
      allow_pass_to_agent: false,
      allow_run_overrides: false,
    };
    const canonical =
      '{"allow_agent_root_propose":false,"allow_pass_to_agent":false,"allow_run_overrides":false,"allowed_providers":["codex"]}';
    const reported = await execute(db, reportRepositoryConfigCommand, {
      projectId: FIX.projectA,
      expectedVersion: 1,
      document: config,
      contentHash: hash(canonical),
    });
    expect(reported).toMatchObject({ ok: true, result: { version: 2, canonicalJson: canonical } });

    const stale = await execute(db, reportRepositoryConfigCommand, {
      projectId: FIX.projectA,
      expectedVersion: 1,
      document: {},
      contentHash: hash("{}"),
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "stale_version" } });
    const secretField = await execute(db, reportRepositoryConfigCommand, {
      projectId: FIX.projectA,
      expectedVersion: 2,
      document: { provider_token: "synthetic-secret" },
      contentHash: hash('{"provider_token":"synthetic-secret"}'),
    });
    expect(secretField).toMatchObject({ ok: false, error: { code: "invalid_config" } });

    const versions = await listVersionRows(
      db,
      "repository_config_versions",
      FIX.workspace,
      { projectId: FIX.projectA },
      { limit: 1 },
    );
    expect(versions).toMatchObject({ hasMore: true, nextCursor: 1 });
    await expect(
      db
        .prepare(
          `UPDATE repository_config_versions SET canonical_json = '{}'
           WHERE workspace_id = ? AND project_id = ? AND version = 1`,
        )
        .run(FIX.workspace, FIX.projectA),
    ).rejects.toThrow(/immutable/);
    await expect(
      db
        .prepare(
          `UPDATE projects SET repository_subpath = 'other'
           WHERE workspace_id = ? AND id = ?`,
        )
        .run(FIX.workspace, FIX.projectA),
    ).rejects.toThrow(/immutable/);
  });

  it("intersects workspace, project, repository, profile, runner, and override inputs", () => {
    const effective = evaluateEffectivePolicy({
      workspace: {
        allowedProviders: ["claude", "codex"],
        allowAgentRootPropose: true,
        allowPassToAgent: true,
        allowRunOverrides: true,
      },
      project: {
        allowedProviders: ["codex"],
        allowAgentRootPropose: true,
        allowPassToAgent: false,
        allowRunOverrides: true,
      },
      repository: {
        allowedProviders: ["codex"],
        allowAgentRootPropose: false,
        allowPassToAgent: false,
        allowRunOverrides: false,
      },
      profileProvider: "codex",
      runnerProviders: ["codex", "grok"],
    });
    expect(effective).toEqual({
      provider: "codex",
      allowAgentRootPropose: false,
      allowPassToAgent: false,
    });
    expect(() =>
      evaluateEffectivePolicy({
        workspace: {
          allowedProviders: ["codex"],
          allowAgentRootPropose: true,
          allowPassToAgent: true,
          allowRunOverrides: true,
        },
        project: {
          allowedProviders: ["codex"],
          allowAgentRootPropose: true,
          allowPassToAgent: true,
          allowRunOverrides: true,
        },
        repository: {
          allowedProviders: ["codex"],
          allowAgentRootPropose: true,
          allowPassToAgent: true,
          allowRunOverrides: true,
        },
        profileProvider: "codex",
        runnerProviders: ["grok"],
      }),
    ).toThrow(/not available/);
  });
});

describe("agent profile versions", () => {
  it("creates and updates policy-allowed profiles without rewriting history", async () => {
    const db = await fixture();
    const created = await execute(db, createAgentProfileCommand, {
      name: "Claude Review",
      provider: "claude",
      model: "claude-sonnet",
      executionMode: "interactive",
      harnessMode: "restricted",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const updated = await execute(db, updateAgentProfileCommand, {
      profileId: created.result.id,
      expectedVersion: 1,
      name: "Claude Review",
      provider: "claude",
      model: "claude-opus",
      executionMode: "headless",
      harnessMode: "restricted",
    });
    expect(updated).toMatchObject({ ok: true, result: { resource_version: 2 } });
    const versions = await listVersionRows(db, "agent_profile_versions", FIX.workspace, {
      profileId: created.result.id,
    });
    expect(versions.versions).toHaveLength(2);
    expect((versions.versions[0] as { model: string }).model).toBe("claude-sonnet");
    expect((versions.versions[1] as { model: string }).model).toBe("claude-opus");
    const profiles = await listAgentProfilesPage(db, FIX.workspace, { limit: 2 });
    expect(profiles.hasMore).toBe(true);

    await execute(db, updateWorkspacePolicyCommand, {
      expectedVersion: 1,
      allowedProviders: ["codex"],
      allowAgentRootPropose: true,
      allowPassToAgent: true,
      allowRunOverrides: true,
    });
    const forbidden = await execute(db, createAgentProfileCommand, {
      name: "Grok Forbidden",
      provider: "grok",
      executionMode: "interactive",
      harnessMode: "standard",
    });
    expect(forbidden).toMatchObject({ ok: false, error: { code: "provider_forbidden" } });
  });
});
