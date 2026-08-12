// ABOUTME: Renders the human checkpoint that narrows an OAuth request to one BFB project.
// ABOUTME: Browser code obtains a passkey proof before resuming the provider-owned consent flow.

export function oauthAuthorizationPage(clientName: string, scopes: readonly string[]): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Authorize ${escapeHtml(clientName)} · BFB</title>
  <link rel="stylesheet" href="/oauth/authorize.css">
</head>
<body>
  <main class="authorization-shell" data-client-name="${escapeHtml(clientName)}">
    <header class="authorization-header">
      <span class="brand-mark">BFB</span>
      <span class="protocol-mark">REMOTE MCP / HUMAN GRANT</span>
    </header>
    <section class="authorization-copy" aria-labelledby="authorization-title">
      <p class="step-label">Grant boundary</p>
      <h1 id="authorization-title">Choose what ${escapeHtml(clientName)} can touch.</h1>
      <p class="lede">This creates a short-lived, revocable grant. It does not make the client an agent, prove that it is working, or give it the rest of your workspace.</p>
      <dl class="request-facts">
        <div><dt>Client</dt><dd>${escapeHtml(clientName)}</dd></div>
        <div><dt>Scopes</dt><dd>${escapeHtml(scopes.join(" · "))}</dd></div>
        <div><dt>Expiry</dt><dd>5 minutes</dd></div>
      </dl>
    </section>
    <section class="authorization-controls" aria-label="Grant boundary">
      <div id="signed-out" hidden>
        <h2>Sign in to continue</h2>
        <p>BFB needs your current GitHub-backed session before it can show any workspace.</p>
        <button id="sign-in" class="button-primary" type="button">Continue with GitHub</button>
      </div>
      <form id="grant-form" hidden>
        <label>
          <span>Workspace</span>
          <select id="workspace" required><option value="">Choose workspace</option></select>
        </label>
        <label>
          <span>Project</span>
          <select id="project" required disabled><option value="">Choose project</option></select>
        </label>
        <div class="boundary-note">
          <strong>Project boundary only.</strong>
          <span>The client cannot widen this grant by sending another ID later.</span>
        </div>
        <button id="authorize" class="button-primary" type="submit">Verify passkey & authorize</button>
      </form>
      <div id="loading" role="status">Checking current BFB authority…</div>
      <p id="error" class="error" role="alert" hidden></p>
    </section>
  </main>
  <script type="module" src="/oauth/authorize.js"></script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

