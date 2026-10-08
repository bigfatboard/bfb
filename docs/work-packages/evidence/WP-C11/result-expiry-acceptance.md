# C11 delegated-result execution-clock expiry checkpoint

A delegated result now requires its exact credential to remain unexpired when
a write-only database-clock guard executes inside the committing D1 batch.
The guard is separate from, and atomic with, existing target/source, scope,
epoch and credential predicates. Missing, invalid, NULL or elapsed expiry
fails closed, including empty evidence. Submission and audit observation
timestamps still use the prepared `ctx.now`.

Tested source: `6df0fce858a73f8fb5ab3275a9538ddc806b9a69`.
Protocol: unchanged `bfb-wire/1`.
D1 head: `0047_security_audit_positions`; no migration added.

C11 remains `in_progress`. Private creation, sharing and author-private
checkpoints stay disabled; C12 remains planned.

## Regression and rollback proof

Two domain cases and two genuinely authenticated mounted MCP cases cover
natural expiry and delayed live controls. Each negative reaches the batch while
valid, waits for database-clock expiry, and compares the complete unchanged
credential row before flushing. It then proves uniform `command_failed` and
rollback of submission, task/run states and versions, event, audit, outbox,
idempotency and cursor. The controls commit once with empty evidence and retain
prepared observations despite delayed flush.

The existing real-D1 delivery harness adds two independently labelled checks.
It runs the live control first, then delays the unchanged credential until
natural expiry before calling the actual binding batch. Native bound statements
are preserved. Both checks pass alongside its 37 retained checks.

Before the correction, both new natural-expiry cases failed and both live
controls passed. A separate corrected actual-D1 probe passed its live control
before exposing an expired submission committing on the unfixed source. These
are bounded local regression observations, not clean committed-fixture
certificates of the old source. A compiler preparation error, an incompatible
initial D1 wrapper that failed the live control, and an unrecompiled mounted
attempt are excluded from security proof.

Legacy successful credentials now derive current setup windows from the
database through unchanged shared helpers. Historical work observations and
explicit expired overrides remain; elapsed read controls use stored deadlines.
No SQL clock is faked and no production shared clock/lease helper is changed.

## Clean verification

Exact `pnpm test:c11` passes 2,321 stage cases in 83 file invocations, plus its
C10/C08 dependency gates. Eight stage D1 harnesses pass 81 checks. The separate
notification Worker/D1/Queue/DLQ drill passes; its 41 record labels include
setup and repeated dispatch/redaction, not 41 independent cases. The additive
`pnpm test:c11:result-expiry` is composed once, including four new cases and
the 39-check delivery harness.

Exact X03 passes 71 unit cases, 11 Worker/D1/R2 checks and both OAuth browser
cases without a provider or persistent pilot. Full `pnpm verify` passes 4,445
TypeScript cases in 199 files, Go checks and all 16 Swift cases without skipping
selected platform checks. Frozen install, before/after worktree checks,
unchanged source identity and empty final status pass. See the
[manifest](result-expiry-manifest.json) and
[command result](result-expiry-command-result.json).

## Scope and remaining gates

This certificate checks expiry at the delegated-result temporal guard
statement, not every subsequent statement, response delivery, other command,
runner/local capability or lease. The mounted OAuth expiry cases are not real
HTTP Worker/D1 expiry proofs; actual D1 is separately proven through domain/Hub.
Other natural-expiry boundaries remain open.

GitHub key existence policy, execution-owned consumers and destructive private
retention still gate activation. Private creation/sharing/checkpoints,
publication, project knowledge, skills, vault, reminders and contribution views
remain unfinished. Prior UI evidence is preserved, not re-certified here.
No live pilot, provider, installed app, deployment or external CI was operated.
