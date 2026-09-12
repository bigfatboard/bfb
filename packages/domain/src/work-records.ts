// ABOUTME: Owns C08 run snapshots, execution state, and provider-session foundations.
// ABOUTME: State transitions are explicit and never infer results from process or session endings.

import { createHash } from "node:crypto";

import { assertEpoch, assertProjectAccess, assertRole, loadPrincipal } from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { randomUlid } from "./ids.js";
import { PROVIDERS, type Provider } from "./projects.js";
import { getTask, type TaskRecord } from "./work-commands.js";

export const RUN_RESULT_STATES = [
  "open",
  "submitted",
  "changes_requested",
  "accepted",
  "failed",
  "cancelled",
] as const;
export type RunResultState = (typeof RUN_RESULT_STATES)[number];
export const RUN_ACTIVITIES = [
  "working",
  "needs_human",
  "waiting_user_submit",
  "waiting_external",
  "idle",
  "offline",
  "unknown",
] as const;
export type RunActivity = (typeof RUN_ACTIVITIES)[number];
export const EXECUTION_STATES = ["queued", "launching", "attached", "detached", "ended"] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];
export const EXECUTION_END_REASONS = [
  "launch_blocked",
  "launch_expired",
  "process_exit",
  "terminated",
  "lost",
] as const;
export type ExecutionEndReason = (typeof EXECUTION_END_REASONS)[number];

const RUN_TRANSITIONS: Record<RunResultState, readonly RunResultState[]> = {
  open: ["submitted", "failed", "cancelled"],
  submitted: ["changes_requested", "accepted"],
  changes_requested: ["submitted", "failed", "cancelled"],
  accepted: [],
  failed: [],
  cancelled: [],
};

const EXECUTION_TRANSITIONS: Record<ExecutionState, readonly ExecutionState[]> = {
  queued: ["launching", "ended"],
  launching: ["attached", "ended"],
  attached: ["detached", "ended"],
  detached: ["attached", "ended"],
  ended: [],
};

export function assertRunResultTransition(from: RunResultState, to: RunResultState): void {
  if (from !== to && !RUN_TRANSITIONS[from].includes(to)) {
    throw new DomainError("invalid_transition", `run result cannot move from ${from} to ${to}`);
  }
}

export function assertExecutionTransition(from: ExecutionState, to: ExecutionState): void {
  if (from !== to && !EXECUTION_TRANSITIONS[from].includes(to)) {
    throw new DomainError("invalid_transition", `execution cannot move from ${from} to ${to}`);
  }
}

async function requireHuman(ctx: HubContext) {
  if (!ctx.actorHumanId || ctx.actorDelegationId) {
    throw new DomainError("forbidden", "direct authorized human required");
  }
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertEpoch(principal, ctx.authorizationEpoch);
  assertRole(principal, ["owner", "member"]);
  return principal;
}

function version(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new DomainError("invalid_argument", `${field} is invalid`);
  }
  return Number(value);
}

function providers(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new DomainError("invalid_policy", "stored provider policy is invalid");
  }
  return parsed;
}

interface PolicyVersionRow {
  allowed_providers_json: string;
  allow_agent_root_propose: number;
  allow_pass_to_agent: number;
  allow_run_overrides: number;
  current_version: number;
}

interface ProfileVersionRow {
  name: string;
  provider: Provider;
  model: string | null;
  execution_mode: "interactive" | "headless";
  harness_mode: "restricted" | "standard";
  current_version: number;
}

export interface RunRecord {
  id: string;
  project_id: string;
  task_id: string;
  requested_by_human_id: string;
  agent_profile_id: string;
  result_state: RunResultState;
  activity: RunActivity;
  resource_version: number;
}

export interface CreateRunInput {
  taskId: string;
  expectedTaskVersion: number;
  agentProfileId: string;
  workspacePolicyVersion: number;
  projectPolicyVersion: number;
  repositoryConfigVersion: number;
  agentProfileVersion: number;
}

export interface CreateRunResult {
  run: RunRecord;
  task: TaskRecord;
  snapshot: {
    id: string;
    contentHash: string;
    canonicalJson: string;
  };
}

