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

Current checkpoint: [measurement attention lineage](evidence/WP-C11/measurement-attention-manifest.json)
and [human attention history](evidence/WP-C11/human-attention-history-manifest.json),
clean-certified together at `c4747a9`. Exact C11 passes 3,004 stage invocation
cases across 121 file invocations, six panel browser cases and 214 D1 checks
across eighteen harnesses; its notification drill is separate. Exact A04, A02
and X03 pass, including their native and browser checks. Full verification
passes 4,788 TypeScript cases, Go and all 16 Swift cases. Same-project fixtures
separate task privacy from project restrictions. Measurement sources and all
human attention readers require exact retained task/run/execution/assignment
lineage, without requiring current execution activity or the newest assignment.
Canonical ended, earlier-generation, resolved and empty history stays readable.
Historical pre-upgrade fixtures preserve their old task shape through migration;
this does not change production capture, measurements or clocks.

Next is browser task child-collection selection. Its source is committed at
`a1506cd`; the exact focused target passes 78 cases and four native D1 groups,
and a finalized committed OLD replay records 12 failures/13 controls. Its own
clean C11/full-verification pipeline is running, not yet acceptance. Parent
denial must remain distinct from an authorized empty or terminal child page.
GitHub key policy, execution-owned delivery and destructive private retention
remain open. Private creation, sharing, inherited private children and
checkpoints stay disabled; C11 remains in progress and C12 planned.

### Earlier checkpoints

The [task-detail panel selection checkpoint](evidence/WP-C11/detail-panels-manifest.json)
is clean-certified at `9687435`. Exact C11 passes 2,684 stage invocation cases,
six panel browser cases and 206 D1 checks across sixteen harnesses; its
notification drill is separate. Exact W03 passes 239 unit/mounted cases and
91 shared browser cases. Full verification passes 4,772 TypeScript cases, Go
and all 16 Swift cases. Panels bind coherent snapshots, mutation callbacks and
drafts to the current selection/operation. Current denials remove records,
viewers and actions; keyboard retry preserves drafts. Artifact notes remain
artifact-bound; rapid duplicate actions dispatch once. Hidden visited sections
retain their label-only opt-in notice and the existing default action budget.
The original 25-case committed OLD probe records 20 failures/five controls;
nine later expanded cases are separate from that OLD replay. Browser denials
are intercepted presentation responses, not server authorization proof.
Its evidence remains unchanged.

The [public business delivery and CLI ceilings checkpoint](evidence/WP-C11/public-business-manifest.json)
is clean-certified at `4a7b399`: exact C11 passes 2,614 stage invocation cases
and 206 D1 checks across sixteen harnesses; X03 and full verification pass with
4,738 TypeScript cases, Go and all 16 Swift cases. Typed adapters retain
original transport authority through admission, staged commit, cached replay
and final post-Hub selection; CLI readers retain their original binding/project
ceilings. Native SQL and historical fixture corrections were certified by a
fresh complete pipeline. Its evidence remains unchanged.

The [human detail and cached business delivery checkpoint](evidence/WP-C11/human-detail-cache-manifest.json)
is clean-certified at `61cb5ae`: exact C11 passes 2,527 stage invocation cases
and 200 D1 checks across fifteen harnesses; X03 and full verification pass with
4,651 TypeScript cases, Go and all 16 Swift cases. Canonical attention detail
and task/attention cached replies retain current business authority and
historical fields. Its evidence remains unchanged.

The [delegated list selection checkpoint](evidence/WP-C11/list-delivery-manifest.json)
is clean-certified at `8e04700`: exact C11 passes 2,495 stage invocation cases
and 181 D1 checks across fourteen harnesses; X03 and full verification pass with
4,619 TypeScript cases, Go and all 16 Swift cases. Current authority and canonical
project/task pages share a final statement, retaining authorized empty pages,
captured project ceilings, readable-root traversal and parent masking without
read effects. Its evidence remains unchanged.

The [delegated task read checkpoint](evidence/WP-C11/task-delivery-manifest.json)
is clean-certified at `4fc181e`: final canonical selection repeats current read
authority and original OAuth restrictions, returning current fields and
redacting unreadable parents without read effects. Exact C11 passes 2,459 stage
invocation cases and 160 D1 checks across thirteen harnesses; X03 and full
verification pass with 4,583 TypeScript cases, Go and all 16 Swift cases.
Its evidence remains unchanged.

