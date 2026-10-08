# C11 unsupported audit and legacy recovery quarantine checkpoint

Tested source: `b085cb97c4f8aef7454b8822bee5b52cc9403068`.
Protocol: unchanged `bfb-wire/1`. D1 head: `0045_private_task_authority`.

Security audit delivers only its certified canonical artifact actions/dispatch
wrappers and upload-recovery receipts. Every unsupported family is omitted before
visible limits, `has_more` and anchors, independently of payload or private
presence. Current Owner/retained-epoch denial still precedes anchor denial.
Sanitization is not treated as historical source lineage.

Three legacy recovery kinds—notification redispatch, GitHub requeue and recovery
clearing—are uniformly unavailable. Existing browser authentication, current
Owner, method, budget, CSRF and pure body/proof-ID admission remain. Fixed 409
`request_rejected` with `recovery kind is unavailable` precedes proof lookup,
consumption, target/hash/ledger/cache access and business effects. Direct helpers
also deny without SQL; orphaned effect/proof helpers are removed. Registered
upload recovery, normal integration consumers and stored rows/proofs remain.

Meaningful domain/mounted regressions failed before repair, as did a bounded
actual-D1 unsupported-audit read. Independent review passes 521 cases across
eight files, including 494 retained artifact/upload controls. The current X05
D6/D7 drills prove unchanged parked state/watermark and unused fresh proofs;
they do not claim working legacy requeue/rewind. Dated evidence stays historical.
Impeccable clarification adds concise audit-scope copy without more controls.

## Clean verification

Exact `pnpm test:c11` passes 1,904 invocation cases in 68 files and 58 D1 checks
across five harnesses. Separate C10 passes 86 cases/nine D1 checks; C08 passes
23 cases and its independent-worker race proof. Counts are not a unique combined
cross-package total. New suites contain 13 domain and 14 mounted cases.

Exact X05 passes 60 cases, 11 runtime scenarios and five browser cases. Full
`pnpm verify` passes 4,246 TypeScript cases in 186 files, Go and all 16 Swift
cases, without platform skips. G01 caller compilation passes, not runtime
acceptance. Frozen install/worktree checks pass; source remains unchanged and
final status is empty. See the [result](quarantine-command-result.json) and
[manifest](quarantine-manifest.json).

The initial clean attempt at `5d31a14` stopped at an older D1 fixture expecting
an unsupported generic audit control. It is a compatibility-fixture failure,
not new security-red evidence. The corrected control is a source-backed run-free
artifact receipt; diagnostic/legacy rows remain stored, but cannot consume its
slot or serve as anchors. The independent semantic control is unchanged.
A fresh checkout passes all gates. Earlier certificates are not rewritten.

## Limits

C11 remains `in_progress`; private creation/sharing/checkpoints stay disabled
and C12 stays planned. Opaque positions, notification identities, GitHub key
policy, remaining coordination delivery, natural in-flight expiry and destructive
private retention remain activation barriers. No private R2 byte, provider,
pilot, deployment or external-CI certificate is claimed. New project knowledge,
skills, vault values, reminders and contribution views remain unbuilt.
