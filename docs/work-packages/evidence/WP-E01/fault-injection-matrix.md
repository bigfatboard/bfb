# WP-E01 fault-injection matrix

Harness: `tsx tools/events/run.ts` — two independent Worker isolates (`bfb-events-a/b`)
driving one production `WorkspaceHub` Durable Object against disposable D1 at migration
`0019_event_ledger`. Unit coverage: `packages/domain/test/events.test.ts` (14 cases),
`apps/control-worker/test/event-routes.test.ts` (3 cases).

## Worker/D1 run

- Migration: populated 0018 state upgrades to 0019 preserving task history; ledger opens empty.
- Committed events: 13 across 9 ingest commands alternating Workers A/B.
- Observations: 11 raw measurement rows, each keyed by its event ID.
- Run projection count: 13; execution heartbeat count: 8.

| # | Fault | Injection | Dispositions | Effect |
| --- | --- | --- | --- | --- |
| F1 | Duplicate transport + acknowledgement loss | Same 2-event batch sent 3 times across Workers | accepted, accepted then already_committed x2 | One ledger row per event; kind counters and observations unchanged on resend |
| F2 | Out-of-order delivery | Sequences 4 before 3 in one batch | accepted, accepted | Ledger cursors follow batch order; replay returns cursor order |
| F3 | Concurrent batches | 2x2-event batches in parallel across Workers | all accepted | 8 distinct event IDs, 8 distinct cursors, no gaps inside a batch range |
| F4 | Delayed offline row | `occurred_at` two days old, sent after a second pending launch exists | accepted | Row binds the original run ID, not the newer run |
| F5 | Poison mix | Closed-payload violation, unknown execution, generation 99, future timestamp, then one valid row | 4x permanently_rejected then accepted | Valid row commits; diagnostics carry bounded codes for the three semantic poisons |
| F6 | Acknowledgement loss after poison | Resend of the F1 batch | already_committed x2 | Ledger, observation, run-projection, and heartbeat totals identical before/after |
| F7 | Foreign execution reference | Valid envelope for an unknown execution from the same runner | permanently_rejected `unknown_execution` | Nothing commits |
| F8 | Terminal telemetry | `result_submitted`, `execution_ended`, `heartbeat` | all accepted | `runs.result_state` stays `open`; execution state untouched |
| F9 | Replay/high-water | Direct D1 reads after all faults | n/a | High-water equals max ledger cursor; 13/13 envelopes replay in cursor order |

## Decision log

- A D1 batch conflict aborts the whole batch; the daemon retries and converges on explicit dispositions (F1/F6).
- Transport violations without an addressable triple (non-object items, empty/oversized batches) reject the batch uniformly with nothing committed (vitest route suite).
