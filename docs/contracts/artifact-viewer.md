# BFB artifact viewer contract (WP-V02, frozen)

This contract freezes the isolated preview flow that WP-V02 owns. Readers must
also follow [`artifacts.md`](artifacts.md) for storage, roles, and kinds, and
`ARCHITECTURE.md` for origin isolation.

## 1. View grant

| Field         | Shape                        | Notes                                              |
| ------------- | ---------------------------- | -------------------------------------------------- |
| `view_id`     | ULID, non-secret             | Identifies the grant in URLs, audit, and support.  |
| `secret`      | 32 random bytes, base64url   | Returned once over the authenticated session.      |
| `nonce`       | 16 random bytes, hex         | Per-view channel value returned with the secret.   |
| `version_id`  | ULID of an `available` version | Grant binds this exact version.                  |
| `content_hash`| SHA-256 hex of the version bytes | Redemption rechecks equality.                |
| `expires_at`  | `now + 5 minutes`            | Reloading a preview always mints a new grant.      |

- The route layer mints the secret and nonce, passes only their SHA-256 hashes
  into the `artifact.create_view_grant` hub command, and returns the plaintext
  pair once in the `201` response. Hub results persist in idempotency records,
  so a secret or nonce inside a command result MUST be rejected in review.
- The grant row stores the secret hash, the nonce hash, the viewing human, the
  issuing session hash, the authorization epoch, the exact content hash, and
  expiry. D1 MUST NOT retain a plaintext secret or nonce in grants, versions,
  audit payloads, idempotency records, rate keys, or logs. Audit payloads carry
  the non-secret view ID only: `{ version_id, view_id }`.
- Issuance requires a current browser session with CSRF, workspace membership
  at the current epoch (any role, including reviewers), and an `available`
  version. The session hash binds issuance and audit; redemption authority is
  the single-use secret plus nonce, fenced by epoch and expiry.
- The view secret MUST NOT appear in any URL, referrer, history entry, log,
  D1 plaintext, or artifact byte.

## 2. Bootstrap

- `GET /view/<view-id>` on the artifact origin serves one fixed, byte-identical
  `text/html` document for every ULID-shaped ID (unknown IDs included, so there
  is no oracle). It contains no artifact bytes and no credential.
- The fixed script offers a fresh `MessageChannel` port to its parent with a
  `{ type: "bfb-view-ready" }` signal, accepts exactly one
  `{ type: "bfb-view-grant", secret, nonce }` message over that port under a
  strict shape (three keys, secret 16–256 base64url chars, nonce 32 hex), then
  submits a same-origin `POST` form with `view_secret` and `view_nonce` fields
  to `/view/<view-id>/redeem`, which navigates the iframe to the redeemed
  document. The view ID is read from the bootstrap location.
- A sandboxed frame without `allow-same-origin` has the opaque origin `null`,
  so the viewer cannot address it with a targeted `postMessage`, and sender
  origin is not a usable signal in either direction. The ready post therefore
  uses a wildcard target but carries no authority — a type tag plus the port
  only. The secret crosses exactly one port whose peer the bootstrap created.
- The iframe attribute MUST be exactly `sandbox="allow-scripts allow-forms"`
  with `referrerpolicy="no-referrer"`. `allow-forms` exists only for the single
  redemption submit; the redeemed response policy below removes it by
  intersection.

## 3. Redemption

- `POST /view/<view-id>/redeem` accepts only
  `application/x-www-form-urlencoded` bodies up to 4096 bytes carrying exactly
  `view_secret` and `view_nonce`. Anything else is a uniform
  `403 { error: "request_rejected" }` that reveals nothing about which field
  was wrong. Oversized bodies fail `413` before any byte is read.
- Before reading any byte, one conditional D1 batch rechecks the secret hash,
  the nonce hash, expiry, version availability, exact content hash, and the
  current authorization epoch, consumes the grant through the single-use
  trigger, and inserts the `artifact.view_redeemed` audit row. A racing or
  replayed redemption aborts the batch with no byte effect; reloads need fresh
  grants.
- The worker re-verifies `SHA-256(R2 bytes) == content_hash` and the
  `workspaces/<workspace-id>/` key prefix before serving. Mismatch or absence
  fails `500 { error: "view_failed" }` without secret, nonce, digest, or byte
  detail.
- Redemption responses by format: `html` and `svg` bytes raw; `png`/`jpeg`
  bytes raw; `markdown`, `mermaid`, `diff`, `json`, and `log` rendered
  server-side into static script-free documents (§5). Compressed `log` chunks
  that do not decode as UTF-8 render the static fallback instead.
