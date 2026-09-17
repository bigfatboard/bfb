# Discussion delivery v1

Owner: [D02](../work-packages/WP-D02-discussion-delivery.md), under
[ADR 0002](../adr/0002-human-initiated-discussions.md). Acceptance evidence
is indexed by the [D02 manifest](../work-packages/evidence/WP-D02/manifest.json).
Exact acceptance: `pnpm test:d02`.

D01 owns discussion records and permission; this contract owns supervised
delivery of bounded read-only turns on the enrolled Mac. D03 consumes the
committed outputs referenced here rather than interpreting provider prose.

## Authority and scope

Each participant turn reauthorizes against current human authority before any
provider effect: deadline, stop (cancellation or revocation), and the frozen
read-only tool boundary. Delivery plans only certified adapters (`fake` for
deterministic tests, `codex` for the bounded experiment) through the frozen
L03 kit; headless Claude turns fail closed because L07 certifies no such
transport. Fresh turns start new sessions; continuations resume the exact
owned observed session. Forks, predetermined sessions, and writable configs
fail closed in the kit.

Peer content travels only as attributed external context in turn stdin under
the fixed read-only instruction. It never reaches provider argv or
environment, and it cannot grant permission, invoke tools, mutate the
checkout, select participants, or extend the schedule.

## Session fencing and causal identity

One worker owns each participant slot in local migration `012` with a
monotonic fencing generation. A duplicate worker fails with
`ownership_conflict`; a restart reconciles through `Reopen` and advances
fencing through `Reacquire`, so the crashed generation stays stale. Every
attempt carries the fencing that recorded it and only the current generation
writes.

Causal identity chains discussion, slot, ordinal, turn, delivery, and
idempotency key. A repeated key returns the original attempt; changed input
under a key fails with `idempotency_conflict`. The first acknowledgement
binds the exact observed session immutably; a competing session fails with
`session_conflict`, another participant's session with `session_busy`, and a
mismatched continuation with `session_mismatch`.

## Dispatch, acknowledgement, and recovery

Each dispatch records its attempt before the possible provider effect, plans
the read-only turn, marks the effect started, runs it, acknowledges the exact
session, validates the bounded output, and completes. A proven spawn refusal
returns the attempt to recorded with `dispatch_failed` and stays retryable.
Any uncertain loss reports `delivery_unknown` and never retries blindly.

`Reopen` separates the crash windows after a restart: recorded attempts stay
retryable, started or acknowledged attempts become `unknown` and pause
ownership, and ambiguous deliveries stay paused. An unknown attempt
reconciles once through `ConfirmUnknown` when provider facts prove its
effect, or pauses visibly through `MarkAmbiguous` when they cannot; the
schedule then stops with `delivery_ambiguous`. Unknown and ambiguous attempts
retain guards: ownership cannot release until they settle.

## Scheduler and bounds

The default is three rounds and six participant turns. Initial positions are
independent; each later ordinal requires all earlier ordinals completed. The
scheduler enforces slot order, the turn bound, the deadline (stopping with
`deadline_exceeded`), cancellation, and revocation before any effect.
Participants sharing one physical worktree serialize on a checkout holder;
no automated Git mutation occurs.

Outputs are strict bounded recommendations (at most 8,192 bytes) with
reasons, evidence references to frozen context or relative files at the
frozen revision, agreement and disagreement references to completed source
messages, and human questions. Malformed or oversized output fails visibly
with `output_malformed` or `output_bound_exceeded` and stops the schedule
with `provider_failed`. The conclusion references the final two stored
outputs verbatim and preserves disagreements; it never synthesizes consensus.
A human decision remains D01/D03 business and is out of scope here.

## Failure codes

`ownership_conflict`, `ownership_required`, `fencing_stale`,
`recovery_pending`, `session_mismatch`, `session_conflict`, `session_busy`,
`schedule_required`, `schedule_violation`, `discussion_stopped`,
`deadline_exceeded`, `checkout_occupied`, `revoked`,
`authority_unavailable`, `provider_unsupported`, `provider_mismatch`,
`provider_discussion_unsafe`, `dispatch_failed`, `delivery_unknown`,
`attempt_required`, `idempotency_conflict`, `invalid_transition`,
`output_malformed`, `output_bound_exceeded`, `output_forbidden`,
`output_required`, `conclusion_blocked`, `peer_escalation`,
`migration_mismatch`, `unsafe_state`, `storage_failed`, `invalid_request`.
