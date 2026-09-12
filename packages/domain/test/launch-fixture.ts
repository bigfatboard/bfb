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

import { FIX, seedSyntheticWorkspace } from "../src/fixtures.js";
import { WorkspaceHub, type CommandOutcome, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { launchDeadline } from "../src/launch-state.js";
import { claimLaunchCommand, startLaunchCommand } from "../src/launches.js";
import {
  createAgentProfileCommand,
  reportRepositoryConfigCommand,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
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

export async function launchFixture(database?: SqlDatabase) {
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
  success(
    await human(updateWorkspacePolicyCommand, {
      ...policy,
      allowedProviders: [...policy.allowedProviders],
      expectedVersion: 1,
    }),
  );
  success(
    await human(updateProjectPolicyCommand, {
      ...policy,
      allowedProviders: [...policy.allowedProviders],
      expectedVersion: 1,
      projectId: FIX.projectA,
    }),
  );
  success(
    await human(reportRepositoryConfigCommand, {
      projectId: FIX.projectA,
      expectedVersion: 1,
      document: {},
      contentHash: EMPTY_CONFIG_HASH,
    }),
  );
  const profile = success(
    await human(createAgentProfileCommand, {
      name: "Synthetic launch provider",
      provider: "fake",
      model: "synthetic",
      executionMode: "interactive",
      harnessMode: "restricted",
    }),
  );
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