- No artifact-origin response may set, accept, or echo cookies. Requests
  bearing `bfb_session` / `__Host-bfb_session` cookies fail `400`.

## 4. Header policy (exact)

Every bootstrap response MUST send:

```
content-type: text/html; charset=utf-8
content-security-policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors <app-origin>
cache-control: private, no-store
referrer-policy: no-referrer
x-content-type-options: nosniff
permissions-policy: accelerometer=(), camera=(), display-capture=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), usb=(), web-share=(), xr-spatial-tracking=()
```

The bootstrap policy deliberately carries no `sandbox` directive: the iframe
attribute owns `allow-scripts allow-forms` for the single redemption submit,
and a response sandbox here would intersect forms away before redemption runs.

Every redemption response (including images and rendered text) MUST send the
same headers with this content security policy instead:

```
content-security-policy: default-src 'none'; sandbox allow-scripts; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors <app-origin>
```

`frame-ancestors` MUST pin the exact app origin. There is no `allow-same-origin`,
no network (`connect-src 'none'`, images `data:`/`blob:` only), no top
navigation or popups, no downloads, and no form capability: the response
`sandbox allow-scripts` intersects the iframe attribute and removes forms.
The same headers constrain a redeemed document opened directly as top-level;
there scripts run with an opaque origin, storage throws, and every exfiltration
vector stays blocked. Chromium still permits a top-level sandboxed document to
navigate itself away (a bare GET that commits away from the hostile document);
that request carries no credential, no referrer, and no secret, and the
intended iframe context blocks top navigation entirely.

## 5. Strict text renderers

Text formats render server-side to static markup with no scripts, event
handlers, frames, forms, or untrusted URLs. All source bytes pass through
HTML escaping; hostile input survives only as visible escaped text.

- Markdown subset: ATX headings (`#`–`###`), fenced code, flat ordered and
  unordered lists, rules, paragraphs, inline code, `**bold**`, `*emphasis*`,
  and `http(s)` links with `rel="noopener"`. Raw HTML renders as escaped
  text; images degrade to alt text; `javascript:` and other schemes stay
  unlinked literal text.
- Mermaid subset: first line `graph TD|TB|LR|RL|BT`, node IDs with optional
  `(round)`, `((stadium))`, `[rect]`, or `{diamond}` labels, and `-->`, `---`,
  `==>` edges with optional `|pipe|` labels. Directive lines (`click`, `href`,
  `style`, `class`, `classDef`, `linkStyle`, `subgraph`, `direction`, `call`,
  `interaction`), comments aside, any `javascript:`/`data:`/event-handler
  pattern, and any markup are dropped, counted, and disclosed; output is static
  SVG with no links, scripts, or foreign content.
- Bounds: 256 KiB source prefix (longer input truncates with notice), 200
  nodes, 400 edges, 200-char labels, 10 000 rendered lines, 1 MiB formatted
  JSON, 2 MiB defensive output ceiling. Over-bound input renders a static
  fallback document naming the limit class, never a partial active document.
- Diff renders `+`/`-`/`@@`/header line classes; JSON pretty-prints valid input
  and degrades invalid input to escaped text with a note; logs render escaped
  text with line caps and truncation notices.

## 6. Abuse control

- View creation (`artifact:view-create`, per-human subject) and redemption
  (`artifact:view-redeem`, per-view subject) share the C01 durable
  attempt/poll budgets (20 attempts, 60 polls per 60 s window) across control
  isolates and the Artifact Worker. Exhaustion fails `403` before bytes; the
  budgeted-out grant stays unconsumed and redeemable from another budget lane.
- Rate subjects hash humans and view IDs; raw secrets and nonces MUST NOT
  enter rate keys or diagnostics.

## 7. Viewer lifecycle (web)

- `ArtifactViewer` (apps/web) never injects bytes into trusted DOM and never
  places secrets in URLs, attributes, or markup. HTML and SVG wait for an
  explicit Run preview; other formats load on mount. Stop disposes the frame;
  Reload mints a fresh grant. The viewer answers only the exact frame's ready
  signal with a strict shape and single port, transfers the grant once over
  that port, wipes the secret, and stops listening.

## 8. Non-goals

- Reviewer project scoping for previews (V03), server-side browser rendering,
  generic `postMessage` trust, auto-running active content, downloads from
  previews, and compressed log-chunk decompression.
