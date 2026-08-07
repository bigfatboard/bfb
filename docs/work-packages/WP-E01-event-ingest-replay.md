# WP-E01 — Event ingestion, projection, and replay

Status: `planned`

Risk: Very high

## Outcome

Authenticated runner batches commit each normalized observation at most once, against its immutable execution assignment, and expose durable workspace replay with explicit per-event disposition.

## Dependencies

- **Requires:** C01, C04, C06, C08, C09, L06.
- **Unlocks:** A01, A03, A04, E02, L07, P01, P02, X04, X05.
- **Can run with:** W01 and artifact infrastructure after shared migrations are sequenced.

## Scope

- Add immutable event tables, raw uniquely identified measurement observations, and core execution/session/turn/tool/progress/activity projections. A04 owns derived interval, token-quality, price-catalog, aggregate, and display schemas.
- Validate `run_execution_id` and assignment generation against authenticated runner history; derive workspace/project/task/run/actor/source server-side.
- Distinguish agent-run hook/MCP actors from daemon-observed runner facts.
- Deduplicate transport by event ID and `(workspace_id, source_stream_id, source_sequence)`.
- Return `accepted`, `already_committed`, `retryable`, or `permanently_rejected` per event plus bounded diagnostics.
- Commit event, workspace cursor, and absolute/version-guarded projections through the hub FIFO.
- Expose paginated replay and D1 high-water reads.
- Add launch/session/process/activity projection foundations for L05/L06 verified process heartbeats and provider activity without interpreting heartbeat/Stop/exit as result.
- Integrate L06 deletion/quarantine behavior and delayed final-hook replay.

## Non-goals

- Browser sockets, raw provider payload storage, transcript streaming, derived measurement/price aggregates, attention/result business mutations, or Queue-based ordering.

## Work plan

1. Add event/projection migrations and assignment/actor validation.
2. Implement batch ingest/idempotency/dispositions through `WorkspaceHub`.
3. Implement replay/high-water and projection reads.
4. Fault-inject duplicate/out-of-order/concurrent/delayed/poison events and acknowledgement loss.

## Acceptance

- Concurrent runs and delayed offline rows never attach to the currently active run by mistake.
- Every event receives a disposition; terminal poison rows do not block later rows.
- Duplicate transport causes one D1/projection effect; absolute totals never double increment.
- Runner rows are never deleted from a browser/workspace cursor.
- Unknown provider fields and invalid actor claims cannot enter the ledger.
- Stop, heartbeat, socket loss, terminal close, and process exit do not submit a result.
- Replaying process heartbeats or raw measurement observations cannot inflate later A04-derived intervals/totals; each observation retains its unique identity and provenance.

## Evidence and handoff

- Commit concurrency/fault traces, actor/provenance matrix, raw-observation boundary, replay fixtures, and projection invariants.
- E02 consumes cursor invalidations; L06 retains explicit disposition authority.

## Risks and decisions

- Event truth and transport truth are different. At-most-one database effect does not mean independently duplicated provider hooks are silently merged.
