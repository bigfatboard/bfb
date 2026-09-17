# WP-D02 fencing and delivery state

Ownership is one row per discussion participant slot in local migration 012.
Fencing advances only through `Reacquire` after `Reopen`; the crashed
generation stays stale and its writes fail with `fencing_stale`.

```mermaid
stateDiagram-v2
    [*] --> owned: Acquire(worker, fencing=1)
    owned --> owned: same worker reacquires
    owned --> paused: Pause / Cancel / Reopen with unknown
    paused --> owned: Reacquire(new worker, fencing+1)
    owned --> released: Release (no unsettled attempt)
    paused --> released: never (uncertainty retains guards)
    released --> [*]
```

Duplicate workers fail with `ownership_conflict`, including across process
restarts against the same file. A released slot needs reconcile, not a fresh
acquire (`recovery_pending`).

Attempts chain discussion, slot, ordinal, turn, delivery, and idempotency key.
Each dispatch records its attempt before the possible provider effect.

```mermaid
stateDiagram-v2
    [*] --> recorded: RecordAttempt (before effect)
    recorded --> effect_started: MarkEffectStarted
    recorded --> recorded: proven non-start (dispatch_failed, retryable)
    effect_started --> acknowledged: Acknowledge exact session
    effect_started --> unknown: Reopen after crash
    acknowledged --> unknown: Reopen after crash
    unknown --> acknowledged: ConfirmUnknown with provider facts
    unknown --> ambiguous: MarkAmbiguous (no proof)
    effect_started --> ambiguous: MarkAmbiguous (no proof)
    acknowledged --> ambiguous: MarkAmbiguous (no proof)
    acknowledged --> completed: output stored
    recorded --> failed: FailAttempt
    effect_started --> failed: FailAttempt
    acknowledged --> failed: FailAttempt
    unknown --> failed: FailAttempt
    completed --> [*]
    failed --> [*]
    ambiguous --> [*]: paused, never retried blindly
```

The first acknowledgement binds the exact observed session immutably.
`session_conflict` (competing ID), `session_busy` (another participant's
session), and `session_mismatch` (wrong continuation or malformed identity)
all fail without advancing state.
