// ABOUTME: Checks W02 request allowlists, wake-link construction, and state presentation.
// ABOUTME: Every blocking condition maps to a specific state with a safe next action.

import { describe, expect, it } from "vitest";
import { randomUlid, runnerGrantsTarget, type RunnerGrantsInput } from "@bfb/domain";

import { hashPublicValue } from "../src/runner-enrollment.js";
import {
  buildControlRequest,
  buildStartRequest,
  buildWakeLink,
  createLaunchClient,
  describeCheckoutDisplay,
  describeLaunchStatus,
  isSettledControlState,
  isUnsettledLaunch,
  linkedCheckoutsMessage,
  newIdempotencyKey,
  providerStatusMessage,
  refreshTaskLaunches,
  resolveEffectiveCheckoutId,
  splitRunnerStatuses,
  startAttemptSettlesKey,
  type CheckoutStatus,
  type CheckoutSummary,
  type LaunchStatus,
  type RunnerSummary,
} from "../src/launch/api.js";

const START_KEYS = [
  "agent_profile_id",
  "agent_profile_version",
  "checkout_id",
  "expected_task_version",
  "idempotency_key",
  "project_policy_version",
  "repository_config_version",
  "runner_id",
  "schema_version",
  "task_id",
  "workspace_policy_version",
].sort();

function baseLaunch(overrides: Partial<LaunchStatus> = {}): LaunchStatus {
  return {
    launch_id: randomUlid(),
    run_id: randomUlid(),
    run_execution_id: randomUlid(),
    assignment_generation: 1,
    task_id: randomUlid(),
    project_id: randomUlid(),
    runner_id: randomUlid(),
    checkout_id: randomUlid(),
    requesting_human_id: randomUlid(),
    state: "pending",
    expires_at: "2026-08-07T12:02:00.000Z",
    cancelled: false,
    end_reason: null,
    execution_state: "queued",
    execution_end_reason: null,
    result_state: "open",
    activity: "unknown",
    lease_state: null,
    containment_reason: null,
    agent_profile_id: randomUlid(),
    provider: "fake",
    model: "synthetic",
    execution_mode: "interactive",
    ...overrides,
  };
}

function stringsOf(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsOf);
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(stringsOf);
  }
  return [];
}