The [delegated attention read checkpoint](evidence/WP-C11/attention-delivery-manifest.json)
is clean-certified at `3a2b0a6`: final canonical selection retains exact
attention/task/run/execution/assignment lineage and repeats current read
authority and original OAuth restrictions. New canonical answers, read-only
roles and ended historical executions remain readable without read effects.
Exact C11 passes 2,427 stage invocation cases and 140 D1 checks across twelve
harnesses; X03 and full verification pass with 4,551 TypeScript cases, Go and
all 16 Swift cases. Its evidence remains unchanged.

The [delegated context delivery checkpoint](evidence/WP-C11/delegated-context-manifest.json)
is clean-certified at `7aaf625`: fresh selection, committing delivery, cached
replay and final MCP selection repeat current read authority. Original OAuth
nullable boundaries remain ceilings; retries reconstruct only canonical
previously delivered versions, including an authorized empty list. Exact C11
passes 2,393 stage invocation cases and 122 D1 checks across eleven harnesses;
X03 and full verification pass with 4,517 TypeScript cases, Go and all 16 Swift
cases. Its evidence remains unchanged.

The [delegated attention creation checkpoint](evidence/WP-C11/delegated-attention-manifest.json)
is clean-certified at `0e987c9`: retained creation authority, permitted run state
and immutable waiter context are guarded without narrowing Reviewer requests,
write-only scope or exact retries. Its historical parity expiry fixture is
repaired; its evidence remains unchanged.

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
Its [clean checkpoint](evidence/WP-C11/audit-positions-manifest.json) passes at
`23c8930`: 2,298 stage invocation cases, 79 D1 checks across eight harnesses,
the separate notification runtime, exact X01/X05 and full verification with
4,422 TypeScript cases, Go and all 16 Swift cases. The new real-D1 proof bounds
queries at 18 bindings and 33,807 SQL bytes and closes position v1 without
rewriting audit history. Current board UI workspace-selection races are next.
GitHub key policy, execution-owned delivery, destructive private retention and
natural expiry remain barriers; no private activation or complete C11 is implied.

The [browser board selection checkpoint](evidence/WP-C11/browser-board-manifest.json)
is clean-certified at `320b23a`: exact W03 passes 205 unit and 85 shared browser
cases; C11 passes 2,317 stage invocation cases and 79 D1 checks across eight
harnesses, with the separate notification runtime. Full verification passes
4,441 TypeScript cases, Go and all 16 Swift cases. Board, profiles and role share
the current human, selection incarnation and newest request. Old body/error/
finalizer and creation callbacks cannot restore previous workspace content;
current failures clear stale authority and retain one keyboard-operable retry.
Light/dark themes and the two default task actions are unchanged. The browser
secondary workspace is intercepted synthetic presentation, not server authority
proof, and native popup-key navigation remains uncertified. GitHub key policy,
execution-owned consumers, destructive private retention and natural expiry
remain barriers. Private creation/sharing/checkpoints stay disabled; C11 remains
in progress and C12 planned.

The [delegated-result expiry checkpoint](evidence/WP-C11/result-expiry-manifest.json)
is clean-certified at `6df0fce`. An additional atomic database-clock guard
rejects unchanged credentials that naturally expire before batch execution,
while delayed live controls retain observation timestamps. Exact C11, X03 and
full repository/platform verification pass. This closes only the delegated-
result temporal guard statement, not later statements, response delivery,
other commands or runner/lease expiry. GitHub key policy, execution-owned
delivery, destructive private retention and other expiry boundaries remain
open. Private creation/sharing/checkpoints remain disabled; C11 stays in
progress and C12 planned.

The [delegated artifact commit checkpoint](evidence/WP-C11/delegated-artifacts-manifest.json)
is clean-certified at `026be0b`: exact C11 passes 2,344 stage invocation cases
and 96 D1 checks across nine harnesses; X03 and full verification pass, including
4,468 TypeScript cases, Go and all 16 Swift cases. Creation/finalization repeat
retained current authority and exact publication targets inside their batch,
with a separate database-clock expiry ceiling and unchanged observations.
Corrected old-source reproducers establish the boundary loss; initial unseeded
task attempts are excluded. This is command-local proof, not later-statement,
response, byte retrieval or private activation certification. Delegated
attention commit authority is next; GitHub key policy, execution-owned delivery,
destructive retention and other expiry boundaries remain open. Private
creation/sharing/checkpoints stay disabled; C11 remains in progress and C12
planned.
