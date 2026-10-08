# WP-D02 crash matrix

Deterministic fake-provider fault coverage from
`go test -race -count=1 ./internal/discussion/...`. Every row was observed
passing; no row retries blindly.

| Boundary | Owning test | Observed result |
| --- | --- | --- |
| Crash before dispatch (proven non-start) | TestCrashBeforeDispatchIsRetryable | `dispatch_failed`; `Reopen` reports retryable; same-key retry completes with exactly one additional provider call |
| Crash after a possible provider effect | TestCrashAfterPossibleEffectPausesUntilReconciled | `delivery_unknown`; `Reopen` marks unknown and pauses; blind retry refused with `discussion_stopped` |
| Late provider facts prove the effect | TestCrashAfterPossibleEffectPausesUntilReconciled | `ConfirmUnknown` binds once; duplicate confirm fails `invalid_transition`; ordinal completes without a second effect |
| Unprovable effect | TestUnprovableEffectPausesVisibly | `MarkAmbiguous`; schedule stops with `delivery_ambiguous`; redispatch refused; `Release` refused with `recovery_pending` |
| Duplicate workers | TestDuplicateWorkersConflict, TestDuplicateWorkerCannotDispatch | second worker fails `ownership_conflict`; duplicate dispatch fails `fencing_stale` with zero provider calls |
| Restart | TestRestartRequiresReconcileThenBumpsFencing, TestRestartMidTurnReconcilesWithoutDuplication | direct reacquire fails `ownership_conflict`; `Reopen` then `Reacquire` advances fencing 1 to 2; old generation writes fail `fencing_stale`; second `Reopen` is stable |
| Wrong session | TestSessionAuthorityMatrix | continuation with an unbound identity fails `session_mismatch` |
| Busy session | TestSessionAuthorityMatrix | acknowledging another participant's session fails `session_busy` |
| Unowned session | TestSessionAuthorityMatrix, TestUnownedSlotRejectsWriters | missing ownership fails `ownership_required` |
| Revoked authority | TestSessionAuthorityMatrix | revoked sponsor fails `revoked` before any schedule or provider read |
| Cancellation | TestCancellationDeadlineAndRevocation | `human_cancelled` stops the schedule and pauses owners; dispatch fails `discussion_stopped` with zero provider calls |
| Deadline | TestDeadlineStopsScheduler | past-deadline dispatch fails `deadline_exceeded` and records the stop reason |
| Malformed output | TestMalformedAndOversizedOutputsFailVisibly | `output_malformed`; attempt failed; schedule stops with `provider_failed` |
| Oversized output (>8192 bytes) | TestMalformedAndOversizedOutputsFailVisibly | `output_bound_exceeded`; attempt failed; schedule stops with `provider_failed` |
| Missing session identity | TestMalformedAndOversizedOutputsFailVisibly | empty observed session fails `session_mismatch` before acknowledgement |
| Changed session mid-continuation | TestCrashAfterPossibleEffectPausesUntilReconciled | post-fencing writes from the old generation fail `fencing_stale` |
| Unsupported provider | TestUnsupportedProviderFailsClosed | unknown provider fails `provider_unsupported` before planning |
| Duplicate dispatch of a finished turn | TestHappyPathTurnCompletes | second dispatch fails `invalid_transition`; one completion only |
| Changed input under one idempotency key | TestIdempotencyKeyBindsOneInput | `idempotency_conflict`; same input replays the original attempt |
| Same-checkout contention | TestSameCheckoutSerializes | second holder fails `checkout_occupied`; foreign release fails; release frees |
