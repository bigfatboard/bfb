// ABOUTME: Task-sheet initiation form for a two-agent discussion with eligibility.
// ABOUTME: Unavailable runners, checkouts, and profiles stay actionable, never silently hidden.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CheckoutStatus, RunnerSummary } from "../launch/api.js";
import { createLaunchClient } from "../launch/api.js";
import {
  buildCreateRequest,
  createDiscussionClient,
  newDiscussionKey,
  type AgentProfileRecord,
} from "./api.js";
import {
  canStartDiscussion,
  describeSlotEligibility,
  type CheckoutInput,
  type EligibilityResult,
  type RunnerInput,
} from "./presentation.js";

export interface DiscussionStartProps {
  workspaceId: string;
  taskId: string;
  taskVersion: number;
  projectId: string;
  humanId: string;
  role: "owner" | "member" | "reviewer";
  fetchImpl?: typeof fetch | undefined;
  csrfToken?: string | undefined;
  onStarted: (discussionId: string) => void;
}

interface SlotSelection {
  profileId: string;
  runnerId: string;
  checkoutId: string;
}

function toRunnerInput(runner: RunnerSummary): RunnerInput {
  return {
    runner_id: runner.runner_id,
    device_label: runner.device_label,
    status: runner.status,
    launcher_human_ids: runner.launcher_human_ids,
    owner_human_id: runner.owner_human_id,
  };
}

function toCheckoutInput(checkout: CheckoutStatus["checkouts"][number], valid: boolean): CheckoutInput {
  return {
    checkout_id: checkout.checkout_id,
    runner_id: checkout.runner_id,
    project_id: checkout.project_id,
    label: checkout.label,
    status: checkout.status,
    ...(checkout.block_reason ? { block_reason: checkout.block_reason } : {}),
    inventory_valid: valid,
  };
}