describe("w02 launch request builders", () => {
  it("emits the exact C09 Start fields and nothing else", () => {
    const body = buildStartRequest({
      taskId: randomUlid(),
      expectedTaskVersion: 3,
      agentProfileId: randomUlid(),
      agentProfileVersion: 1,
      workspacePolicyVersion: 2,
      projectPolicyVersion: 2,
      repositoryConfigVersion: 2,
      runnerId: randomUlid(),
      checkoutId: randomUlid(),
      idempotencyKey: newIdempotencyKey(),
    });
    expect(Object.keys(body).sort()).toEqual(START_KEYS);
    expect(body).toMatchObject({ schema_version: 1 });
    for (const text of stringsOf(body)) {
      expect(text.startsWith("/")).toBe(false);
    }
    expect(JSON.stringify(body)).not.toMatch(/wake|intent|command|path/i);
  });

  it("adds retry_run_id only for explicit retries", () => {
    const retry = buildStartRequest({
      taskId: randomUlid(),
      expectedTaskVersion: 3,
      agentProfileId: randomUlid(),
      agentProfileVersion: 1,
      workspacePolicyVersion: 2,
      projectPolicyVersion: 2,
      repositoryConfigVersion: 2,
      runnerId: randomUlid(),
      checkoutId: randomUlid(),
      retryRunId: randomUlid(),
      idempotencyKey: newIdempotencyKey(),
    });
    expect(Object.keys(retry).sort()).toEqual([...START_KEYS, "retry_run_id"].sort());
  });

  it("emits the exact run-control fields bound to one assignment", () => {
    const body = buildControlRequest({
      runnerId: randomUlid(),
      runExecutionId: randomUlid(),
      assignmentGeneration: 2,
      action: "interrupt",
      idempotencyKey: newIdempotencyKey(),
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        "action",
        "assignment_generation",
        "idempotency_key",
        "run_execution_id",
        "runner_id",
        "schema_version",
      ].sort(),
    );
  });

  it("builds only cloud wake links from a validated origin and intent", () => {
    const intent = randomUlid();
    expect(buildWakeLink("https://launch.bfb.example.test", intent)).toBe(
      `https://launch.bfb.example.test/l/${intent}`,
    );
    for (const origin of [
      "https://launch.bfb.example.test/l/evil",
      "https://launch.bfb.example.test/",
      "bfb://launch",
      "",
    ]) {
      expect(() => buildWakeLink(origin, intent)).toThrow();
    }
    for (const bad of ["not-a-ulid", "12345678-1234-1234-1234-123456789012", ""]) {
      expect(() => buildWakeLink("https://launch.bfb.example.test", bad)).toThrow();
    }
  });

  it("mints ULID idempotency keys", () => {
    expect(newIdempotencyKey()).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it("settles the Start key on any answered request, never on a lost one", () => {
    // A stored launch owns its key, and a typed rejection stored nothing, so
    // the next Start must mint a fresh key instead of reusing a spent one for
    // another task or changed inputs. Only a lost response keeps the key so
    // the next click replays the same request.
    expect(startAttemptSettlesKey("stored")).toBe(true);
    expect(startAttemptSettlesKey("rejected")).toBe(true);
    expect(startAttemptSettlesKey("unanswered")).toBe(false);
  });

  it("keeps the run-control key while live and frees it once settled", () => {
    // Repeated presses for a live control replay the same control; a settled
    // one (applied, rejected, or expired unclaimed) must free its key so the
    // next press issues a new control instead of returning the settled one.
    expect(isSettledControlState("pending")).toBe(false);
    expect(isSettledControlState("claimed")).toBe(false);
    expect(isSettledControlState("applied")).toBe(true);
    expect(isSettledControlState("rejected")).toBe(true);
    expect(isSettledControlState("expired")).toBe(true);
  });

  it("matches the server grants step-up target without extra fields", async () => {
    const input = {
      runnerId: randomUlid(),
      expectedGrantEpoch: 2,
      projectIds: [randomUlid(), randomUlid()].sort(),
      launcherHumanIds: [randomUlid()],
    };
    const browser = await hashPublicValue([
      "runner.grants.replace",
      input.runnerId,
      input.expectedGrantEpoch,
      [...input.projectIds].sort(),
      [...input.launcherHumanIds].sort(),
    ]);
    expect(browser).toBe(runnerGrantsTarget(input as Omit<RunnerGrantsInput, "stepUpProofId">));
  });
});

describe("w02 launch presentation", () => {
  it("keeps pending distinct with an optional wake signal", () => {
    const shown = describeLaunchStatus(baseLaunch());
    expect(shown.headline).toBe("Pending Mac claim");
    expect(shown.actions).toEqual(["wake", "cancel"]);
    expect(shown.needsLocalRecovery).toBe(false);
  });

  it("shows claimed launches as waiting, not working", () => {
    const shown = describeLaunchStatus(
      baseLaunch({ state: "claimed", execution_state: "launching", lease_state: "reserved" }),
    );
    expect(shown.headline).toBe("Launching");
    expect(shown.detail).not.toMatch(/work/i);
  });

  it("marks attached providers without claiming activity", () => {
    const shown = describeLaunchStatus(
      baseLaunch({ state: "started", execution_state: "attached", lease_state: "live" }),
    );
    expect(shown.headline).toBe("Provider attached");
    expect(shown.actions).toContain("focus_existing");
  });

  it("routes waiting-user-submit to the Mac Terminal", () => {
    const shown = describeLaunchStatus(
      baseLaunch({
        state: "started",
        execution_state: "attached",
        activity: "waiting_user_submit",
        lease_state: "live",
      }),
    );
    expect(shown.headline).toBe("Waiting for human submit");
    expect(shown.nextAction).toMatch(/never types/i);
  });

  it("keeps detached executions fenced with exact controls", () => {
    const shown = describeLaunchStatus(
      baseLaunch({ state: "started", execution_state: "detached", lease_state: "live" }),
    );
    expect(shown.headline).toBe("Execution detached");
    expect(shown.actions).toEqual(["interrupt", "terminate", "cancel"]);
  });

  it("reports process end without marking the task done", () => {
    const shown = describeLaunchStatus(
      baseLaunch({
        state: "started",
        execution_state: "ended",
        execution_end_reason: "process_exit",
        lease_state: "released",
      }),
    );
    expect(shown.headline).toBe("Process ended");
    expect(`${shown.detail} ${shown.nextAction}`).toMatch(/not marked done/);
    expect(`${shown.headline} ${shown.detail} ${shown.nextAction}`).not.toMatch(
      /is done|is complete|has completed|successfully completed/i,
    );
    expect(shown.actions).toEqual(["resume", "retry"]);
  });

  it("offers no launch action once the run result is recorded", () => {
    const shown = describeLaunchStatus(
      baseLaunch({
        state: "started",
        execution_state: "ended",
        execution_end_reason: "process_exit",
        result_state: "accepted",
        lease_state: "released",
      }),
    );
    expect(shown.actions).toEqual([]);
  });

  it("requires an explicit click after expiry", () => {
    const shown = describeLaunchStatus(
      baseLaunch({
        state: "expired",
        end_reason: "launch_expired",
        execution_state: "ended",
        execution_end_reason: "launch_expired",
      }),
    );
    expect(shown.headline).toBe("Launch expired");
    expect(shown.actions).toEqual(["retry"]);
  });

  it("distinguishes blocked and terminated rejections", () => {
    const blocked = describeLaunchStatus(
      baseLaunch({ state: "rejected", end_reason: "launch_blocked", execution_state: "ended" }),
    );
    expect(blocked.headline).toBe("Launch rejected");
    const terminated = describeLaunchStatus(
      baseLaunch({ state: "rejected", end_reason: "terminated", execution_state: "ended" }),
    );
    expect(terminated.detail).toMatch(/cancel/i);
  });

  it("blocks containment_unknown with a local-only handoff", () => {
    const shown = describeLaunchStatus(
      baseLaunch({
        state: "claimed",
        execution_state: "launching",
        lease_state: "containment_unknown",
        containment_reason: "escaped_descendant",
      }),
    );
    expect(shown.headline).toBe("Containment unknown");
    expect(shown.actions).toEqual([]);
    expect(shown.needsLocalRecovery).toBe(true);
    expect(shown.nextAction).toMatch(/cannot clear/i);
  });

  it("keeps result state out of the execution headline", () => {
    for (const resultState of ["open", "submitted", "failed", "cancelled"] as const) {
      const shown = describeLaunchStatus(baseLaunch({ result_state: resultState }));
      expect(shown.headline).not.toContain(resultState);
    }
  });

  it("keeps refreshing every launch that can still move", () => {
    // Pending and claimed launches await the Mac; started launches still
    // move through attach, detach, exit, and local containment recovery, so
    // the card must keep reading them. Only a final presentation settles.
    expect(isUnsettledLaunch(baseLaunch())).toBe(true);
    expect(
      isUnsettledLaunch(
        baseLaunch({ state: "claimed", execution_state: "launching", lease_state: "reserved" }),
      ),
    ).toBe(true);
    expect(
      isUnsettledLaunch(
        baseLaunch({ state: "started", execution_state: "attached", lease_state: "live" }),
      ),
    ).toBe(true);
    expect(
      isUnsettledLaunch(
        baseLaunch({ state: "started", execution_state: "detached", lease_state: "live" }),
      ),
    ).toBe(true);
    expect(
      isUnsettledLaunch(
        baseLaunch({
          state: "claimed",
          execution_state: "launching",
          lease_state: "containment_unknown",
          containment_reason: "escaped_descendant",
        }),
      ),
    ).toBe(true);
  });

  it("settles only launches with a final presentation", () => {
    expect(
      isUnsettledLaunch(
        baseLaunch({
          state: "started",
          execution_state: "ended",
          execution_end_reason: "process_exit",
          lease_state: "released",
        }),
      ),
    ).toBe(false);
    expect(
      isUnsettledLaunch(
        baseLaunch({
          state: "expired",
          end_reason: "launch_expired",
          execution_state: "ended",
          execution_end_reason: "launch_expired",
        }),
      ),
    ).toBe(false);
    expect(
      isUnsettledLaunch(
        baseLaunch({ state: "rejected", end_reason: "launch_blocked", execution_state: "ended" }),
      ),
    ).toBe(false);
    expect(isUnsettledLaunch(baseLaunch({ cancelled: true }))).toBe(false);
  });
});

function baseRunner(overrides: Partial<RunnerSummary> = {}): RunnerSummary {
  const owner = randomUlid();
  return {
    schema_version: 1,
    runner_id: randomUlid(),
    workspace_id: randomUlid(),
    owner_human_id: owner,
    device_label: "Synthetic Mac",
    public_key_thumbprint: "synthetic-thumbprint",
    authorization_epoch: 1,
    grant_epoch: 1,
    status: "enrolled",
    enrolled_at: "2026-08-07T12:00:00.000Z",
    granted_project_ids: [],
    launcher_human_ids: [owner],
    checkout_status: baseCheckoutStatus(),
    ...overrides,
  };
}

function baseCheckoutStatus(overrides: Partial<CheckoutStatus> = {}): CheckoutStatus {
  return {
    runner_id: randomUlid(),
    device_label: "Synthetic Mac",
    owner_human_id: randomUlid(),
    status: "enrolled",
    inventory_revision: 1,
    inventory_received_at: "2026-08-07T12:00:00.000Z",
    inventory_valid: true,
    checkouts: [],
    providers: [],
    ...overrides,
  };
}

describe("w02 runner inventory reads", () => {
  it("splits embedded statuses without an extra read per runner", () => {
    const first = baseRunner();
    const second = baseRunner({ checkout_status: null });
    const { statuses, failures } = splitRunnerStatuses([first, second]);
    expect(statuses[first.runner_id]).toBe(first.checkout_status);
    expect(statuses[second.runner_id]).toBeUndefined();
    expect(failures[second.runner_id]).toMatch(/unavailable/);
    expect(failures[first.runner_id]).toBeUndefined();
  });

  it("coalesces concurrent identical reads into one request", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      await Promise.resolve();
      return new Response(JSON.stringify({ runners: [] }), { status: 200 });
    }) as typeof fetch;
    const client = createLaunchClient(fetchImpl, randomUlid(), "csrf");
    const [first, second] = await Promise.all([client.listRunners(), client.listRunners()]);
    expect(first).toEqual({ runners: [] });
    expect(second).toEqual({ runners: [] });
    expect(calls).toBe(1);
  });

  it("records a missing embedded status instead of an empty inventory", () => {
    const missing = baseRunner({ checkout_status: null });
    const { statuses, failures } = splitRunnerStatuses([missing]);
    expect(statuses[missing.runner_id]).toBeUndefined();
    expect(failures[missing.runner_id]).toMatch(/unavailable/);
    expect(describeCheckoutDisplay(undefined, true)).toBe("unavailable");
    expect(linkedCheckoutsMessage(undefined, true)).not.toMatch(/has not reported a checkout yet/);
    expect(providerStatusMessage(undefined, true)).toMatch(/unavailable/);
  });

  it("keeps empty and invalid inventories distinct from unavailable reads", () => {
    const empty = baseCheckoutStatus({
      inventory_valid: false,
      inventory_received_at: null,
    });
    const invalid = baseCheckoutStatus({
      inventory_valid: false,
      inventory_received_at: "2026-08-07T12:00:00.000Z",
    });
    const ready = baseCheckoutStatus({
      checkouts: [
        {
          schema_version: 1,
          checkout_id: randomUlid(),
          workspace_id: randomUlid(),
          runner_id: randomUlid(),
          project_id: randomUlid(),
          label: "Synthetic Alpha Checkout",
          repository_identity: "synthetic/alpha",
          workspace_subpath: ".",
          physical_worktree_hash: `sha256:${"a".repeat(64)}`,
          repository_config_hash: `sha256:${"b".repeat(64)}`,
          is_default: true,
          dirty: false,
          status: "validated",
          validated_at: "2026-08-07T12:00:00.000Z",
        },
      ],
    });
    expect(describeCheckoutDisplay(ready, false)).toBe("ready");
    expect(linkedCheckoutsMessage(ready, false)).toBeNull();
    expect(describeCheckoutDisplay(empty, false)).toBe("empty");
    expect(describeCheckoutDisplay(invalid, false)).toBe("invalid");
    expect(describeCheckoutDisplay(undefined, false)).toBe("unavailable");
    expect(linkedCheckoutsMessage(empty, false)).toMatch(/has not reported a checkout yet/);
    expect(linkedCheckoutsMessage(invalid, false)).toMatch(/failed validation/);
    expect(providerStatusMessage(empty, false)).toMatch(/No provider report/);
  });

  it("refreshes only launches after a command, never runner inventories", async () => {
    const calls: string[] = [];
    const launches = [baseLaunch(), baseLaunch()];
    const client = {
      launchesForTask: async (taskId: string) => {
        calls.push(taskId);
        return { launches };
      },
    };
    const body = await refreshTaskLaunches(client, "task-id");
    expect(body.launches).toEqual(launches);
    expect(calls).toEqual(["task-id"]);
    expect("listRunners" in client).toBe(false);
    expect("checkoutStatus" in client).toBe(false);
  });
});

