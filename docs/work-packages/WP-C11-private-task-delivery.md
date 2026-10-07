# WP-C11 — Private-task delivery and sharing

Status: `in_progress`

Risk: Very high

Test target: `pnpm test:c11`

Evidence manifest: `docs/work-packages/evidence/WP-C11/manifest.json`

## Outcome

Create private work and explicitly share it without leaking content/existence
through another BFB surface.

## Dependencies

- **Requires:** C10, C05, C06, A01, A02, A03, A04, D01, E02, V03, W01, X03.
- **Unlocks:** C12.
- **Can run with:** no shared authorization, migration, Hub or generated-contract changes.

## Scope

ADR 0015's full delivery matrix, private child/internal-content and agent-view
authority, creator-only ACL commands, named-human read/contribute/edit grants,
opaque principal-scoped cursors and revocation. Uncertified notification/external
integrations fail closed for private resources. Coordinate launch/discussion
consumers with the other lane without implementing provider execution here.

## Non-goals

Publication, provider adapters/remote start, vault values and owner override.

## Contracts

### Consumes

- C10 task-access kernel v1 and migration 0045.
- Current human, CLI, delegation and run-scoped credential contracts as
  independent authority ceilings; no provider/runner acknowledgement wire changes.

### Produces

- [Private task delivery v1](../contracts/private-task-delivery.md), including
  full surface inventory, staged activation, typed commands, internal author
  authority and the opaque recipient-position contract.
- `pnpm test:c11` and its stage-labelled stable evidence manifest.

## Work plan

1. Fence human/delegated task reads and shared work-command cache returns.
2. Fence child records, local agent/pending operations and artifact bytes.
3. Fence metadata/replay/notifications/integrations and coordination consumers.
4. Add creation/sharing/internal-progress controls and certify all stages.

## Acceptance

The delivery contract freezes the complete surface inventory, command shapes,
internal author authority, opaque cursor contract and activation gate.
Prove denied/cached/revoked/concurrent
delivery and existence/count metadata. Every existing surface enforces current
task access or rejects private records. C10 tests alone cannot activate privacy.

## Evidence

The manifest must identify completed stages separately from the complete matrix,
committed source, exact commands and redacted deny/revoke/race results. Kernel
evidence is a dependency, not a delivery certificate. Current baseline:
`pnpm test:c10` passes 86 cases and nine real-D1 checks before C11 code changes.

## Risks and decisions

Existence/cursor metadata can leak even when content is filtered. No private
creation is enabled until every delivery surface is fenced or unavailable.
Coordinate shared contracts without changing the other lane's execution work.

## Handoff

In progress. Contracts and exact target are assigned; private creation remains
unavailable. Stage 1 is clean-certified at `02dffa6`: 121 focused cases, nine
real-D1 checks, C10/C08/X03 regressions and full repository/platform verification
pass. Its manifest explicitly excludes complete package acceptance. The
[child-delivery checkpoint](evidence/WP-C11/stage-two-manifest.json) is
clean-certified at `21e6d8b`: 821 focused cases, 14 real-D1 checks, retained
C10/C08/X03 regressions and full verification with 3,296 TypeScript cases, Go
and all 16 Swift cases. Synthetic task-parent child/content and artifact
authority are fenced. The
[partial metadata checkpoint](evidence/WP-C11/stage-three-manifest.json) is
clean-certified at `1e6b710`: 1,079 focused cases, 20 real-D1 checks and exact
C10/C08/X01/X04/X05/X03 regressions; full verification passes 3,420 TypeScript
cases, Go and all 16 Swift cases. It closes recognized result-reference
existence/cache/atomic source checks and adds shared-only notification,
GitHub and operations content fences. Opaque positions, GitHub unbound-key
collisions, complete operations privacy, coordination consumers and
creation/sharing/internal-progress remain open. Natural credential/lease expiry
during an in-flight D1 batch is explicitly uncertified and still requires a
coordinated repair before activation. No full delivery certificate, live private
R2 byte certificate or deployment exists. Downstream C12 remains planned until
all stages pass from one clean committed checkout.

The [retention/upload-recovery checkpoint](evidence/WP-C11/retention-recovery-manifest.json)
is clean-certified at `de4f5fe`: 1,179 cases, 24 real-D1 checks, retained C10/C08,
exact X05 acceptance and full verification with 3,520 TypeScript cases, Go and
all 16 Swift cases. Human retention counts and delivery use exact shared
parents/current scope; configured system selection is separate. Upload recovery
commits proof, current authority/state guards, artifact effects, ledger and safe
receipts atomically through the Hub, with a final browser authority check.
Complete audit/aggregate/diagnostic/other-recovery privacy and destructive
private retention remain uncertified. Canonical artifact security-audit delivery
is certified separately below, not as private activation or provider operation.