export const createRunCommand: HubCommand<CreateRunInput, CreateRunResult> = {
  name: "run.create",
  async run(input, ctx) {
    const prepared = await prepareRunCreation(input, ctx);
    await persistRunCreation(prepared, ctx);
    return prepared.result;
  },
};

/** Prepared before writes so launch creation can validate every D1 precondition atomically. */
export interface PreparedRunCreation {
  input: CreateRunInput;
  result: CreateRunResult;
  existingRun?: boolean;
  snapshotGeneration?: number;
}

export async function prepareRunCreation(
  input: CreateRunInput,
  ctx: HubContext,
): Promise<PreparedRunCreation> {
  const principal = await requireHuman(ctx);
  const task = await getTask(ctx.db, ctx.workspaceId, input.taskId);
  if (!task) {
    throw new DomainError("not_found", "task not found");
  }
  assertProjectAccess(principal, task.project_id);
  const expectedTaskVersion = version(input.expectedTaskVersion, "expected task version");
  if (task.resource_version !== expectedTaskVersion) {
    throw new DomainError("stale_version", "task version conflict");
  }
  if (task.state !== "ready") {
    throw new DomainError("invalid_transition", "a new run requires a ready task");
  }
  const workspacePolicyVersion = version(input.workspacePolicyVersion, "workspace policy version");
  const projectPolicyVersion = version(input.projectPolicyVersion, "project policy version");
  const repositoryConfigVersion = version(
    input.repositoryConfigVersion,
    "repository config version",
  );
  const agentProfileVersion = version(input.agentProfileVersion, "agent profile version");

  const workspace = (await ctx.db
    .prepare(
      `SELECT version.allowed_providers_json, version.allow_agent_root_propose,
                version.allow_pass_to_agent, version.allow_run_overrides,
                current.resource_version AS current_version
         FROM workspace_policy_versions AS version
         JOIN workspace_policies AS current ON current.workspace_id = version.workspace_id
         WHERE version.workspace_id = ? AND version.version = ?`,
    )
    .get(ctx.workspaceId, workspacePolicyVersion)) as PolicyVersionRow | undefined;
  const project = (await ctx.db
    .prepare(
      `SELECT version.allowed_providers_json, version.allow_agent_root_propose,
                version.allow_pass_to_agent, version.allow_run_overrides,
                current.resource_version AS current_version
         FROM project_policy_versions AS version
         JOIN project_policies AS current
           ON current.workspace_id = version.workspace_id
          AND current.project_id = version.project_id
         WHERE version.workspace_id = ? AND version.project_id = ? AND version.version = ?`,
    )
    .get(ctx.workspaceId, task.project_id, projectPolicyVersion)) as PolicyVersionRow | undefined;
  const repository = (await ctx.db
    .prepare(
      `SELECT version.allowed_providers_json, version.allow_agent_root_propose,
                version.allow_pass_to_agent, version.allow_run_overrides,
                current.resource_version AS current_version
         FROM repository_config_versions AS version
         JOIN repository_configs AS current
           ON current.workspace_id = version.workspace_id
          AND current.project_id = version.project_id
         WHERE version.workspace_id = ? AND version.project_id = ? AND version.version = ?`,
    )
    .get(ctx.workspaceId, task.project_id, repositoryConfigVersion)) as
    PolicyVersionRow | undefined;
  const profile = (await ctx.db
    .prepare(
      `SELECT version.name, version.provider, version.model,
                version.execution_mode, version.harness_mode,
                current.resource_version AS current_version
         FROM agent_profile_versions AS version
         JOIN agent_profiles AS current
           ON current.workspace_id = version.workspace_id
          AND current.id = version.profile_id
         WHERE version.workspace_id = ? AND version.profile_id = ? AND version.version = ?`,
    )
    .get(ctx.workspaceId, input.agentProfileId, agentProfileVersion)) as
    ProfileVersionRow | undefined;
  if (!workspace || !project || !repository || !profile) {
    throw new DomainError("not_found", "run snapshot input version not found");
  }
  if (
    workspace.current_version !== workspacePolicyVersion ||
    project.current_version !== projectPolicyVersion ||
    repository.current_version !== repositoryConfigVersion ||
    profile.current_version !== agentProfileVersion
  ) {
    throw new DomainError("stale_version", "run snapshot input is not current");
  }
  if (
    workspace.allow_pass_to_agent !== 1 ||
    project.allow_pass_to_agent !== 1 ||
    repository.allow_pass_to_agent !== 1
  ) {
    throw new DomainError("pass_to_agent_forbidden", "effective policy forbids agent runs");
  }
  if (
    !providers(workspace.allowed_providers_json).includes(profile.provider) ||
    !providers(project.allowed_providers_json).includes(profile.provider) ||
    !providers(repository.allowed_providers_json).includes(profile.provider)
  ) {
    throw new DomainError("provider_forbidden", "profile provider exceeds snapshot policy");
  }

  const canonical = JSON.stringify({
    agent_profile: {
      id: input.agentProfileId,
      version: agentProfileVersion,
      ...profile,
    },
    project_id: task.project_id,
    project_policy: { version: projectPolicyVersion, ...project },
    repository_config: { version: repositoryConfigVersion, ...repository },
    task_id: task.id,
    workspace_policy: { version: workspacePolicyVersion, ...workspace },
  });
  const contentHash = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
  const runId = randomUlid();
  const snapshotId = randomUlid();
  return {
    input,
    result: {
      run: {
        id: runId,
        project_id: task.project_id,
        task_id: task.id,
        requested_by_human_id: principal.humanId,
        agent_profile_id: input.agentProfileId,
        result_state: "open",
        activity: "unknown",
        resource_version: 1,
      },
      task: { ...task, state: "active", resource_version: task.resource_version + 1 },
      snapshot: { id: snapshotId, contentHash, canonicalJson: canonical },
    },
  };
}

