# WP-V02 — Isolated artifact viewer

Status: `planned`

Risk: Very high

Test target: `pnpm test:v02`

Evidence manifest: `docs/work-packages/evidence/WP-V02/manifest.json`

## Outcome

A human can deliberately render Markdown, Mermaid, diff, image, SVG, log,
JSON, or self-contained HTML in a fully isolated origin that cannot touch
control-plane sessions, cookies, or APIs, so teams can trust previews of
agent-produced files.

Implementation, gate, and evidence are complete on this branch and waiting on
V01: this package stays `planned` because `pnpm roadmap:check` rejects any
status beyond `planned` while dependency V01 is not `done` (V01 itself waits
on A01). The Handoff records the exact state.

## Dependencies

- **Requires:** V01, C01, F03, W01.
- **Unlocks:** V03, X02.
- **Can run with:** L05, W02, E02, L06, A02, A03. UI changes stay on artifact
  view surfaces; D1 migration number `0026` is reserved for this package.

## Scope

- View grant creates single-use, short-lived, human-scoped authorization for
  the current human session with epoch, exact version/hash, nonce, and expiry
  checks enforced at redemption by the Artifact Worker through hub.
- Load a fixed cookie-less artifact-origin bootstrap and transfer the secret
  through one fresh `MessageChannel` to the exact iframe with a strict,
  size-limited schema bound to the per-view nonce.
- Redeem through a bounded `POST` and atomically recheck membership/epoch
  before bytes; D1 keeps only the non-secret view ID (hashes for the secret
  and nonce), the audit uses only the non-secret view ID, and provenance is
  available without subscribing bytes.
- Bootstrap iframe `sandbox="allow-scripts allow-forms"` only for redemption,
  with final response CSP `sandbox allow-scripts` to remove form capability.
- Require explicit Run preview for active HTML/SVG and provide stop/reload.
- `Content-Security-Policy`, no-store/no-referrer/nosniff/restrictive
  permissions policy, exact frame ancestors, no same-origin, no connect, no
  top navigation/popups/downloads/forms.
- Implement bounded renderers and strict Mermaid with HTML links/labels
  disabled and source/node/edge/time limits.
- Apply C01's durable abuse controls to redemption abuse with bounded
  redemption bodies, attempt caps, uniform failures, and no raw view_secret
  in rate keys or logs.
- Keep self-contained HTML dependency-free; no JSX/bundling/import maps/npm.

## Non-goals

- Generic `window.postMessage` trust (the viewer answers only the exact
  frame's ready signal with a strict shape and single port, then stops
  listening; the secret crosses that port once and is wiped).
- Server-side browser rendering, auto-run in lists, downloads from previews,
  reviewer project scoping for previews (V03), compressed log-chunk
  decompression.

## Contracts

### Consumes

- `docs/contracts/artifacts.md` — artifact formats, roles, content addressing,
  R2 layout, and hub authorization (V01).
- C01 `WorkspaceHub` command protocol, durable abuse budgets, and the
  `artifact_audit_outbox` table.
- F03 two-origin substrate (`APP_ORIGIN`, `ARTIFACT_ORIGIN`) and W01 app shell
  and renderer surfaces.

### Produces

- `docs/contracts/artifact-viewer.md` — frozen view grant, bootstrap,
  redemption, header policy, strict renderer, abuse, and lifecycle contract.
- Stable test target `pnpm test:v02` and evidence manifest
  `docs/work-packages/evidence/WP-V02/manifest.json` for checkpoint and
  release automation.

## Work plan

1. Migrate D1 `0026_artifact_viewer` (single-use grants, consume-once and
   immutability triggers) and add the domain view-grant command with
   hash-only storage. Verify with `packages/domain/test/artifact-views.test.ts`.
2. Add the Artifact Worker bootstrap/redemption endpoints with the frozen
   header policy and bounded strict renderers. Verify with
   `apps/artifact-worker/test/view.test.ts` and `renderers.test.ts`.
3. Add the control-plane view-grant route with durable budgets. Verify with
   `apps/control-worker/test/artifact-view-routes.test.ts`.
4. Add the web `ArtifactViewer` with explicit preview gating and the
   port-answering lifecycle. Verify with `apps/web/test/artifact-viewer.test.ts`.
