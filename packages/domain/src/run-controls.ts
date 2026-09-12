// ABOUTME: Owns short-lived human run controls and exact-session resumption into a new execution.
// ABOUTME: Claims and dispositions bind current principals and immutable assignments without releasing checkout locks.

import type { SqlDatabase } from "@bfb/db";
import type {
  RunControlClaim,
  RunControlDisposition,
  RunControlReference,
  RunControlRequest,
  RunControlResult,
} from "@bfb/protocol";

import { assertEpoch, loadPrincipal } from "./authorization.js";
import type { HubCommand, HubContext } from "./hub.js";
import { randomUlid } from "./ids.js";
import {
  assertLeaseBinding,
  endUnstartedLaunch,
  guardLaunchMutation,
  launchDeadline,
  launchHash,
  launchHuman,
  launchRunner,
  launchWire,
  readLaunch,
  readLease,
  reauthorizeLaunch,
  snapshotOf,
  type LaunchRow,
} from "./launch-state.js";
import { appendRunnerCommandReference, resolveRunnerCommandReference } from "./runner-channel.js";
import { rejectRunnerRequest, runnerHash, runnerObject } from "./runner-crypto.js";
import {
  assertCurrentRunnerPrincipal,
  assertRunnerLaunchAuthority,
  type RunnerPrincipal,
} from "./runners.js";

type ControlContext = Pick<HubContext, "db" | "workspaceId" | "now">;

interface ControlRow {
  id: string;
  workspace_id: string;
  execution_id: string;
  assignment_generation: number;
  runner_id: string;
  requesting_human_id: string;
  requesting_human_epoch: number;
  runner_authorization_epoch: number;
  runner_grant_epoch: number;
  runner_key_thumbprint: string;
  action: RunControlRequest["action"];
  idempotency_key_hash: string;
  request_hash: string;
  state: "pending" | "claimed" | "applied" | "rejected" | "expired";
  claim_key_hash: string | null;
  disposition: string | null;
  created_at: string;
  expires_at: string;
  disposed_at: string | null;
  resume_launch_id: string | null;
}

function summary(row: ControlRow): RunControlResult {
  return launchWire<RunControlResult>("run-control-result", {
    schema_version: 1,
    control_id: row.id,
    run_execution_id: row.execution_id,
    assignment_generation: row.assignment_generation,
    runner_id: row.runner_id,
    action: row.action,
    state: row.state,
    disposition: row.disposition,
    expires_at: row.expires_at,
    ...(row.resume_launch_id ? { resume_launch_id: row.resume_launch_id } : {}),
  });
}

async function target(ctx: ControlContext, execution: string, generation: number, runner: string) {
  const record = (await ctx.db
    .prepare(
      `SELECT id FROM launch_commands WHERE workspace_id = ? AND execution_id = ? AND assignment_generation = ?`,
    )
    .get(ctx.workspaceId, execution, generation)) as { id: string } | undefined;
  if (!record) rejectRunnerRequest();
  const row = await readLaunch(ctx.db, ctx.workspaceId, record.id);
  if (row.runner_id !== runner) rejectRunnerRequest();
  return row;
}

async function readControl(ctx: ControlContext, id: string) {
  const row = (await ctx.db
    .prepare(`SELECT * FROM run_controls WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, id)) as ControlRow | undefined;
  if (!row) rejectRunnerRequest();
  return row;
}

async function authority(ctx: ControlContext, control: ControlRow, row: LaunchRow) {
  const human = await loadPrincipal(ctx.db, ctx.workspaceId, control.requesting_human_id);
  assertEpoch(human, control.requesting_human_epoch);
  await assertRunnerLaunchAuthority(ctx.db, human, row.runner_id, row.project_id);
  const runner = (await ctx.db
    .prepare(
      `SELECT authorization_epoch, grant_epoch, key_thumbprint FROM runners WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, row.runner_id)) as {
    authorization_epoch: number;
    grant_epoch: number;
    key_thumbprint: string;
  };
  if (
    runner.authorization_epoch !== control.runner_authorization_epoch ||
    runner.grant_epoch !== control.runner_grant_epoch ||
    runner.key_thumbprint !== control.runner_key_thumbprint
  )
    rejectRunnerRequest();
}

