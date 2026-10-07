# Event ledger v1

Owner: [E01](../work-packages/WP-E01-event-ingest-replay.md). Gate: `pnpm test:e01`.

This contract freezes runner event ingest, per-event dispositions, workspace
replay, and D1 high-water reads. L06 (the runner-side uploader) calls the
ingest endpoint defined here; E02 consumes replay and high-water; A04 derives
intervals and totals from raw observations without reinterpreting them.

## Wire consumed (F02, frozen)

- `runner-event-submission` v1: the frozen original batch item. Claimed
  workspace/project/task/run IDs are non-authoritative hints; the server
  ignores them for attribution and never stores them.
- `event-envelope` v1: the committed replay shape returned by browser reads.
- `event-disposition` v1: the per-event ingest outcome. `accepted` and
  `already_committed` carry no diagnostic; `retryable` and
  `permanently_rejected` always carry a bounded `TypedError`.
- A04 adds separately named `runner-telemetry-submission` v2 under
  [ADR 0009](../adr/0009-connected-measurement-telemetry.md), without widening
  those v1 schemas or fixtures. Mixed v1/v2 batches retain the outer v1 envelope.
  Typed payloads contain only bounded activity identities or quality-labelled
  turn-delta token fields; they cannot create business state.

No shell, executable, argv, cwd, local path, task text, repository URL,
branch, credential, or provider argument is an accepted ingest field. Payloads
are closed objects; unknown provider fields fail validation.

## Ingest endpoint

`POST /runner/workspaces/:workspace/runners/:runner/events/ingest`

- C06 request-bound possession authentication (`X-BFB-Runner-Proof`), the same
  transport guard and the recurring-channel durable abuse budgets (120 attempts
  per enrollment, 1,024 per IP per minute), not the bootstrap tier. Ingest is
  recurring telemetry: one batch per enrollment per 5 s tick.
  Uniform `request_rejected` failures reveal nothing about workspace state.
- Body (at most 65,536 bytes):
  `{"schema_version": 1, "events": [<runner-event-submission>, ...]}`,
  with 1 to 25 items. Each item is at most 8,192 bytes encoded.
- Response `200`:
  `{"schema_version": 1, "workspace_id": "<ulid>",
    "high_water_cursor": <integer>,
    "dispositions": [<event-disposition>, ...]}`,
  with exactly one disposition per submitted item, in submission order.
- Transport violations (non-JSON body, missing envelope, empty or oversized
  batch, non-object items, or items without a well-formed
  `(event_id, source_stream_id, source_sequence)` triple) reject the whole
  batch uniformly and commit nothing. A row without an addressable triple
  cannot receive an explicit disposition, so it can never be deleted or
  quarantined by cursor.

`GET /runner/workspaces/:workspace/runners/:runner/events/capabilities` uses
the same possession channel and recurring budget. The closed response is
`{"schema_version":1,"accepted_event_versions":[1,2]}`. An unsupported or
unavailable peer leaves typed rows durable and visibly degraded locally;
neither downgrade nor compatibility-only quarantine is allowed.

The signed raw batch/item bytes are checked before numeric normalization.
Non-integer/unsafe JSON counter lexemes cannot round into accepted integers.

## Attribution

Every committed event binds its immutable execution assignment exactly:

- `(workspace_id, run_execution_id, assignment_generation)` must match a
  committed `execution_assignments` row for the authenticated runner.
  Workspace, project, task, run, and source are derived server-side from that
  row and the bound run; claimed IDs are ignored.
- Delayed offline rows commit against their original execution and generation;
  ingest never reattributes a row to a currently active run.
- Actor derivation distinguishes hook/MCP telemetry from daemon facts:
  `runner_observed` commits actor `{type: "runner", id: <runner>}`;
  `agent_reported` and `hook_inbox` commit actor
  `{type: "agent_run", id: <run_execution_id>}`.
- Source is always `{type: "runner", id: <runner>}` plus the provider from
  that execution's immutable launch snapshot when one is present. Mutable
  profile edits cannot relabel historical telemetry. Typed measurements require
  a valid immutable snapshot; no current-profile fallback is guessed.
- `provider_session_id`, when present, is passed through as an observation
  key. Ingest does not create provider sessions and never interprets session,
  heartbeat, Stop, socket-loss, terminal-close, or process-exit rows as a
  result: `run.result_state`, attention state, and execution state are
  untouched by ingest.

## Dispositions

