// ABOUTME: Approves a locally generated public runner identity with explicit projects and a bound passkey assertion.
// ABOUTME: Keeps browser approval separate from connectivity and never receives a runner key or token.

import { useEffect, useState } from "react";
import type { RunnerEnrollmentHandoff } from "@bfb/protocol";

import { requestStepUpProof } from "./auth/webauthn.js";

const idPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const keyCoordinate = /^[A-Za-z0-9_-]{43}$/u;

export async function hashPublicValue(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function parseEnrollmentFragment(
  fragment: string,
): Promise<{ handoff: RunnerEnrollmentHandoff; thumbprint: string }> {
  const encoded = fragment.replace(/^#/u, "");
  if (encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(encoded))
    throw new Error("Invalid enrollment link.");
  const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  if (btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "") !== encoded)
    throw new Error("Invalid enrollment link.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
  const handoff = JSON.parse(text) as RunnerEnrollmentHandoff;
  const key = handoff?.public_key;
  if (
    handoff?.schema_version !== 1 ||
    !idPattern.test(handoff.workspace_id) ||
    !idPattern.test(handoff.runner_id) ||
    typeof handoff.device_label !== "string" ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._()'-]{0,79}$/u.test(handoff.device_label) ||
    handoff.device_label.trim() !== handoff.device_label ||
    key?.crv !== "P-256" ||
    key.kty !== "EC" ||
    !keyCoordinate.test(key.x) ||
    !keyCoordinate.test(key.y)
  )
    throw new Error("Invalid enrollment link.");
  const publicKey = { crv: key.crv, kty: key.kty, x: key.x, y: key.y };
  // Go's map encoder sorts field names. Exact canonical form rejects duplicate
  // fields, private-key parameters and hidden routing/command data in the link.
  const canonical = {
    device_label: handoff.device_label,
    public_key: publicKey,
    runner_id: handoff.runner_id,
    schema_version: 1,
    workspace_id: handoff.workspace_id,
  };
  if (JSON.stringify(canonical) !== text) throw new Error("Invalid enrollment link.");
  await crypto.subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "verify",
  ]);
  return { handoff, thumbprint: await hashPublicValue(publicKey) };
}

interface Workspace {
  id: string;
  slug: string;
  role: "owner" | "member" | "reviewer";
  authorization_epoch: number;
}

