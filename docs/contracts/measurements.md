# Measurements and provenance v1

Owner: [A04](../work-packages/WP-A04-measurements.md). Gate: `pnpm test:a04`.

This contract freezes typed measurement observations, interval derivation,
token normalization with quality, versioned price-catalog calculation, the
explicit review-timer service consumed by V03, attention latency, intervention
counts, capped browser-activity estimates, project/provider/priority
aggregation, and the separated product displays. G01 uses these metrics as
release assertions.

A04 derives from raw observations without reinterpreting them. It never
infers completion, human attention, agent activity, time, or token usage from
transport presence or prose, and never presents estimated or unavailable
values as exact.

## Records (D1 migration `0027_measurements`)

Every stored observation carries a unique `(workspace_id, observation_id)`.
Totals are derived at read time from unique identities; replaying an
observation inserts no second row, so replays cannot inflate totals.
Observation tables are immutable: update/delete triggers abort.

`token_observations` keeps one row per unique usage report:

- `run_id`, `run_execution_id`, bound to an existing run and execution.
- `provider`: `claude`, `codex`, `grok`, or `fake`.
- `model`: optional 1-128 character caller-observed model string.
- Nullable non-negative counters: `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`.
- `quality`: `provider_reported`, `stream_derived`, `estimated`, or
  `unavailable`. `unavailable` rows carry no counters.
- `provenance`: `runner_observed`, `agent_reported`, or `hook_inbox`.
- `occurred_at` (observed time) and `committed_at` (server time).

`measurement_intervals` keeps one row per unique runner-reported interval:

- `run_id`, `run_execution_id`, bound to an existing run and execution.
- `interval_kind`: `process_alive`, `active`, `external_wait`, or `idle`.
- Half-open `[started_at, ended_at)` UTC timestamps; `ended_at` must be
  strictly after `started_at`.
- `provenance`: `runner_observed`, `agent_reported`, or `hook_inbox`.

`review_timers` keeps one explicit human timer per row:

- `task_id` plus optional `run_id`; `started_by_human_id`, `started_at`.
- `state`: `open` → `stopped`, guarded by `resource_version`.
- `stopped_at` set once on stop; rows are never deleted.
- At most one `open` timer per `(task_id, started_by_human_id)`.

`review_timer_observations` keeps one immutable row per `started`/`stopped`
transition with human actor provenance and unique observation identity.

`browser_activity_observations` keeps one immutable row per observed browser
interval with human actor provenance:

- Optional `task_id`; half-open `[started_at, ended_at)`.
- Stored duration is capped at `BROWSER_ACTIVITY_CAP_MS` (5 minutes);
  `capped` records whether the cap applied. Values are always estimates.

## Interval model

An interval is a half-open `[started_at, ended_at)` pair in epoch
milliseconds. Union totals merge overlapping and adjacent intervals from
unique observation identities and report milliseconds plus the contributing
observation count. Zero-length intervals contribute nothing; inverted
intervals are rejected. Open (unpaired) starts are reported as
`open_interval_count` and contribute nothing to totals.

Derived run measures (all in milliseconds, each with its provenance):

- `launch_latency_ms`: launch command `created_at` to the first
  `execution_attached` ledger event for its execution; when nothing ever
  attached, to `cancelled_at`, or to `expires_at` once expired. Null while
  the command is still pending.
- `process_elapsed_ms`: first execution attach (ledger `execution_attached`,
  falling back to execution `created_at`) to the last execution `ended_at`,
  or to read time while an execution is still live. Runner-offline wall time
  stays inside this span and is additionally reported as `offline_ms`.
- `process_alive_ms`: union of per-execution `[attach, end]` spans. Unlike
  elapsed wall time, gaps between executions are excluded.
- `active_ms`: union of paired turn intervals (`turn_started` to the next
  `turn_stopped`/`turn_failed`) and tool intervals (`tool_started` to the
  next `tool_finished`/`tool_failed`) per execution, plus reported `active`
  intervals. Pairing is per execution in `occurred_at` order.
- `attention_wait_ms`: union of spans with at least one open blocking
  attention request (`requested_at` to `answered_at`, else `resolved_at`,
  else read time). Non-blocking requests never contribute.
- `external_wait_ms` / `idle_ms`: union of reported `external_wait`/`idle`
  intervals. The v1 ledger carries no implicit source for either; absence is
  reported as null with reason `no_observations`, never as zero labor.
- `offline_ms`: within the elapsed span, sub-spans with no heartbeat for
  longer than `HEARTBEAT_STALE_MS` (45 seconds, the architecture presence
  threshold), from last heartbeat plus 45 seconds to the next heartbeat.
  Reported beside elapsed time, never subtracted from it.
- `run_age_ms`: run `created_at` to the latest result submission or review
  timestamp, else to read time. Terminal result state is reported as
  `run_complete`; a failed or cancelled run with no submission measures to
  read time and says so.

## Token normalization

Canonical fields are `input`, `output`, `cache_read`, `cache_write`, and
`reasoning`, each a non-negative safe integer or absent. Provider shapes map
without invention:

- Codex `exec`/`turn.completed` usage: `input_tokens` → `input`,
  `output_tokens` → `output`, `cached_input_tokens` → `cache_read`,
  `reasoning_output_tokens` → `reasoning`; `cache_write` stays absent.
