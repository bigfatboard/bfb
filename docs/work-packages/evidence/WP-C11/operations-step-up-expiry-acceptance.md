# C11 operations step-up atomic expiry

Retention setting and proof-bound stuck-upload resolution now require database-
clock liveness when their operations-local consume UPDATE executes. Supplied-
time validation, the opaque consumption winner, exact action/human/workspace/
target/epoch binding and one-use guard remain. A successful batch may return
after proof expiry without undoing committed history. No shared step-up, Hub,
runner, provider or lease implementation changes.

Clean source: `44c57142ff33101c60cf649b0f2af503f5cd59b3`. D1 head remains
`0048_task_collection_positions`; no migration or wire changes.

## Finite temporal proof

The additive target passes 343 cases in seven files, including eight new staged
cases, and six independently collecting native groups. Retention, fresh upload
recovery and target-ledger retries have expired/live pairs. Two staged cases
also delay a successfully committed batch reply past TTL. Native proofs retain
the actual prepared/bound statements and parameters, use the same five-second
pre-batch delay, and witness unchanged rows and the intended clock boundary.
Three expired batches roll back; three live batches commit before expiry and
return after it with exact historical rows and occurrence times intact.

The unchanged `bd5dbf5` OLD replay records three meaningful staged failures/five
controls and three native failures/three controls. All expired native waves
succeed and consume the proof on OLD. Outcomes and proof consumption are
collected; failures stop at the first denial assertion and are not claimed as
separately collected downstream canonical failures. The final observed-outcome
replay uses the pinned runtime and verifies unchanged production before/after.

Native current proofs compare all 135 canonical tables and separately compare
HTTP budgets. Only the three actually present named engine/migration tables are
excluded. Foreign keys and transient guards stay clean. Bounds are 14 bindings,
4,731 SQL bytes and nineteen batch statements for timed production domain-Hub
statements; setup, witnesses and snapshots are excluded. Fresh recovery includes
run-bound shared and run-free metadata targets, not object deletion or bytes.

## Clean verification

Frozen install, full verify, exact C11, exact X05 and before/after worktree checks
exit zero with `C11_OPERATIONS_STEP_UP_EXPIRY_CLEAN_CERTIFICATE_OK`. Source
identity is retained and final status is empty.

C11 passes 3,683 stage case invocations across 147 file invocations in twenty-
three blocks, not unique totals; six panel browser cases and 240 top-level native
labels across twenty-two harnesses are separate. C10 retains 86 cases/eight
files/nine native checks; C08 retains 23 cases/five files and its native proof.
The notification drill's 41 emitted labels are separate. Full verification
passes 4,877 TypeScript cases/225 files, Go and all sixteen Swift cases, with no
selected platform check skipped. X05 passes 60 cases/six files, eleven native
scenarios and five browser cases. See the [manifest](operations-step-up-expiry-manifest.json)
and [command result](operations-step-up-expiry-command-result.json).

## Repairs and limits

Six retained operation suites now bind proof issuance and invocation to a
fixture-local SQL clock without changing historical corpora or shared clocks.
Recovery's temporary fake Date is restored in finally. G01's retention fixture
has the same bounded repair and typechecks; its runtime remains uncertified.
The first post-guard focused run's twenty-seven stale-clock failures, the initial
engine-table snapshot failure and an unpinned exploratory native replay are
excluded from acceptance. Temporary diagnostic code is removed.

This is consume-statement-local proof, not later-statement/response deadlines,
shared passkey expiry, agent/runner/lease expiry, deployed auth or private
activation. G01 runner-token and static AG02/AG04 gates remain open, not waived.
The next slice is Timo's approved uniform manual GitHub linking hold, retaining
webhook reconciliation; this tested source does not implement it. Historical
GitHub source fences, execution-owned delivery and destructive private retention
remain open. Private creation/sharing/checkpoints stay disabled; C11 remains
`in_progress`, C12 planned. The wider MVP, merge and beta rollout are not claimed.
