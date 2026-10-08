# WP-V03 review-timer evidence

V03 implements no timer. All review durations come from A04 observations.

- Recording a review requires a direct human and, when supplied, an existing
  A04 `review_timer_observations` row in the same workspace; unknown ids fail
  `not_found`, malformed ids fail `invalid_argument`.
- The `artifact.record_review` command writes no `review_timers`,
  `review_timer_observations`, or `browser_activity_observations` rows. The
  domain timer test and the worker harness assert identical timer tables
  before and after recording (the harness additionally asserts the stopped
  observation row added by A04's own `review_timer.stop` is the only delta).
- `getTaskMeasurements` (A04) reports the stopped total consumed by the
  Review surface; the worker snapshot in `review-binding.json` records
  `stopped_total_ms > 0` with the `started`/`stopped` observation kinds.
- The Review surface embeds A04's `MeasurementsPanel` unchanged for the
  explicit start/stop controls and duration displays. V03 renders no timer of
  its own and no presence-derived time.
- `browser_activity.record` observations never enter review records or reads:
  the worker asserts review status carries no presence keys, and the browser
  spec records a 5-minute presence observation, then shows it only inside the
  estimated browser section while the human review section stays independent.

Timer behavior under races (double start, foreign stop, stale version) stays
owned and proven by A04's `pnpm test:a04`.
