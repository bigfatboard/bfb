# WP-E01 raw-observation boundary

`measurement_observations` keeps one raw observation per accepted measurement-kind
event, keyed by `(workspace_id, observation_id)` where the observation ID is the
event ID. Each row carries `measure_kind`, `capture_origin`, actor, `occurred_at`,
and the committed cursor as provenance.

## Observation kinds (v1)

`heartbeat`, `session_started`, `session_resumed`, `session_ended`,
`turn_started`, `turn_stopped`, `turn_failed`, `tool_started`, `tool_finished`,
`tool_failed`, `progress_reported`.

Non-measurement rows (`execution_attached`, `result_submitted`, `run_failed`,
`launch_*`, and similar lifecycle telemetry) commit ledger rows and projections
but no observation.

## A04 handoff

- Totals and intervals derive from unique observation identities, never from
  replay counts: resending a heartbeat returns `already_committed` and inserts
  no second observation, so later aggregates cannot inflate.
- Observations are immutable (update/delete triggers abort), exactly like ledger rows.
- E01 computes no intervals, token quality, prices, aggregates, or display
  values. Those schemas belong to A04, which consumes this table.
- Runner payloads are closed empty objects in v1, so observations carry
  identity and provenance but no measurement values yet; a later wire version
  may add bounded measurement fields without changing the identity rule.