/** A pulled ID reveals only this runner's authorized target; a separate fresh claim is mandatory. */
export async function readRunnerControl(
  db: SqlDatabase,
  rawPrincipal: RunnerPrincipal,
  raw: RunControlReference,
  now: string,
) {
  const principal = await assertCurrentRunnerPrincipal(db, rawPrincipal, now);
  const input = launchWire<RunControlReference>("run-control-reference", raw);
  const ctx = { db, workspaceId: principal.workspaceId, now };
  const control = await readControl(ctx, input.control_id);
  if (control.runner_id !== principal.runnerId) rejectRunnerRequest();
  const row = await target(
    ctx,
    control.execution_id,
    control.assignment_generation,
    principal.runnerId,
  );
  await authority(ctx, control, row);
  return summary(control);
}

async function checkTarget(ctx: HubContext, action: ControlRow["action"], row: LaunchRow) {
  const lease = await readLease(ctx.db, row);
  if (
    action === "cancel" &&
    (row.state === "pending" || row.state === "rejected" || row.state === "expired")
  )
    return;
  assertLeaseBinding(lease, row);
  if (action === "cancel" && row.state === "claimed" && lease.state === "reserved") return;
  if (action === "resume") {
    if (
      lease.state !== "released" ||
      (row.execution_state !== "ended" && row.execution_state !== "detached") ||
      (row.result_state !== "open" && row.result_state !== "changes_requested")
    )
      rejectRunnerRequest();
    return;
  }
  if (
    lease.state !== "live" ||
    !lease.identity_json ||
    (row.execution_state !== "attached" && row.execution_state !== "detached")
  )
    rejectRunnerRequest();
}

async function finishControl(
  ctx: HubContext,
  control: ControlRow,
  state: "rejected" | "expired",
  disposition: string,
) {
  await ctx.db
    .prepare(
      `UPDATE run_controls SET state = ?, disposition = ?, disposed_at = ? WHERE workspace_id = ? AND id = ? AND state IN ('pending', 'claimed')`,
    )
    .run(state, disposition, ctx.now, ctx.workspaceId, control.id);
  await resolveRunnerCommandReference(ctx, control.runner_id, control.id);
  return summary({ ...control, state, disposition, disposed_at: ctx.now });
}