The [canonical artifact audit checkpoint](evidence/WP-C11/artifact-audit-manifest.json)
is clean-certified at `80abaa6`: 1,373 cases, 30 real-D1 checks, retained C10/C08,
exact X05 acceptance and full verification with 3,714 TypeScript cases, Go and
all 16 Swift cases. Nine artifact actions and strict paired dispatch wrappers
resolve exact current shared parents, typed source fields and matching grant
provenance before page/count/anchor selection. Current Owner scope is rechecked
even for empty pages; NUL-suffixed metadata and serialized object envelopes are
rejected. Historical payloads are reconstructed without rewriting stored rows.
Three stored upload-recovery retry races extend the earlier regression proof.
Other audit families, global positions, aggregate/diagnostic privacy and full
C11 acceptance remain open.

The [upload-recovery audit checkpoint](evidence/WP-C11/recovery-audit-manifest.json)
is clean-certified at `ac3f86e`: 1,574 cases, 37 real-D1 checks, retained C10/C08,
exact X05 acceptance and full verification with 3,915 TypeScript cases, Go and
all 16 Swift cases. Strict receipts bind applied ledger history and every current
failed shared/run-free target; mixed hidden targets omit the whole receipt.
Typed reconstruction preserves redacted arrays and legitimate older/retry history.
Valid UTC pages and anchors share microsecond-preserving normalized ordering,
with insertion-order ties and unchanged display timestamps. Recovery execution
is unchanged. Other audit families, live queue/health aggregates, frozen diagnostics,
opaque positions and complete delivery/creation/sharing remain open; the prior
in-flight credential/lease expiry reproducer is unresolved. C11 stays in progress.

The [scoped operations aggregate checkpoint](evidence/WP-C11/operations-aggregate-manifest.json)
is clean-certified at `2a38b63`: 1,800 cases, 45 real-D1 checks across two
harnesses, retained C10/C08, exact X05 acceptance and full verification with
4,141 TypeScript cases, Go and all 16 Swift cases. One final current-observer
selection binds supported queue/token totals and remasks hydrated work together.
Notification operator history is separate from recipient preferences; typed
GitHub and applied-recovery projections require every current shared source.
Independent NUL-parent regressions close malformed upload/retention remask while
preserving genuine run-free uploads. Counts are supported visible sources, not
physical queue-drained status. Frozen diagnostics, other audit/recovery families,
opaque positions and complete delivery remain open; private creation stays
disabled and the earlier in-flight expiry barrier remains unresolved.

The [diagnostic quarantine checkpoint](evidence/WP-C11/diagnostic-manifest.json)
is clean-certified at `03c0b81`: 1,828 cases, 49 real-D1 checks across three
harnesses, retained C10/C08, exact X05 acceptance and full verification with
4,169 TypeScript cases, Go and all 16 Swift cases. Browser diagnostic paths and
Hub commands retain authority/structural admission, then deny uniformly before
cache/proof/business effects. Valid upload jobs acknowledge without source or
storage lookup. Diagnostic audit/semantic copies are omitted before visible
limits and anchors while historical rows and objects remain unchanged. The UI
has an accessible unavailable notice and on-demand explanation, with no
diagnostic or passkey requests. Current X05 D9 proves this hold, not v1 upload;
dated evidence is preserved. Other audit/recovery families, opaque positions,
composite board/deck final delivery, coordination consumers and the prior
natural-expiry barrier remain open. C11 stays in progress; private creation,
creator sharing and author-private checkpoints remain disabled; C12 stays planned.

The [canonical board/deck checkpoint](evidence/WP-C11/board-manifest.json)
is clean-certified at `014f73b`: 1,877 invocation cases, 55 real-D1 checks across
four harnesses, retained C10/C08 and exact W03 acceptance (179 unit and 87
shared browser cases). Full verification passes 4,219 TypeScript cases, Go and
all 16 Swift cases. One final current-authority selector returns lanes, an
independent three-item deck, current role/epoch, task bodies, policy/routing,
current owner names and exact typed work history. Heuristic recent events are
uniformly held inside existing task Details. The first certification attempt
passed test gates but failed final clean status due to a historical G01 capture;
routine captures now use ignored output and the fresh clean certificate passes.
Unsupported audit/recovery implementation, opaque positions, coordination,
natural expiry and private activation remain open. C11 is still in progress.

