// ABOUTME: Typed W02 browser client for runner, checkout, launch, and control reads.
// ABOUTME: Request builders use exact field allowlists; wake values never enter launch input.

import { randomUlid } from "@bfb/domain";

export interface RunnerSummary {
  schema_version: 1;
  runner_id: string;
  workspace_id: string;
  owner_human_id: string;
  device_label: string;
  public_key_thumbprint: string;
  authorization_epoch: number;
  grant_epoch: number;
  status: "enrolled" | "revoked";
  enrolled_at: string;
  granted_project_ids: string[];
  launcher_human_ids: string[];
}

export interface CheckoutSummary {
  schema_version: 1;
  checkout_id: string;
  workspace_id: string;
  runner_id: string;
  project_id: string;
  label: string;
  repository_identity: string;
  workspace_subpath: string;
  physical_worktree_hash: string;
  repository_config_hash: string;
  is_default: boolean;
  branch?: string;
  head?: string;
  dirty: boolean;
  block_reason?: string;
  status: "registered" | "validated" | "stale" | "blocked";
  validated_at: string;
}

export interface ProviderReport {
  provider: string;
  version: string;
  manifest_id: string;
  capabilities: string[];
  status: string;
  observed_at: string;
  expires_at: string;
}

export interface CheckoutStatus {
  runner_id: string;
  device_label: string;
  owner_human_id: string;
  status: "enrolled" | "revoked";
  inventory_revision: number | null;
  inventory_received_at: string | null;
  inventory_valid: boolean;
  checkouts: CheckoutSummary[];
  providers: ProviderReport[];
}

export interface LaunchStatus {
  launch_id: string;
  run_id: string;
  run_execution_id: string;
  assignment_generation: number;
  task_id: string;
  project_id: string;
  runner_id: string;
  checkout_id: string;
  requesting_human_id: string;
  state: "pending" | "claimed" | "started" | "rejected" | "expired";
  expires_at: string;
  cancelled: boolean;
  end_reason: "launch_blocked" | "launch_expired" | "terminated" | null;
  execution_state: "queued" | "launching" | "attached" | "detached" | "ended";
  execution_end_reason:
    | "launch_blocked"
    | "launch_expired"
    | "process_exit"
    | "terminated"
    | "lost"
    | null;
  result_state: "open" | "submitted" | "changes_requested" | "accepted" | "failed" | "cancelled";
  activity: string;
  lease_state: "reserved" | "live" | "containment_unknown" | "released" | null;
  containment_reason:
    | "escaped_descendant"
    | "identity_ambiguous"
    | "evidence_missing"
    | "recovery_incomplete"
    | null;
  agent_profile_id: string | null;
  provider: string | null;
  model: string | null;
  execution_mode: "interactive" | "headless" | null;
}

export interface LaunchClient {
  listRunners(): Promise<{ runners: RunnerSummary[] }>;
  checkoutStatus(runnerId: string): Promise<CheckoutStatus>;
  launchesForTask(taskId: string): Promise<{ launches: LaunchStatus[] }>;
  launch(launchId: string): Promise<{ launch: LaunchStatus }>;
  start(body: Record<string, unknown>): Promise<Response>;
  control(body: Record<string, unknown>): Promise<Response>;
  wake(launchId: string): Promise<{
    intent_kind: string;
    intent_id: string;
    launch_id: string;
    expires_at: string;
  }>;
  launchOrigin(): Promise<string>;
}