export function RunnerEnrollmentPage(props: {
  fetchImpl: typeof fetch;
  csrfToken: string;
  humanName: string | null;
  workspaces: Workspace[];
  fragment?: string;
}) {
  const fetchFn = props.fetchImpl;
  const [identity, setIdentity] = useState<Awaited<
    ReturnType<typeof parseEnrollmentFragment>
  > | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspace = props.workspaces.find((item) => item.id === identity?.handoff.workspace_id);
  const canEnroll = workspace?.role === "owner" || workspace?.role === "member";

  useEffect(() => {
    let active = true;
    void parseEnrollmentFragment(props.fragment ?? window.location.hash)
      .then((result) => {
        if (active) setIdentity(result);
      })
      .catch(() => {
        if (active)
          setError("This enrollment link is invalid. Generate a new link from BFB on your Mac.");
      });
    return () => {
      active = false;
    };
  }, [props.fragment]);

  useEffect(() => {
    if (!identity || !canEnroll) return;
    let active = true;
    void (async () => {
      try {
        const base = `/api/v1/workspaces/${identity.handoff.workspace_id}`;
        const [projectResponse, runnerResponse] = await Promise.all([
          fetchFn(`${base}/projects?limit=100`),
          fetchFn(`${base}/runners`),
        ]);
        if (!projectResponse.ok || !runnerResponse.ok)
          throw new Error("Current project access could not be loaded. Reload this page to retry.");
        const body = (await projectResponse.json()) as {
          projects: { id: string; name: string }[];
          next_cursor?: string;
        };
        const existing = (await runnerResponse.json()) as {
          runners: { runner_id: string; public_key_thumbprint: string; status: string }[];
        };
        const runner = existing.runners.find(
          (item) => item.runner_id === identity.handoff.runner_id,
        );
        if (
          runner &&
          (runner.public_key_thumbprint !== identity.thumbprint || runner.status === "revoked")
        )
          throw new Error(
            "This runner identity is unavailable. Start a new enrollment from your Mac.",
          );
        if (active) {
          setProjects(body.projects);
          setApproved(Boolean(runner));
          setLoaded(true);
        }
      } catch (caught) {
        if (active)
          setError(caught instanceof Error ? caught.message : "Enrollment could not be loaded.");
      }
    })();
    return () => {
      active = false;
    };
  }, [identity, canEnroll, fetchFn]);

  async function approve(event: React.FormEvent) {
    event.preventDefault();
    if (!identity || !workspace || !canEnroll || busy || !confirmed || !chosen.length) return;
    setBusy(true);
    setError(null);
    try {
      const handoff = identity.handoff;
      const projects = [...chosen].sort();
      const targetId = await hashPublicValue([
        "runner.enroll",
        handoff.runner_id,
        handoff.device_label,
        identity.thumbprint,
        projects,
      ]);
      const proof = await requestStepUpProof(fetchFn, props.csrfToken, {
        action: "runner.enroll",
        workspaceId: workspace.id,
        targetId,
        scopes: [],
        authorizationEpoch: workspace.authorization_epoch,
      });
      const response = await fetchFn(`/api/v1/workspaces/${workspace.id}/runners`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bfb-csrf": props.csrfToken },
        body: JSON.stringify({
          runner_id: handoff.runner_id,
          device_label: handoff.device_label,
          public_key: handoff.public_key,
          project_ids: projects,
          step_up_proof_id: proof,
        }),
      });
      if (!response.ok)
        throw new Error(
          "Approval was not confirmed. Reload to check whether it committed, then retry if needed.",
        );
      setApproved(true);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Approval failed. No connection is assumed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="runner-pairing" aria-labelledby="runner-pairing-title">
      <a className="brand-mark" href="/" aria-label="BFB home">
        BFB
      </a>
      <p className="section-label">CONNECT YOUR MAC</p>
      <h1 id="runner-pairing-title">
        {approved ? "Mac approved." : "Trust this Mac, explicitly."}
      </h1>
      <p className="pairing-intro">
        Choose which projects this Mac can work on. Remote launch stays private to you until you
        explicitly share it.
      </p>
      {error ? (
        <p role="alert" className="inline-error">
          {error}
        </p>
      ) : null}
      {!props.humanName ? (
        <section className="settings-panel">
          <h2>Sign in to approve</h2>
          <p>Sign in in another tab, then return here to finish pairing.</p>
          <a className="button-primary" href="/" target="_blank" rel="noreferrer">
            Open sign-in
          </a>
          <button
            className="button-secondary"
            type="button"
            onClick={() => window.location.reload()}
          >
            Check sign-in
          </button>
        </section>
      ) : identity ? (
        <>
          <dl className="pairing-identity">
            <div>
              <dt>Mac</dt>
              <dd>{identity.handoff.device_label}</dd>
            </div>
            <div>
              <dt>Workspace</dt>
              <dd>{workspace?.slug ?? "Not available to this account"}</dd>
            </div>
            <div>
              <dt>Approving as</dt>
              <dd>{props.humanName}</dd>
            </div>
            <div>
              <dt>Public key fingerprint</dt>
              <dd>
                <code>{identity.thumbprint}</code>
              </dd>
            </div>
          </dl>
          {!canEnroll ? (
            <p role="alert" className="inline-error">
              You need an active owner or member role in this workspace to enroll a Mac.
            </p>
          ) : approved ? (
            <section role="status" className="settings-panel">
              <h2>Approval is saved.</h2>
              <p>
                The daemon can now connect in the background, even when the BFB menu-bar app is
                closed. Approval alone does not mean the Mac is online.
              </p>
              <p>Check its connection in BFB on your Mac. You can close this page.</p>
              <a className="button-secondary" href={`/w/${workspace!.slug}`}>
                Open workspace
              </a>
            </section>
          ) : !loaded ? (
            error ? (
              <button
                type="button"
                className="button-secondary"
                onClick={() => window.location.reload()}
              >
                Reload approval
              </button>
            ) : (
              <p role="status">Loading current project access…</p>
            )
          ) : (
            <form onSubmit={(event) => void approve(event)} className="stacked-form settings-panel">
              <fieldset disabled={busy}>
                <legend>Allow these projects</legend>
                {projects.map((project) => (
                  <label key={project.id} className="check-row">
                    <input
                      type="checkbox"
                      checked={chosen.includes(project.id)}
                      onChange={(event) =>
                        setChosen((previous) =>
                          event.target.checked
                            ? [...previous, project.id]
                            : previous.filter((id) => id !== project.id),
                        )
                      }
                    />
                    {project.name}
                  </label>
                ))}
                {!projects.length ? (
                  <p>No accessible projects. Ask a workspace owner to grant access, then reload.</p>
                ) : null}
              </fieldset>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I recognize this Mac and its key fingerprint.
              </label>
              <p className="section-help">
                Compare the fingerprint with BFB on the Mac. Only public identity leaves the device;
                signing keys and provider credentials stay local.
              </p>
              <button
                type="submit"
                className="button-primary"
                disabled={busy || !confirmed || !chosen.length}
              >
                {busy ? "Verifying approval…" : "Verify passkey & approve Mac"}
              </button>
              <a href="/">Cancel enrollment</a>
            </form>
          )}
        </>
      ) : !error ? (
        <p role="status">Checking the public enrollment link…</p>
      ) : null}
    </main>
  );
}
