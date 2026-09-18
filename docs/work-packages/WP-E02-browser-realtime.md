# WP-E02 — Browser realtime, timeline, and presence

Status: `done`

Risk: High

Test target: `pnpm test:e02`

Evidence manifest: `docs/work-packages/evidence/WP-E02/manifest.json`

## Outcome

A workspace member watching a running attempt sees one live Run timeline and honest presence from committed ledger events: the browser subscribes first, buffers socket invalidations, replays authoritative HTTP ranges, and renders actor, source, provenance, session/execution identity, and committed summaries without ever treating a socket summary as durable state.

## Dependencies

- **Requires:** E01, W01.
- **Unlocks:** A02, D03, G01, X01.
- **Can run with:** L05, W02, L06, A01, V01, L07, P01.

## Scope

- Authenticated browser WebSocket upgrade carried to the hub with hibernating attachments that store IDs/epochs/expiry only. Close sockets on session/token expiry, membership epoch change, and revocation.
- Subscribe-first client state machine: buffer invalidations first, capture D1 high-water, replay HTTP events after the client cursor through that mark, then drain/fetch buffered cursors without dropping or duplicating events.
- Broadcast only compact invalidations with the new committed cursor; WebSocket summaries are never the only copy of an event.
- Run timeline with actor/source/provenance, session/execution identity, and meaningful but honest summaries. Render all summaries and bodies as inert data through W01's escaped renderer (no raw HTML from task, provider, or event text).
- Presence with separate connectivity (connecting/live/stale/offline), process presence (alive/idle/unknown), and normalized activity (working only with heartbeat/supporting evidence, idle prompt not shown as working). Apply 15-second live heartbeat and 45-second stale presentation policy. Show idle/unknown/waiting states honestly; human presence uses committed interaction/review records, e.g. 'Reviewed 20 minutes ago' derives from a committed review, not browser presence.
- Replay-race coverage (events injected before subscription, before/at/after high-water capture, during replay and during drain), eviction and reconnect, expiry and revocation, stale presence, and hostile event strings.
- Contract freeze in `docs/contracts/browser-realtime.md` (socket, invalidation, and presence contract).

## Non-goals

- E01 ledger semantics, dispositions, and retention stay untouched; no new ledger kinds or cadence changes.
- Provider execution, launch orchestration, agent scheduling, and attention/review decisions stay with their owners.
- Card and runner launch-operation views stay with W02; E02 mounts only the realtime, timeline and presence surfaces.
- No autonomous completion inference, time/token accounting, or result acceptance from connectivity or presence.

## Contracts

### Consumes

- E01 event ledger contract (`docs/contracts/event-ledger.md`): replay ranges, high-water cursor, dispositions, projections.
- E01 HTTP replay endpoints (`GET .../events`) and W01 app-shell/renderer patterns in `apps/web`, `packages/ui`, `apps/control-worker`.
- C02 sessions/epochs and C04 authorization epochs for staleness, expiry, and revocation closes.
- F02 frozen wire-envelope shape for replay rows.

### Produces

- Browser realtime v1 (`docs/contracts/browser-realtime.md`): authenticated subscribe route, subprotocol, hibernation attachment fields, compact invalidation shape, close policy, subscribe-first resync rule, timeline entry shape, and presence policy.
- Stable test target `pnpm test:e02` and evidence manifest `docs/work-packages/evidence/WP-E02/manifest.json` for checkpoint/release automation.

## Work plan

1. Freeze the socket, invalidation, and presence contract with the server BrowserSockets manager, the authenticated upgrade route, and hub wiring; verify with socket and route unit tests.
2. Build the subscribe-first resync machine plus timeline and presence projections; verify with the deterministic replay-race suite and projection unit tests.
3. Prove the live path in a two-Worker Durable Object harness with real sockets (handshake, fan-out, reconnect, expiry, revocation, hostile cleanliness).
4. Prove the browser path end to end over the e2e server (timeline, presence, hostile inertness, reviewer fence, revocation); capture the declared traces and screenshots.
5. Record the package shape, evidence manifest, roadmap index, and checkpoint-log line; pass the gate from a clean checkout.

## Acceptance

- Authenticated WebSocket upgrade carries browser subscriptions to the hub; hibernating attachments store IDs/epochs/expiry only (no cookies/tokens). Sockets close on session/token expiry, membership epoch change, and revocation.
- Client connects the WebSocket first, gets the hub's D1 high-water cursor, buffers live invalidations during replay, replays HTTP events after the client cursor through that high-water mark, then drains/fetches buffered cursors. A higher cursor triggers replay; a WebSocket summary is never the only copy. Test injects events before subscription, before/at/after high-water capture, during replay and during drain; each renders once in order.
- On every commit the server broadcasts only the compact committed cursor. Timeline rows show actor/source/provenance and the bound session/execution identity. Durable Object eviction/reconnect recovers identity without bearer material, and expiry/revocation close only affected sockets.
- Run timeline summarizes kinds meaningfully without claiming results/acceptance/completion; task/provider/event text passes through the escaped renderer and cannot inject raw HTML (hostile-string test).
- Presence separates connectivity, process presence, and normalized activity. 45s stale policy never flips a result to failed; an idle prompt is never 'working'; human 'Reviewed N ago' comes only from a committed review.
- `pnpm test:e02` passes; committed evidence shows traces/screenshots plus the passing suites with the tested commit hash.

## Evidence

- `docs/work-packages/evidence/WP-E02/manifest.json` indexes the gate run (unit, workerd harness, browser), the replay-race matrix, eviction/expiry traces, timeline/presence reports, hostile-content report, and browser screenshots, conforming to the evidence manifest schema with commit, heads, environment, commands, outcome, and redaction status.
- Browser traces and screenshots live under `docs/work-packages/evidence/WP-E02/browser/`.

## Risks and decisions

- Workerd hibernation restore cannot be forced in the test harness, so eviction recovery is proven by attachment serialization across manager instances plus reconnect authority checks; the exact close codes ride socket-double unit tests while the harness asserts close frames and teardown.
- The miniflare test client does not surface server-initiated close events, so the harness proves revocation teardown by close frame plus attrition (later commits reach only survivors).
- v0.1 has no committed review records, so human presence derives from committed task comments and the UI never renders a "Reviewed …" claim; the projection is fenced so a future review record is the only source of such a claim.
- No D1 migration: all E02 reads use `0019_event_ledger` tables, so no `0022` migration is taken.

## Handoff

- Settled 18 September: `done`. E01 is `done`, and `pnpm test:e02` passed in a detached clean checkout at `9372c0f` (install, build, exact target with the workerd harness and 8 browser tests).
- Run `pnpm test:e02` (unit plus `tools/realtime` workerd harness plus the `e02-realtime` Playwright suite on `BFB_E2E_PORT=4181`).
- Build on `docs/contracts/browser-realtime.md`; keep invalidations cursor-only and replay authoritative.
- Known limits: single shared expiry alarm covers runner and browser sockets per workspace; the browser client retries transient closes three times, then requires manual reconnect; expired sessions require sign-in again.