export function createLaunchClient(
  fetchFn: typeof fetch,
  workspaceId: string,
  csrfToken: string,
): LaunchClient {
  const base = `/api/v1/workspaces/${workspaceId}`;
  async function get<T>(path: string): Promise<T> {
    const response = await fetchFn(path);
    if (!response.ok) {
      throw new Error(`Launch read failed (${response.status})`);
    }
    return (await response.json()) as T;
  }
  return {
    listRunners: () => get(`${base}/runners`),
    checkoutStatus: (runnerId) => get(`${base}/runners/${runnerId}/checkouts`),
    launchesForTask: (taskId) =>
      get(`${base}/launches?task_id=${encodeURIComponent(taskId)}`),
    launch: (launchId) => get(`${base}/launches/${launchId}`),
    start: (body) =>
      fetchFn(`${base}/launches`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bfb-csrf": csrfToken },
        body: JSON.stringify(body),
      }),
    control: (body) =>
      fetchFn(`${base}/run-controls`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bfb-csrf": csrfToken },
        body: JSON.stringify(body),
      }),
    wake: async (launchId) => {
      const response = await fetchFn(`${base}/launches/wake`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bfb-csrf": csrfToken },
        body: JSON.stringify({ schema_version: 1, launch_id: launchId }),
      });
      if (!response.ok) {
        throw new Error(`Wake signal failed (${response.status})`);
      }
      return (await response.json()) as {
        intent_kind: string;
        intent_id: string;
        launch_id: string;
        expires_at: string;
      };
    },
    launchOrigin: async () => {
      const response = await fetchFn("/api/v1/_substrate");
      if (!response.ok) {
        throw new Error("Launch origin is unavailable");
      }
      const body = (await response.json()) as { launch_origin?: string };
      if (!body.launch_origin) {
        throw new Error("Launch origin is unavailable");
      }
      return body.launch_origin;
    },
  };
}

export function newIdempotencyKey(): string {
  return randomUlid();
}

export interface StartInput {
  taskId: string;
  expectedTaskVersion: number;
  agentProfileId: string;
  agentProfileVersion: number;
  workspacePolicyVersion: number;
  projectPolicyVersion: number;
  repositoryConfigVersion: number;
  runnerId: string;
  checkoutId: string;
  retryRunId?: string;
  idempotencyKey: string;
}

/** Exact C09 Start fields. Any other field, including wake values, is rejected. */
export function buildStartRequest(input: StartInput): Record<string, unknown> {
  return {
    schema_version: 1,
    idempotency_key: input.idempotencyKey,
    task_id: input.taskId,
    expected_task_version: input.expectedTaskVersion,
    agent_profile_id: input.agentProfileId,
    agent_profile_version: input.agentProfileVersion,
    workspace_policy_version: input.workspacePolicyVersion,
    project_policy_version: input.projectPolicyVersion,
    repository_config_version: input.repositoryConfigVersion,
    runner_id: input.runnerId,
    checkout_id: input.checkoutId,
    ...(input.retryRunId === undefined ? {} : { retry_run_id: input.retryRunId }),
  };
}

export type ControlAction = "focus_existing" | "resume" | "interrupt" | "terminate" | "cancel";