export function DiscussionStart(props: DiscussionStartProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  const launchClient = useMemo(
    () => createLaunchClient(fetchFn, props.workspaceId, props.csrfToken ?? ""),
    [fetchFn, props.csrfToken, props.workspaceId],
  );
  const discussionClient = useMemo(
    () => createDiscussionClient(fetchFn, props.workspaceId, props.csrfToken ?? ""),
    [fetchFn, props.csrfToken, props.workspaceId],
  );
  const canManage = props.role === "owner" || props.role === "member";
  const [profiles, setProfiles] = useState<AgentProfileRecord[]>([]);
  const [runners, setRunners] = useState<RunnerSummary[]>([]);
  const [statuses, setStatuses] = useState<Record<string, CheckoutStatus>>({});
  const [question, setQuestion] = useState("");
  const [rounds, setRounds] = useState(3);
  const [duration, setDuration] = useState(900);
  const [first, setFirst] = useState<SlotSelection>({ profileId: "", runnerId: "", checkoutId: "" });
  const [second, setSecond] = useState<SlotSelection>({ profileId: "", runnerId: "", checkoutId: "" });
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<{
    workspace: number;
    project: number;
    config: number;
  } | null>(null);

  useEffect(() => {
    if (!canManage) {
      return;
    }
    let active = true;
    setLoaded(false);
    void (async () => {
      try {
        const [profileBody, runnerBody] = await Promise.all([
          (await fetchFn(
            `/api/v1/workspaces/${props.workspaceId}/agent-profiles?limit=100`,
          )).json() as Promise<{ profiles: AgentProfileRecord[] }>,
          launchClient.listRunners(),
        ]);
        if (!active) {
          return;
        }
        setProfiles(profileBody.profiles);
        setRunners(runnerBody.runners);
        const taskBody = (await (
          await fetchFn(`/api/v1/workspaces/${props.workspaceId}/tasks/${props.taskId}`)
        ).json()) as { task: { project_id: string } };
        const [workspacePolicy, projectPolicy, repositoryConfig] = await Promise.all([
          (await fetchFn(`/api/v1/workspaces/${props.workspaceId}/workspace-policy`))
            .json() as Promise<{ policy: { resourceVersion: number } }>,
          (await fetchFn(
            `/api/v1/workspaces/${props.workspaceId}/projects/${taskBody.task.project_id}/policy`,
          )).json() as Promise<{ policy: { resourceVersion: number } }>,
          (await fetchFn(
            `/api/v1/workspaces/${props.workspaceId}/projects/${taskBody.task.project_id}/repository-config`,
          )).json() as Promise<{ config: { resource_version: number } }>,
        ]);
        if (!active) {
          return;
        }
        setPolicy({
          workspace: workspacePolicy.policy.resourceVersion,
          project: projectPolicy.policy.resourceVersion,
          config: repositoryConfig.config.resource_version,
        });
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Discussion start is unavailable.");
        }
      } finally {
        if (active) {
          setLoaded(true);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [canManage, fetchFn, launchClient, props.taskId, props.workspaceId]);

  const headless = useMemo(
    () => profiles.filter((profile) => profile.provider === "claude" || profile.provider === "codex"),
    [profiles],
  );

  const knownStatuses = useRef(new Set<string>());
  const ensureStatus = useCallback(
    async (runnerId: string, runner: RunnerSummary | undefined) => {
      if (!runnerId || knownStatuses.current.has(runnerId)) {
        return;
      }
      knownStatuses.current.add(runnerId);
      try {
        const status = await launchClient.checkoutStatus(runnerId);
        setStatuses((current) => ({ ...current, [runnerId]: status }));
      } catch {
        setStatuses((current) => ({
          ...current,
          [runnerId]: {
            runner_id: runnerId,
            device_label: runner?.device_label ?? runnerId,
            owner_human_id: runner?.owner_human_id ?? "",
            status: runner?.status ?? "enrolled",
            inventory_revision: null,
            inventory_received_at: null,
            inventory_valid: false,
            checkouts: [],
            providers: [],
          },
        }));
      }
    },
    [launchClient],
  );

  const launchable = useMemo(
    () =>
      runners.filter(
        (runner) =>
          runner.status === "enrolled" &&
          (runner.owner_human_id === props.humanId ||
            runner.launcher_human_ids.includes(props.humanId)),
      ),
    [runners, props.humanId],
  );
  const defaultRunnerId = launchable[0]?.runner_id ?? runners[0]?.runner_id ?? "";

  function resolvedRunnerId(slot: SlotSelection): string {
    return slot.runnerId || defaultRunnerId;
  }

  useEffect(() => {
    if (!loaded) {
      return;
    }
    for (const slot of [first, second]) {
      const runnerId = resolvedRunnerId(slot);
      if (runnerId) {
        void ensureStatus(
          runnerId,
          runners.find((entry) => entry.runner_id === runnerId),
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, runners, first.runnerId, second.runnerId, defaultRunnerId, ensureStatus]);

  function slotEligibility(slot: SlotSelection): EligibilityResult | null {
    const profile = profiles.find((entry) => entry.id === slot.profileId);
    if (!profile) {
      return {
        status: "unsupported",
        headline: "Select a profile",
        nextAction: "Pick a restricted headless Claude or Codex profile for this slot.",
      };
    }
    const runner = runners.find((entry) => entry.runner_id === resolvedRunnerId(slot));
    const status = runner ? statuses[runner.runner_id] : undefined;
    if (!runner || !status) {
      return null;
    }
    const checkout = slot.checkoutId
      ? status.checkouts.find((entry) => entry.checkout_id === slot.checkoutId)
      : status.checkouts[0];
    const checkoutOccupied =
      first.checkoutId !== "" &&
      second.checkoutId !== "" &&
      first.checkoutId === second.checkoutId &&
      slot.checkoutId !== "";
    return describeSlotEligibility({
      profile,
      runner: toRunnerInput(runner),
      checkout: checkout ? toCheckoutInput(checkout, status.inventory_valid) : undefined,
      checkoutOccupied,
      humanId: props.humanId,
    });
  }

  const firstEligibility = slotEligibility(first);
  const secondEligibility = slotEligibility(second);
  const ready =
    firstEligibility !== null &&
    secondEligibility !== null &&
    canStartDiscussion(firstEligibility, secondEligibility);

  if (!canManage) {
    return null;
  }

  if (!loaded) {
    return (
      <section aria-label="Start discussion" data-testid="discussion-start">
        <div className="sheet-loading" role="status">
          Loading discussion eligibility…
        </div>
      </section>
    );
  }

  function slotForm(
    legend: string,
    slot: SlotSelection,
    setSlot: (next: SlotSelection) => void,
    testPrefix: string,
    eligibility: EligibilityResult | null,
  ) {
    const runnerCheckouts = (
      statuses[resolvedRunnerId(slot)]?.checkouts ??
      runners.flatMap((runner) => statuses[runner.runner_id]?.checkouts ?? [])
    ).filter((checkout) => checkout.project_id === props.projectId);
    return (
      <fieldset data-testid={`${testPrefix}-slot`}>
        <legend>{legend}</legend>
        <label>
          Agent profile
          <select
            data-testid={`${testPrefix}-profile`}
            value={slot.profileId}
            onChange={(event) => setSlot({ ...slot, profileId: event.target.value })}
            required
          >
            <option value="">Choose a profile</option>
            {headless.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {`${profile.name} · ${profile.provider} · ${profile.execution_mode}/${profile.harness_mode}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Runner
          <select
            data-testid={`${testPrefix}-runner`}
            value={slot.runnerId}
            onChange={(event) => setSlot({ ...slot, runnerId: event.target.value, checkoutId: "" })}
          >
            <option value="">Automatic</option>
            {runners.map((runner) => (
              <option key={runner.runner_id} value={runner.runner_id}>
                {`${runner.device_label} · ${runner.status}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Checkout
          <select
            data-testid={`${testPrefix}-checkout`}
            value={slot.checkoutId}
            onChange={(event) => setSlot({ ...slot, checkoutId: event.target.value })}
          >
            <option value="">Automatic</option>
            {runnerCheckouts.map((checkout) => (
              <option key={checkout.checkout_id} value={checkout.checkout_id}>
                {`${checkout.label} · ${checkout.status}`}
              </option>
            ))}
          </select>
        </label>
        {eligibility ? (
          <p data-testid={`${testPrefix}-eligibility`} data-eligibility={eligibility.status}>
            <strong>{eligibility.headline}</strong>
            <span>{eligibility.nextAction}</span>
          </p>
        ) : (
          <p data-testid={`${testPrefix}-eligibility`} data-eligibility="checking">
            <strong>Checking runner state…</strong>
            <span>Checkout availability loads with the selected runner.</span>
          </p>
        )}
      </fieldset>
    );
  }

  return (
    <section aria-label="Start discussion" data-testid="discussion-start">
      <h3>Start a discussion</h3>
      <p className="section-help">
        Two restricted headless participants exchange bounded read-only turns. Starting a
        discussion never starts work or completes the task.
      </p>
      {error ? (
        <p className="inline-error" role="alert" data-testid="discussion-start-error">
          {error}
        </p>
      ) : null}
      <form
        data-testid="discussion-start-form"
        className="stacked-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || !policy || busy) {
            return;
          }
          const resolve = (slot: SlotSelection): SlotSelection => ({
            profileId: slot.profileId,
            runnerId: slot.runnerId || defaultRunnerId || "",
            checkoutId:
              slot.checkoutId ||
              statuses[slot.runnerId || defaultRunnerId || ""]?.checkouts.find(
                (entry) => entry.project_id === props.projectId,
              )?.checkout_id ||
              "",
          });
          const resolvedFirst = resolve(first);
          const resolvedSecond = resolve(second);
          const profileOf = (id: string): AgentProfileRecord | undefined =>
            profiles.find((entry) => entry.id === id);
          if (
            resolvedFirst.profileId === resolvedSecond.profileId ||
            !resolvedFirst.runnerId ||
            !resolvedFirst.checkoutId ||
            !resolvedSecond.runnerId ||
            !resolvedSecond.checkoutId
          ) {
            setError("Two distinct profiles with a runner and checkout each are required.");
            return;
          }
          setBusy(true);
          setError(null);
          const body = buildCreateRequest({
            taskId: props.taskId,
            expectedTaskVersion: props.taskVersion,
            question: question.trim(),
            gitRevision: "0".repeat(40),
            workspacePolicyVersion: policy.workspace,
            projectPolicyVersion: policy.project,
            repositoryConfigVersion: policy.config,
            participants: [
              {
                agentProfileId: resolvedFirst.profileId,
                agentProfileVersion: profileOf(resolvedFirst.profileId)?.resource_version ?? 1,
                runnerId: resolvedFirst.runnerId,
                checkoutId: resolvedFirst.checkoutId,
              },
              {
                agentProfileId: resolvedSecond.profileId,
                agentProfileVersion: profileOf(resolvedSecond.profileId)?.resource_version ?? 1,
                runnerId: resolvedSecond.runnerId,
                checkoutId: resolvedSecond.checkoutId,
              },
            ],
            rounds,
            durationSeconds: duration,
            idempotencyKey: newDiscussionKey(),
          });
          void (async () => {
            try {
              const response = await discussionClient.create(body);
              if (!response.ok) {
                const parsed = (await response.json().catch(() => ({}))) as {
                  error?: { code?: string; message?: string };
                };
                throw new Error(
                  parsed.error?.message ?? `Discussion start failed (${response.status})`,
                );
              }
              const parsed = (await response.json()) as {
                result?: { discussion_id?: string };
              };
              const discussionId = parsed.result?.discussion_id;
              if (!discussionId) {
                throw new Error("Discussion started without an id.");
              }
              setQuestion("");
              props.onStarted(discussionId);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Discussion start failed.");
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <label>
          Question for both participants
          <textarea
            data-testid="discussion-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            maxLength={4096}
            rows={3}
            required
          />
        </label>
        <label>
          Rounds (1–3, two turns each)
          <select
            data-testid="discussion-rounds"
            value={rounds}
            onChange={(event) => setRounds(Number(event.target.value))}
          >
            <option value={1}>1 round · 2 turns</option>
            <option value={2}>2 rounds · 4 turns</option>
            <option value={3}>3 rounds · 6 turns</option>
          </select>
        </label>
        <label>
          Deadline
          <select
            data-testid="discussion-duration"
            value={duration}
            onChange={(event) => setDuration(Number(event.target.value))}
          >
            <option value={60}>1 minute</option>
            <option value={900}>15 minutes</option>
            <option value={3600}>60 minutes</option>
          </select>
        </label>
        {slotForm("First participant", first, setFirst, "discussion-first", firstEligibility)}
        {slotForm("Second participant", second, setSecond, "discussion-second", secondEligibility)}
        <button
          type="submit"
          className="button-primary"
          data-testid="discussion-start-button"
          disabled={busy || !ready || !question.trim() || !policy}
        >
          {busy ? "Starting…" : "Start read-only discussion"}
        </button>
        {!ready ? (
          <p className="section-help" data-testid="discussion-start-blocked">
            Both slots must be eligible before the discussion can start.
          </p>
        ) : null}
      </form>
    </section>
  );
}
