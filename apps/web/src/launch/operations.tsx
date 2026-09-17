// ABOUTME: W02 runner administration and card-level launch operations.
// ABOUTME: Grant changes use action-bound passkey step-up; containment recovery stays local-only.

import { useCallback, useEffect, useMemo, useState } from "react";

import { requestStepUpProof } from "../auth/webauthn.js";
import { hashPublicValue } from "../runner-enrollment.js";
import {
  buildControlRequest,
  buildStartRequest,
  buildWakeLink,
  createLaunchClient,
  describeCheckoutDisplay,
  describeLaunchStatus,
  linkedCheckoutsMessage,
  loadLaunchableCheckoutStatuses,
  newIdempotencyKey,
  providerStatusMessage,
  refreshTaskLaunches,
  resultLabel,
  type CheckoutStatus,
  type ControlAction,
  type LaunchStatus,
  type RunnerSummary,
} from "./api.js";

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

interface MemberRecord {
  id: string;
  display_name: string;
  role: string;
}

interface ProjectRecord {
  id: string;
  name: string;
}

function shortHead(head: string | undefined): string {
  return head ? head.slice(0, 12) : "unknown";
}

export interface RunnerOperationsProps {
  workspaceId: string;
  humanId: string;
  role: "owner" | "member" | "reviewer";
  authorizationEpoch: number;
  csrfToken: string;
  fetchImpl?: typeof fetch;
}

