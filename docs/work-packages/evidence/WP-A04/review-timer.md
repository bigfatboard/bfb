# WP-A04 review-timer trace

The review timer is an explicit reviewer-owned stopwatch, frozen in
`docs/contracts/measurements.md` for V03. There is exactly one open timer
per task per human; only the starter can stop it.

Automated traces:

- Domain (`packages/domain/test/measurements.test.ts`, `review timers`):
  start/stop accumulation (240s), double start (`timer_open`), foreign stop
  (`forbidden`), stale version (`stale_version`), double stop
  (`invalid_transition`), per-task scoping, and started/stopped observation
  history.
- Routes (`apps/control-worker/test/measurement-routes.test.ts`): the same
  races over HTTP with 400/403/404/409 status mapping, plus reviewer start
  on a granted project.
- Harness (`tools/measurements/run.ts`, `review_timer` snapshot): cross-worker
  double start and foreign stop rejections with two observations
  (`started`, `stopped`) and a 240s stopped total that differs from agent
  active time.
- Browser (`browser/measurements-timer-open.png`,
  `browser/measurements-timer-stopped.png`): the owner starts the timer from
  the task sheet, exactly one stop control appears, and stopping returns the
  sheet to the start control.

V03 consumes `review_timer.start`/`stop`, `listReviewTimers`, and
`listReviewTimerObservations`; visual-review code must not implement a
second timer.