/** Only owning hub commands may persist this prepared run; no transport writes directly. */
export async function persistRunCreation(
  prepared: PreparedRunCreation,
  ctx: HubContext,
): Promise<void> {
  const { input, result } = prepared;
  const { run, task, snapshot } = result;
  if (!prepared.existingRun)
    await ctx.db
      .prepare(
        `INSERT INTO runs
         (workspace_id, id, project_id, task_id, requested_by_human_id,
          agent_profile_id, result_state, activity, resource_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', 'unknown', 1, ?)`,
      )
      .run(
        ctx.workspaceId,
        run.id,
        task.project_id,
        task.id,
        run.requested_by_human_id,
        input.agentProfileId,
        ctx.now,
      );
  await ctx.db
    .prepare(
      `INSERT INTO run_configuration_snapshots
         (workspace_id, id, project_id, run_id, workspace_policy_version,
          project_policy_version, repository_config_version, agent_profile_id,
          agent_profile_version, canonical_json, content_hash, created_at, snapshot_generation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.workspaceId,
      snapshot.id,
      task.project_id,
      run.id,
      input.workspacePolicyVersion,
      input.projectPolicyVersion,
      input.repositoryConfigVersion,
      input.agentProfileId,
      input.agentProfileVersion,
      snapshot.canonicalJson,
      snapshot.contentHash,
      ctx.now,
      prepared.snapshotGeneration ?? 1,
    );
  await ctx.db
    .prepare(
      `UPDATE tasks SET state = 'active', resource_version = ?
         WHERE workspace_id = ? AND id = ? AND resource_version = ?`,
    )
    .run(task.resource_version, ctx.workspaceId, task.id, input.expectedTaskVersion);
}

export interface UpdateRunActivityInput {
  runId: string;
  expectedVersion: number;
  activity: RunActivity;
}

export const updateRunActivityCommand: HubCommand<UpdateRunActivityInput, RunRecord> = {
  name: "run.activity.update",
  async run(input, ctx) {
    const principal = await requireHuman(ctx);
    if (!RUN_ACTIVITIES.includes(input.activity)) {
      throw new DomainError("invalid_argument", "run activity is invalid");
    }
    const run = (await ctx.db
      .prepare(
        `SELECT id, project_id, task_id, requested_by_human_id, agent_profile_id,
                result_state, activity, resource_version
         FROM runs WHERE workspace_id = ? AND id = ?`,
      )
      .get(ctx.workspaceId, input.runId)) as RunRecord | undefined;
    if (!run) {
      throw new DomainError("not_found", "run not found");
    }
    assertProjectAccess(principal, run.project_id);
    const expected = version(input.expectedVersion, "expected run version");
    if (run.resource_version !== expected) {
      throw new DomainError("stale_version", "run version conflict");
    }
    if (
      run.result_state === "accepted" ||
      run.result_state === "failed" ||
      run.result_state === "cancelled"
    ) {
      throw new DomainError("invalid_transition", "terminal run activity cannot change");
    }
    const next = expected + 1;
    await ctx.db
      .prepare(
        `UPDATE runs SET activity = ?, resource_version = ?
         WHERE workspace_id = ? AND id = ? AND resource_version = ?`,
      )
      .run(input.activity, next, ctx.workspaceId, run.id, expected);
    return { ...run, activity: input.activity, resource_version: next };
  },
};

export interface ExecutionRecord {
  id: string;
  run_id: string;
  state: ExecutionState;
  end_reason: ExecutionEndReason | null;
  resource_version: number;
  created_at: string;
  ended_at: string | null;
}

export interface CreateExecutionInput {
  runId: string;
}

export const createExecutionCommand: HubCommand<CreateExecutionInput, ExecutionRecord> = {
  name: "execution.create",
  async run(input, ctx) {
    const principal = await requireHuman(ctx);
    const run = (await ctx.db
      .prepare(
        `SELECT run.project_id, run.result_state,
                (SELECT COUNT(*) FROM run_executions AS execution
                 WHERE execution.workspace_id = run.workspace_id
                   AND execution.run_id = run.id AND execution.state != 'ended') AS active_executions,
                (SELECT COUNT(*) FROM provider_sessions AS session
                 WHERE session.workspace_id = run.workspace_id
                   AND session.run_id = run.id) AS provider_sessions
         FROM runs AS run WHERE run.workspace_id = ? AND run.id = ?`,
      )
      .get(ctx.workspaceId, input.runId)) as
      | {
          project_id: string;
          result_state: RunResultState;
          active_executions: number;
          provider_sessions: number;
        }
      | undefined;
    if (!run) {
      throw new DomainError("not_found", "run not found");
    }
    assertProjectAccess(principal, run.project_id);
    if (run.result_state !== "open" && run.result_state !== "changes_requested") {
      throw new DomainError("invalid_transition", "terminal run cannot create an execution");
    }
    if (run.active_executions > 0) {
      throw new DomainError("invalid_transition", "run already has an active execution");
    }
    if (run.provider_sessions > 0) {
      throw new DomainError("invalid_transition", "provider work requires a deliberate new run");
    }
    const id = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO run_executions
         (workspace_id, id, run_id, state, end_reason, resource_version, created_at, ended_at)
         VALUES (?, ?, ?, 'queued', NULL, 1, ?, NULL)`,
      )
      .run(ctx.workspaceId, id, input.runId, ctx.now);
    return {
      id,
      run_id: input.runId,
      state: "queued",
      end_reason: null,
      resource_version: 1,
      created_at: ctx.now,
      ended_at: null,
    };
  },
};

