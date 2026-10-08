# WP-D02 restart-recovery runtime evidence

From `go test -race -count=1 ./internal/discussion/...` against real SQLite
files closed and reopened mid-turn (no mocks for persistence):

- `TestRestartRequiresReconcileThenBumpsFencing`: a new worker handle on the
  same file cannot acquire (`ownership_conflict`); clean `Reopen` reports an
  empty matrix; `Reacquire` advances fencing 1 to 2 and preserves the session
  binding; the crashed generation fails `fencing_stale`.
- `TestRestartMidTurnReconcilesWithoutDuplication`: killing the handle with an
  `effect_started` attempt, then `Reopen`, surfaces exactly one unknown paused
  attempt; a second `Reopen` is stable; after `Reacquire`, late session facts
  confirm once, the bounded output stores, the ordinal completes, and the old
  worker's writes fail `fencing_stale`. Six-turn provider-call counts stay
  exact: no duplicate effect.
- `TestReleaseRetainsGuardsWhileUnsettled`: `Release` fails
  `recovery_pending` while a recorded attempt exists and succeeds once it is
  failed; a released slot needs reconcile rather than a fresh acquire.
- `TestUnprovableEffectPausesVisibly`: without provider facts the delivery
  stays `ambiguous`, the schedule names `delivery_ambiguous`, and ownership
  cannot release (`recovery_pending`).

Process uncertainty retains guards in every path: unknown and ambiguous
attempts block release, reacquire requires `Reopen` first for started work,
and no path replays an unacknowledged external effect.
