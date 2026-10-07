# C11 delegated artifact commit authority checkpoint

Delegated artifact creation and finalization now repeat their retained authority
and exact publication target in write-only guards inside the committing D1
batch. Current contribution, project access, membership/epoch, Owner/Member
role, delegation/client, write scope and boundary must still authorize the
retained run/task/project. A separate database-clock guard requires the exact
credential to remain unexpired. Prepared work/audit timestamps are unchanged.

Tested source: `026be0b4b348b6803478cb56411560d4e618f071`.
Protocol: unchanged `bfb-wire/1`.
D1 head: `0047_security_audit_positions`; no migration added.

C11 remains `in_progress`. Private creation, sharing and author-private
checkpoints stay disabled; C12 remains planned.

## Regression and rollback proof

Fourteen domain and nine genuinely authenticated mounted MCP cases cover new
artifacts, additional versions and verified finalization. Domain and D1 controls
preserve write-only OAuth scope; no new read scope is required. Independent
authority loss rolls back artifact effects, audit/outbox, semantic receipts,
idempotency and cursor without erasing the independent change. Failed creation
keys can retry after a valid new contribution grant; completed keys remain
rejected. Delayed live controls retain their prepared observations.

The actual-D1 domain/Hub harness passes 15 checks using native bound statements.
It proves genuine consumed upload bookkeeping, exact verified receipt/object
tuples, current private contribution without workspace-owner bypass, and an
unchanged credential that is live on arrival and naturally expires before the
batch. Finalization pins uploading state, artifact/run/format/role, digest/size
and the canonical verified object before its UPDATE. Consumed upload history
does not need to regain freshness.

Corrected reproducers in a disposable pre-fix checkout produce 15 expected
failures and eight passes in the focused suites, and ten failures with five
passes in D1. These are local regression observations, not committed old-source
package certificates. Initial boundary attempts used an unseeded task and hit
a foreign-key failure before authority checking; they are excluded. Corrected
fixtures create a real unrelated task and witness the independent mutation.
Competing finalization already denied a second receipt on unfixed source; it
is retained as a backstop control, not claimed as a new security regression.

## Clean verification

Exact `pnpm test:c11` passes 2,344 stage cases in 85 file invocations, plus its
C10/C08 dependency gates. Nine stage D1 harnesses pass 96 checks. The separate
notification drill passes; its 41 record labels include setup and repeated
dispatch/redaction, not 41 independent cases. The new additive
`pnpm test:c11:delegated-artifacts` is composed once by C11. Its actual-D1
queries remain bounded at 30 bindings, 7,043 SQL bytes and 13 batch statements.

Exact X03 passes 71 unit cases, 11 Worker/D1/R2 checks and both OAuth browser
cases. Full `pnpm verify` passes 4,468 TypeScript cases in 201 files, Go checks
and all 16 Swift cases without skipping selected platform checks. Frozen
install, before/after worktree checks, unchanged source identity and empty
final status pass. See the [manifest](delegated-artifacts-manifest.json) and
[command result](delegated-artifacts-command-result.json).

## Scope and remaining gates

This certificate covers the command-local guard statements, not every later
statement, response delivery, artifact-byte retrieval or other command. The
OAuth MCP races are authenticated mounted requests using staged SQLite;
actual D1 is separately proven through domain/Hub. Runner/local capability,
lease expiry and cleanup remain outside this slice. Delegated attention commit
authority is the next product-side seam to prove.

GitHub key policy, execution-owned delivery, destructive private retention and
other expiry boundaries still gate activation. Publication, project knowledge,
skills, vault, reminders and contribution views remain unfinished. The approved
Impeccable UI direction carries forward; it is not re-certified here. No live
pilot, provider, installed app, deployment or external CI was operated.
