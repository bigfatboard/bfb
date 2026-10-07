# Actionable notifications v1

Owner: [X01](../work-packages/WP-X01-notifications.md). Gate: `pnpm test:x01`.

This contract freezes notification subscriptions, preferences, push
endpoints, event selection, delivery bookkeeping, deep links, and the
Queue/DLQ retry discipline. Notifications are derived views over committed
domain state: they never create task, run, attention, or launch truth, and
they never block a product command.

## Records and recipient identities

Migration `0030_notifications` owns the delivery ledger. C11's additive
`0046_notification_public_identities` adds recipient-safe identities; this
transition requires its own acceptance evidence and does not enable private work.

`notification_preferences` keeps one override row per
`(workspace, human, project scope, channel, category)`. `project_id` is the
literal `*` for workspace-wide scope or one project ULID. `channel` is
`browser_push` or `macos`. `category` is `attention`, `launch_blocked`,
`run_failed`, `result_submitted`, `result_accepted`,
`result_changes_requested`, or `run_cancelled`. `enabled` is `0`/`1`.
Rows are upserted by the owning human only; readers fall back to
[defaults](#defaults) when no row matches.

`notification_push_endpoints` keeps one row per
`(workspace, human, endpoint_hash)` where `endpoint_hash` is the hex
SHA-256 of the `https:` push endpoint URL (at most 2048 chars). `p256dh`
(87-88 base64url chars) and `auth` (22-24 base64url chars) are the
receiver's public keys. A 404/410 from the push service deletes only the
contacted endpoint's row; sibling endpoints of the same human survive.
There is no tombstone.

`notification_deliveries` is the delivery bookkeeping ledger, keyed by the
stable `delivery_id`:

- `delivery_id` is a deterministic 26-char Crockford-base32 ID derived
  as `upper(hex(sha256("x01" | workspace_id | event_cursor | channel |
  recipient)))` truncated to 26 chars with the first char masked into
  `0-7`, where recipient is the human ULID for `browser_push` or the
  runner ULID for `macos`. This is an internal, enumerable source-derived key,
  not an opaque public identity. Retries re-derive it so redelivery has one
  logical effect per channel. Queue/DLQ, inbox foreign keys, dispatch watermarks
  and outcome bookkeeping retain it; recipient responses never return it.
- `public_id` is a stored, immutable, timestamp-free identity encoded as 26
  Crockford-base32 characters from 128 cryptographically random bits. It has no
  cursor, timestamp, recipient or epoch input. A winning fan-out INSERT retains
  one identity across retries; a logical-key conflict reloads that row, while
  an identity collision fails rather than silently discarding a delivery.
  Assigned identities and their workspace/source/channel/recipient binding
  cannot change. This is an object identity, not a bearer capability: current
  recipient, credential, membership/epoch, project, preference and exact shared
  parent checks remain necessary at every delivery/contact/ack boundary.
- `state` is `pending`, `delivered`, `suppressed`, `failed`, or
  `dead_lettered`. `suppressed` means access, scope, or preference failed
  at attempt time and no endpoint was contacted. `failed` is terminal
  without retry (unconfigured VAPID, gone endpoint, invalid message).
  `dead_lettered` means the queue attempt budget was exhausted; a
  diagnostic copy was also sent to the DLQ binding.
- `attempt_count` counts real endpoint attempts; `last_error` is a bounded
  `code: detail` string with no secret, body, or URL content.

`notification_macos_inbox` keeps one row per `(workspace, runner,
delivery_id)` with `acked_at` set by the owning runner's pull/ack. The
inbox write is the durable macOS handoff; the daemon offers each unacked
row through the existing app bridge (`NotifyAttention`) on its poll
cadence and the signed app shows its fixed copy. Delivered and
permission-denied intents are acked; transient bridge failures stay
unacked for the next poll. A row never carries task text, paths, tokens,
commands, or arguments: the daemon receives the opaque delivery ULID only.

`notification_dispatch_state` keeps one `(workspace, last_cursor)` row per
workspace so outbox dispatch resumes without resending.

## Defaults

Sparse by design. With no override row, a subscribed event notifies:

| Category | `browser_push` | `macos` |
| --- | --- | --- |
| `attention` | on | on |
| `launch_blocked` | on | on |
| `run_failed` | on | on |
| `result_submitted` | on | on |
| `result_accepted` | on | on |
| `result_changes_requested` | off | off |
| `run_cancelled` | off | off |

An explicit override row wins over the default for its exact
`(project scope, channel, category)`; a project-scoped row wins over the
workspace-wide row. Disabling a category never affects other categories,
and no preference can enable a category for a project the reader cannot
access.

## Event selection

Selection is a pure function of one committed `semantic_events` row
`(workspace_cursor, kind, payload)`. Only these kinds can notify; every
other hub command and every runner telemetry kind maps to no notification:

| Semantic kind | Selects when | Category |
| --- | --- | --- |
| `attention.request` | `result.state` is `open` | `attention` |
| `launch.reject` | always | `launch_blocked` |
| `launch.claim` | `result.state` is `rejected`/`expired` with `reason` `launch_blocked`/`launch_expired` | `launch_blocked` |
| `launch.authorize` | `result.decision` is `rejected` with `rejection.code` `launch_blocked`/`launch_expired` | `launch_blocked` |
| `result.submit` | `result.taskState` is `review` | `result_submitted` |
| `result.request_changes` | always | `result_changes_requested` |
| `result.accept` | always | `result_accepted` |
| `result.fail` | always | `run_failed` |
| `result.cancel` | always | `run_cancelled` |

"Review requested" is the `result.submit` transition that moves a task
into review; no V03 artifact-review kind is selected. Heartbeat, turn,
tool, progress, session, presence, execution, discussion, artifact, auth,
and all other command kinds never notify, even when a preference names
them: selection runs before preferences.

Payloads are untrusted for display. Selection extracts only ULID-typed IDs
(attention, launch, run, submission version); fan-out re-reads the
referenced D1 rows for project scope and existence. A missing or
inaccessible referent notifies nobody.

## Fan-out and access recheck

One queue message carries only `(workspace_id, event_cursor, kind,
job_id)` with stable `job_id = "x01:{workspace}:{cursor}"`. The consumer
reloads the semantic row, rejects kind mismatches, re-runs selection, and
resolves the subject's project from D1:

- attention: `attention_requests` row by ID.
- launch: `launch_commands` row by ID joined to `runs` for the project.
- result: `runs` row by run ID for project and task; submission version
  from the payload.

A human is eligible only when, at fan-out time, they are a current member
(no revocation, epoch matches), their project set contains the subject's
project, and their effective preference enables the category on the
channel. Push fan-out additionally requires a registered endpoint; macOS
fan-out writes one inbox row per enrolled runner owned by an eligible
human that holds a project grant for the subject's project. Delivery inserts
ignore only the stable logical-key conflict, so duplicate or out-of-order queue
delivery converges without hiding a public-identity collision.

Each attempt rechecks membership, epoch, project scope, and preference
immediately before contacting an endpoint. A human revoked, unscoped, or
opted out between fan-out and attempt is recorded `suppressed` and no
endpoint is contacted. Revoked and inaccessible objects never appear in a
notification body, title, or link.

## Delivery

### Browser Push

Push uses VAPID (RFC 8292) with `aes128gcm` content encoding (RFC 8291):
single-record body `salt(16) || rs u32be || keyidlen u8 || as_pub(65) ||
ciphertext`, plaintext suffixed with the `0x02` padding delimiter, and
`Content-Encoding: aes128gcm` with `TTL` and vapid `Authorization`
headers. The X01 gate reproduces the RFC 8291 Appendix A vectors
byte-for-byte.
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` come only
from Worker secrets; they never appear in D1, logs, evidence, or
committed configuration. Tests generate ephemeral keys and serve a fake
push origin. Missing secrets mark pending push deliveries `failed` with
`push_unconfigured` and acknowledge the message: secrets cannot heal
mid-flight.

The encrypted payload is fixed-shape JSON:

```json
{
  "title": "BFB needs your attention",
  "body": "Open BFB to review the next step.",
  "deep_link": "https://app.example/w/01J.../tasks/01J.../attention/01J...",
  "delivery_id": "01J..."
}
```

Titles and bodies are fixed per category and carry no task text. One
delivery covers every endpoint of the human: the consumer tries each
registered endpoint oldest-first. A `200`/`201` marks `delivered`. A
`404`/`410` deletes only that endpoint's row and the consumer tries the
next one. `failed` with `endpoint_expired` is recorded only when every
endpoint answered `404`/`410`. A `429`/`5xx` or network failure is
retryable.

### macOS

macOS delivery is the durable inbox row plus the daemon's bounded poll of
`POST /runner/workspaces/:workspace/runners/:runner/notifications/pull`
over the existing C06 request-bound possession transport, then
`.../notifications/ack`. The v1 pull envelope retains `schema_version`,
`workspace_id`, `runner_id` and `deliveries`; each delivery contains only the
public identity as `delivery_id`. The daemon validates the complete enrollment
tuple and entire bounded batch before offering any intent. Unknown fields,
trailing JSON, malformed/duplicate identities and foreign enrollment tuples
reject without offers or acknowledgements.
The daemon offers each intent once through `internal/appbridge`
`NotifyAttention`; the signed app reuses its fixed title/body and single
**Open BFB** action, and reports `notification_denied` when permission is
off. The daemon never receives task text, paths, tokens, commands, or
provider arguments through this path.

### Legacy identity transition

The migration adds a nullable identity column without rewriting existing delivery
or inbox rows. Application cryptography assigns missing identities in bounded,
resumable batches through the registered system-only
`notification.public_ids.ensure` Hub command. Its strict input is
`{deliveryIds: string[]}` (1–100 distinct internal IDs); the fixed maintenance
actor and epoch 1 are checked before cached replies. Sorted input fingerprints
bind retries. Only NULL identities change; count-only receipts contain neither
aliases nor recipient content. Existing state, attempts, errors, timestamps,
foreign keys and acknowledgements remain unchanged.

Cron scans every historical state. Recipient history/native reads may ensure
missing identities from their authorized bounded page, then repeat the original
retained-authority selection after that await. They never omit legacy rows,
fall back to source-derived identities or allocate an identity after the final
authority check. Repeated interference has a bounded uniform rejection. Push
retry ensures a missing identity before its existing final contact check.

Public history has its existing limit but no raw `after` cursor. Its explicit
DTO preserves authorized category/state/attempt/error/timestamp fields and the
public `delivery_id`, never internal keys or `event_cursor`. Legitimately
authorized shared history remains readable after a role/token change; identities
are not bound to the creation epoch.

Old unacknowledged derived IDs acknowledge zero, exactly like unknown/foreign
IDs; the original inbox rows remain available under their new identities.
An already displayed old-ID notice may appear once more at cutover because the
native client has no durable offered-ID receipt. Previously delivered push
payloads cannot be recalled. Deployment must retire old producers and prove the
backfill has no remaining NULL identities before claiming complete cutover.
This contract authorizes no deployment or live native/provider operation.

## Queue and DLQ discipline

`NOTIFY_JOBS` (`bfb-notify-<env>`) carries event messages;
`NOTIFY_DLQ` (`bfb-notify-dlq-<env>`) receives diagnostic copies. The
consumer `[[queues.consumers]]` sets `max_batch_size = 10`,
`max_retries = 5`, and `dead_letter_queue` to the DLQ. Queue names, DLQ
names, and consumer registrations are per-package and additive: X04 owns
its own names and never shares these bindings.

Per-message isolation is mandatory: every message is wrapped in its own
`try/catch` with an explicit `ack()` or `retry()`; an uncaught error must
never replay a whole successful batch. Retryable endpoint failures call
`msg.retry()` while `msg.attempts < 5`. When the budget is exhausted the
consumer marks remaining retryable deliveries `dead_lettered`, sends one
bounded diagnostic copy per delivery to `NOTIFY_DLQ`, and acknowledges
the message. The DLQ copy carries IDs, category, channel, attempt count,
and error code only. Poison messages therefore land in visible DLQ state
(D1 rows plus DLQ copies) without blocking other messages or any product
command: external enqueue/contact never run inside a Hub mutation, and product
commands never await delivery. Identity maintenance uses its own serialized Hub
command before notification delivery; it creates no task/run/attention truth.

Outbox dispatch runs on the Worker Cron alongside existing sweeps and is
also directly invocable: it advances `notification_dispatch_state`,
sending one message per newly committed actionable event. Dispatch sends
are idempotent by construction (stable job IDs, idempotent consumer), so
a crash between send and watermark advance converges by redelivery.

## Deep links

Links are built only from the validated app origin and ULID-typed IDs:

- attention: `{appOrigin}/w/{workspace}/tasks/{task}/attention/{attention}`
- result submit/changes/accept: `{appOrigin}/w/{workspace}/tasks/{task}/runs/{run}/results/{version}`
- launch blocked, run failed/cancelled: `{appOrigin}/w/{workspace}/tasks/{task}/runs/{run}`

Links contain no task text, local path, token, command, or provider
argument. Any canary drawn from those classes must be absent from every
title, body, link, DLQ copy, and log the package emits. The wake-link
opaque intent (`launch.bfb.<tld>/l/<ULID>`) stays owned by C09; X01 never
mints wake intents.

## Abuse and limits

Preference/endpoint mutations run as hub commands with the caller's
idempotency key and the C01 durable per-address/per-principal budgets of
their routes. Exhausting the browser poll/attempt budget answers the
uniform `403 {error: request_rejected}`, matching the GitHub browser
surface. Push endpoint registration bounds URL and key lengths and
accepts `https:` endpoints only. Fan-out bounds recipients per event (500
humans, 25 runners per human) and never pages without a limit. Cron
purges acked inbox rows older than 7 days and dead endpoint-less
preferences of removed members.

## Verification ownership

The X01 gate covers the event-selection fixture (A02 attention plus each
retained A03 transition, no V03 kind), duplicate/out-of-order queue
delivery with one logical effect per channel, revocation between fan-out
and attempt, telemetry suppression, deep-link/payload canary scans,
expired-endpoint deletion, poison-to-DLQ with visible state, batch
isolation, unconfigured-VAPID terminals, and the migration-registered
check, across real Workers, D1, and a local Queue with DLQ. D1 migration
head for historical X01 evidence is `0030_notifications`. C11 identity acceptance
must additionally prove populated upgrade/resume, identity immutability and
convergence, cursor-free public wires, public-only acknowledgements, authority
loss after backfill/signing, and production-shaped native decoding, while
preserving internal dispatch/retry/DLQ/operator behavior.
