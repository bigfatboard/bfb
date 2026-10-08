# C11 human artifact atomic expiry

Human upload and view grants now require database-clock liveness at the actual
consume UPDATE. Retained request time cannot extend an unchanged grant across an
await. Exact lineage, supplied-time validation and one-use guards remain. Once
consumption succeeds, later body/R2/receipt work may finish past TTL; the existing
current-delivery authority still applies. This is not a later-statement or
response deadline.

Clean tested source: `bd5dbf5e6eed7ec037ab8c6e48f1bbe015a70b46`. Production
changes end at `31b720c`; subsequent commits repair retained test fixtures.
D1 head remains `0048_task_collection_positions`; no wire or migration changes.

## Finite proof

The additive artifact target passes 130 cases in nine files and ten independent
native groups. Six mounted cases cover upload/view natural expiry, equal-delay
live controls and successful consumption followed by completion past TTL. Four
new native groups join six retained groups. Grants are still live after actual
preparation/binding, retain their original parameters and canonical rows during
the same explicit delay, and arrive expired or comfortably live as intended.
Canonical snapshots, one-use history, useful bytes and clean foreign keys pass.
Handler bounds are 19 bindings, 4,716 SQL bytes and eight batch statements;
setup, Hub internals, witnesses and snapshots are excluded.

The unchanged `c341c48` OLD production replay records two meaningful mounted
expiry failures with four healthy controls, and two meaningful native expiry
failures with eight controls. OLD consumption succeeds after natural expiry.
Mounted soft assertions also collect useful response/byte and canonical effects;
native failures stop at the first denial expectation and are not claimed as
independently collected downstream failures. The incomplete initial mounted
JSON-on-HTML probe is excluded.

## Native receipt repair

Exact V01 exposed an agent-origin upload failure on both the human-expiry source
and its unchanged parent. Temporary bounded diagnosis identified the eight-
statement receipt batch and native `Expression tree is too large` error. No
documented numeric limit is claimed. All diagnostic code was removed.

Only the receipt CHECK expression is flattened: the unchanged agent witness is
a sibling scalar operand instead of nested inside the source COUNT. Grant,
attempt, consumed-time, version and literal agent-origin checks stay in that
source operand. The human branch, first retained-byte/lineage guard, parameter
order and batch shape remain unchanged. Fifteen new staged cases prove one
useful control and fourteen current-authority losses with complete rollback;
the full agent suite passes 86 cases. Staged SQLite does not prove native depth;
the exact clean V01 compiled-native run separately proves the repaired path.

## Clean verification

The frozen-install, verify, C11, V01, V02, V03 and before/after worktree pipeline
exits zero with `PRODUCT_PRIVACY_FINITE_CLEAN_CERTIFICATE_OK`. Source identity
and final empty status are retained.

Exact C11 passes 3,340 stage case invocations in 140 file invocations across
twenty-two blocks, not unique totals. Six panel browser cases and 234 native
labels across twenty-one harnesses are separate. C10 retains 86 cases/eight
files/nine native checks; C08 retains 23 cases/five files and its native marker.
The notification drill's 41 setup/repeated labels are separate, not cases.

Full verification passes 4,869 TypeScript cases in 224 files, Go and all sixteen
Swift cases with no selected platform check skipped. V01 passes 264 focused
cases, its D1 marker, Go race checks and the compiled native proof. V02 passes
165 focused cases, native D1 and sixteen browser cases. V03 passes 64 focused
cases, fourteen native checks and nine browser cases. Each includes the 1,154-
case protocol suite separately. See the [manifest](human-grant-expiry-manifest.json)
and [command result](human-grant-expiry-command-result.json).

## Repairs and limits

Connected-review expectations now match the existing denial UI and server
contract: auth loss hides records/actions; restoring the same synthetic session
allows keyboard retry and keeps the unsent draft without publishing. Project
loss is a uniform 404. No production review UI or authority changed.

G01 now inserts the genuine historical sixteen-column task before the later
authority migration and proves full-row preservation through upgrade. Its next
event-ingest step still rejects an expired historical runner credential. G01
and its static AG02/AG04 failures remain open; none is waived or included in the
finite certificate. Earlier stopped pipelines and a standalone later
`work_unavailable` native failure are exploratory, not acceptance; no cause is
assigned to that latter failure and no execution code changed.

Mounted synthetic authentication/fake R2 and disposable native D1/R2 are local
proofs, not deployed sign-in or private activation. The compiled V01 run is
regression verification, not execution-lane implementation. Operations step-up
natural expiry is the next frozen, uncertified slice. GitHub policy/history,
execution-owned delivery and destructive private retention remain open.
Private creation/sharing/checkpoints stay disabled; C11 remains `in_progress`
and C12 planned. The wider MVP, merge, beta deployment and external CI are not
claimed.
