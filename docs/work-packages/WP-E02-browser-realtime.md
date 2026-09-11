# WP-E02 — Browser realtime, timeline, and presence

Status: `planned`

Risk: High

## Outcome

The browser shows committed work within seconds and recovers from disconnect/hibernation without gaps, duplicates, or false claims that a connected agent is working.

## Dependencies

- **Requires:** E01, W01.
- **Unlocks:** A02, D03, G01, X01.
- **Can run with:** L07/W02 after run-state contracts freeze.

## Scope

- Add authenticated browser WebSocket upgrade and hibernating attachments containing IDs/epochs/expiry but no cookies/tokens.
- Close sockets on session/token expiry, membership epoch change, and revocation.
- Establish the authenticated WebSocket subscription and start buffering invalidations first; then receive/capture the D1 high-water cursor, replay HTTP events after the client cursor through that mark, and finally drain/fetch buffered cursors above it.
- Broadcast only compact committed-cursor invalidations; D1 replay stays authoritative.
- Build Run timeline with actor/source/provenance, session/execution identity, and meaningful event summaries.
- Render task/provider/event text through W01's escaped or allowlisted renderer; compact summaries are data and can never inject raw HTML into the authenticated app origin.
- Separate connectivity, process presence, and normalized activity.
- Apply 15-second live heartbeat and 45-second stale presentation policy without changing run result.
- Show idle/unknown/waiting states honestly; human presence uses committed interaction/review records.

## Non-goals

- Durable state only in sockets, terminal transcript streaming, browser tab time as labor, or connected/process-alive as working.

## Work plan

1. Implement authorized hibernating socket lifecycle and expiry/revocation.
2. Implement the subscribe-first replay state machine with injected events before subscription, before/during high-water capture, during replay, and during buffer drain.
3. Build timeline and separate presence projections.
4. Test eviction, reconnect, cursor gaps, sleep/wake, stale signals, and authorization changes.

## Acceptance

- Events injected before subscription, before/at/after high-water capture, during replay, and during drain all render once in order.
- Durable Object eviction/reconnect recovers identity without bearer credentials in attachments.
- Expiry/revocation closes only affected sockets and blocks new messages.
- A higher cursor triggers replay; a WebSocket summary is never the only copy.
- Process alive at an idle prompt is not labelled working.
- “Reviewed 20 minutes ago” derives from a committed review, not browser presence.
- Malicious provider/event strings render as inert text or reviewed safe markup and never execute on the authenticated origin.

## Evidence and handoff

- Commit deterministic replay-race suite, eviction/expiry traces, and timeline/presence screenshots.
- A02/A04 subscribe to committed projections rather than inventing parallel live state.

## Risks and decisions

- Realtime correctness is primarily resynchronization correctness; low latency without replay is not acceptable.