export function RunnerOperations(props: RunnerOperationsProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  const client = useMemo(
    () => createLaunchClient(fetchFn, props.workspaceId, props.csrfToken),
    [fetchFn, props.workspaceId, props.csrfToken],
  );
  const [runners, setRunners] = useState<RunnerSummary[]>([]);
  const [statuses, setStatuses] = useState<Record<string, CheckoutStatus>>({});
  const [statusFailures, setStatusFailures] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [forms, setForms] = useState<
    Record<string, { projects: string[]; launchers: string[]; confirmed: boolean }>
  >({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const listed = await client.listRunners();
      setRunners(listed.runners);
      const next = await loadLaunchableCheckoutStatuses(client, listed.runners, props.humanId);
      setStatuses(next.statuses);
      setStatusFailures(next.failures);
      const projectResponse = await fetchFn(
        `/api/v1/workspaces/${props.workspaceId}/projects?limit=100`,
      );
      if (projectResponse.ok) {
        const body = (await projectResponse.json()) as { projects: ProjectRecord[] };
        setProjects(body.projects);
        const seen = new Map<string, MemberRecord>();
        for (const project of body.projects) {
          const memberResponse = await fetchFn(
            `/api/v1/workspaces/${props.workspaceId}/members?project_id=${encodeURIComponent(project.id)}`,
          );
          if (memberResponse.ok) {
            const memberBody = (await memberResponse.json()) as { members: MemberRecord[] };
            for (const member of memberBody.members) {
              seen.set(member.id, member);
            }
          }
        }
        setMembers([...seen.values()]);
      }
      setLoaded(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Runner operations failed to load.");
    }
  }, [client, fetchFn, props.humanId, props.workspaceId]);

  const refreshRunners = useCallback(async () => {
    const listed = await client.listRunners();
    const kept = new Set(listed.runners.map((runner) => runner.runner_id));
    setRunners(listed.runners);
    setStatuses((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([id]) => kept.has(id))),
    );
    setStatusFailures((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([id]) => kept.has(id))),
    );
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  function formFor(runner: RunnerSummary) {
    return (
      forms[runner.runner_id] ?? {
        projects: [...runner.granted_project_ids],
        launchers: [...runner.launcher_human_ids],
        confirmed: false,
      }
    );
  }

  function setForm(runnerId: string, patch: Partial<ReturnType<typeof formFor>>) {
    setForms((previous) => ({
      ...previous,
      [runnerId]: {
        projects: [],
        launchers: [],
        confirmed: false,
        ...previous[runnerId],
        ...patch,
      },
    }));
  }

  async function submitGrants(runner: RunnerSummary) {
    const form = formFor(runner);
    if (!form.confirmed || busy) {
      return;
    }
    setBusy(runner.runner_id);
    setError(null);
    setStatus(null);
    try {
      const projectIds = [...form.projects].sort();
      const launcherIds = [...form.launchers].sort();
      const target = await hashPublicValue([
        "runner.grants.replace",
        runner.runner_id,
        runner.grant_epoch,
        projectIds,
        launcherIds,
      ]);
      const proof = await requestStepUpProof(fetchFn, props.csrfToken, {
        action: "runner.grants.replace",
        workspaceId: props.workspaceId,
        targetId: target,
        scopes: [],
        authorizationEpoch: props.authorizationEpoch,
      });
      const response = await fetchFn(
        `/api/v1/workspaces/${props.workspaceId}/runners/${runner.runner_id}/grants`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-bfb-csrf": props.csrfToken },
          body: JSON.stringify({
            expected_grant_epoch: runner.grant_epoch,
            project_ids: projectIds,
            launcher_human_ids: launcherIds,
            step_up_proof_id: proof,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(await responseError(response));
      }
      setStatus(`Sharing updated for ${runner.device_label} after passkey verification.`);
      setForms((previous) => {
        const next = { ...previous };
        delete next[runner.runner_id];
        return next;
      });
      await refreshRunners();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sharing update failed.");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(runner: RunnerSummary) {
    if (busy) {
      return;
    }
    setBusy(runner.runner_id);
    setError(null);
    setStatus(null);
    try {
      const proof = await requestStepUpProof(fetchFn, props.csrfToken, {
        action: "runner.revoke",
        workspaceId: props.workspaceId,
        targetId: runner.runner_id,
        scopes: [],
        authorizationEpoch: props.authorizationEpoch,
      });
      const response = await fetchFn(
        `/api/v1/workspaces/${props.workspaceId}/runners/${runner.runner_id}/revoke`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-bfb-csrf": props.csrfToken },
          body: JSON.stringify({ step_up_proof_id: proof }),
        },
      );
      if (!response.ok) {
        throw new Error(await responseError(response));
      }
      setStatus(`${runner.device_label} revoked. Pending launches cancel; live channels close.`);
      await refreshRunners();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Revocation failed.");
    } finally {
      setBusy(null);
    }
  }

  if (!loaded) {
    return (
      <section className="settings-surface" data-testid="runner-operations" aria-busy="true">
        <p className="section-label">RUNNERS &amp; LAUNCHES</p>
        <h1>Loading runner operations…</h1>
      </section>
    );
  }

  return (
    <section className="settings-surface" data-testid="runner-operations">
      <div className="settings-heading">
        <div>
          <p className="section-label">RUNNERS &amp; LAUNCHES</p>
          <h1>Runner operations</h1>
          <p>Enrolled Macs, their linked checkouts, and who may launch on them.</p>
        </div>
      </div>
      {error ? (
        <p className="inline-error" role="alert" data-testid="runner-operations-error">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="inline-status" role="status">
          {status}
        </p>
      ) : null}
      {runners.length === 0 ? (
        <div className="settings-panel">
          <h2>No runners available</h2>
          <p>
            Enroll a Mac from the BFB app to create a runner. Approval happens on the enrollment
            page with a passkey check.
          </p>
        </div>
      ) : null}
      <div className="settings-grid">
        {runners.map((runner) => {
          const checkout = statuses[runner.runner_id];
          const checkoutReadFailed = statusFailures[runner.runner_id] !== undefined;
          const checkoutDisplay = describeCheckoutDisplay(checkout, checkoutReadFailed);
          const owns = runner.owner_human_id === props.humanId;
          const form = formFor(runner);
          const canShare = owns && runner.status === "enrolled" && props.role !== "reviewer";
          return (
            <article
              key={runner.runner_id}
              className="settings-panel"
              data-testid={`runner-${runner.runner_id}`}
            >
              <div className="panel-title-row">
                <div>
                  <p className="section-label">{owns ? "YOUR MAC" : "SHARED WITH YOU"}</p>
                  <h2>{runner.device_label}</h2>
                </div>
                <span>{runner.status}</span>
              </div>
              <dl className="pairing-identity">
                <div>
                  <dt>Projects</dt>
                  <dd>{runner.granted_project_ids.length}</dd>
                </div>
                <div>
                  <dt>Launchers</dt>
                  <dd>{runner.launcher_human_ids.length}</dd>
                </div>
                <div>
                  <dt>Grant epoch</dt>
                  <dd>
                    <code>{runner.grant_epoch}</code>
                  </dd>
                </div>
                <div>
                  <dt>Last Mac report</dt>
                  <dd>{checkout?.inventory_received_at ?? "never"}</dd>
                </div>
              </dl>
              <h3>Linked checkouts</h3>
              {!checkout || checkout.checkouts.length === 0 ? (
                <p
                  data-testid={
                    checkoutDisplay === "unavailable"
                      ? `checkouts-unavailable-${runner.runner_id}`
                      : undefined
                  }
                >
                  {linkedCheckoutsMessage(checkout, checkoutReadFailed)}
                </p>
              ) : (
                <ul className="admin-list" data-testid={`checkouts-${runner.runner_id}`}>
                  {checkout.checkouts.map((item) => (
                    <li key={item.checkout_id}>
                      <div>
                        <strong>{item.label}</strong>
                        <span>
                          {`${item.branch ?? "branch unknown"} · ${shortHead(item.head)} · ${item.dirty ? "dirty" : "clean"} · ${item.status}`}
                        </span>
                        {item.block_reason ? (
                          <span role="alert">{`Blocked: ${item.block_reason.replaceAll("_", " ")}`}</span>
                        ) : null}
                        <code>{`validated ${item.validated_at}`}</code>
                        {item.is_default ? <span>Default</span> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <h3>Provider capability</h3>
              {!checkout || checkout.providers.length === 0 ? (
                <p>{providerStatusMessage(checkout, checkoutReadFailed)}</p>
              ) : (
                <ul className="admin-list">
                  {checkout.providers.map((provider) => (
                    <li key={provider.provider}>
                      <div>
                        <strong>{provider.provider}</strong>
                        <span>{`${provider.version || "unverified"} · ${provider.status}`}</span>
                        <code>{provider.capabilities.join(", ")}</code>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {canShare ? (
                <form
                  className="stacked-form admin-form"
                  data-testid={`grants-${runner.runner_id}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitGrants(runner);
                  }}
                >
                  <h3>Share this Mac</h3>
                  <fieldset>
                    <legend>Projects</legend>
                    {projects.map((project) => (
                      <label className="check-row" key={project.id}>
                        <input
                          type="checkbox"
                          checked={form.projects.includes(project.id)}
                          onChange={(event) =>
                            setForm(runner.runner_id, {
                              projects: event.target.checked
                                ? [...form.projects, project.id]
                                : form.projects.filter((id) => id !== project.id),
                            })
                          }
                        />
                        {project.name}
                      </label>
                    ))}
                  </fieldset>
                  <fieldset>
                    <legend>Named launchers (members and owners only)</legend>
                    {members
                      .filter((member) => member.role === "owner" || member.role === "member")
                      .map((member) => (
                        <label className="check-row" key={member.id}>
                          <input
                            type="checkbox"
                            checked={form.launchers.includes(member.id)}
                            disabled={member.id === runner.owner_human_id}
                            onChange={(event) =>
                              setForm(runner.runner_id, {
                                launchers: event.target.checked
                                  ? [...form.launchers, member.id]
                                  : form.launchers.filter((id) => id !== member.id),
                              })
                            }
                          />
                          {`${member.display_name} (${member.role})`}
                        </label>
                      ))}
                  </fieldset>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={form.confirmed}
                      onChange={(event) =>
                        setForm(runner.runner_id, { confirmed: event.target.checked })
                      }
                    />
                    I recognize every named launcher.
                  </label>
                  <p className="section-help">
                    Saving invokes a user-verifying passkey assertion bound to this exact runner,
                    epoch, project set, and launcher set.
                  </p>
                  <button
                    type="submit"
                    className="button-secondary"
                    disabled={busy === runner.runner_id || !form.confirmed}
                  >
                    Verify passkey &amp; save sharing
                  </button>
                  <button
                    type="button"
                    className="button-quiet"
                    disabled={busy === runner.runner_id}
                    onClick={() => void revoke(runner)}
                  >
                    Revoke Mac
                  </button>
                </form>
              ) : (
                <p className="section-help">
                  {runner.status === "revoked"
                    ? "This Mac is revoked. Only the owner can re-enroll it from the device."
                    : owns
                      ? "Sharing needs an owner or member session with a fresh passkey assertion."
                      : "Only the enrolling human can change sharing or revoke this Mac."}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

interface TaskRecord {
  id: string;
  project_id: string;
  title: string;
  state: string;
  resource_version: number;
}

interface ProfileRecord {
  id: string;
  name: string;
  provider: string;
  model: string | null;
  execution_mode: string;
  resource_version: number;
}

interface ControlResult {
  control_id: string;
  state: string;
  disposition: string | null;
  expires_at: string;
}

export interface LaunchSectionProps {
  workspaceId: string;
  taskId: string;
  humanId: string;
  role: "owner" | "member" | "reviewer";
  csrfToken: string;
  fetchImpl?: typeof fetch;
}

export function LaunchSection(props: LaunchSectionProps) {
  const fetchFn = props.fetchImpl ?? fetch;
  const client = useMemo(
    () => createLaunchClient(fetchFn, props.workspaceId, props.csrfToken),
    [fetchFn, props.workspaceId, props.csrfToken],
  );
  const canManage = props.role === "owner" || props.role === "member";
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [runners, setRunners] = useState<RunnerSummary[]>([]);
  const [statuses, setStatuses] = useState<Record<string, CheckoutStatus>>({});
  const [statusFailures, setStatusFailures] = useState<Record<string, string>>({});
  const [launches, setLaunches] = useState<LaunchStatus[]>([]);
  const [profileId, setProfileId] = useState("");
  const [runnerId, setRunnerId] = useState("");
  const [checkoutId, setCheckoutId] = useState("");
  const [startKey, setStartKey] = useState(() => newIdempotencyKey());
  const [controlKeys, setControlKeys] = useState<Record<string, string>>({});
  const [controlResults, setControlResults] = useState<Record<string, ControlResult>>({});
  const [wakeLinks, setWakeLinks] = useState<Record<string, { href: string; expiresAt: string }>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const taskResponse = await fetchFn(
      `/api/v1/workspaces/${props.workspaceId}/tasks/${props.taskId}`,
    );
    if (!taskResponse.ok) {
      throw new Error("Task is not available.");
    }
    const taskBody = (await taskResponse.json()) as { task: TaskRecord };
    setTask(taskBody.task);
    const [profileBody, runnerBody, launchBody] = await Promise.all([
      (await fetchFn(`/api/v1/workspaces/${props.workspaceId}/agent-profiles?limit=100`)).json(),
      client.listRunners(),
      client.launchesForTask(props.taskId),
    ]);
    setProfiles((profileBody as { profiles: ProfileRecord[] }).profiles);
    setRunners(runnerBody.runners);
    const next = await loadLaunchableCheckoutStatuses(client, runnerBody.runners, props.humanId);
    setStatuses(next.statuses);
    setStatusFailures(next.failures);
    setLaunches(launchBody.launches);
  }, [client, fetchFn, props.humanId, props.taskId, props.workspaceId]);

  const refreshLaunches = useCallback(async () => {
    const body = await refreshTaskLaunches(client, props.taskId);
    setLaunches(body.launches);
  }, [client, props.taskId]);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    void reload()
      .catch((caught: unknown) =>
        active ? setError(caught instanceof Error ? caught.message : "Launch state failed.") : null,
      )
      .finally(() => {
        if (active) {
          setLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, [reload]);

  const awaitingClaim = launches.some(
    (launch) => launch.state === "pending" || launch.state === "claimed",
  );
  useEffect(() => {
    if (!awaitingClaim) {
      return;
    }
    const timer = setInterval(() => {
      void client
        .launchesForTask(props.taskId)
        .then((body) => setLaunches(body.launches))
        .catch(() => null);
    }, 5000);
    return () => clearInterval(timer);
  }, [awaitingClaim, client, props.taskId]);

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
  const effectiveRunnerId = runnerId || launchable[0]?.runner_id || "";
  const runnerStatus = effectiveRunnerId ? statuses[effectiveRunnerId] : undefined;
  const selectableCheckouts = useMemo(() => {
    if (!runnerStatus || !task) {
      return [];
    }
    return runnerStatus.checkouts.filter((checkout) => checkout.project_id === task.project_id);
  }, [runnerStatus, task]);
  const effectiveCheckoutId =
    checkoutId || runnerStatus?.checkouts.find((item) => item.is_default)?.checkout_id || "";
  const usableProfiles = useMemo(() => profiles.filter((item) => item.model), [profiles]);
  const effectiveProfileId = profileId || usableProfiles[0]?.id || "";
  const selectedCheckout = selectableCheckouts.find(
    (item) => item.checkout_id === effectiveCheckoutId,
  );
  const checkoutBlocked = selectedCheckout && selectedCheckout.status !== "validated";

  async function readVersions() {
    if (!task) {
      throw new Error("Task is not available.");
    }
    const profile = profiles.find((item) => item.id === effectiveProfileId);
    if (!profile) {
      throw new Error("Select an agent profile.");
    }
    const [workspacePolicy, projectPolicy, repositoryConfig] = await Promise.all([
      (
        await fetchFn(`/api/v1/workspaces/${props.workspaceId}/workspace-policy`)
      ).json() as Promise<{ policy: { resourceVersion: number } }>,
      (
        await fetchFn(`/api/v1/workspaces/${props.workspaceId}/projects/${task.project_id}/policy`)
      ).json() as Promise<{ policy: { resourceVersion: number } }>,
      (
        await fetchFn(
          `/api/v1/workspaces/${props.workspaceId}/projects/${task.project_id}/repository-config`,
        )
      ).json() as Promise<{ config: { resource_version: number } }>,
    ]);
    return {
      profile,
      workspacePolicyVersion: workspacePolicy.policy.resourceVersion,
      projectPolicyVersion: projectPolicy.policy.resourceVersion,
      repositoryConfigVersion: repositoryConfig.config.resource_version,
    };
  }

  async function startAttempt(retryRunId?: string, freshKey?: string) {
    if (!task || !effectiveRunnerId || !effectiveCheckoutId || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const versions = await readVersions();
      const taskResponse = await fetchFn(
        `/api/v1/workspaces/${props.workspaceId}/tasks/${props.taskId}`,
      );
      if (!taskResponse.ok) {
        throw new Error("Task changed. Reload before starting.");
      }
      const fresh = ((await taskResponse.json()) as { task: TaskRecord }).task;
      setTask(fresh);
      const key = freshKey ?? startKey;
      const response = await client.start(
        buildStartRequest({
          taskId: fresh.id,
          expectedTaskVersion: fresh.resource_version,
          agentProfileId: versions.profile.id,
          agentProfileVersion: versions.profile.resource_version,
          workspacePolicyVersion: versions.workspacePolicyVersion,
          projectPolicyVersion: versions.projectPolicyVersion,
          repositoryConfigVersion: versions.repositoryConfigVersion,
          runnerId: effectiveRunnerId,
          checkoutId: effectiveCheckoutId,
          idempotencyKey: key,
          ...(retryRunId === undefined ? {} : { retryRunId }),
        }),
      );
      if (!response.ok) {
        throw new Error(
          `${await responseError(response)}. The list below shows the current typed state.`,
        );
      }
      await refreshLaunches();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Start failed.");
    } finally {
      setBusy(false);
    }
  }

  async function sendWake(launch: LaunchStatus) {
    setError(null);
    try {
      const issued = await client.wake(launch.launch_id);
      const origin = await client.launchOrigin();
      const href = buildWakeLink(origin, issued.intent_id);
      setWakeLinks((previous) => ({
        ...previous,
        [launch.launch_id]: { href, expiresAt: issued.expires_at },
      }));
      if (typeof window !== "undefined") {
        window.open(href, "_blank", "noopener");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wake signal failed.");
    }
  }

  async function sendControl(launch: LaunchStatus, action: ControlAction) {
    const scope = `${launch.run_execution_id}:${launch.assignment_generation}:${action}`;
    const key = controlKeys[scope] ?? newIdempotencyKey();
    setControlKeys((previous) => ({ ...previous, [scope]: key }));
    setError(null);
    try {
      const response = await client.control(
        buildControlRequest({
          runnerId: launch.runner_id,
          runExecutionId: launch.run_execution_id,
          assignmentGeneration: launch.assignment_generation,
          action,
          idempotencyKey: key,
        }),
      );
      if (!response.ok) {
        throw new Error(await responseError(response));
      }
      const result = (await response.json()) as ControlResult;
      setControlResults((previous) => ({ ...previous, [scope]: result }));
      await refreshLaunches();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Control failed.");
    }
  }

  if (!loaded) {
    return (
      <section aria-busy="true" aria-label="Launch operations" data-testid="launch-section">
        <p role="status">Loading launch state…</p>
      </section>
    );
  }

  return (
    <section aria-label="Launch operations" data-testid="launch-section">
      <h3>Launch operations</h3>
      {error ? (
        <p className="inline-error" role="alert" data-testid="launch-error">
          {error}
        </p>
      ) : null}
      {canManage ? (
        <form
          className="stacked-form"
          data-testid="start-form"
          onSubmit={(event) => {
            event.preventDefault();
            void startAttempt();
          }}
        >
          <label>
            Agent profile
            <select
              data-testid="start-profile"
              value={effectiveProfileId}
              onChange={(event) => setProfileId(event.target.value)}
              required
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id} disabled={!profile.model}>
                  {`${profile.name} · ${profile.provider}${profile.model ? ` · ${profile.model}` : " · no model set"}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Mac runner
            <select
              data-testid="start-runner"
              value={effectiveRunnerId}
              onChange={(event) => {
                setRunnerId(event.target.value);
                setCheckoutId("");
              }}
              required
            >
              {launchable.map((runner) => (
                <option key={runner.runner_id} value={runner.runner_id}>
                  {runner.owner_human_id === props.humanId
                    ? `${runner.device_label} (your Mac)`
                    : `${runner.device_label} (shared with you)`}
                </option>
              ))}
            </select>
          </label>
          {launchable.length === 0 ? (
            <p role="note">
              No Mac is shared with you. Ask a runner owner to name you as a launcher.
            </p>
          ) : null}
          <label>
            Linked checkout
            <select
              data-testid="start-checkout"
              value={effectiveCheckoutId}
              onChange={(event) => setCheckoutId(event.target.value)}
              required
            >
              {selectableCheckouts.map((checkout) => (
                <option key={checkout.checkout_id} value={checkout.checkout_id}>
                  {`${checkout.label} · ${checkout.branch ?? "branch unknown"} · ${checkout.dirty ? "dirty" : "clean"} · ${checkout.status}`}
                </option>
              ))}
            </select>
          </label>
          {effectiveRunnerId && !runnerStatus ? (
            <p role="note" data-testid="checkout-unavailable">
              {linkedCheckoutsMessage(undefined, statusFailures[effectiveRunnerId] !== undefined)}
            </p>
          ) : null}
          {usableProfiles.length === 0 ? (
            <p role="note">
              No agent profile pins a model. Ask an owner to set one before starting.
            </p>
          ) : null}
          {checkoutBlocked ? (
            <p role="alert" data-testid="checkout-blocked">
              {`This checkout is ${selectedCheckout?.status}${
                selectedCheckout?.block_reason
                  ? `: ${selectedCheckout.block_reason.replaceAll("_", " ")}`
                  : ""
              }. Relink and verify it on the Mac before starting.`}
            </p>
          ) : null}
          <button
            type="submit"
            className="button-primary"
            data-testid="start-button"
            disabled={
              busy ||
              !effectiveRunnerId ||
              !effectiveCheckoutId ||
              !effectiveProfileId ||
              Boolean(checkoutBlocked)
            }
          >
            {busy ? "Starting…" : "Start on selected Mac"}
          </button>
          <p className="section-help">
            One click records one durable command. Repeating the click reuses the same request.
          </p>
        </form>
      ) : (
        <p className="section-help" data-testid="launch-readonly">
          Reviewers watch launch state here. Starting and run controls need an owner or member role.
        </p>
      )}
      <div className="launch-list" data-testid="launch-list">
        {launches.length === 0 ? (
          <p data-testid="launch-empty">No launches for this task yet.</p>
        ) : null}
        {launches.map((launch) => {
          const presentation = describeLaunchStatus(launch);
          return (
            <article
              key={launch.launch_id}
              data-testid={`launch-${launch.launch_id}`}
              data-tone={presentation.tone}
            >
              <h4>{presentation.headline}</h4>
              <p>{presentation.detail}</p>
              <p data-testid="launch-result">{resultLabel(launch.result_state)}</p>
              <p>{`Mac fence: ${launch.lease_state ?? "none"}`}</p>
              <p className="section-help">{presentation.nextAction}</p>
              {presentation.needsLocalRecovery ? (
                <p role="alert" data-testid="local-recovery">
                  Open the BFB app on the Mac to inspect and recover. No web action clears this
                  marker.
                </p>
              ) : null}
              {canManage && presentation.actions.includes("wake") ? (
                <button
                  type="button"
                  className="button-secondary"
                  data-testid={`wake-${launch.launch_id}`}
                  onClick={() => void sendWake(launch)}
                >
                  Wake Mac (optional signal)
                </button>
              ) : null}
              {wakeLinks[launch.launch_id] ? (
                <p data-testid={`wake-link-${launch.launch_id}`}>
                  <a
                    href={wakeLinks[launch.launch_id]!.href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open wake signal
                  </a>
                  <span>{`Expires ${wakeLinks[launch.launch_id]!.expiresAt}. The signal never starts or claims the launch.`}</span>
                </p>
              ) : null}
              {canManage && presentation.actions.includes("retry") ? (
                <button
                  type="button"
                  className="button-secondary"
                  data-testid={`retry-${launch.launch_id}`}
                  onClick={() => {
                    const key = newIdempotencyKey();
                    setStartKey(key);
                    void startAttempt(launch.run_id, key);
                  }}
                >
                  Start again explicitly
                </button>
              ) : null}
              {canManage &&
                (["interrupt", "terminate", "cancel", "focus_existing", "resume"] as const).map(
                  (action) =>
                    presentation.actions.includes(action) ? (
                      <button
                        key={action}
                        type="button"
                        className="button-secondary"
                        data-testid={`${action}-${launch.launch_id}`}
                        onClick={() => void sendControl(launch, action)}
                      >
                        {action === "focus_existing"
                          ? "Return to existing session"
                          : `Send ${action}`}
                      </button>
                    ) : null,
                )}
              {Object.entries(controlResults)
                .filter(([scope]) => scope.startsWith(`${launch.run_execution_id}:`))
                .map(([scope, result]) => (
                  <p key={scope} data-testid={`control-result-${result.control_id}`}>
                    {`Control ${result.control_id}: ${result.state}${result.disposition ? ` (${result.disposition})` : ""}. Expires ${result.expires_at}.`}
                  </p>
                ))}
            </article>
          );
        })}
      </div>
    </section>
  );
}