The [unsupported audit/recovery quarantine checkpoint](evidence/WP-C11/quarantine-manifest.json)
is clean-certified at `b085cb9`: 1,904 invocation cases, 58 real-D1 checks across
five harnesses, retained C10/C08, exact X05 and full verification with 4,246
TypeScript cases, Go and all 16 Swift cases. Generic audit delivery is removed;
three legacy recovery kinds deny uniformly before proof/source/cache/effects.
Canonical artifact/upload receipts and proof-bound upload recovery remain.
Stored rows and ordinary integration consumers are preserved. Current X05 D6/D7
prove the hold, not historical requeue/rewind. An older D1 generic audit control
was corrected after the initial clean attempt failed; a fresh checkout passes.
Opaque positions, outward notification identities, GitHub key policy, remaining
coordination, natural expiry and destructive private retention remain open.
Private creation/sharing/checkpoints stay disabled; C11 is still in progress.

The [human coordination-history checkpoint](evidence/WP-C11/coordination-manifest.json)
is clean-certified at `7a34404`: 1,958 invocation cases, 63 real-D1 checks across
six harnesses, exact D01/W02 regressions and full verification with 4,300
TypeScript cases, Go and all 16 Swift cases. Shared discussion history repeats
exact current parent/viewer authority after all advisory awaits; lists retain
empty-parent scope before pagination. Human launch status binds the exact
assignment/execution/run/task/project/snapshot and lease occupant. Private
creator/grantee history remains held. The first clean attempt caught a stale
profile migration expectation; the corrected manual defaults and every prior
field pass from a fresh checkout. This does not certify participant/runner
authority, cleanup, opaque positions or natural in-flight expiry. The included
public-position contract is not implementation proof. Private creation remains
disabled; C11 remains in progress and C12 remains planned.

The [public-position quarantine checkpoint](evidence/WP-C11/public-positions-manifest.json)
is clean-certified at `9220606`: 1,999 invocation cases, 67 real-D1 checks across
seven harnesses, exact E01/E02/A04/X03/X05/W03 regressions and full verification
with 4,335 TypeScript cases, Go and all 16 Swift cases. Public raw feeds and new
browser sockets deny before source/high-water access; public receipts omit only
the top-level Hub cursor. Internal ordering, runner nudges, authorized business
DTOs and measurement arithmetic remain. Browser retirement is independent of
commands, including shared alarm composition. Public measurement sources are
null; compact on-demand notices suppress stale history without extra actions.
Exact W03 passes 186 unit and 83 shared browser cases. Initial clean attempts
caught an added recovery DTO field and a stale available-source expectation;
both were repaired before fresh final certification. Notification identities,
security-audit anchors, GitHub key policy, execution-owned consumers, destructive
private retention and natural in-flight expiry remain open. Private creation,
sharing and author-private checkpoints stay disabled; C11 stays in progress and
C12 planned. This is an availability hold, not an opaque replacement stream or
a live-provider/private-byte/deployment certificate.

The [notification identity checkpoint](evidence/WP-C11/notification-identities-manifest.json)
is clean-certified at `4f156f5`: 2,044 invocation cases, seven earlier D1
harnesses plus the production notification Worker/D1/Queue/DLQ drill, exact
X01/X05 and full verification with 4,380 TypeScript cases, Go and all 16 Swift
cases. Additive migration 0046 preserves internal keys, historical delivery
states and inbox acknowledgements while assigning immutable random public
identities through bounded Hub repair. Recipient wires omit raw event positions;
native pull retains its complete v1 tuple and accepts only public-ID acks.
Post-repair/signing parent, project and epoch regressions pass. Stale migration
and G01 caller fixtures were repaired before final clean certification. Complete
cutover and installed native delivery remain uncertified. Audit anchors are
next; GitHub key policy, execution-owned consumers, destructive private retention
and natural in-flight expiry remain open. Private creation/sharing/checkpoints
stay disabled; C11 remains in progress and C12 remains planned.

The audit-position v1 wire is now frozen in the delivery contract: random hashed
ten-minute positions, exact current audience/epoch/page-size binding, inherited
capture ceiling/expiry, whole-selection commit guards and final delivered-cut
checks. Its additive target is `pnpm test:c11:audit-positions`, composed by C11.
Implementation and clean-checkout evidence are pending; this contract does not
close audit positions or activate private work.
