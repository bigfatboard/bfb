// ABOUTME: Creates, claims and reauthorizes immutable run launches through WorkspaceHub.
// ABOUTME: Durable request keys deduplicate effects while every retry checks current authority.

import type {
  ExecutionAssignment,
  FinalAuthorization,
  LaunchClaim,
  LaunchClaimResult,
  LaunchFinalRequest,
  LaunchSnapshot,
  LaunchStartRequest,
} from "@bfb/protocol";

import { assertEpoch } from "./authorization.js";
import { type HubCommand } from "./hub.js";
import { randomUlid } from "./ids.js";
import { normalizeRepositoryConfig } from "./projects.js";
import { appendRunnerCommandReference } from "./runner-channel.js";
import { rejectRunnerRequest, runnerHash, runnerId, runnerObject } from "./runner-crypto.js";
import { assertRunnerLaunchAuthority, type RunnerPrincipal } from "./runners.js";
import { prepareRunCreation, persistRunCreation, type RunRecord } from "./work-records.js";
import {
  assertLeaseBinding,
  canonicalLaunchJson,
  createRunInput,
  endUnstartedLaunch,
  guardLaunchMutation,
  launchDeadline,
  launchHash,
  launchHuman,
  launchRunner,
  launchSummary,
  launchWire,
  LEASE_TTL_MS,
  policySettings,
  readLaunch,
  readLaunchEnvironment,
  readLease,
  reauthorizeLaunch,
  snapshotOf,
  type LaunchRow,
  type LeaseRow,
} from "./launch-state.js";

export const startLaunchCommand: HubCommand<
  LaunchStartRequest,
  ReturnType<typeof launchSummary>
