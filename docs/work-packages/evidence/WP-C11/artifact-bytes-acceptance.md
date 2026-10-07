# C11 human upload reply and local native artifact bytes

Tested and production source: `833babe2079b1eb45b11851b3b8fe6e956cd9ae1`.
Protocol: unchanged `bfb-wire/1`.
D1 head: `0047_security_audit_positions`; no migration added.

C11 remains `in_progress`. Private creation, creator sharing, inherited private
children and author-private checkpoints stay disabled; C12 remains planned.

## Human upload reply

After the receipt transaction commits, one final read binds the retained consumed
grant/hash/attempt/time/human/epoch to the canonical artifact version, receipt,
immutable source, audit and object. Current contribution authority and the
original captured project vector still apply. A denied response does not roll
back the committed history or delete stored bytes. A genuine consumed grant may
converge on an immutable receipt created by another grant for the same content;
the caller's retained consume tuple is independently checked.

Eleven mounted human-private-upload cases contain seven additions and four
retained controls. Post-commit grant, epoch, role, permission and restricted
project losses deny. The snapshot-free task-move/new-project-grant and retained
result attempt-substitution controls are expressly synthetic robustness probes,
not production task-move commands or demonstrated reachable business races.

The committed unfixed `23158d` runtime, built independently, replays only the
original five cases: the post-COMMIT revocation case gets HTTP 200 instead of
403, while four controls pass. Six later additions are skipped and native groups
are not replayed on OLD. The OLD failure establishes the status boundary; it is
not a separate byte-body probe. Production source remained unchanged and the
test overlay was removed with clean status confirmed.

## Actual disposable D1 and R2

The additive `pnpm test:c11:artifact-bytes` target passes 112 cases in seven
files and four independently collecting native Worker/D1/R2 groups. It is
composed once by C11. Synthetic signed browser cookies use production cookie/
CSRF validation, control routes and the external WorkspaceHub. Dormant privacy
and sharing rows are fixtures, not available product commands.

Healthy private creator, named contributor/read-recipient, shared and run-free
paths return exact synthetic bytes. Ungranted Owner access denies. Actual R2
`get`, `put` and `arrayBuffer` operations are forwarded; native D1 batches receive
the original bound statements. One-use grants, immutable receipt convergence,
pre-consume denial, post-get/body denial, post-put receipt rollback and
post-successful-receipt response denial are independently witnessed.

Canonical snapshots cover business, authority and history, excluding engine
metadata, migrations and abuse accounting. Each independent revoke changes only
its named grant row; subsequent denial and replay preserve all committed rows
and pass foreign-key checks. Failed verification retains the actual orphan R2
object rather than deleting it. Handler SQL is bounded at 19 parameters and
4,716 bytes; these limits do not cover control/Hub setup or snapshot queries.

## Clean certificate and limits

Unchanged committed source passes frozen install, exact C11, full `pnpm verify`
and clean status before/after. C11 passes 3,201 case invocations across 132 file
invocations in twenty-one blocks, six retained panel browser cases and 222 native
check labels across twenty harnesses. C10/C08 dependencies and the separate
notification runtime are not added to those totals. Counts are invocations and
bounded check labels, not unique cases or assertions.

Full verification passes 4,820 TypeScript cases in 221 files, Go and all 16 Swift
cases. No platform gate is skipped. Earlier UI, viewer, OAuth and measurement
package certificates remain separate; no fresh standalone package claim is made.

This is local native proof, not compiled-browser presentation, deployed ingress,
live private bytes, an installed app, persistent pilot, agent-upload reply or
natural-expiry certification. Opaque child cursors, GitHub key policy,
execution-owned consumers, destructive private retention and other temporal
boundaries still gate activation. No cursor migration/fallback, view-parent
policy change, Hub/kernel rewrite, cleanup, provider operation or rollout occurs.