export interface TransitionExecutionInput {
  runId: string;
  executionId: string;
  expectedVersion: number;
  state: ExecutionState;
  endReason?: ExecutionEndReason;
}

export const transitionExecutionCommand: HubCommand<TransitionExecutionInput, ExecutionRecord> = {
  name: "execution.transition",
  async run(input, ctx) {
    const principal = await requireHuman(ctx);
    if (!EXECUTION_STATES.includes(input.state)) {
      throw new DomainError("invalid_argument", "execution state is invalid");
    }
    const execution = (await ctx.db
      .prepare(
        `SELECT execution.id, execution.run_id, execution.state, execution.end_reason,
                execution.resource_version, execution.created_at, execution.ended_at,
                run.project_id
         FROM run_executions AS execution
         JOIN runs AS run ON run.workspace_id = execution.workspace_id AND run.id = execution.run_id
         WHERE execution.workspace_id = ? AND execution.run_id = ? AND execution.id = ?`,
      )
      .get(ctx.workspaceId, input.runId, input.executionId)) as
      (ExecutionRecord & { project_id: string }) | undefined;
    if (!execution) {
      throw new DomainError("not_found", "execution not found");
    }
    assertProjectAccess(principal, execution.project_id);
    const expected = version(input.expectedVersion, "expected execution version");
    if (execution.resource_version !== expected) {
      throw new DomainError("stale_version", "execution version conflict");
    }
    assertExecutionTransition(execution.state, input.state);
    const endReason = input.state === "ended" ? input.endReason : undefined;
    if (
      (input.state === "ended" && (!endReason || !EXECUTION_END_REASONS.includes(endReason))) ||
      (input.state !== "ended" && input.endReason !== undefined)
    ) {
      throw new DomainError("invalid_argument", "execution end reason is invalid");
    }
    const next = expected + 1;
    const endedAt = input.state === "ended" ? ctx.now : null;
    await ctx.db
      .prepare(
        `UPDATE run_executions
         SET state = ?, end_reason = ?, ended_at = ?, resource_version = ?
         WHERE workspace_id = ? AND id = ? AND resource_version = ?`,
      )
      .run(input.state, endReason ?? null, endedAt, next, ctx.workspaceId, execution.id, expected);
    return {
      id: execution.id,
      run_id: execution.run_id,
      state: input.state,
      end_reason: endReason ?? null,
      resource_version: next,
      created_at: execution.created_at,
      ended_at: endedAt,
    };
  },
};

