# WP-A04 interval property notes

The union property suite lives in
`packages/domain/test/measurements.test.ts` under `unionIntervalsMs` and
needs no extra dependency: a `mulberry32` PRNG with fixed seed `20260917`
generates 300 deterministic trials of 1–6 half-open intervals over a small
integer range.

Each trial asserts:

1. The union total equals brute-force millisecond coverage.
2. The union total never exceeds the sum of parts (dedupe upper bound).
3. The union total covers the longest single part (coverage lower bound).
4. Replaying every interval leaves the total unchanged (replay safety).

Fixed unit cases pin the edges the sweep cannot name: adjacent-interval
merging, zero-length contributions, exact-duplicate collapse, and empty
input. Turn/tool pairing in `getRunMeasurements` is FIFO per execution in
`occurred_at` order; unpaired starts are counted as `open_intervals` and
contribute nothing, which the open-interval test pins.

The Worker/D1 harness (`tools/measurements/run.ts`, `intervals` snapshot)
repeats the overlap and replay checks across two Workers against real D1 so
SQL-level union inputs (reported `measurement_intervals` rows) follow the
same algebra as the unit suite.
