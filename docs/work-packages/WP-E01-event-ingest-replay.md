# WP-E01 — Event ingestion, projection, and replay

Status: `planned`

Risk: Very high

Test target: `pnpm test:e01`

Evidence manifest: `docs/work-packages/evidence/WP-E01/manifest.json`

## Outcome

Authenticated runner batches commit each normalized observation at most once, against its immutable execution assignment, and expose durable workspace replay with explicit per-event disposition.

## Dependencies

- **Requires:** C01, C04, C06, C08, C09, L06.
- **Unlocks:** A01, A03, A04, E02, L07, P01, P02, X04, X05.
- **Can run with:** W01 and artifact infrastructure after shared migrations are sequenced.

## Scope

- Immutable `event_ledger` table (D1 migration `0019_event_ledger`), raw uniquely identified `measurement_observations`, and core run/execution/session/per-kind projections. A04 owns derived interval, token-quality, price-catalog, aggregate, and display schemas.
- `event.ingest` hub command: validates `run_execution_id` and assignment generation against authenticated runner history; derives workspace/project/task/run/actor/source server-side and ignores claimed-ID hints.
- Actor separation: `runner_observed` rows commit a runner actor (daemon-observed fact); `agent_reported`/`hook_inbox` rows commit an `agent_run` actor bound to the execution.
- Deduplication by event ID and by `(workspace_id, source_stream_id, source_sequence)`, including within-batch duplicates.
- Per-event `accepted`, `already_committed`, `retryable`, or `permanently_rejected` dispositions with bounded diagnostics; terminal poison never blocks later rows.
- Shared workspace-cursor reservation through the hub FIFO: each accepted event takes the next monotonic cursor in batch order; event, cursor, and absolute cursor-guarded projections commit in one atomic D1 batch.
- Runner ingest route `POST /runner/workspaces/:workspace/runners/:runner/events/ingest` with C06 possession authentication; browser replay `GET /api/v1/workspaces/:workspace/events` and high-water `GET .../events/high-water` reading directly from D1.
- Launch/session/process/activity projection foundations (heartbeat presence, session binding, turn/tool/per-kind counts) that never interpret heartbeat/Stop/exit rows as results.
- L06 quarantine contract: `permanently_rejected` rows carry terminal diagnostics for bounded local quarantine; delayed final-hook rows replay against their original execution and are never reattributed to an active run.

## Non-goals

- Browser sockets (E02), raw provider payload storage, transcript streaming, derived measurement/price aggregates (A04), attention/result business mutations (A02/A03), Queue-based ordering, and per-stream contiguous acknowledgement (an optimization the dispositions make unnecessary).

## Contracts

### Consumes

- C01 WorkspaceHub FIFO command lane, atomic D1 batches, and shared `workspace_cursors` sequence.
- C04 live membership/project grants (revocation fenced per ingest); reviewer role stays project-scoped and cannot replay the workspace ledger.
- C06 runner possession authentication and token/grant epochs for the ingest transport.
- C08 work records (runs, executions) and C09 immutable execution assignments, snapshots, and checkout fencing for attribution.
- F02 `runner-event-submission`, `event-envelope`, and `event-disposition` v1 wire schemas plus fixtures (consumed frozen; E01 adds no protocol schema).
- `docs/contracts/runner-channel.md` batch arrival semantics (disposition-addressed local delete/quarantine only).

### Produces

- [Event ledger v1](../contracts/event-ledger.md): frozen ingest, disposition, replay, and high-water contract; D1 head `0019_event_ledger`.
- Stable test target `pnpm test:e01` (domain suites, route suites, migration suite, two-Worker D1 fault harness) and evidence manifest `docs/work-packages/evidence/WP-E01/manifest.json`.
- Additive cursor-range support on the hub command lane (`extraCursors`/`cursorBase`): single-row commands behave exactly as before.

## Work plan

1. Event/projection migration `0019_event_ledger` with immutability triggers; manifest and `MIGRATION_HEAD` advance. Verified by `packages/db/test/migrations.test.ts`.
2. `event.ingest` domain command with idempotency, dispositions, absolute projections, and ledger replay/high-water reads. Verified by `packages/domain/test/events.test.ts`.
3. Runner ingest and browser replay routes through production auth. Verified by `apps/control-worker/test/event-routes.test.ts`.
4. Two-Worker D1 fault harness: duplicate, out-of-order, concurrent, delayed, poison, acknowledgement loss, foreign runner, non-inference, replay. Verified by `tsx tools/events/run.ts`.

## Acceptance

- Concurrent runs and delayed offline rows never attach to the currently active run by mistake.
- Every event receives a disposition; terminal poison rows do not block later rows.
- Duplicate transport causes one D1/projection effect; absolute totals never double increment.
- Runner rows are never deleted from a browser/workspace cursor.
- Unknown provider fields and invalid actor claims cannot enter the ledger.
- Stop, heartbeat, socket loss, terminal close, and process exit do not submit a result.
- Replaying process heartbeats or raw measurement observations cannot inflate later A04-derived intervals/totals; each observation retains its unique identity and provenance.

## Evidence

- `docs/work-packages/evidence/WP-E01/manifest.json` with the tested commit, protocol/schema versions, migration head, toolchains, commands, and redaction status.
- `docs/work-packages/evidence/WP-E01/command-result.json`: bounded `pnpm test:e01`, `pnpm verify`, and `pnpm worktree:check` outcomes.
- `docs/work-packages/evidence/WP-E01/fault-injection-matrix.md`: Worker/D1 fault traces and counts.
- `docs/work-packages/evidence/WP-E01/actor-provenance-matrix.md`: capture-origin to actor/source derivation.
- `docs/work-packages/evidence/WP-E01/raw-observation-boundary.md`: observation kinds and A04 handoff.
- `docs/work-packages/evidence/WP-E01/replay-projection-invariants.md`: replay fixtures and absolute-projection checks.

## Risks and decisions

- Event truth and transport truth are different. At-most-one database effect does not mean independently duplicated provider hooks are silently merged: a reused stream sequence under a fresh event ID is permanently rejected, never merged.
- Shared cursor space with command audit rows means ledger cursors are monotonic but not gapless; replay ranges tolerate gaps and reviewers never see the ledger.
- `retryable` covers exactly one real state: the execution exists but no assignment has committed yet (C08-created executions). Unknown executions and generation mismatches are terminal.

## Handoff

- Implementation, gate (`pnpm test:e01`), `pnpm verify`, `pnpm worktree:check`, and the clean-checkout gate are complete at the committed hash; evidence is recorded in the manifest.
- Status stays `planned`: `pnpm roadmap:check` rejects any status beyond `planned` while dependency L06 is not `done`. Nothing downstream may consume E01 as final until L06 completes and the status advances.
- E02 consumes cursor invalidations and the replay/high-water routes; L06 retains explicit disposition authority (accepted/already-committed remove, retryable keeps queued, permanently-rejected quarantines bounded); A04 derives from `measurement_observations` by unique observation identity.
- Known limitations: per-stream contiguous acknowledgement is not computed (dispositions are authoritative); runner event payloads are closed empty objects in v1, so observations carry identity and provenance but no measurement values yet.