- Claude hook usage: `input_tokens` → `input`, `output_tokens` →
  `output`, `cache_read_input_tokens` → `cache_read`,
  `cache_creation_input_tokens` → `cache_write`; reasoning stays absent
  unless the provider reports it.
- Unknown, negative, non-integer, or unsafe values are rejected; a report
  with no usable field is stored as `unavailable`, never as zeros.

Summation rules:

- `exact` sums only `provider_reported` plus `stream_derived` rows.
- `estimated` sums only `estimated` rows and is always labelled estimated.
- `unavailable` counts rows without counters; they contribute nothing.
- No response carries a single combined total. Displays show the exact
  total, the estimated total, and the unavailable count as separate values.

## Price catalogs (calculation only, never stored facts)

Cost is always derived from immutable token facts with an explicit catalog
version and calculation time. Token rows never store money.

- `PRICE_CATALOG_2026_06_01` (superseded) and `PRICE_CATALOG_2026_09_01`
  (current), each mapping exact model strings to USD per one million tokens
  for `input`, `output`, `cache_read`, `cache_write`, and `reasoning`.
- `calculateCost(tokens, model, catalogVersion)` returns `amount_usd` plus
  the catalog version and `calculated_at`, or a null amount with reason
  `unknown_model` when the model has no entry. Unknown models never fall
  back to another model's price.
- Recomputing the same token facts under another catalog version explains
  historical totals without changing them.

## Review-timer service (consumed by V03)

The reviewer explicitly starts and stops one timer per task. Visual-review
code uses this service and does not create a second timer implementation.

- `review_timer.start` (direct human, reviewer role or higher, project
  access): fails as `timer_open` when the requester already has an open
  timer on the task. Commits the timer plus its `started` observation.
- `review_timer.stop` (the starting human only): fails as `forbidden` for
  anyone else and as `invalid_transition` when already stopped, with an
  optimistic version check. Commits `stopped_at` plus its observation.
- Reads report per-timer durations, per-task totals (stopped durations
  summed; open timers reported separately with elapsed-to-read-time), and
  the full observation history oldest first.
- Hub idempotency replays the identical record on retried keys.

## Attention latency, interventions, browser activity

- `first_response_ms`: `first_response_at` minus `requested_at` per
  attention request; `resolution_ms`: `resolved_at` (else `answered_at`)
  minus `requested_at`. Unanswered requests report null with an `open`
  flag. These remain distinct from agent active time.
- Intervention counts per task: attention requests by kind and state,
  result reviews by decision (`request_changes`, `accept`), result
  submission versions, runs per task (restarts), and launch interventions
  (blocked plus expired commands). Counts come from committed tables; the
  absence of intervention is never presented as approval.
- Browser activity totals sum capped observation durations per human and
  task, always labelled `estimated`. Browser-open time is never presented
  as labor or as review time.

## Aggregation

`aggregateMeasurements` rolls the same separated measures up by
`project_id`, provider (from the run's agent profile), and task priority
(the v1 task-type grouping; v1 has no separate task-type field). Each cell
carries run counts, summed active/elapsed/attention milliseconds, token
sums by quality class, human review milliseconds, and attention counts.
Aggregation implements no autonomy rule and changes no record.

## Displays

Task and run surfaces show five separate sections, each with its
provenance, and never collapse them into one number:

1. Human time: review-timer minutes plus attention response/resolution.
2. Agent time: active, process elapsed, and process-alive unions.
3. Waiting: attention wait, external wait/idle, and visible offline spans.
4. Tokens: exact total, estimated total, unavailable count, per-field
   quality labels, and cost with its catalog version.
5. Provenance: observation counts by kind and the note that every total
   traces to source observations through the measurements reads.

Empty states say what is missing (`no_observations`,
`no_idle_source_in_v1`) instead of showing zeros as facts.

## Domain commands and reads

- `token.report` (runner actor): validates the execution assignment against
  the authenticated runner exactly like event ingest, binds run and
  execution server-side, and stores one observation. A repeated
  `observation_id` returns the stored row without a second effect.
- `interval.report` (runner actor): same assignment validation; stores one
  reported interval. Repeats return the stored row.
- `review_timer.start` / `review_timer.stop` (direct human only).
- `browser_activity.record` (direct human, self only): caps the stored
  duration and reports whether the cap applied.
- Reads go directly to D1: `getRunMeasurements`, `getTaskMeasurements`,
  `aggregateMeasurements`, `listTokenObservations`,
  `listMeasurementIntervals`, `listReviewTimers`,
  `listReviewTimerObservations`, `listBrowserActivity`.
- Browser REST under `/api/v1/workspaces/:workspace`: `GET
  /runs/:run/measurements`; `GET /tasks/:task/measurements`; `GET|POST
  /tasks/:task/review-timers`; `POST /review-timers/:timer/stop`; `POST
  /browser-activity`.

## Verification ownership

The A04 gate covers interval-union property tests (seeded, deterministic),
duplicate and replayed observations, overlapping activity/process/wait
intervals, offline-gap visibility, missing provider usage, historical price
changes, review-timer races, aggregation, and the separated browser
displays with traceable provenance. D1 migration head after this package is
`0027_measurements`.