5. Certify the hostile corpus, header policy, and cross-isolate budgets with
   `tools/artifact-viewer/run.ts`, and the sandbox/CSP claims in a real
   browser with `apps/web/test/e2e/v02-viewer.spec.ts`. Freeze the contract,
   capture evidence, regenerate the roadmap, and run the clean-checkout gate.

## Acceptance

- [ ] View secret appears in no URL, referrer, history entry, log, D1
  plaintext, or artifact bytes.
- [ ] Reload requires a fresh grant; replay/expiry/revocation fails before bytes.
- [ ] Hostile content cannot read cookies, call control APIs, navigate top,
  open popups, submit forms, download, or make network requests from inside
  the intended iframe.
- [ ] Redeemed hostile document opened directly as top-level remains
  constrained by the response CSP sandbox and cannot recover navigation,
  network, form, popup, or download capability.
- [ ] Only the exact transferred channel/nonce is accepted.
- [ ] Mermaid and other renderers stop safely at bounds.
- [ ] Artifact origin never sets/receives app session cookie.
- [ ] View-grant attempt caps are durable across isolates; oversized/exhausted
  redemption fails before bytes and exposes no raw secret.

Every box above is proven by `pnpm test:v02`: the hostile HTML, SVG,
Mermaid, network, navigation, cookie, API, and denial-of-service corpus runs
inside the intended iframe and as a directly opened top-level redeemed
document, plus cross-isolate redemption abuse, replay, expiry, revocation,
the exact channel and nonce check, renderer bounds, and URL, referrer,
history, log, and D1 secret checks. Browser tests are mandatory for the
sandbox and CSP claims and live in `apps/web/test/e2e/v02-viewer.spec.ts`.

## Evidence

- `docs/work-packages/evidence/WP-V02/manifest.json` (conforms to
  `docs/work-packages/evidence/manifest.schema.json`),
  `hostile-corpus.md` (acceptance matrix from `tools/artifact-viewer/run.ts`),
  `headers.json` (captured bootstrap and redemption header sets),
  `csp-sandbox-report.md` (browser sandbox/CSP report from
  `apps/web/test/e2e/v02-viewer.spec.ts`), and `command-result.json`
  (command outcomes for the tested commit).

## Risks and decisions

- Active previews must run scripts to be useful, so containment cannot rely
  on script removal. Decision: raw bytes served under a sandboxed opaque
  origin with `connect-src 'none'`, no forms/popups/downloads/top-navigation,
  proven by hostile self-reporting documents in a real browser.
- A sandboxed opaque-origin frame cannot be addressed with a targeted
  `postMessage` (recipient origin is `null`). Decision: the fixed bootstrap
  offers a fresh port to its parent with an authority-free ready signal; the
  viewer answers only the exact frame's signal over that port, once, then
  stops listening. Sender origin is not a signal by construction.
- Chromium permits a top-level sandboxed document to navigate itself away (a
  bare GET that unloads the hostile document). Decision: the request carries
  no credential, no referrer, and no secret, and the intended iframe context
  blocks top navigation entirely; the browser suite asserts both halves.

## Handoff

- Implementation, gate, and evidence are complete on branch `muse/v02` at the
  committed hash recorded in the evidence manifest; status stays `planned`
  pending V01 (`planned` pending A01). No push performed.
- Commands: `pnpm test:v02` (build, protocol, vitest suites, harness with
  `V02_D1_OK`, browser suite on `BFB_E2E_PORT=4185`), `pnpm verify`,
  `pnpm worktree:check`, and the clean-checkout gate
  (`git worktree add --detach /tmp/bfb-v02-clean <commit>`,
  `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test:v02`).
- D1 migration `0026_artifact_viewer` is this package's only migration.
- Known limitations: role-`log` (compressed) chunks render the static
  fallback (no decompression); mermaid covers the strict flowchart subset
  only; top-level self-navigation issues a credential-free bare GET (see
  Risks); reviewer project scoping for previews is a V03 concern.
- V03 receives the frozen `docs/contracts/artifact-viewer.md`, the
  `ArtifactViewer` component with its port-answering lifecycle, and the
  immutable view surfaces; it MUST NOT inject bytes into trusted DOM.
- Graph notes: `Unlocks` lists V03 and X02 (both require V02); V04 has no
  package file yet, so it cannot be listed until it exists. F03's unlock list
  gained the missing V02 entry (one line) so `pnpm roadmap:write` regenerates
  the index.