> = {
  name: "launch.start",
  replay: "reject",
  auditInput: (input) => ({
    taskId: input.task_id,
    runnerId: input.runner_id,
    checkoutId: input.checkout_id,
    agentProfileId: input.agent_profile_id,
  }),
  async run(raw, ctx) {
    const input = launchWire<LaunchStartRequest>("launch-start-request", raw);
    const principal = await launchHuman(ctx);
    const keyHash = runnerHash(input.idempotency_key),
      requestHash = launchHash(input);
    const existing = (await ctx.db
      .prepare(
        `SELECT id FROM launch_commands WHERE workspace_id = ? AND requesting_human_id = ? AND idempotency_key_hash = ?`,
      )
      .get(ctx.workspaceId, principal.humanId, keyHash)) as { id: string } | undefined;
    if (existing) {
      const row = await readLaunch(ctx.db, ctx.workspaceId, existing.id);
      if (row.request_hash !== requestHash) rejectRunnerRequest();
      assertEpoch(principal, row.requesting_human_epoch);
      await assertRunnerLaunchAuthority(ctx.db, principal, row.runner_id, row.project_id);
      if (row.state === "pending" || row.state === "claimed") {
        if (Date.parse(row.expires_at) <= Date.parse(ctx.now)) {
          await endUnstartedLaunch(ctx, row, "launch_expired");
          return launchSummary({ ...row, state: "expired" });
        }
        await reauthorizeLaunch(ctx, row, false);
      }
      return launchSummary(row);
    }

    const prepared = await prepareRunCreation(createRunInput(input), ctx);
    const { task, run } = prepared.result;
    await assertRunnerLaunchAuthority(ctx.db, principal, input.runner_id, task.project_id);
    const environment = await readLaunchEnvironment(
      ctx,
      {
        runnerId: input.runner_id,
        checkoutId: input.checkout_id,
        projectId: task.project_id,
        profileId: input.agent_profile_id,
        taskId: task.id,
      },
      false,
    );
    if (
      environment.snapshot.workspace_policy_version !== input.workspace_policy_version ||
      environment.snapshot.project_policy_version !== input.project_policy_version ||
      environment.snapshot.repository_config_version !== input.repository_config_version ||
      environment.snapshot.agent_profile_version !== input.agent_profile_version ||
      environment.checkout.repository_config_hash !== environment.snapshot.repository_config_hash
    )
      rejectRunnerRequest();
    const occupied = await readLease(ctx.db, {
      runner_id: input.runner_id,
      physical_worktree_hash: environment.checkout.physical_worktree_hash,
    });
    if (occupied && occupied.state !== "released") rejectRunnerRequest();

    let generation = 1;
    if (input.retry_run_id) {
      const retry = (await ctx.db
        .prepare(
          `SELECT run.*,
        (SELECT COUNT(*) FROM provider_sessions WHERE workspace_id = run.workspace_id AND run_id = run.id) AS sessions,
        (SELECT COUNT(*) FROM run_executions WHERE workspace_id = run.workspace_id AND run_id = run.id AND state != 'ended') AS active,
        (SELECT COALESCE(MAX(assignment_generation), 0) FROM execution_assignments WHERE workspace_id = run.workspace_id AND run_id = run.id) AS generation,
        (SELECT COALESCE(MAX(snapshot_generation), 0) FROM run_configuration_snapshots WHERE workspace_id = run.workspace_id AND run_id = run.id) AS snapshot_generation
        FROM runs AS run WHERE run.workspace_id = ? AND run.id = ?`,
        )
        .get(ctx.workspaceId, input.retry_run_id)) as
        | (RunRecord & {
            sessions: number;
            active: number;
            generation: number;
            snapshot_generation: number;
          })
        | undefined;
      if (
        !retry ||
        retry.task_id !== task.id ||
        retry.project_id !== task.project_id ||
        retry.agent_profile_id !== input.agent_profile_id ||
        retry.requested_by_human_id !== principal.humanId ||
        retry.result_state !== "open" ||
        retry.sessions ||
        retry.active ||
        retry.generation < 1
      )
        rejectRunnerRequest();
      Object.assign(run, {
        id: retry.id,
        activity: retry.activity,
        resource_version: retry.resource_version,
      });
      prepared.existingRun = true;
      prepared.snapshotGeneration = retry.snapshot_generation + 1;
      generation = retry.generation + 1;
    }
    const snapshot: LaunchSnapshot = {
      ...environment.snapshot,
      snapshot_generation: prepared.snapshotGeneration ?? 1,
    };
    prepared.result.snapshot.canonicalJson = canonicalLaunchJson(snapshot);
    prepared.result.snapshot.contentHash = `sha256:${launchHash(snapshot)}`;
    const id = randomUlid(),
      execution = randomUlid(),
      expires = launchDeadline(ctx.now);
    await guardLaunchMutation(
      ctx,
      `EXISTS (SELECT 1 FROM tasks WHERE workspace_id = ? AND id = ? AND state = 'ready' AND resource_version = ?)`,
      [ctx.workspaceId, task.id, input.expected_task_version],
    );
    await persistRunCreation(prepared, ctx);
    await ctx.db
      .prepare(
        `INSERT INTO run_executions (workspace_id, id, run_id, state, resource_version, created_at) VALUES (?, ?, ?, 'queued', 1, ?)`,
      )
      .run(ctx.workspaceId, execution, run.id, ctx.now);
    await ctx.db
      .prepare(
        `INSERT INTO execution_assignments (workspace_id, execution_id, assignment_generation, run_id, task_id, project_id,
      runner_id, checkout_id, physical_worktree_hash, requesting_human_id, requesting_human_epoch,
      runner_authorization_epoch, runner_grant_epoch, runner_key_thumbprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        execution,
        generation,
        run.id,
        task.id,
        task.project_id,
        input.runner_id,
        input.checkout_id,
        snapshot.physical_worktree_hash,
        principal.humanId,
        principal.authorizationEpoch,
        environment.runner.authorization_epoch,
        environment.runner.grant_epoch,
        environment.runner.key_thumbprint,
        ctx.now,
      );
    await ctx.db
      .prepare(
        `INSERT INTO launch_commands (workspace_id, id, execution_id, assignment_generation, run_id, requesting_human_id,
      idempotency_key_hash, request_hash, state, snapshot_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        id,
        execution,
        generation,
        run.id,
        principal.humanId,
        keyHash,
        requestHash,
        prepared.result.snapshot.id,
        ctx.now,
        expires,
      );
    await appendRunnerCommandReference(ctx, input.runner_id, task.project_id, {
      command_id: id,
      command_kind: "launch",
      expires_at: expires,
    });
    return launchSummary({
      id,
      execution_id: execution,
      assignment_generation: generation,
      run_id: run.id,
      runner_id: input.runner_id,
      checkout_id: input.checkout_id,
      state: "pending",
      expires_at: expires,
    });
  },
};

function claimResult(row: LaunchRow, lease: LeaseRow): LaunchClaimResult {
  const snapshot = snapshotOf(row);
  const assignment: ExecutionAssignment = {
    schema_version: 1,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    task_id: row.task_id,
    run_id: row.run_id,
    run_execution_id: row.execution_id,
    assignment_generation: row.assignment_generation,
    runner_id: row.runner_id,
    checkout_id: row.checkout_id,
    created_at: row.created_at,
  };
  return launchWire<LaunchClaimResult>("launch-claim-result", {
    schema_version: 1,
    assignment,
    snapshot,
    specification: {
      schema_version: 1,
      launch_id: row.id,
      run_id: row.run_id,
      run_execution_id: row.execution_id,
      assignment_generation: row.assignment_generation,
      task_id: row.task_id,
      runner_id: row.runner_id,
      checkout_id: row.checkout_id,
      agent_profile_id: snapshot.agent_profile_id,
      config_snapshot_id: row.snapshot_id,
      config_snapshot_hash: row.snapshot_hash,
      execution_config: snapshot.execution_config,
      expires_at: row.expires_at,
      ...(row.resume_session_id
        ? {
            resume_session: {
              provider_session_id: row.resume_session_id,
              observed_session_id: row.resume_observed_session_id,
            },
          }
        : {}),
    },
    fencing_generation: lease.fencing_generation,
    lease_expires_at: lease.expires_at,
  });
}

type ClaimOutcome =
  | { state: "claimed"; claim: LaunchClaimResult }
  | { state: "expired" | "rejected"; reason: "launch_expired" | "launch_blocked" };

export const claimLaunchCommand: HubCommand<
  { principal: RunnerPrincipal; claim: LaunchClaim },
  ClaimOutcome
> = {
  name: "launch.claim",
  replay: "reject",
  auditInput: (input) => ({ runnerId: input.principal.runnerId, launchId: input.claim.launch_id }),
  async run(input, ctx) {
    runnerObject(input, ["principal", "claim"]);
    const request = launchWire<LaunchClaim>("launch-claim", input.claim);
    const principal = await launchRunner(ctx, input.principal);
    if (request.runner_id !== principal.runnerId || request.device_proof_nonce !== undefined)
      rejectRunnerRequest();
    const row = await readLaunch(ctx.db, ctx.workspaceId, request.launch_id);
    if (row.runner_id !== principal.runnerId) rejectRunnerRequest();
    const keyHash = runnerHash(request.idempotency_key);
    if ((row.claim_key_hash && row.claim_key_hash !== keyHash) || row.state === "started")
      rejectRunnerRequest();
    if (row.state === "expired" || row.state === "rejected")
      return {
        state: row.state,
        reason: row.state === "expired" ? "launch_expired" : "launch_blocked",
      };
    if (Date.parse(row.expires_at) <= Date.parse(ctx.now)) {
      await endUnstartedLaunch(ctx, row, "launch_expired");
      return { state: "expired", reason: "launch_expired" };
    }
    const lease = await readLease(ctx.db, row);
    try {
      if (row.cancelled_at) rejectRunnerRequest();
      await reauthorizeLaunch(ctx, row);
    } catch {
      await endUnstartedLaunch(ctx, row, "launch_blocked");
      return { state: "rejected", reason: "launch_blocked" };
    }
    if (row.state === "claimed") {
      assertLeaseBinding(lease, row);
      if (lease.state !== "reserved" || lease.expires_at <= ctx.now) rejectRunnerRequest();
      return { state: "claimed", claim: claimResult(row, lease) };
    }
    if (lease && lease.state !== "released") {
      await endUnstartedLaunch(ctx, row, "launch_blocked");
      return { state: "rejected", reason: "launch_blocked" };
    }
    const fence = (lease?.fencing_generation ?? 0) + 1;
    const claimedLease: LeaseRow = {
      workspace_id: ctx.workspaceId,
      runner_id: row.runner_id,
      physical_worktree_hash: row.physical_worktree_hash,
      execution_id: row.execution_id,
      assignment_generation: row.assignment_generation,
      fencing_generation: fence,
      state: "reserved",
      expires_at: launchDeadline(ctx.now, LEASE_TTL_MS),
      observation_sequence: 0,
      observed_at: null,
      identity_json: null,
      containment_reason: null,
      released_at: null,
    };
    const result = claimResult(row, claimedLease);
    await guardLaunchMutation(
      ctx,
      `EXISTS (SELECT 1 FROM launch_commands WHERE workspace_id = ? AND id = ? AND state = 'pending' AND claim_key_hash IS NULL AND cancelled_at IS NULL)`,
      [ctx.workspaceId, row.id],
    );
    await guardLaunchMutation(
      ctx,
      `NOT EXISTS (SELECT 1 FROM checkout_leases WHERE runner_id = ? AND physical_worktree_hash = ? AND state != 'released')`,
      [row.runner_id, row.physical_worktree_hash],
    );
    await ctx.db
      .prepare(
        `INSERT INTO checkout_leases (workspace_id, runner_id, physical_worktree_hash, execution_id, assignment_generation, fencing_generation, state, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?) ON CONFLICT (runner_id, physical_worktree_hash) DO UPDATE SET
      workspace_id = excluded.workspace_id, execution_id = excluded.execution_id, assignment_generation = excluded.assignment_generation,
      fencing_generation = excluded.fencing_generation, state = 'reserved', expires_at = excluded.expires_at, observation_sequence = 0,
      observed_at = NULL, identity_json = NULL, containment_reason = NULL, released_at = NULL`,
      )
      .run(
        ctx.workspaceId,
        row.runner_id,
        row.physical_worktree_hash,
        row.execution_id,
        row.assignment_generation,
        fence,
        claimedLease.expires_at,
      );
    await ctx.db
      .prepare(
        `UPDATE launch_commands SET state = 'claimed', claimed_at = ?, claim_key_hash = ? WHERE workspace_id = ? AND id = ?`,
      )
      .run(ctx.now, keyHash, ctx.workspaceId, row.id);
    await ctx.db
      .prepare(
        `UPDATE run_executions SET state = 'launching', resource_version = resource_version + 1 WHERE workspace_id = ? AND id = ? AND state = 'queued'`,
      )
      .run(ctx.workspaceId, row.execution_id);
    return { state: "claimed", claim: result };
  },
};

export const authorizeLaunchCommand: HubCommand<
  { principal: RunnerPrincipal; authorization: LaunchFinalRequest },
  FinalAuthorization
> = {
  name: "launch.authorize",
  replay: "reject",
  auditInput: (input) => ({
    runnerId: input.principal.runnerId,
    launchId: input.authorization.launch_id,
    executionId: input.authorization.run_execution_id,
    generation: input.authorization.assignment_generation,
  }),
  async run(input, ctx) {
    runnerObject(input, ["principal", "authorization"]);
    const request = launchWire<LaunchFinalRequest>("launch-final-request", input.authorization);
    const principal = await launchRunner(ctx, input.principal);
    const row = await readLaunch(ctx.db, ctx.workspaceId, request.launch_id);
    if (
      row.runner_id !== principal.runnerId ||
      row.execution_id !== request.run_execution_id ||
      row.assignment_generation !== request.assignment_generation
    )
      rejectRunnerRequest();
    const lease = await readLease(ctx.db, row);
    assertLeaseBinding(lease, row, request.fencing_generation);
    const response = {
      schema_version: 1 as const,
      launch_id: row.id,
      run_execution_id: row.execution_id,
      assignment_generation: row.assignment_generation,
      authorized_at: ctx.now,
    };
    const identity = canonicalLaunchJson({
      supervisor: request.supervisor,
      local_lock_id: request.local_lock_id,
    });
    let reason: "launch_expired" | "launch_blocked" | undefined;
    try {
      if (
        row.state !== "claimed" ||
        row.cancelled_at ||
        row.execution_state !== "launching" ||
        lease.state !== "reserved" ||
        Date.parse(lease.expires_at) <= Date.parse(ctx.now) ||
        (row.final_identity_json && row.final_identity_json !== identity)
      )
        rejectRunnerRequest();
      if (Date.parse(row.expires_at) <= Date.parse(ctx.now)) {
        reason = "launch_expired";
        rejectRunnerRequest();
      }
      const { snapshot } = await reauthorizeLaunch(ctx, row);
      if (
        row.snapshot_id !== request.config_snapshot_id ||
        row.snapshot_hash !== request.config_snapshot_hash ||
        snapshot.repository_config_hash !== request.repository_config_hash ||
        row.physical_worktree_hash !== request.physical_worktree_hash
      )
        rejectRunnerRequest();
    } catch {
      reason ??= "launch_blocked";
    }
    if (reason) {
      if (row.state === "claimed" || row.state === "pending")
        await endUnstartedLaunch(ctx, row, reason);
      return {
        ...response,
        decision: "rejected",
        rejection: {
          schema_version: 1,
          category: "authorization_denied",
          code: reason,
          message: "launch authorization rejected",
        },
      };
    }
    await ctx.db
      .prepare(
        `UPDATE launch_commands SET final_authorized_at = ?, final_identity_json = ? WHERE workspace_id = ? AND id = ? AND state = 'claimed'`,
      )
      .run(ctx.now, identity, ctx.workspaceId, row.id);
    return { ...response, decision: "authorized" };
  },
};

export const rejectLaunchCommand: HubCommand<
  {
    principal: RunnerPrincipal;
    launchId: string;
    executionId: string;
    assignmentGeneration: number;
  },
  { state: "rejected" | "expired" }
> = {
  name: "launch.reject",
  replay: "reject",
  auditInput: (input) => ({ runnerId: input.principal.runnerId, launchId: input.launchId }),
  async run(input, ctx) {
    runnerObject(input, ["principal", "launchId", "executionId", "assignmentGeneration"]);
    const principal = await launchRunner(ctx, input.principal);
    const row = await readLaunch(ctx.db, ctx.workspaceId, runnerId(input.launchId));
    if (
      row.runner_id !== principal.runnerId ||
      row.execution_id !== runnerId(input.executionId) ||
      row.assignment_generation !== input.assignmentGeneration ||
      row.state === "started"
    )
      rejectRunnerRequest();
    const expired = Date.parse(row.expires_at) <= Date.parse(ctx.now);
    await endUnstartedLaunch(ctx, row, expired ? "launch_expired" : "launch_blocked");
    return { state: expired ? "expired" : "rejected" };
  },
};

export const tightenLaunchCommand: HubCommand<
  {
    principal: RunnerPrincipal;
    launchId: string;
    executionId: string;
    assignmentGeneration: number;
    fencingGeneration: number;
    snapshotHash: string;
    repositoryConfigHash: string;
    document: unknown;
  },
  LaunchClaimResult
> = {
  name: "launch.tighten",
  replay: "reject",
  auditInput: (input) => ({
    runnerId: input.principal.runnerId,
    launchId: input.launchId,
    repositoryConfigHash: input.repositoryConfigHash,
  }),
  async run(input, ctx) {
    runnerObject(input, [
      "principal",
      "launchId",
      "executionId",
      "assignmentGeneration",
      "fencingGeneration",
      "snapshotHash",
      "repositoryConfigHash",
      "document",
    ]);
    const principal = await launchRunner(ctx, input.principal);
    const row = await readLaunch(ctx.db, ctx.workspaceId, runnerId(input.launchId));
    if (
      row.runner_id !== principal.runnerId ||
      row.execution_id !== runnerId(input.executionId) ||
      row.assignment_generation !== input.assignmentGeneration ||
      row.snapshot_hash !== input.snapshotHash ||
      row.state !== "claimed" ||
      row.cancelled_at ||
      row.final_authorized_at ||
      Date.parse(row.expires_at) <= Date.parse(ctx.now)
    )
      rejectRunnerRequest();
    const lease = await readLease(ctx.db, row);
    assertLeaseBinding(lease, row, input.fencingGeneration);
    if (lease.state !== "reserved" || Date.parse(lease.expires_at) <= Date.parse(ctx.now))
      rejectRunnerRequest();
    const snapshot = snapshotOf(row);
    // A fresh inventory reports the new hash; all other authority checks still bind the old snapshot.
    await reauthorizeLaunch(ctx, row, true, input.repositoryConfigHash);
    const normalized = normalizeRepositoryConfig(
      input.document,
      policySettings(snapshot.repository_policy),
    );
    const hash = `sha256:${runnerHash(normalized.canonical)}`;
    if (
      hash !== input.repositoryConfigHash ||
      !normalized.settings.allowPassToAgent ||
      !normalized.settings.allowedProviders.includes(snapshot.execution_config.provider)
    )
      rejectRunnerRequest();
    if (hash === snapshot.repository_config_hash) return claimResult(row, lease);
    const next = launchWire<LaunchSnapshot>("launch-snapshot", {
      ...snapshot,
      snapshot_generation: snapshot.snapshot_generation + 1,
      repository_config_hash: hash,
      repository_policy: {
        allowed_providers: normalized.settings.allowedProviders,
        allow_agent_root_propose: normalized.settings.allowAgentRootPropose,
        allow_pass_to_agent: normalized.settings.allowPassToAgent,
        allow_run_overrides: normalized.settings.allowRunOverrides,
      },
    });
    const snapshotId = randomUlid(),
      canonical = canonicalLaunchJson(next),
      contentHash = `sha256:${launchHash(next)}`;
    const updated = {
      ...row,
      snapshot_id: snapshotId,
      canonical_json: canonical,
      snapshot_hash: contentHash,
    };
    const result = claimResult(updated, lease);
    await ctx.db
      .prepare(
        `INSERT INTO run_configuration_snapshots (workspace_id, id, project_id, run_id, workspace_policy_version, project_policy_version,
      repository_config_version, agent_profile_id, agent_profile_version, canonical_json, content_hash, created_at, snapshot_generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        snapshotId,
        row.project_id,
        row.run_id,
        next.workspace_policy_version,
        next.project_policy_version,
        next.repository_config_version,
        next.agent_profile_id,
        next.agent_profile_version,
        canonical,
        contentHash,
        ctx.now,
        next.snapshot_generation,
      );
    await ctx.db
      .prepare(`UPDATE launch_commands SET snapshot_id = ? WHERE workspace_id = ? AND id = ?`)
      .run(snapshotId, ctx.workspaceId, row.id);
    return result;
  },
};
