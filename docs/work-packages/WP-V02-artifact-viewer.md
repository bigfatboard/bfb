# WP-V02 — Isolated artifact viewer

Status: `planned`

Risk: Very high

## Outcome

A human can deliberately render Markdown, Mermaid, diff, image, SVG, log, JSON, or self-contained HTML without giving agent content access to BFB cookies, APIs, navigation, network, or trusted DOM.

## Dependencies

- **Requires:** C01, V01, W01.
- **Unlocks:** V03, X02.
- **Can run with:** A04 after shared UI ownership is agreed.

## Scope

- Create non-secret `view_id` plus hashed one-time `view_secret` bound to session, epoch, exact version/hash, nonce, and expiry through the hub.
- Load a fixed cookie-less artifact-origin bootstrap and transfer the secret through one fresh `MessageChannel` to the exact iframe.
- Redeem through bounded POST; atomically recheck membership/epoch/version, consume grant, and record audit before bytes.
- Use bootstrap iframe `sandbox="allow-scripts allow-forms"` only for redemption; apply final response CSP `sandbox allow-scripts` to remove form capability.
- Apply no-store/no-referrer/nosniff/restrictive permissions policy, exact frame ancestors, no same-origin, no connect, no top navigation/popups/downloads/forms.
- Require explicit **Run preview** for active HTML/SVG and provide stop/reload.
- Implement bounded renderers and strict Mermaid with HTML links/labels disabled and source/node/edge/time limits.
- Keep self-contained HTML dependency-free; no JSX/bundling/import maps/npm.
- Apply C01's durable abuse controls, bounded redemption bodies, attempt caps, and uniform failures to view-grant creation/redemption without storing raw `view_secret` values in rate keys or logs.

## Non-goals

- Auto-run in lists, general app runtime, external dependencies, trusted-origin injection, server-side browser rendering, or generic `window.postMessage` trust.

## Work plan

1. Implement view grant/bootstrap/MessageChannel/redemption flow.
2. Apply final sandbox/CSP/header policy and deliberate preview lifecycle.
3. Add bounded renderers.
4. Run hostile HTML/SVG/Mermaid/network/navigation/cookie/API/DoS corpus, cross-isolate redemption abuse, and URL/log secret checks both inside the intended iframe and as a directly opened top-level redeemed document.

## Acceptance

- View secret appears in no URL, referrer, history entry, log, D1 plaintext, or artifact bytes.
- Reload requires a fresh grant; replay/expiry/revocation fails before bytes.
- Hostile content cannot read app cookies, call control APIs, navigate top, open popups, submit forms, download, or make network requests.
- A redeemed hostile document opened directly as a top-level response remains constrained by the response CSP sandbox and cannot recover navigation, network, form, popup, or download capability.
- Only the exact transferred channel/nonce is accepted.
- Mermaid and other renderers stop safely at bounds.
- Artifact origin never sets/receives an app session cookie.
- View-grant attempt caps remain durable across Worker isolates; oversized/exhausted redemption fails before bytes and exposes no raw secret.

## Evidence and handoff

- Commit browser hostile-content report, response-header captures, URL/log audit, and renderer-bound tests.
- V03 receives an immutable view component; it never injects bytes into trusted DOM.

## Risks and decisions

- The redemption bootstrap and untrusted execution document have different sandbox needs; tests must prove final restrictions intersect correctly.
