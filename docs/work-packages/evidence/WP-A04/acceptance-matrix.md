# WP-A04 acceptance matrix

Each Acceptance bullet maps to the automated proof that must pass under
`pnpm test:a04` from a clean checkout.

| Acceptance | Proof |
| --- | --- |
| Duplicate/replayed observations cannot inflate totals | `packages/domain/test/measurements.test.ts`: token and interval replay return the stored row with one stored row; observation-ID confusion is rejected. `tools/measurements/run.ts`: cross-worker duplicate token/interval reports converge on single rows (`tokens`, `intervals` snapshots). Seeded property sweep replays every interval set without changing the union. |
| Overlapping activity/process/wait intervals deduplicate correctly | Domain seeded property tests (300 trials, seed `20260917`) match brute-force coverage with union ≤ sum and ≥ longest part. Domain paired turn/tool overlap test asserts 50s active from overlapping 50s/20s spans. Harness asserts the 180s union of overlapping reported waits. |
| Runner-offline wall time remains visible rather than silently removed | Domain heartbeat-gap test: elapsed keeps 360s while `offline_ms` reports 260s. Harness `derivation` snapshot records `offline_ms: 230000` beside full elapsed time. |
| Estimated/unavailable token values are never displayed/summed as exact | Domain quality-separation test (exact vs estimated vs unavailable), unavailable-stores-null test, unknown-model null-cost test. Route test asserts honest empty states and the `2026-09-01` catalog pin. Browser spec asserts exact, estimated, and unavailable render as separate values. |
| Human review time and attention latency remain distinct from agent time | Domain timer accumulation (240s review) and attention-latency tests assert review/attention values differ from active time. Task rollup keeps `review.stopped_total_ms` outside agent totals. Browser spec asserts the human section reads `4m 00s` while agent reads `0s active`. |
| A reviewer can trace every displayed total to source observations/provenance | Token summaries carry per-quality observation-ID lists; run reads carry ledger/token/interval/observation counts; the browser provenance section and run API assertions expose them. |

Negative cases (all exit non-zero / reject): foreign execution reports,
observation-ID confusion, unavailable rows with counters, estimated rows
without counters, inverted intervals, double timer start (`timer_open`),
foreign timer stop (`forbidden`), stale timer versions, double stop,
inverted/future browser intervals, unknown catalog versions, project-scoped
reviewer reads of ungranted projects (404).