function baseCheckout(overrides: Partial<CheckoutSummary> = {}): CheckoutSummary {
  const runnerId = randomUlid();
  return {
    schema_version: 1,
    checkout_id: randomUlid(),
    workspace_id: randomUlid(),
    runner_id: runnerId,
    project_id: randomUlid(),
    label: "Synthetic checkout",
    repository_identity: "synthetic/checkout",
    workspace_subpath: ".",
    physical_worktree_hash: `sha256:${"a".repeat(64)}`,
    repository_config_hash: `sha256:${"b".repeat(64)}`,
    is_default: false,
    dirty: false,
    status: "validated",
    validated_at: "2026-08-07T12:00:00.000Z",
    ...overrides,
  };
}

describe("w02 start checkout selection", () => {
  it("defaults to the task project default, not the first default in inventory order", () => {
    const projectA = randomUlid();
    const projectB = randomUlid();
    const otherDefault = baseCheckout({ project_id: projectA, is_default: true });
    const taskDefault = baseCheckout({ project_id: projectB, is_default: true });
    const inventory = [otherDefault, taskDefault];
    expect(resolveEffectiveCheckoutId("", inventory, projectB)).toBe(taskDefault.checkout_id);
    expect(resolveEffectiveCheckoutId("", inventory, projectA)).toBe(otherDefault.checkout_id);
  });

  it("never falls back to another project's checkout when the task project has none", () => {
    const other = baseCheckout({ project_id: randomUlid(), is_default: true });
    expect(resolveEffectiveCheckoutId("", [other], randomUlid())).toBe("");
  });

  it("requires explicit selection even when the project has just one non-default checkout", () => {
    const checkout = baseCheckout();
    expect(resolveEffectiveCheckoutId("", [checkout], checkout.project_id)).toBe("");
    expect(resolveEffectiveCheckoutId(checkout.checkout_id, [checkout], checkout.project_id)).toBe(
      checkout.checkout_id,
    );
  });

  it("leaves a removed selection empty instead of choosing another non-default checkout", () => {
    const checkout = baseCheckout();
    expect(resolveEffectiveCheckoutId(randomUlid(), [checkout], checkout.project_id)).toBe("");
  });

  it("keeps an explicit selection only when it belongs to the task project", () => {
    const projectB = randomUlid();
    const other = baseCheckout({ project_id: randomUlid(), is_default: true });
    const selected = baseCheckout({ project_id: projectB });
    const taskDefault = baseCheckout({ project_id: projectB, is_default: true });
    const inventory = [other, selected, taskDefault];
    expect(resolveEffectiveCheckoutId(selected.checkout_id, inventory, projectB)).toBe(
      selected.checkout_id,
    );
    expect(resolveEffectiveCheckoutId(other.checkout_id, inventory, projectB)).toBe(
      taskDefault.checkout_id,
    );
  });
});