export function oauthAuthorizationStyles(): Response {
  return new Response(AUTHORIZATION_STYLES, {
    headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

export function oauthAuthorizationScript(): Response {
  return new Response(AUTHORIZATION_SCRIPT, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const AUTHORIZATION_STYLES = `
:root { color-scheme: light; font-family: "Schibsted Grotesk", Inter, ui-sans-serif, system-ui, sans-serif; --canvas: oklch(0.976 0.005 75); --surface: oklch(0.944 0.012 35); --ink: oklch(0.16 0.015 30); --muted: oklch(0.43 0.02 30); --rule: oklch(0.78 0.02 30); --crimson: oklch(0.464 0.169 26.9); --error: oklch(0.42 0.17 25); background: var(--canvas); color: var(--ink); }
* { box-sizing: border-box; }
body { min-width: 320px; min-height: 100vh; margin: 0; background: var(--canvas); }
button, select { font: inherit; color: inherit; }
button:focus-visible, select:focus-visible { outline: 3px solid var(--crimson); outline-offset: 3px; }
.authorization-shell { width: min(100% - 32px, 960px); margin: 0 auto; padding: 28px 0 64px; }
.authorization-header { display: flex; align-items: baseline; justify-content: space-between; padding-bottom: 18px; border-bottom: 2px solid var(--ink); }
.brand-mark { font-size: 1.4rem; font-weight: 850; letter-spacing: -0.035em; }
.protocol-mark, .step-label, label > span, dt { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .72rem; font-weight: 700; letter-spacing: .035em; }
.protocol-mark, .step-label, dt { color: var(--muted); }
.authorization-copy { padding: 64px 0 42px; }
.step-label { margin: 0 0 8px; }
h1 { max-width: 760px; margin: 0; font-size: 4.75rem; line-height: .98; letter-spacing: -.035em; text-wrap: balance; }
.lede { max-width: 68ch; margin: 24px 0 0; color: var(--muted); font-size: 1.05rem; line-height: 1.6; }
.request-facts { display: flex; flex-wrap: wrap; gap: 1px; margin: 34px 0 0; padding: 0; background: var(--rule); border: 1px solid var(--rule); }
.request-facts div { flex: 1 1 190px; padding: 14px 16px; background: var(--canvas); }
.request-facts dt { margin-bottom: 5px; }
.request-facts dd { margin: 0; font-weight: 650; overflow-wrap: anywhere; }
.authorization-controls { max-width: 680px; padding-top: 30px; border-top: 1px solid var(--rule); }
h2 { margin: 0 0 8px; font-size: 1.45rem; }
#signed-out p { max-width: 60ch; color: var(--muted); line-height: 1.55; }
#grant-form { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
label { display: grid; gap: 7px; }
select { min-height: 48px; width: 100%; border: 1px solid var(--ink); border-radius: 4px; padding: 0 38px 0 12px; background: transparent; }
select:disabled { cursor: not-allowed; opacity: .55; }
.boundary-note { grid-column: 1 / -1; display: flex; gap: 8px 14px; flex-wrap: wrap; padding: 14px 0; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.boundary-note span { color: var(--muted); }
.button-primary { min-height: 48px; width: fit-content; border: 0; border-radius: 4px; padding: 0 18px; background: var(--ink); color: var(--canvas); font-weight: 750; cursor: pointer; }
.button-primary:hover:not(:disabled) { background: var(--crimson); }
.button-primary:disabled { cursor: wait; opacity: .6; }
#authorize { grid-column: 1 / -1; }
#loading { color: var(--muted); }
.error { max-width: 68ch; margin: 18px 0 0; color: var(--error); font-weight: 650; }
[hidden] { display: none !important; }
@media (max-width: 640px) { .protocol-mark { display: none; } .authorization-copy { padding-top: 44px; } h1 { font-size: 2.4rem; } #grant-form { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; } }
`;

const AUTHORIZATION_SCRIPT = `
const root = document.querySelector(".authorization-shell");
const signedOut = document.querySelector("#signed-out");
const signIn = document.querySelector("#sign-in");
const form = document.querySelector("#grant-form");
const workspace = document.querySelector("#workspace");
const project = document.querySelector("#project");
const authorize = document.querySelector("#authorize");
const loading = document.querySelector("#loading");
const error = document.querySelector("#error");
let csrfToken = "";
let workspaces = [];

function fail(message) {
  error.textContent = message;
  error.hidden = false;
}

function clearError() {
  error.hidden = true;
  error.textContent = "";
}

function decode(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).buffer;
}

function encode(value) {
  if (!value) return "";
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function responseMessage(response, fallback) {
  try {
    const body = await response.json();
    return body.message || body.error || fallback;
  } catch {
    return fallback;
  }
}

async function requestProof(action) {
  if (!globalThis.PublicKeyCredential || !navigator.credentials) {
    throw new Error("This browser cannot perform the required passkey check.");
  }
  const headers = { "content-type": "application/json", "x-bfb-csrf": csrfToken };
  const optionsResponse = await fetch("/auth/step-up/options", {
    method: "POST",
    headers,
    body: JSON.stringify({ action }),
  });
  if (!optionsResponse.ok) {
    throw new Error(await responseMessage(optionsResponse, "A registered passkey is required."));
  }
  const payload = await optionsResponse.json();
  const publicKey = {
    ...payload.options,
    challenge: decode(payload.options.challenge),
    allowCredentials: payload.options.allowCredentials?.map((credential) => ({
      ...credential,
      id: decode(credential.id),
    })),
  };
  const credential = await navigator.credentials.get({ publicKey });
  if (!credential) throw new Error("Passkey verification was cancelled.");
  const assertion = credential.response;
  const verification = await fetch("/auth/step-up/verify", {
    method: "POST",
    headers,
    body: JSON.stringify({
      challenge_id: payload.challenge_id,
      response: {
        id: credential.id,
        rawId: encode(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment,
        clientExtensionResults: credential.getClientExtensionResults(),
        response: {
          clientDataJSON: encode(assertion.clientDataJSON),
          authenticatorData: encode(assertion.authenticatorData),
          signature: encode(assertion.signature),
          userHandle: encode(assertion.userHandle),
        },
      },
    }),
  });
  if (!verification.ok) {
    throw new Error(await responseMessage(verification, "Passkey verification failed."));
  }
  const result = await verification.json();
  if (!result.proof_id) throw new Error("Passkey verification returned no proof.");
  return result.proof_id;
}

async function loadProjects() {
  clearError();
  project.disabled = true;
  project.replaceChildren(new Option("Loading projects…", ""));
  if (!workspace.value) {
    project.replaceChildren(new Option("Choose project", ""));
    return;
  }
  const response = await fetch("/api/v1/workspaces/" + encodeURIComponent(workspace.value) + "/projects?limit=100");
  if (!response.ok) {
    project.replaceChildren(new Option("Projects unavailable", ""));
    fail("BFB could not load projects for that workspace.");
    return;
  }
  const body = await response.json();
  project.replaceChildren(new Option("Choose project", ""));
  for (const item of body.projects || []) project.add(new Option(item.name, item.id));
  project.disabled = false;
}

async function start() {
  try {
    const session = await fetch("/auth/session");
    if (!session.ok) {
      loading.hidden = true;
      signedOut.hidden = false;
      return;
    }
    const sessionBody = await session.json();
    csrfToken = sessionBody.csrf_token || "";
    const response = await fetch("/api/v1/workspaces");
    if (!response.ok) throw new Error("BFB could not load your workspace memberships.");
    workspaces = (await response.json()).workspaces || [];
    workspace.replaceChildren(new Option("Choose workspace", ""));
    for (const item of workspaces) workspace.add(new Option(item.slug, item.id));
    loading.hidden = true;
    form.hidden = false;
  } catch (caught) {
    loading.hidden = true;
    fail(caught instanceof Error ? caught.message : "Authorization setup failed.");
  }
}

workspace.addEventListener("change", () => void loadProjects());

signIn.addEventListener("click", async () => {
  clearError();
  signIn.disabled = true;
  try {
    const response = await fetch("/auth/sign-in/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_path: location.pathname + location.search }),
    });
    const body = await response.json();
    if (!response.ok || !body.url) throw new Error("GitHub sign-in could not start.");
    location.assign(body.url);
  } catch (caught) {
    signIn.disabled = false;
    fail(caught instanceof Error ? caught.message : "GitHub sign-in could not start.");
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  const selectedWorkspace = workspaces.find((item) => item.id === workspace.value);
  if (!selectedWorkspace || !project.value) {
    fail("Choose one workspace and one project.");
    return;
  }
  authorize.disabled = true;
  authorize.textContent = "Waiting for passkey…";
  try {
    const query = new URLSearchParams(location.search);
    const scopes = (query.get("scope") || "").split(/\\s+/u).filter(Boolean).sort();
    const proofId = await requestProof({
      action: "oauth.delegation.create",
      clientId: query.get("client_id"),
      resource: query.get("resource"),
      workspaceId: selectedWorkspace.id,
      projectId: project.value,
      scopes,
      authorizationEpoch: selectedWorkspace.authorization_epoch,
    });
    query.set("workspace_id", selectedWorkspace.id);
    query.set("project_id", project.value);
    query.set("step_up_proof_id", proofId);
    query.set("provider_label", root.dataset.clientName || "Remote MCP client");
    location.assign("/oauth/authorize?" + query.toString());
  } catch (caught) {
    authorize.disabled = false;
    authorize.textContent = "Verify passkey & authorize";
    fail(caught instanceof Error ? caught.message : "Passkey verification failed.");
  }
});

void start();
`;