| Disposition | Meaning | Local effect (L06) |
| --- | --- | --- |
| `accepted` | New ledger row committed with a server cursor. | Remove the row. |
| `already_committed` | Same event ID, or same stream row, already stored. | Remove the row. |
| `retryable` | Well-formed row whose execution exists but has no committed assignment yet. | Keep queued. |
| `permanently_rejected` | Schema, attribution, or stream-integrity poison with a bounded diagnostic. | Bounded local quarantine; must not block later rows. |

Rejection causes: unknown execution (`unknown_execution`), generation mismatch
on an assigned execution (`assignment_generation_confusion`), wrong runner
(`wrong_runner`), missing project grant (`project_grant_revoked`), future
`occurred_at` beyond 5 minutes of server time (`future_timestamp`),
event-ID reuse across stream rows (`event_id_confusion`), stream-sequence
reuse across event IDs (`stream_sequence_conflict`), oversized item
(`event_too_large`), and schema failures with the codec diagnostic.

Only an explicit per-event disposition may delete or quarantine a local
outbox row. A workspace replay cursor never deletes or quarantines rows.
The uploader validates the complete workspace-bound acknowledgement and
matching event/stream/sequence triples before applying any disposition.
Malformed, foreign-workspace or conflicting duplicate acknowledgements retain
the batch. A typed row rejected only for unsupported schema remains queued.

## Cursors, ledger, and projections

- Each accepted event receives the next workspace-local monotonic server
  cursor from the shared `workspace_cursors` sequence, allocated in batch
  order through the WorkspaceHub FIFO. The hub audit row consumes the top of
  the reserved range; unused reservations are gaps, never reuse.
- The whole validated batch (ledger rows, observations, absolute projections)
  commits in one atomic D1 batch. A D1-level conflict aborts the batch; the
  daemon retries and converges on explicit dispositions.
- `event_ledger` rows are immutable: update/delete triggers abort, and there
  is no delete path. Deduplication is by event ID and by
  `(workspace_id, source_stream_id, source_sequence)`.
- `measurement_observations` keeps one raw observation per accepted
  measurement-kind event (heartbeat, session, turn, tool, progress rows),
  keyed by the event ID with actor/source/capture-origin provenance. Totals
  are derived from unique observation identities; replaying a heartbeat or
  observation can never inflate a later aggregate.
- For typed telemetry, A04's canonical source and alias tables bind the full
  input fingerprint and semantic activity/usage identity. Canonical facts,
  token observations and ledger rows share the atomic D1 batch; recaptured
  aliases remain traceable ledger events without duplicating observations.
- Run, execution, session, and per-kind projections are absolute,
  cursor-guarded upserts recomputed from committed counts plus the batch;
  they never blindly increment after an insert. Heartbeat presence
  (`heartbeat_count`, `last_heartbeat_at`) is liveness only, never activity
  or completion.

## Current C11 public delivery policy

The [C11 public-position quarantine](private-task-delivery.md) holds browser
replay/high-water and exported public raw-position readers uniformly before
source/high-water reads. Existing credential, role and pure query admission
remain; valid public requests receive fixed 409 `request_rejected` with
`event feeds are unavailable` and no-store. Stored ledger/order, runner ingest,
capabilities, per-item dispositions and acknowledgements are unchanged. The
following replay wire remains historical, not current available delivery.

## Replay and high-water

`GET /api/v1/workspaces/:workspace/events/high-water` returns
`{"schema_version": 1, "workspace_id": "<ulid>", "high_water_cursor": <integer>}`.

`GET /api/v1/workspaces/:workspace/events?after_cursor=&through_cursor=&limit=`
returns committed `event-envelope` rows in cursor order plus
`high_water_cursor` and `has_more`. `through_cursor` defaults to the current
high-water; `limit` defaults to 100 and caps at 100. Both reads go directly
to D1 and require a current workspace owner or member; reviewers stay
project-scoped. There is no browser or workspace-cursor delete path.

Frozen v1 replay is a metadata projection: typed telemetry rows retain their
closed payload in canonical storage but expose an empty v1 replay payload.
Authorized A04 measurement-source reads expose bounded source metadata; replay
is not an export of raw typed payloads.

Browser resynchronization follows the architecture rule: connect first, read
the D1 high-water, buffer live invalidations, replay HTTP events after the
client cursor through that high-water mark, then drain the buffer. A higher
committed cursor is an invalidation to replay, never durable state.

## Verification ownership

The E01 gate covers duplicate, out-of-order, concurrent, delayed, and poison
events plus acknowledgement loss across real Workers and D1; exactly-once
ledger/projection effects; absolute totals under replay; actor/provenance
separation; closed-payload rejection; invalid actor claims; no result
inference from stop/heartbeat/exit rows; and replay/high-water reads. D1
migration head after this package is `0019_event_ledger`.
