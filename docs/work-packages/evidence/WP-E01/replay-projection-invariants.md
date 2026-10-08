# WP-E01 replay and projection invariants

## Replay fixtures

Replay returns committed `event-envelope` rows in `workspace_cursor` order:

- `GET /api/v1/workspaces/:workspace/events?after_cursor=<n>&through_cursor=<m>&limit=<l>`
  returns envelopes with `after < cursor <= through`, plus `high_water_cursor` and `has_more`.
- `through_cursor` defaults to the current D1 high-water; `limit` defaults to 100 and caps at 100.
- `GET /api/v1/workspaces/:workspace/events/high-water` returns the max committed ledger cursor.
- Every stored envelope revalidates against the F02 `event-envelope` schema on read; corruption surfaces as `event_history_corrupt`, never as a partial row.
- Replayed fixture (Worker harness, 13 rows): cursors strictly increasing; every envelope carries the assignment-derived workspace/project/task/run/execution, a runner or agent_run actor, and a runner source bound to the committing runner.

## Projection invariants (checked after every fault)

- `run_event_projections`, `execution_event_projections`,
  `session_event_projections`, and `event_kind_counters` are absolute:
  each upsert recomputes `event_count` from committed rows plus the batch and
  advances only when the incoming cursor exceeds the stored one
  (`WHERE excluded.last_cursor > ...last_cursor`).
- Duplicate transport (F1/F6) leaves all four tables byte-identical: counts and
  cursors do not move on `already_committed`.
- Heartbeat presence (`heartbeat_count`, `last_heartbeat_at`) records liveness
  only; run activity and result state are never written by ingest.
- Ledger and observation tables have update/delete abort triggers; the only
  writes to projections come from the ingest command in the same atomic D1
  batch as their ledger rows.
- There is no browser or workspace-cursor delete path: the browser surface
  exposes GET replay and high-water only, and non-GET methods change nothing.