export function buildControlRequest(input: {
  runnerId: string;
  runExecutionId: string;
  assignmentGeneration: number;
  action: ControlAction;
  idempotencyKey: string;
}): Record<string, unknown> {
  return {
    schema_version: 1,
    idempotency_key: input.idempotencyKey,
    runner_id: input.runnerId,
    run_execution_id: input.runExecutionId,
    assignment_generation: input.assignmentGeneration,
    action: input.action,
  };
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Builds only C09's short-lived cloud wake link. Never a Terminal command. */
export function buildWakeLink(launchOrigin: string, intentId: string): string {
  if (!/^https?:\/\/[^/]+$/.test(launchOrigin)) {
    throw new Error("Invalid launch origin.");
  }
  if (!ULID.test(intentId)) {
    throw new Error("Invalid wake intent.");
  }
  return `${launchOrigin}/l/${intentId}`;
}

export type LaunchTone = "waiting" | "active" | "blocked" | "settled";

export interface LaunchPresentation {
  headline: string;
  detail: string;
  tone: LaunchTone;
  nextAction: string;
  actions: Array<"wake" | "retry" | "cancel" | "interrupt" | "terminate" | "focus_existing" | "resume">;
  needsLocalRecovery: boolean;
}

/**
 * Maps one durable launch read to its operator presentation. Result state is
 * reported separately and never inferred from process or execution endings.
 */
export function describeLaunchStatus(launch: LaunchStatus): LaunchPresentation {
  if (launch.lease_state === "containment_unknown") {
    return {
      headline: "Containment unknown",
      detail: `The Mac reported ${launch.containment_reason?.replaceAll("_", " ") ?? "an unclear"} process state. Launches stay blocked until the Mac inspects and recovers locally.`,
      tone: "blocked",
      nextAction: "Open the BFB app on the Mac and run explicit local recovery. This page cannot clear containment.",
      actions: [],
      needsLocalRecovery: true,
    };
  }
  if (launch.state === "expired") {
    return {
      headline: "Launch expired",
      detail: "The two-minute window passed without a Mac claim. Nothing started.",
      tone: "settled",
      nextAction: "Press Start again to create a new explicit launch.",
      actions: ["retry"],
      needsLocalRecovery: false,
    };
  }
  if (launch.state === "rejected") {
    const reason =
      launch.end_reason === "terminated"
        ? "A cancel control terminated it before execution."
        : "The Mac or policy checks blocked it before execution.";
    return {
      headline: "Launch rejected",
      detail: `${reason} The run result stays open.`,
      tone: "settled",
      nextAction: "Fix the blocking condition, then press Start again.",
      actions: ["retry"],
      needsLocalRecovery: false,
    };
  }
  if (launch.cancelled) {
    return {
      headline: "Launch cancelled",
      detail: "Cancellation stops further authorization. The Mac still proves the checkout is free.",
      tone: "settled",
      nextAction: "Wait for the Mac to confirm release, or start again explicitly.",
      actions: ["retry"],
      needsLocalRecovery: false,
    };
  }
  if (launch.execution_state === "ended") {
    if (launch.execution_end_reason === "launch_expired") {
      return {
        headline: "Launch expired",
        detail: "The two-minute window passed without a Mac claim. Nothing started.",
        tone: "settled",
        nextAction: "Press Start again to create a new explicit launch.",
        actions: ["retry"],
        needsLocalRecovery: false,
      };
    }
    return {
      headline: "Process ended",
      detail: `The owned process group ended (${launch.execution_end_reason?.replaceAll("_", " ") ?? "unknown cause"}). The run result stays ${launch.result_state}; the task is not marked done.`,
      tone: "settled",
      nextAction:
        launch.result_state === "open" || launch.result_state === "changes_requested"
          ? "Return to the existing session or start again explicitly."
          : "The run result is recorded separately.",
      actions:
        launch.result_state === "open" || launch.result_state === "changes_requested"
          ? ["resume", "retry"]
          : [],
      needsLocalRecovery: false,
    };
  }
  if (launch.state === "pending") {
    return {
      headline: "Pending Mac claim",
      detail: "The durable command waits for the selected Mac. Expiry needs another explicit Start.",
      tone: "waiting",
      nextAction: "Optionally wake the Mac. The wake signal never starts or claims the launch.",
      actions: ["wake", "cancel"],
      needsLocalRecovery: false,
    };
  }
  if (launch.execution_state === "detached") {
    return {
      headline: "Execution detached",
      detail: "Process presence was lost while the Mac holds the checkout fence.",
      tone: "blocked",
      nextAction: "Interrupt, terminate, or cancel the exact execution. Check the Mac before retrying.",
      actions: ["interrupt", "terminate", "cancel"],
      needsLocalRecovery: false,
    };
  }
  if (launch.execution_state === "attached") {
    if (launch.activity === "waiting_user_submit") {
      return {
        headline: "Waiting for human submit",
        detail: "The provider waits in the Mac Terminal for the visible constant prompt.",
        tone: "active",
        nextAction: "Submit the prompt in Terminal on the Mac. BFB never types for you.",
        actions: ["focus_existing", "interrupt", "terminate", "cancel"],
        needsLocalRecovery: false,
      };
    }
    return {
      headline: "Provider attached",
      detail: `${launch.provider ?? "Provider"} runs on the Mac under the claimed fence.`,
      tone: "active",
      nextAction: "Interrupt, terminate, or cancel the exact execution when needed.",
      actions: ["focus_existing", "interrupt", "terminate", "cancel"],
      needsLocalRecovery: false,
    };
  }
  return {
    headline: "Launching",
    detail: "The Mac claimed the command and runs pre-execution checks.",
    tone: "waiting",
    nextAction: "Wait for attach, or cancel the exact execution.",
    actions: ["cancel"],
    needsLocalRecovery: false,
  };
}

export function resultLabel(resultState: string): string {
  return `Result: ${resultState.replaceAll("_", " ")} (recorded separately)`;
}
