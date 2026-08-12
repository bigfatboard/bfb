// ABOUTME: Renders owner-only project, agent-profile, and workspace-policy administration.
// ABOUTME: Sensitive policy changes obtain an action-bound passkey proof before mutation.

import { useCallback, useEffect, useState } from "react";

import { requestStepUpProof } from "./auth/webauthn.js";

type Provider = "claude" | "codex" | "grok";

interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
  tint: string;
  access_mode: "workspace" | "restricted";
  repository_host: string;
  hosted_repository_id: string;
  repository_subpath: string;
  resource_version: number;
}

interface AgentProfileRecord {
  id: string;
  name: string;
  provider: Provider;
  model: string | null;
  execution_mode: "interactive" | "headless";
  harness_mode: "restricted" | "standard";
  resource_version: number;
}

interface WorkspacePolicy {
  allowedProviders: Provider[];
  allowAgentRootPropose: boolean;
  allowPassToAgent: boolean;
  allowRunOverrides: boolean;
  resourceVersion: number;
}

export interface WorkspaceSettingsProps {
  workspaceId: string;
  authorizationEpoch: number;
  csrfToken: string;
  fetchImpl: typeof fetch;
  onChanged: () => void;
}

function requestId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export function WorkspaceSettings(props: WorkspaceSettingsProps) {
  const fetchFn = props.fetchImpl;
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [profiles, setProfiles] = useState<AgentProfileRecord[]>([]);
  const [policy, setPolicy] = useState<WorkspacePolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const base = `/api/v1/workspaces/${props.workspaceId}`;
      const [projectResponse, profileResponse, policyResponse] = await Promise.all([
        fetchFn(`${base}/projects?limit=100`),
        fetchFn(`${base}/agent-profiles?limit=100`),
        fetchFn(`${base}/workspace-policy`),
      ]);
      if (!projectResponse.ok || !profileResponse.ok || !policyResponse.ok) {
        const failed = [projectResponse, profileResponse, policyResponse].find(
          (response) => !response.ok,
        )!;
        throw new Error(await responseError(failed));
      }
      const projectBody = (await projectResponse.json()) as { projects: ProjectRecord[] };
      const profileBody = (await profileResponse.json()) as { profiles: AgentProfileRecord[] };
      const policyBody = (await policyResponse.json()) as { policy: WorkspacePolicy };
      setProjects(projectBody.projects);
      setProfiles(profileBody.profiles);
      setPolicy(policyBody.policy);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Workspace controls failed to load.");
    } finally {
      setLoading(false);
    }
  }, [fetchFn, props.workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mutate(action: () => Promise<Response>, success: string): Promise<void> {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const response = await action();
      if (!response.ok) {
        throw new Error(await responseError(response));
      }
      setStatus(success);
      await load();
      props.onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Mutation failed.");
    } finally {
      setSaving(false);
    }
  }

  if (loading && !policy) {
    return (
      <section className="settings-surface" data-testid="settings-surface" aria-busy="true">
        <p className="section-label">PROJECTS &amp; POLICY</p>
        <h1>Loading workspace controls…</h1>
      </section>
    );
  }

  return (
    <section className="settings-surface" data-testid="settings-surface">
      <div className="settings-heading">
        <div>
          <p className="section-label">PROJECTS &amp; POLICY</p>
          <h1>Workspace controls</h1>
          <p>Explicit configuration, versioned changes, and no mystery admin switches.</p>
        </div>
        <span className="owner-only">Owner only</span>
      </div>

      {error ? (
        <p className="inline-error" role="alert" data-testid="settings-error">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="inline-status" role="status">
          {status}
        </p>
      ) : null}

      <div className="settings-grid">
        <section className="settings-panel" aria-labelledby="projects-heading">
          <div className="panel-title-row">
            <div>
              <p className="section-label">PROJECT REGISTRY</p>
              <h2 id="projects-heading">Projects</h2>
            </div>
            <span>{projects.length}</span>
          </div>
          <ul className="admin-list">
            {projects.map((project) => (
              <li key={project.id}>
                <span className="project-swatch" style={{ backgroundColor: project.tint }} />
                <div>
                  <strong>{project.name}</strong>
                  <span>{`${project.slug} · ${project.access_mode} · v${project.resource_version}`}</span>
                  <code>{`${project.repository_host}/${project.hosted_repository_id}`}</code>
                </div>
              </li>
            ))}
          </ul>
          <form
            className="stacked-form admin-form"
            data-testid="create-project-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void mutate(
                () =>
                  fetchFn(`/api/v1/workspaces/${props.workspaceId}/projects`, {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      "x-bfb-csrf": props.csrfToken,
                    },
                    body: JSON.stringify({
                      name: form.get("name"),
                      slug: form.get("slug"),
                      tint: String(form.get("tint") ?? "").toUpperCase(),
                      access_mode: "restricted",
                      repository_host: form.get("repository_host"),
                      hosted_repository_id: form.get("hosted_repository_id"),
                      repository_subpath: ".",
                      request_id: requestId("web-project"),
                    }),
                  }),
                "Restricted project created.",
              );
            }}
          >
            <h3>Add restricted project</h3>
            <label>
              Name
              <input name="name" required maxLength={128} />
            </label>
            <label>
              Slug
              <input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
            </label>
            <label>
              Project color
              <input name="tint" type="color" defaultValue="#6D28D9" required />
            </label>
            <label>
              Repository host
              <input name="repository_host" defaultValue="github.com" required />
            </label>
            <label>
              Hosted repository ID
              <input name="hosted_repository_id" placeholder="GitHub repository node ID" required />
            </label>
            <button type="submit" className="button-secondary" disabled={saving}>
              Add project
            </button>
          </form>
        </section>

        <section className="settings-panel" aria-labelledby="profiles-heading">
          <div className="panel-title-row">
            <div>
              <p className="section-label">AGENT PROFILES</p>
              <h2 id="profiles-heading">Profiles</h2>
            </div>
            <span>{profiles.length}</span>
          </div>
          <ul className="admin-list">
            {profiles.map((profile) => (
              <li key={profile.id}>
                <div>
                  <strong>{profile.name}</strong>
                  <span>{`${profile.provider} · ${profile.execution_mode} · ${profile.harness_mode}`}</span>
                  <code>{profile.model ?? "Provider default model"}</code>
                </div>
              </li>
            ))}
          </ul>
          <form
            className="stacked-form admin-form"
            data-testid="create-profile-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void mutate(
                () =>
                  fetchFn(`/api/v1/workspaces/${props.workspaceId}/agent-profiles`, {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      "x-bfb-csrf": props.csrfToken,
                    },
                    body: JSON.stringify({
                      name: form.get("name"),
                      provider: form.get("provider"),
                      model: String(form.get("model") ?? "") || undefined,
                      execution_mode: form.get("execution_mode"),
                      harness_mode: form.get("harness_mode"),
                      request_id: requestId("web-profile"),
                    }),
                  }),
                "Agent profile created.",
              );
            }}
          >
            <h3>Add agent profile</h3>
            <label>
              Name
              <input name="name" required maxLength={128} />
            </label>
            <label>
              Provider
              <select name="provider" defaultValue="codex">
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="grok">Grok</option>
              </select>
            </label>
            <label>
              Model override
              <input name="model" placeholder="Provider default" />
            </label>
            <label>
              Execution mode
              <select name="execution_mode" defaultValue="interactive">
                <option value="interactive">Interactive</option>
                <option value="headless">Headless</option>
              </select>
            </label>
            <label>
              Harness mode
              <select name="harness_mode" defaultValue="standard">
                <option value="standard">Standard</option>
                <option value="restricted">Restricted</option>
              </select>
            </label>
            <button type="submit" className="button-secondary" disabled={saving}>
              Add profile
            </button>
          </form>
        </section>

        {policy ? (
          <section className="settings-panel policy-panel" aria-labelledby="policy-heading">
            <div className="panel-title-row">
              <div>
                <p className="section-label">ACTION-BOUND</p>
                <h2 id="policy-heading">Workspace policy</h2>
              </div>
              <span>{`v${policy.resourceVersion}`}</span>
            </div>
            <form
              className="stacked-form"
              data-testid="workspace-policy-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const allowedProviders = (["claude", "codex", "grok"] as const).filter(
                  (provider) => form.get(provider) === "on",
                );
                const settings = {
                  allowed_providers: allowedProviders,
                  allow_agent_root_propose: form.get("allow_agent_root_propose") === "on",
                  allow_pass_to_agent: form.get("allow_pass_to_agent") === "on",
                  allow_run_overrides: form.get("allow_run_overrides") === "on",
                };
                void mutate(async () => {
                  const targetId = await sha256Json([
                    "workspace.policy.update",
                    null,
                    policy.resourceVersion,
                    [...allowedProviders].sort(),
                    settings.allow_agent_root_propose,
                    settings.allow_pass_to_agent,
                    settings.allow_run_overrides,
                  ]);
                  const proofId = await requestStepUpProof(fetchFn, props.csrfToken, {
                    action: "workspace.policy.update",
                    workspaceId: props.workspaceId,
                    targetId,
                    scopes: [],
                    authorizationEpoch: props.authorizationEpoch,
                  });
                  return fetchFn(`/api/v1/workspaces/${props.workspaceId}/workspace-policy`, {
                    method: "PUT",
                    headers: {
                      "content-type": "application/json",
                      "x-bfb-csrf": props.csrfToken,
                    },
                    body: JSON.stringify({
                      expected_version: policy.resourceVersion,
                      ...settings,
                      step_up_proof_id: proofId,
                      request_id: requestId("web-workspace-policy"),
                    }),
                  });
                }, "Workspace policy updated after passkey verification.");
              }}
            >
              <fieldset>
                <legend>Allowed providers</legend>
                {(["claude", "codex", "grok"] as const).map((provider) => (
                  <label className="check-row" key={provider}>
                    <input
                      type="checkbox"
                      name={provider}
                      defaultChecked={policy.allowedProviders.includes(provider)}
                    />
                    {provider}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Capabilities</legend>
                <label className="check-row">
                  <input
                    type="checkbox"
                    name="allow_agent_root_propose"
                    defaultChecked={policy.allowAgentRootPropose}
                  />
                  Agents may propose root tasks
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    name="allow_pass_to_agent"
                    defaultChecked={policy.allowPassToAgent}
                  />
                  Humans may pass work to agents
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    name="allow_run_overrides"
                    defaultChecked={policy.allowRunOverrides}
                  />
                  Run overrides allowed
                </label>
              </fieldset>
              <p className="section-help">
                Saving invokes a user-verifying passkey assertion bound to this exact policy version
                and value set.
              </p>
              <button
                type="submit"
                className="button-attention"
                data-testid="save-workspace-policy"
                disabled={saving}
              >
                Verify passkey &amp; save
              </button>
            </form>
          </section>
        ) : null}
      </div>
    </section>
  );
}
