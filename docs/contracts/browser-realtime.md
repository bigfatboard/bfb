# Browser realtime v1

Owner: [E02](../work-packages/WP-E02-browser-realtime.md). Gate: `pnpm test:e02`.

This contract freezes the authenticated browser subscription, the compact
invalidation shape, the subscribe-first resynchronization rule, and the
timeline and presence semantics. E01 owns the ledger, dispositions, replay,
and high-water reads consumed here; this package adds no wire schema and no
D1 migration. D1 head stays `0019_event_ledger`.

## Socket subscription

`GET /realtime/workspaces/:workspace/subscribe`

- Browser cookie session only. A present `Authorization` header is rejected
  as `credential_confusion`; an absent or expired session is `401`.
- Requires `Upgrade: websocket` and
  `Sec-WebSocket-Protocol: bfb.browser.v1`, else `400`. No query string.
- Requires an exact `Origin` match against the app origin, so a foreign
  page cannot ride the browser cookie into another origin's socket.
- Requires a current workspace `owner` or `member`. Reviewers stay
  project-scoped and receive `403`; the ledger replay endpoints keep the
  same fence.
- On success the Control Worker forwards the upgrade to the workspace
  `WorkspaceHub` Durable Object with one `x-bfb-browser-principal` JSON
  header. The header carries IDs, epochs, and expiry only: `workspaceId`,
  `humanId`, `authorizationEpoch`, `role`, `sessionId`, `sessionExpiresAt`.
  It never carries a cookie, session token, or bearer secret.

## Hibernation attachments

Socket attachments persist across eviction and contain only
IDs/epochs/expiry:

```json
{
  "schema_version": 1,
  "workspaceId": "<ulid>",
  "humanId": "<ulid>",
  "authorizationEpoch": 1,
  "role": "owner",
  "sessionId": "<opaque>",
  "sessionExpiresAt": "2026-08-07T12:05:00.000Z",
  "connectionId": "<ulid>",
  "subscribedAt": "2026-08-07T12:00:00.000Z"
}
```

After eviction the hub recovers identity by deserializing this attachment
and rechecking the session row plus the membership epoch against D1. No
re-authentication secret is stored or replayed.

## Message shapes

All messages are closed JSON objects with `schema_version: 1`. Unknown
fields and unknown kinds are rejected; a rejected client frame closes the
socket with `1008`.

Server to client:

- `browser.realtime.ready`: `{workspace_id, connection_id, high_water_cursor,
  server_time}`. Sent once after subscribe; the cursor is the D1 high-water
  at subscribe time.
- `event.committed`: `{workspace_id, high_water_cursor}`. Compact
  invalidation only: a cursor hint, never event data. Keys are exactly
  `schema_version`, `kind`, `workspace_id`, `high_water_cursor`.
- `browser.realtime.alive`: `{workspace_id, connection_id, server_time}`.
  Heartbeat acknowledgement.
- `browser.realtime.close`: `{workspace_id, reason}` with
  `reason` in `session_expired`, `session_revoked`, `authorization_revoked`.
  Sent once before the socket closes.

Client to server:

- `browser.realtime.heartbeat`: `{workspace_id, connection_id}`. Clients
  SHOULD send one every 15 seconds; the server rejects more than one per
  10-second window and rechecks session plus membership epoch on each one.

## Lifecycle and close policy

- The server rechecks every browser socket after each committed workspace
  command and on its persistent expiry alarm.
- Expired sessions close with `4401` (`session_expired`). Deleted sessions,
  membership epoch changes (including removal, role loss, and rejoin under
  a new epoch), and grant revocation close with `4403`
  (`session_revoked` / `authorization_revoked`). Only affected sockets
  close; other members of the same workspace are undisturbed, and no new
  message is accepted from a closed socket.
- The expiry alarm is scheduled at the earliest attached
  `sessionExpiresAt`. A lost alarm timer fails closed: live sockets close
  with `1011` rather than outliving their authority.

## Resynchronization rule (normative)

D1 replay stays authoritative; the socket is a notification channel:

1. Open the WebSocket subscription first and start buffering
   `event.committed` cursors.
2. Capture the D1 high-water cursor from `browser.realtime.ready`.
3. Replay HTTP events after the client cursor through that mark
   (`GET .../events?after_cursor=<client>&through_cursor=<mark>`).
4. Drain: while the buffered maximum exceeds the replayed-through cursor,
   replay the next buffered range. Then stay live: a higher cursor is an
   invalidation to replay, never durable state.

Events committed before subscription, before/at/after high-water capture,
during replay, and during drain each render exactly once in cursor order.
Deduplication is by event ID; ordering is by workspace cursor.

## Timeline entries

The Run timeline is a projection of committed replay envelopes for one
run, newest last. Each entry carries cursor, kind, meaningful summary,
actor/source/provenance, session/execution identity, and commit time:

- Actor: `runner` (daemon-observed fact) or `agent_run` (agent-reported or
  hook telemetry), with the bound ID.
- Source: the owning runner plus the run profile provider when known.
- Provenance: `capture_origin` rendered as `daemon-observed` or
  `agent-reported`; never reworded into a completion claim.
- Session/execution identity: `run_execution_id`, `assignment_generation`,
  and `provider_session_id` when present.

Summaries are fixed per-kind templates. Compact summaries are data: every
task, provider, and event-controlled string renders as escaped text through
the W01 React text pattern. No timeline code path uses raw HTML, and no
summary may claim a result, acceptance, or completion.

## Presence semantics

Connectivity, process presence, and normalized activity are separate
fields; none changes the run result.

- Heartbeat cadence is 15 seconds; the stale threshold is 45 seconds.
- Connectivity: `live` (socket open with a signal inside 45 seconds),
  `stale` (open but quiet for 45 seconds or more), `offline` (socket
  closed). Stale never mutates run state.
- Process presence: `alive` (a heartbeat inside 45 seconds), `stale` (an
  older heartbeat), `unknown` (no heartbeat observed). A live process
  waiting at an idle prompt is `idle` activity, never `working`.
- Activity: `working` requires an open normalized turn interval
  (`turn_started` without a later `turn_stopped` / `turn_failed`).
  Heartbeat-only runs are `idle`. Runs with no observed events are
  `unknown`. A trailing `attention_requested` without a newer turn bound
  is `needs_human`.
- Human presence uses committed interaction records only. In v0.1 the only
  such records are task comments: the latest human-authored comment
  renders as "Last human note … ago". There are no committed review
  records yet (A03 owns them), so the UI must never render a "Reviewed …"
  claim, and browser presence is never presented as attention or work
  time.

## Verification ownership

The E02 gate covers the authenticated upgrade, attachment secrecy,
subscribe-first replay races, eviction/reconnect identity, expiry and
revocation closes, cursor-only invalidations, timeline actor/provenance
identity, presence policy boundaries, and hostile-string inertness, over
unit suites, a two-Worker Durable Object harness with real sockets, and a
real-browser suite. No D1 migration is owned by this package.