export const createRunControlCommand: HubCommand<RunControlRequest, ReturnType<typeof summary>> = {
  name: "run_control.create",
  replay: "reject",
  auditInput: (input) => ({
    executionId: input.run_execution_id,
    assignmentGeneration: input.assignment_generation,
    runnerId: input.runner_id,
    action: input.action,
  }),
  async run(raw, ctx) {
    const input = launchWire<RunControlRequest>("run-control-request", raw),
      human = await launchHuman(ctx);
    const row = await target(
      ctx,
      input.run_execution_id,
      input.assignment_generation,
      input.runner_id,
    );
    await assertRunnerLaunchAuthority(ctx.db, human, row.runner_id, row.project_id);
    const keyHash = runnerHash(input.idempotency_key),
      requestHash = launchHash(input);
    const existing = (await ctx.db
      .prepare(
        `SELECT * FROM run_controls WHERE workspace_id = ? AND requesting_human_id = ? AND idempotency_key_hash = ?`,
      )
      .get(ctx.workspaceId, human.humanId, keyHash)) as ControlRow | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash) rejectRunnerRequest();
      await authority(ctx, existing, row);
      if (
        (existing.state === "pending" || existing.state === "claimed") &&
        Date.parse(existing.expires_at) <= Date.parse(ctx.now)
      )
        return finishControl(ctx, existing, "expired", "expired");
      return summary(existing);
    }
    await checkTarget(ctx, input.action, row);
    const runner = (await ctx.db
      .prepare(
        `SELECT authorization_epoch, grant_epoch, key_thumbprint FROM runners WHERE workspace_id = ? AND id = ?`,
      )
      .get(ctx.workspaceId, row.runner_id)) as {
      authorization_epoch: number;
      grant_epoch: number;
      key_thumbprint: string;
    };
    const localEffectUnneeded = input.action === "cancel" && row.state === "pending";
    const control: ControlRow = {
      id: randomUlid(),
      workspace_id: ctx.workspaceId,
      execution_id: row.execution_id,
      assignment_generation: row.assignment_generation,
      runner_id: row.runner_id,
      requesting_human_id: human.humanId,
      requesting_human_epoch: human.authorizationEpoch,
      runner_authorization_epoch: runner.authorization_epoch,
      runner_grant_epoch: runner.grant_epoch,
      runner_key_thumbprint: runner.key_thumbprint,
      action: input.action,
      idempotency_key_hash: keyHash,
      request_hash: requestHash,
      state: localEffectUnneeded ? "applied" : "pending",
      claim_key_hash: null,
      disposition: localEffectUnneeded ? "applied" : null,
      created_at: ctx.now,
      expires_at: launchDeadline(ctx.now),
      disposed_at: localEffectUnneeded ? ctx.now : null,
      resume_launch_id: null,
    };
    await ctx.db
      .prepare(
        `INSERT INTO run_controls (workspace_id, id, execution_id, assignment_generation, runner_id, requesting_human_id,
      requesting_human_epoch, runner_authorization_epoch, runner_grant_epoch, runner_key_thumbprint, action, idempotency_key_hash, request_hash,
      state, disposition, created_at, expires_at, disposed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        control.id,
        row.execution_id,
        row.assignment_generation,
        row.runner_id,
        human.humanId,
        human.authorizationEpoch,
        runner.authorization_epoch,
        runner.grant_epoch,
        runner.key_thumbprint,
        input.action,
        keyHash,
        requestHash,
        control.state,
        control.disposition,
        ctx.now,
        control.expires_at,
        control.disposed_at,
      );
    if (input.action === "cancel" || input.action === "terminate") {
      await ctx.db
        .prepare(
          `UPDATE launch_commands SET cancelled_at = COALESCE(cancelled_at, ?) WHERE workspace_id = ? AND id = ?`,
        )
        .run(ctx.now, ctx.workspaceId, row.id);
      if (row.state === "pending" || row.state === "claimed")
        await endUnstartedLaunch(ctx, row, "terminated");
    }
    if (!localEffectUnneeded)
      await appendRunnerCommandReference(ctx, row.runner_id, row.project_id, {
        command_id: control.id,
        command_kind: "run_control",
        expires_at: control.expires_at,
      });
    return summary(control);
  },
};

async function prepareResume(ctx: HubContext, control: ControlRow, row: LaunchRow) {
  const snapshot = snapshotOf(row);
  const sessions = (await ctx.db
    .prepare(
      `SELECT id, observed_session_id FROM provider_sessions WHERE workspace_id = ? AND run_id = ? AND execution_id = ?
    AND state = 'active' AND provider = ? AND observed_session_id IS NOT NULL LIMIT 2`,
    )
    .all(
      ctx.workspaceId,
      row.run_id,
      row.execution_id,
      snapshot.execution_config.provider,
    )) as Array<{ id: string; observed_session_id: string }>;
  if (
    sessions.length !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessions[0]!.observed_session_id)
  )
    rejectRunnerRequest();
  await reauthorizeLaunch(ctx, {
    ...row,
    requesting_human_id: control.requesting_human_id,
    requesting_human_epoch: control.requesting_human_epoch,
    runner_authorization_epoch: control.runner_authorization_epoch,
    runner_grant_epoch: control.runner_grant_epoch,
    runner_key_thumbprint: control.runner_key_thumbprint,
    resume_session_id: sessions[0]!.id,
    resume_observed_session_id: sessions[0]!.observed_session_id,
  });
  const counts = (await ctx.db
    .prepare(
      `SELECT
    (SELECT COUNT(*) FROM run_executions WHERE workspace_id = ? AND run_id = ? AND state != 'ended') AS active,
    (SELECT COALESCE(MAX(assignment_generation), 0) FROM execution_assignments WHERE workspace_id = ? AND run_id = ?) AS generation`,
    )
    .get(ctx.workspaceId, row.run_id, ctx.workspaceId, row.run_id)) as {
    active: number;
    generation: number;
  };
  if (counts.active) rejectRunnerRequest();
  return {
    session: sessions[0]!,
    execution: randomUlid(),
    launch: randomUlid(),
    generation: counts.generation + 1,
  };
}

async function persistResume(
  ctx: HubContext,
  control: ControlRow,
  row: LaunchRow,
  prepared: Awaited<ReturnType<typeof prepareResume>>,
) {
  await guardLaunchMutation(
    ctx,
    `NOT EXISTS (SELECT 1 FROM run_executions WHERE workspace_id = ? AND run_id = ? AND state != 'ended')`,
    [ctx.workspaceId, row.run_id],
  );
  await ctx.db
    .prepare(
      `INSERT INTO run_executions (workspace_id, id, run_id, state, resource_version, created_at) VALUES (?, ?, ?, 'queued', 1, ?)`,
    )
    .run(ctx.workspaceId, prepared.execution, row.run_id, ctx.now);
  await ctx.db
    .prepare(
      `INSERT INTO execution_assignments (workspace_id, execution_id, assignment_generation, run_id, task_id, project_id,
    runner_id, checkout_id, physical_worktree_hash, requesting_human_id, requesting_human_epoch, runner_authorization_epoch, runner_grant_epoch, runner_key_thumbprint, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.workspaceId,
      prepared.execution,
      prepared.generation,
      row.run_id,
      row.task_id,
      row.project_id,
      row.runner_id,
      row.checkout_id,
      row.physical_worktree_hash,
      control.requesting_human_id,
      control.requesting_human_epoch,
      control.runner_authorization_epoch,
      control.runner_grant_epoch,
      control.runner_key_thumbprint,
      ctx.now,
    );
  await ctx.db
    .prepare(
      `INSERT INTO launch_commands (workspace_id, id, execution_id, assignment_generation, run_id, requesting_human_id,
    idempotency_key_hash, request_hash, state, snapshot_id, created_at, expires_at, resume_session_id, resume_observed_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.workspaceId,
      prepared.launch,
      prepared.execution,
      prepared.generation,
      row.run_id,
      control.requesting_human_id,
      runnerHash(`resume:${control.id}`),
      runnerHash(control.id),
      row.snapshot_id,
      ctx.now,
      control.expires_at,
      prepared.session.id,
      prepared.session.observed_session_id,
    );
  await appendRunnerCommandReference(ctx, row.runner_id, row.project_id, {
    command_id: prepared.launch,
    command_kind: "launch",
    expires_at: control.expires_at,
  });
}

export const claimRunControlCommand: HubCommand<
  { principal: RunnerPrincipal; claim: RunControlClaim },
  ReturnType<typeof summary>
> = {
  name: "run_control.claim",
  replay: "reject",
  auditInput: (input) => ({
    runnerId: input.principal.runnerId,
    controlId: input.claim.control_id,
  }),
  async run(input, ctx) {
    runnerObject(input, ["principal", "claim"]);
    const request = launchWire<RunControlClaim>("run-control-claim", input.claim),
      principal = await launchRunner(ctx, input.principal);
    const control = await readControl(ctx, request.control_id);
    if (
      control.runner_id !== principal.runnerId ||
      control.execution_id !== request.run_execution_id ||
      control.assignment_generation !== request.assignment_generation ||
      control.action !== request.action
    )
      rejectRunnerRequest();
    const keyHash = runnerHash(request.idempotency_key);
    if (control.claim_key_hash && control.claim_key_hash !== keyHash) rejectRunnerRequest();
    const row = await target(
      ctx,
      control.execution_id,
      control.assignment_generation,
      principal.runnerId,
    );
    try {
      await authority(ctx, control, row);
    } catch {
      if (control.state === "pending" || control.state === "claimed")
        return finishControl(ctx, control, "rejected", "authorization_lost");
      rejectRunnerRequest();
    }
    if (control.state === "applied" || control.state === "rejected" || control.state === "expired")
      return summary(control);
    if (Date.parse(control.expires_at) <= Date.parse(ctx.now))
      return finishControl(ctx, control, "expired", "expired");
    if (control.resume_launch_id) {
      const resumed = await readLaunch(ctx.db, ctx.workspaceId, control.resume_launch_id);
      if (resumed.cancelled_at || resumed.state === "rejected" || resumed.state === "expired")
        return finishControl(ctx, control, "rejected", "local_rejected");
      await reauthorizeLaunch(ctx, resumed);
      return summary(control);
    }
    try {
      await checkTarget(ctx, control.action, row);
    } catch {
      return finishControl(ctx, control, "rejected", "local_rejected");
    }
    const resumed =
      control.action === "resume" ? await prepareResume(ctx, control, row) : undefined;
    if (resumed) await persistResume(ctx, control, row, resumed);
    await ctx.db
      .prepare(
        `UPDATE run_controls SET state = 'claimed', claim_key_hash = ?, resume_launch_id = ? WHERE workspace_id = ? AND id = ?`,
      )
      .run(keyHash, resumed?.launch ?? null, ctx.workspaceId, control.id);
    return summary({
      ...control,
      state: "claimed",
      claim_key_hash: keyHash,
      resume_launch_id: resumed?.launch ?? null,
    });
  },
};

export const acknowledgeRunControlCommand: HubCommand<
  { principal: RunnerPrincipal; acknowledgement: RunControlDisposition },
  ReturnType<typeof summary>
> = {
  name: "run_control.acknowledge",
  replay: "reject",
  auditInput: (input) => ({
    runnerId: input.principal.runnerId,
    controlId: input.acknowledgement.control_id,
    disposition: input.acknowledgement.disposition,
  }),
  async run(input, ctx) {
    runnerObject(input, ["principal", "acknowledgement"]);
    const request = launchWire<RunControlDisposition>(
        "run-control-disposition",
        input.acknowledgement,
      ),
      principal = await launchRunner(ctx, input.principal);
    const control = await readControl(ctx, request.control_id);
    if (
      control.runner_id !== principal.runnerId ||
      control.execution_id !== request.run_execution_id ||
      control.assignment_generation !== request.assignment_generation ||
      control.claim_key_hash !== runnerHash(request.idempotency_key)
    )
      rejectRunnerRequest();
    const row = await target(
      ctx,
      control.execution_id,
      control.assignment_generation,
      principal.runnerId,
    );
    await authority(ctx, control, row);
    if (control.state === "applied" || control.state === "rejected") {
      if (
        control.disposition !== request.disposition &&
        !(control.state === "applied" && request.disposition === "already_applied")
      )
        rejectRunnerRequest();
      return summary(control);
    }
    if (control.state !== "claimed") rejectRunnerRequest();
    if (Date.parse(control.expires_at) <= Date.parse(ctx.now))
      return finishControl(ctx, control, "expired", "expired");
    if (
      control.resume_launch_id &&
      (request.disposition === "applied" || request.disposition === "already_applied")
    ) {
      const resumed = await readLaunch(ctx.db, ctx.workspaceId, control.resume_launch_id);
      if (resumed.state !== "started") rejectRunnerRequest();
    }
    const applied = request.disposition === "applied" || request.disposition === "already_applied";
    await ctx.db
      .prepare(
        `UPDATE run_controls SET state = ?, disposition = ?, disposed_at = ? WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        applied ? "applied" : "rejected",
        request.disposition,
        ctx.now,
        ctx.workspaceId,
        control.id,
      );
    await resolveRunnerCommandReference(ctx, control.runner_id, control.id);
    return summary({
      ...control,
      state: applied ? "applied" : "rejected",
      disposition: request.disposition,
      disposed_at: ctx.now,
    });
  },
};
