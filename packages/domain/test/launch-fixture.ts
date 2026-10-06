// ABOUTME: Seeds visibly synthetic launch authority and current inventories for domain acceptance.
// ABOUTME: Real proof-of-possession transport is tested separately through production Worker routes.

import type {
  LaunchClaim,
  LaunchFinalRequest,
  LaunchStartRequest,
  RunnerInventory,
} from "@bfb/protocol";
import type { SqlDatabase } from "@bfb/db";
import { expect } from "vitest";

import { authorizeSyntheticPolicyUpdate, FIX, seedSyntheticWorkspace } from "../src/fixtures.js";
import { WorkspaceHub, type CommandOutcome, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { launchDeadline } from "../src/launch-state.js";
import { claimLaunchCommand, startLaunchCommand } from "../src/launches.js";
import {
  createAgentProfileCommand,
  reportRepositoryConfigCommand,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  type AgentProfileRecord,
} from "../src/projects.js";
import { replaceRunnerInventoryCommand } from "../src/runner-channel.js";
import { runnerHash, type RunnerTokenClaims } from "../src/runner-crypto.js";
import type { RunnerPrincipal } from "../src/runners.js";
import { createTaskCommand } from "../src/work-commands.js";
import { openDomainDb } from "./helpers.js";

export const LAUNCH_NOW = "2026-09-12T12:00:00.000Z";
export const EMPTY_CONFIG_HASH = `sha256:${runnerHash("{}")}`;
export const SYNTHETIC_DIGEST = `sha256:${"a".repeat(64)}`;

export function success<T>(outcome: CommandOutcome<T>): T {
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
  if (!outcome.ok) throw new Error(outcome.error.code);
  return outcome.result;
}

export async function launchFixture(
  database?: SqlDatabase,
  options: {
    policySchema?: "pre-offline-agent-work";
    profileSchema?: "pre-permission-mode";
  } = {},
) {
  const db = database ?? (await openDomainDb()),
    hub = new WorkspaceHub(db);
  if (database) await seedSyntheticWorkspace(db);
  const runner = randomUlid(),
    checkout = randomUlid(),
    tokenId = randomUlid();
  const principal: RunnerPrincipal = {
    kind: "runner",
    workspaceId: FIX.workspace,
    runnerId: runner,
    ownerHumanId: FIX.owner,
    authorizationEpoch: 1,
    ownerAuthorizationEpoch: 1,
    grantEpoch: 1,
    tokenEpoch: 1,
    tokenId,
    keyThumbprint: "synthetic-key-thumbprint",
    authExpiresAt: launchDeadline(LAUNCH_NOW, 300_000),
    projectIds: [FIX.projectA],
  };
  const claims: RunnerTokenClaims = {
    v: 1,
    sub: runner,
    workspace_id: FIX.workspace,
    aud: "bfb-runner",
    iss: "https://bfb.example.test",
    jti: tokenId,
    iat: Date.parse(LAUNCH_NOW) / 1000,
    exp: Date.parse(principal.authExpiresAt) / 1000,
    authorization_epoch: 1,
    owner_authorization_epoch: 1,
    grant_epoch: 1,
    token_epoch: 1,
    cnf: { jkt: principal.keyThumbprint },
  };
  await db
    .prepare(
      `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
    VALUES (?, ?, ?, 'Synthetic launch Mac', '{}', ?, 1, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, principal.keyThumbprint, LAUNCH_NOW);
  await db
    .prepare(`INSERT INTO runner_project_grants VALUES (?, ?, ?)`)
    .run(FIX.workspace, runner, FIX.projectA);
  await db
    .prepare(
      `INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, LAUNCH_NOW);
  await db
    .prepare(
      `INSERT INTO runner_tokens (workspace_id, runner_id, id, token_hash, claims_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      FIX.workspace,
      runner,
      tokenId,
      runnerHash("synthetic-not-a-token"),
      JSON.stringify(claims),
      principal.authExpiresAt,
    );
  function human<I, R>(command: HubCommand<I, R>, input: I, now = LAUNCH_NOW, humanId = FIX.owner) {
    return hub.execute(command, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: humanId,
      authorizationEpoch: 1,
      now,
      input,
    });
  }
  function native<I, R>(command: HubCommand<I, R>, input: I, now = LAUNCH_NOW) {
    return hub.execute(command, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorRunnerId: runner,
      authorizationEpoch: 1,
      now,
      input,
    });
  }
  const policy = {
    allowedProviders: ["claude", "codex", "grok", "fake"],
    allowAgentRootPropose: false,
    allowPassToAgent: true,
    allowRunOverrides: true,
  } as const;
  const profileInput = {
    name: "Synthetic launch provider",
    provider: "fake" as const,
    model: "synthetic",
    executionMode: "interactive" as const,
    harnessMode: "restricted" as const,
  };
  let profile: AgentProfileRecord;
  if (options.policySchema === "pre-offline-agent-work") {
    // Arrange genuine pre-0039 history; today's proof-bound mutators require its columns.
    const columns = await db.prepare("PRAGMA table_info(workspace_policies)").all();
    expect(columns.map((column) => (column as { name: string }).name)).not.toContain(
      "offline_agent_tools_json",
    );
    const providers = JSON.stringify([...policy.allowedProviders].sort());
    await db
      .prepare(
        `UPDATE workspace_policies SET allowed_providers_json = ?,
      allow_agent_root_propose = 0, allow_pass_to_agent = 1, allow_run_overrides = 1,
      resource_version = 2 WHERE workspace_id = ?`,
      )
      .run(providers, FIX.workspace);
    await db
      .prepare(
        `INSERT INTO workspace_policy_versions
      (workspace_id, version, allowed_providers_json, allow_agent_root_propose,
       allow_pass_to_agent, allow_run_overrides, created_by_human_id, created_at)
      SELECT workspace_id, resource_version, allowed_providers_json, allow_agent_root_propose,
       allow_pass_to_agent, allow_run_overrides, ?, ? FROM workspace_policies
       WHERE workspace_id = ?`,
      )
      .run(FIX.owner, LAUNCH_NOW, FIX.workspace);
    await db
      .prepare(
        `UPDATE project_policies SET allowed_providers_json = ?,
      allow_agent_root_propose = 0, allow_pass_to_agent = 1, allow_run_overrides = 1,
      resource_version = 2 WHERE workspace_id = ? AND project_id = ?`,
      )
      .run(providers, FIX.workspace, FIX.projectA);
    await db
      .prepare(
        `INSERT INTO project_policy_versions
      (workspace_id, project_id, version, allowed_providers_json, allow_agent_root_propose,
       allow_pass_to_agent, allow_run_overrides, created_by_human_id, created_at)
      SELECT workspace_id, project_id, resource_version, allowed_providers_json, allow_agent_root_propose,
       allow_pass_to_agent, allow_run_overrides, ?, ? FROM project_policies
       WHERE workspace_id = ? AND project_id = ?`,
      )
      .run(FIX.owner, LAUNCH_NOW, FIX.workspace, FIX.projectA);
    await db
      .prepare(
        `UPDATE repository_configs SET allowed_providers_json = ?,
      allow_agent_root_propose = 0, allow_pass_to_agent = 1, allow_run_overrides = 1,
      resource_version = 2 WHERE workspace_id = ? AND project_id = ?`,
      )
      .run(providers, FIX.workspace, FIX.projectA);
    await db
      .prepare(
        `INSERT INTO repository_config_versions
      (workspace_id, project_id, version, canonical_json, content_hash, allowed_providers_json,
       allow_agent_root_propose, allow_pass_to_agent, allow_run_overrides, reported_by_human_id, created_at)
      SELECT workspace_id, project_id, resource_version, canonical_json, content_hash, allowed_providers_json,
       allow_agent_root_propose, allow_pass_to_agent, allow_run_overrides, ?, ? FROM repository_configs
       WHERE workspace_id = ? AND project_id = ?`,
      )
      .run(FIX.owner, LAUNCH_NOW, FIX.workspace, FIX.projectA);
  } else {
    success(
      await human(
        updateWorkspacePolicyCommand,
        await authorizeSyntheticPolicyUpdate(
          db,
          {
            workspaceId: FIX.workspace,
            humanId: FIX.owner,
          },
          {
            ...policy,
            allowedProviders: [...policy.allowedProviders],
            expectedVersion: 1,
          },
        ),
      ),
    );
    success(
      await human(
        updateProjectPolicyCommand,
        await authorizeSyntheticPolicyUpdate(
          db,
          {
            workspaceId: FIX.workspace,
            humanId: FIX.owner,
          },
          {
            ...policy,
            allowedProviders: [...policy.allowedProviders],
            expectedVersion: 1,
            projectId: FIX.projectA,
          },
        ),
      ),
    );
    success(
      await human(reportRepositoryConfigCommand, {
        projectId: FIX.projectA,
        expectedVersion: 1,
        document: {},
        contentHash: EMPTY_CONFIG_HASH,
      }),
    );
  }
  if (
    options.policySchema === "pre-offline-agent-work" ||
    options.profileSchema === "pre-permission-mode"
  ) {
    // Historical migration proofs seed the schema that actually existed, not today's profile writer.
    const columns = await db.prepare("PRAGMA table_info(agent_profiles)").all();
    expect(columns.map((column) => (column as { name: string }).name)).not.toContain(
      "permission_mode",
    );
    profile = {
      id: randomUlid(),
      name: profileInput.name,
      provider: profileInput.provider,
      model: profileInput.model,
      execution_mode: profileInput.executionMode,
      harness_mode: profileInput.harnessMode,
      permission_mode: "manual",
      resource_version: 1,
    };
    await db
      .prepare(
        `INSERT INTO agent_profiles
      (workspace_id, id, name, provider, model, execution_mode, harness_mode, resource_version)
      VALUES (?, ?, ?, 'fake', 'synthetic', 'interactive', 'restricted', 1)`,
      )
      .run(FIX.workspace, profile.id, profileInput.name);
    await db
      .prepare(
        `INSERT INTO agent_profile_versions
      (workspace_id, profile_id, version, name, provider, model, execution_mode, harness_mode,
       created_by_human_id, created_at)
      VALUES (?, ?, 1, ?, 'fake', 'synthetic', 'interactive', 'restricted', ?, ?)`,
      )
      .run(FIX.workspace, profile.id, profileInput.name, FIX.owner, LAUNCH_NOW);
  } else {
    profile = success(await human(createAgentProfileCommand, profileInput));
  }
  const task = success(
    await human(createTaskCommand, {
      projectId: FIX.projectA,
      title: "Synthetic C09 task",
      priority: "P2",
    }),
  );
  let inventory: RunnerInventory = {
    schema_version: 1,
    workspace_id: FIX.workspace,
    runner_id: runner,
    revision: 1,
    checkouts: [
      {
        schema_version: 1,
        checkout_id: checkout,
        workspace_id: FIX.workspace,
        runner_id: runner,
        project_id: FIX.projectA,
        label: "Synthetic checkout",
        repository_identity: "synthetic/c09",
        workspace_subpath: ".",
        physical_worktree_hash: SYNTHETIC_DIGEST,
        repository_config_hash: EMPTY_CONFIG_HASH,
        is_default: true,
        dirty: false,
        status: "validated",
        validated_at: LAUNCH_NOW,
      },
    ],
    providers: [
      {
        provider: "fake",
        version: "1.0.0",
        manifest_id: SYNTHETIC_DIGEST,
        status: "healthy",
        observed_at: LAUNCH_NOW,
        expires_at: launchDeadline(LAUNCH_NOW, 30_000),
        capabilities: [
          "launch.interactive",
          "filesystem.read_only",
          "approval.never",
          "context.session_start",
          "prompt.initial_constant",
          "hooks.session_start",
          "mcp.stdio",
          "control.interrupt",
          "control.terminate",
          "session.resume",
        ],
      },
    ],
  };
  async function refresh(now = LAUNCH_NOW, changes: Partial<RunnerInventory> = {}) {
    inventory = {
      ...inventory,
      revision: inventory.revision + 1,
      providers: inventory.providers.map((provider) => ({
        ...provider,
        observed_at: now,
        expires_at: launchDeadline(now, 30_000),
      })),
      ...changes,
    };
    return success(await native(replaceRunnerInventoryCommand, { principal, inventory }, now));
  }
  await refresh();
  const start: LaunchStartRequest = {
    schema_version: 1,
    idempotency_key: randomUlid(),
    task_id: task.id,
    expected_task_version: 1,
    runner_id: runner,
    checkout_id: checkout,
    agent_profile_id: profile.id,
    agent_profile_version: 1,
    workspace_policy_version: 2,
    project_policy_version: 2,
    repository_config_version: 2,
  };
  async function claim(humanId = FIX.owner) {
    const launch = success(await human(startLaunchCommand, start, LAUNCH_NOW, humanId));
    const request: LaunchClaim = {
      schema_version: 1,
      launch_id: launch.launch_id,
      runner_id: runner,
      idempotency_key: randomUlid(),
      claimed_at: LAUNCH_NOW,
    };
    const claimed = success(await native(claimLaunchCommand, { principal, claim: request }));
    if (claimed.state !== "claimed") throw new Error(claimed.state);
    const spec = claimed.claim.specification;
    const final: LaunchFinalRequest = {
      schema_version: 1,
      launch_id: launch.launch_id,
      run_execution_id: spec.run_execution_id,
      assignment_generation: spec.assignment_generation,
      fencing_generation: claimed.claim.fencing_generation,
      config_snapshot_id: spec.config_snapshot_id,
      config_snapshot_hash: spec.config_snapshot_hash,
      repository_config_hash: claimed.claim.snapshot.repository_config_hash,
      physical_worktree_hash: claimed.claim.snapshot.physical_worktree_hash,
      supervisor: { pid: 1234, start_identity: "123456:1000", executable_hash: SYNTHETIC_DIGEST },
      local_lock_id: randomUlid(),
    };
    return { launch, request, claimed: claimed.claim, final };
  }
  return {
    db,
    hub,
    runner,
    checkout,
    principal,
    profile,
    task,
    start,
    human,
    native,
    claim,
    refresh,
    inventory: () => inventory,
  };
}