export interface CreateProviderSessionInput {
  runId: string;
  executionId: string;
  provider: Provider;
  requestedSessionId?: string;
}

export const createProviderSessionCommand: HubCommand<
  CreateProviderSessionInput,
  { id: string; requestedSessionId: string | null; observedSessionId: null }
> = {
  name: "provider_session.create",
  async run(input, ctx) {
    const principal = await requireHuman(ctx);
    if (!PROVIDERS.includes(input.provider)) {
      throw new DomainError("invalid_argument", "provider is invalid");
    }
    const execution = (await ctx.db
      .prepare(
        `SELECT run.project_id, run.result_state, execution.state, profile.provider
         FROM run_executions AS execution
         JOIN runs AS run ON run.workspace_id = execution.workspace_id AND run.id = execution.run_id
         JOIN agent_profiles AS profile
           ON profile.workspace_id = run.workspace_id AND profile.id = run.agent_profile_id
         WHERE execution.workspace_id = ? AND execution.id = ? AND execution.run_id = ?`,
      )
      .get(ctx.workspaceId, input.executionId, input.runId)) as
      | {
          project_id: string;
          result_state: RunResultState;
          state: ExecutionState;
          provider: string;
        }
      | undefined;
    if (!execution) {
      throw new DomainError("not_found", "execution not found for run");
    }
    assertProjectAccess(principal, execution.project_id);
    if (execution.result_state !== "open" && execution.result_state !== "changes_requested") {
      throw new DomainError("invalid_transition", "terminal run cannot create a provider session");
    }
    if (execution.state !== "attached" && execution.state !== "detached") {
      throw new DomainError("invalid_transition", "provider session requires attached execution");
    }
    if (execution.provider !== input.provider) {
      throw new DomainError("provider_forbidden", "provider session must match the run profile");
    }
    const requested =
      input.requestedSessionId === undefined
        ? null
        : boundedOpaqueId(input.requestedSessionId, "requested provider session id");
    const id = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO provider_sessions
         (workspace_id, id, run_id, execution_id, provider, requested_session_id,
          observed_session_id, state, resource_version, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', 1, ?, NULL)`,
      )
      .run(ctx.workspaceId, id, input.runId, input.executionId, input.provider, requested, ctx.now);
    return { id, requestedSessionId: requested, observedSessionId: null };
  },
};

function boundedOpaqueId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || [...value].length > 256) {
    throw new DomainError("invalid_argument", `${field} is invalid`);
  }
  if (
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new DomainError("invalid_argument", `${field} is invalid`);
  }
  return value;
}
