// ABOUTME: Guides a real signed-in operator through first-owner bootstrap and passkey enrollment.
// ABOUTME: Uses existing reauthentication and ceremony routes without storing codes or simulating authority.

import { useEffect, useRef, useState } from "react";
import { registerPasskey } from "./webauthn.js";

interface PageProps {
  fetchImpl: typeof fetch;
  csrfToken: string;
  search: string;
  navigate(path: string): void;
}

export function enrollmentFlow(search: string, field: string): string | null {
  const params = new URLSearchParams(search);
  const values = params.getAll(field);
  return values.length === 1 && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(values[0] ?? "")
    ? values[0]!
    : null;
}

export function githubReauthenticationURL(value: unknown): string {
  if (typeof value !== "string") throw new Error("GitHub verification did not start.");
  const url = new URL(value);
  if (url.origin !== "https://github.com" || url.username || url.password) {
    throw new Error("GitHub verification returned an unexpected address.");
  }
  return url.href;
}

async function post(fetchImpl: typeof fetch, csrfToken: string, path: string, body: unknown) {
  const response = await fetchImpl(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bfb-csrf": csrfToken },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 429
        ? "Too many attempts. Wait a minute and try again."
        : response.status === 401
          ? "Sign in again to continue."
          : "This verification is unavailable or expired. Start again.",
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

function AuthFrame(props: { title: string; children: React.ReactNode }) {
  return (
    <main className="sign-in-shell">
      <section className="sign-in-panel" aria-labelledby="setup-title">
        <p className="brand-mark">BFB</p>
        <h1 id="setup-title" tabIndex={-1}>
          {props.title}
        </h1>
        {props.children}
      </section>
    </main>
  );
}

export function OnboardingPage(props: PageProps) {
  const flow = enrollmentFlow(props.search, "workspace_bootstrap");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (flow) codeInput.current?.focus();
  }, [flow]);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      const result = await post(
        props.fetchImpl,
        props.csrfToken,
        "/api/v1/workspace-access/bootstrap/start",
        {},
      );
      window.location.assign(githubReauthenticationURL(result.url));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Workspace verification failed.");
      setBusy(false);
    }
  }

  async function complete(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const result = await post(
        props.fetchImpl,
        props.csrfToken,
        "/api/v1/workspace-access/bootstrap/complete",
        {
          flow_id: flow,
          bootstrap_secret: form.get("bootstrap_secret"),
          slug: form.get("slug"),
        },
      );
      if (
        result.role !== "owner" ||
        typeof result.slug !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(result.slug)
      ) {
        throw new Error("The server did not confirm the new workspace.");
      }
      if (codeInput.current) codeInput.current.value = "";
      window.location.assign(`/settings/security?workspace=${encodeURIComponent(result.slug)}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Workspace was not created.");
    } finally {
      if (codeInput.current) codeInput.current.value = "";
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Create your workspace">
      <p>Use the operator’s one-time setup code. Signing in alone does not grant ownership.</p>
      {flow ? (
        <form className="stacked-form" onSubmit={(event) => void complete(event)}>
          <label>
            Workspace address
            <input
              name="slug"
              required
              maxLength={63}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              autoComplete="off"
            />
          </label>
          <label>
            Setup code
            <input
              ref={codeInput}
              name="bootstrap_secret"
              type="password"
              required
              autoComplete="off"
              spellCheck={false}
              maxLength={256}
            />
          </label>
          <button type="submit" className="button-primary" disabled={busy}>
            {busy ? "Creating workspace…" : "Create workspace"}
          </button>
          <button
            type="button"
            className="button-quiet"
            onClick={() => void begin()}
            disabled={busy}
          >
            Restart GitHub verification
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="button-primary"
          onClick={() => void begin()}
          disabled={busy}
        >
          {busy ? "Opening GitHub…" : "Verify with GitHub"}
        </button>
      )}
      {error ? (
        <p role="alert" className="inline-error">
          {error}
        </p>
      ) : null}
      <button type="button" className="button-quiet" onClick={() => props.navigate("/")}>
        Back to BFB
      </button>
    </AuthFrame>
  );
}

interface PasskeySummary {
  id: string;
  name: string | null;
  createdAt: string | null;
}

export function SecurityPage(props: PageProps) {
  const fetchImpl = props.fetchImpl;
  const [passkeys, setPasskeys] = useState<PasskeySummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState(false);
  const flow = enrollmentFlow(props.search, "passkey_enrollment");
  const workspaceSlug = new URLSearchParams(props.search).get("workspace");
  const back =
    workspaceSlug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(workspaceSlug)
      ? `/w/${workspaceSlug}/settings`
      : "/";

  useEffect(() => {
    let active = true;
    fetchImpl("/auth/passkeys")
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Registered passkeys could not be loaded. Reload to retry.");
        const result = (await response.json()) as { passkeys: PasskeySummary[] };
        if (!Array.isArray(result.passkeys))
          throw new Error("Registered passkeys could not be loaded.");
        if (active) setPasskeys(result.passkeys);
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [fetchImpl]);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      const result = await post(
        props.fetchImpl,
        props.csrfToken,
        "/auth/passkeys/enroll/start",
        {},
      );
      if (result.requires_reauthentication !== true)
        throw new Error("Initial enrollment requires fresh GitHub verification.");
      window.location.assign(githubReauthenticationURL(result.url));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Passkey verification failed.");
      setBusy(false);
    }
  }

  async function enroll(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!flow) return;
    setBusy(true);
    setError(null);
    const name = String(new FormData(event.currentTarget).get("name") ?? "");
    try {
      await registerPasskey(props.fetchImpl, props.csrfToken, flow, name);
      const location = new URL(window.location.href);
      location.searchParams.delete("passkey_enrollment");
      window.history.replaceState(
        null,
        "",
        `${location.pathname}${location.search}${location.hash}`,
      );
      setRegistered(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Passkey was not registered.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Secure your account">
      <p>A passkey confirms sensitive actions, including connecting this Mac to your workspace.</p>
      {registered ? (
        <p role="status">Passkey registered. You can now connect your Mac.</p>
      ) : passkeys === null ? (
        <p role="status">Loading passkeys…</p>
      ) : flow ? (
        <form className="stacked-form" onSubmit={(event) => void enroll(event)}>
          <label>
            Passkey name
            <input name="name" required maxLength={128} autoComplete="off" />
          </label>
          <button type="submit" className="button-primary" disabled={busy}>
            {busy ? "Waiting for your authenticator…" : "Create passkey"}
          </button>
          <button
            type="button"
            className="button-quiet"
            disabled={busy}
            onClick={() => void begin()}
          >
            Restart GitHub verification
          </button>
        </form>
      ) : passkeys.length ? (
        <>
          <h2>Registered passkeys</h2>
          <ul>
            {passkeys.map((key) => (
              <li key={key.id}>{key.name || "Passkey"}</li>
            ))}
          </ul>
          <p>Your account is ready for passkey checks.</p>
        </>
      ) : (
        <button
          type="button"
          className="button-primary"
          disabled={busy}
          onClick={() => void begin()}
        >
          {busy ? "Opening GitHub…" : "Verify with GitHub"}
        </button>
      )}
      {error ? (
        <p role="alert" className="inline-error">
          {error}
        </p>
      ) : null}
      <button type="button" className="button-secondary" onClick={() => props.navigate(back)}>
        Continue to BFB
      </button>
    </AuthFrame>
  );
}
