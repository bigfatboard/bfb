# BFB product beta lane

Status: implementation in progress, 8 October 2026.

This lane owns the board, product UI, authenticated MCP product features and
the eight [mandatory requirements](../mvp.plan.md#mandatory-product-scope-extension--5-october).
Timo split it from remote start and agent-to-agent work on 6 October. It starts
from the integrated `7b8620c` checkpoint, preserving the existing implementation
and certificates. Package metadata remains the source of truth for completion.

Latest finite checkpoint: [inherited mounted transport preparation](work-packages/evidence/WP-C11/inherited-transport-manifest.json),
clean-certified at `1ea4618` on one unchanged committed product worktree.
`pnpm test:c11:inheritance` passes 142 cases/five files and four separately
scoped native preparation groups. Full verification passes 5,137 TypeScript
cases/240 files, Go and sixteen Swift cases. Five new mounted browser-session/
CSRF cases and sixteen synthetic-token MCP cases cover inherited delivery,
actual-author versus root authority, credential ancestor masking and revoked
cache returns without discarding committed history. The deck fixture ranks its
new child deterministically; canonical authorship is checked separately from
the unchanged task wire DTO. This is test/contract coverage, not a production
change, compiled-browser/OAuth-flow certificate or private-create activation.
Full C11/X03/database acceptance is not rerun at this source; the earlier complete
pipeline remains separate below. The raw-log cleanup choice remains pending and
deletion behavior is unchanged. Other mandatory features and rollout remain open.

Previous complete C11 checkpoint: [retained private inheritance preparation](work-packages/evidence/WP-C11/private-inheritance-manifest.json),
clean-certified at `08b73ed` in one complete fresh pipeline. C11 passes 4,118
stage case invocations/174 file invocations in twenty-nine blocks, eighteen
browser cases and 273 native labels across twenty-eight harnesses. Dependencies
and forty-one notification labels stay separate. Full verification passes 5,116
TypeScript cases/240 files, Go and sixteen Swift cases. X03 passes 71 cases,
eleven native groups and both OAuth browser flows with fourteen tools; database
upgrade/recovery passes 68 cases/eleven files and `F04_D1_OK` at migration 0050.
The new finite target passes 44 cases/three files and four native groups. Retained
root/parent associations preserve actual authorship, resolve current root ACLs,
keep sharing exact-root and separate shared versus inherited agent-child quotas.
The prepared direct-human private-create command returns minimal guarded
receipts but remains absent from every transport and the production catalog.
Native bounds are 34 bindings/11,764 SQL bytes/nine batch statements for the
instrumented prebatch-cut groups, not all Worker/Hub work. The ordered inherited
LIMIT fixture, project cuts and non-FIFO direct-Hub backstop are explicitly
synthetic. The original generic native failure remains unlocalized; a proven
random-order witness weakness was improved without claiming causality. Thirteen
old-schema notification setup failures in an earlier clean attempt were repaired
without a missing-schema fallback; separate populated migration proofs remain.
Only the complete tested-source pipeline is accepted. Private creation and
ordinary private-parent creation stay unavailable. Full C11 activation,
execution-owned private delivery, destructive retention and the remaining
mandatory features are unfinished. No merge, deployment or pilot operation.

The earlier [browser and OAuth author-private checkpoints](work-packages/evidence/WP-C11/private-checkpoint-manifest.json),
clean-certified at `3f9f085`: C11 passes 4,074 stage case invocations/171 file
invocations in twenty-eight blocks, eighteen browser cases and 269 native labels
across twenty-seven harnesses. Dependencies and forty-one notification labels
remain separate. Full verification passes 5,072 TypeScript cases/237 files,
Go and all sixteen Swift cases. Exact X03 passes 71 cases/seven files, eleven
native groups and two OAuth browser cases with fourteen advertised tools. The
checkpoint slice passes 87 cases/six files, four native groups and six compiled
browser presentation cases. Immutable checkpoints infer human/delegation
authorship and enforce current read/contribution and exact-origin ceilings;
ordinary task-visible progress is unchanged. Impeccable's on-demand controls
retain both themes, single-flight saves and newer drafts. Native bounds are
29 bindings/4,806 bytes/eight batch statements for instrumented prebatch-cut
preparations, not all lifecycle/read or Worker/DO work. Parallel-Hub contribution
cuts and native OAuth metadata are synthetic; staged expiry is not natural proof.
The complete database upgrade/recovery target also passes at that clean source:
60 cases/ten files and `F04_D1_OK` at migration 0049. Its isolated retry uses
process-local `WRANGLER_SEND_METRICS=false` after delayed CLI shutdown; the stopped
original database driver (143) is excluded. This certificate combines completed
same-source gates and a full database retry, not one uninterrupted passing
pipeline. Earlier documentation chronology and stale browser tool-inventory
failures are separate; no behavioral assertion or acceptance gate was weakened.
Private creation remains unavailable; this is not complete C11 or MVP acceptance.

The earlier [creator sharing and repository reconciliation](work-packages/evidence/WP-C11/task-sharing-manifest.json),
clean-certified at `6a2e4ed`: C11 passes 3,987 stage case invocations/165 file
invocations in twenty-seven blocks, twelve browser cases and 265 native labels
across twenty-six harnesses. Dependencies and forty-one notification labels
remain separate. Full verification passes 4,992 TypeScript cases/232 files,
Go and all sixteen Swift cases; exact X04 passes all thirteen native scenarios,
1,154 protocol cases/twelve files, Go protocol and 49 focused cases/three files.
The sharing target passes 72 cases/four files, four native groups and six browser
cases. Creator-only grant/revoke controls are on demand, retain current authority,
and never imply that a historical receipt grants current access. Native permission
intersections use a Reviewer; the parallel-Hub version backstop is synthetic.
The reconcile target passes 44 cases/two files and four native groups, including
one genuine independent installation-revocation cut and its derivative retry.
Direct native bounds are sharing 15 bindings/2,769 bytes/nine batch statements
and reconcile eleven bindings/591 bytes/twelve statements, not Worker/DO internals.
The first clean attempt stopped before behavioral tests on two evidence JSON
formatting errors; the fresh complete pipeline passes without gate changes.
Sharing is implemented over dormant private policy; private creation remains
unavailable and this is not complete C11 or MVP acceptance.

The earlier [coherent GitHub status](work-packages/evidence/WP-C11/github-status-delivery-manifest.json),
clean-certified at `cd69f42`: C11 passes 3,871 stage case invocations/159 file
invocations in twenty-five blocks, six panel browser cases and 257 native labels
across twenty-four harnesses. Dependencies and forty-one notification labels
remain separate. Full verification passes 4,927 TypeScript cases/229 files,
Go and all sixteen Swift cases; exact X04 passes all thirteen native scenarios,
1,154 protocol cases/twelve files, Go protocol and 49 focused cases/three files.
The status target passes 92 cases/six files and ten native groups. The first
actual workspace capture is retained through one coherent final selection;
ordered DTOs and authorized empty arrays remain useful. Direct native status
bounds are five bindings/1,529 bytes, not Worker/DO internals. Final OLD probes
record seven domain failures/three controls, eight mounted failures/five controls
and seven native failures/three controls, excluding exploratory fixture/cleanup
failures. Browser session identity itself has no workspace epoch.

The earlier [beta manual GitHub linking hold](work-packages/evidence/WP-C11/github-manual-hold-manifest.json),
clean-certified at `21e4d69`: C11 passes 3,779 stage case invocations/153 file
invocations in twenty-four blocks, six panel browser cases and 247 native labels
across twenty-three harnesses. Dependencies and forty-one notification drill
labels remain separate. Full verification passes 4,904 TypeScript cases/227 files,
Go and all sixteen Swift cases; exact X04 passes 1,154 protocol cases/twelve files,
Go protocol, 49 focused cases/three files and thirteen native scenarios. The hold
target passes 98 cases/six files and seven native groups. OLD records ten domain
failures/four controls, ten mounted hold-dependent failures/five controls and five
native failures/two controls. Valid manual attempts now share one fixed denial
before task/evidence or cache selection; history and webhook reconciliation remain.
Direct history/provenance reader bounds are seven bindings/1,971 bytes, not
Worker/DO command bounds. The first unchanged-source Go inspection failure remains
separate, with no assigned cause or waiver; scoped uncached repetitions and the
complete fresh retry pass without code or timeout changes.

The earlier [operations step-up atomic expiry](work-packages/evidence/WP-C11/operations-step-up-expiry-manifest.json) is
clean-certified at `44c5714`: C11 passes 3,683 stage case invocations across
147 file invocations in twenty-three blocks, six panel browser cases and 240
native labels across twenty-two harnesses. Dependencies and the notification
drill remain separate. Full verification passes 4,877 TypeScript cases/225 files,
Go and all sixteen Swift cases; exact X05 passes 60 cases/six files, eleven
native scenarios and five browser cases. The operations target passes 343 cases
and six native groups. Its local consume UPDATE rejects naturally expired
proofs; successful commit history remains valid after TTL. OLD records three
staged failures/five controls and three native failures/three controls. Timed
domain-Hub bounds are 14 bindings/4,731 bytes/nineteen batch statements. G01
runtime and broader expiry/activation gates remain uncertified.

The earlier [human artifact atomic expiry](work-packages/evidence/WP-C11/human-grant-expiry-manifest.json) is
clean-certified at `bd5dbf5`: exact C11 passes 3,340 stage-case invocations
across 140 file invocations in twenty-two blocks, six panel browser cases and
234 native labels across twenty-one harnesses. Dependencies and the notification
drill are separate. Full verification passes 4,869 TypeScript cases in 224 files,
Go and all sixteen Swift cases; exact V01/V02/V03 also pass, including compiled
native V01 and the viewer/review browser proofs. The artifact target passes 130
cases/nine files and ten native groups. Human upload/view grants require atomic
database-clock liveness while allowing later completion after valid consumption.
Unchanged OLD replays record two mounted expiry failures/four controls and two
native expiry failures/eight controls. Handler bounds stay 19 bindings/4,716 bytes/
eight batch statements. A pre-existing agent receipt expression-depth failure
is repaired without changing authority; retained browser/migration fixtures are
updated. G01 still fails on an expired historical runner token, AG02/AG04 remain
open, and this finite certificate does not waive release gates or enable privacy.

The [browser task child positions](work-packages/evidence/WP-C11/task-positions-manifest.json)
checkpoint retains its separate `70c8500` certificate. Raw-ID continuation is
retired without fallback for comments/dependencies/links/work-runs; hash-only
Hub positions retain exact audiences, fixed capture/expiry and current parent
access. Complete-selection guards and final post-Hub denial preserve safe
history. Context remains unpaged; this compatibility evidence is unchanged.

The earlier [native Reviewer and project-loss artifact-view proof](work-packages/evidence/WP-C11/native-view-authority-manifest.json)
is clean-certified at `e947fdf` through exact C11 and full verification. That run passes
3,201 stage case invocations across 132 file invocations in twenty-one blocks,
six panel browser cases and 224 native check labels across twenty harnesses;
dependencies and the notification drill remain separate. Full verification passes
4,820 TypeScript cases in 221 files, Go and all 16 Swift cases. The focused
artifact target retains 112 cases and expands from four to six native groups,
proving useful named Reviewer cookie/CSRF reads and restricted-project access
loss after actual R2 get/body. The independent loss changes only the exact
project-access row; task grant, role, epoch, parents and committed consume/audit/
receipt/object history remain unchanged. Both waves start readable; denied
replies retain one-use, stored bytes and clean FKs. Handler SQL bounds remain
19 bindings/4,716 bytes. This proof-only extension changes no production guard
or view-parent policy and claims no new OLD security failure.
This is local native proof, not live private bytes, compiled-browser presentation,
agent-upload reply or expiry certification.
The earlier [human upload reply checkpoint](work-packages/evidence/WP-C11/artifact-bytes-manifest.json)
retains its `833babe` certificate and original five-case OLD replay with one
failure/four controls. The post-commit human response retains exact consumed
lineage, canonical receipt, current contribution and captured project ceilings
without rolling back history. Synthetic parent-move and retained-result probes
are not claimed reachable business transitions; their evidence remains separate.
The earlier [browser task child-collection checkpoint](work-packages/evidence/WP-C11/task-collections-manifest.json)
retains its separate `a1506cd` certificate: uniform late denial including empty
and terminal pages, useful fields/order and captured-project ceilings. Its
unfixed replay records twelve failures/thirteen controls; its parent-move probe
is synthetic. No raw-ID continuation policy is changed by that read proof.
The earlier [measurement attention lineage](work-packages/evidence/WP-C11/measurement-attention-manifest.json)
and [human attention history](work-packages/evidence/WP-C11/human-attention-history-manifest.json)
checkpoints retain their separate `c4747a9` C11/A04/A02/X03/full-verification
certificate. Production capture, arithmetic and clocks are unchanged.
The [task-detail panel certificate](work-packages/evidence/WP-C11/detail-panels-manifest.json)
and earlier public business/CLI certificate remain unchanged. UI details,
drafts, retry and hidden-section notices stay on demand in both themes.
Timo approved raw-ID retirement without fallback and position-only Hub
bookkeeping on 7 October; ADR 0016 and the delivery contract freeze the wire.
Retained private-root association, actual descendant authorship and authority-
family quota semantics are prepared and clean-certified under ADR 0017. The next
product-owned work is creation integration and the remaining activation barriers;
the prepared command is not registered or available through any transport.
Browser/remote-OAuth author-private checkpoints are certified separately from
ordinary shared progress. Local run delivery belongs to the execution lane and
stays unavailable pending its own online IPC integration. Private creation stays
unavailable until the complete matrix passes. The repository-reconcile guard is
now clean-certified; its unchanged-source OLD diagnostic records one independent
revocation failure and one derivative cached retry, not clean OLD acceptance.
Healthy and pre-revoked controls pass. Sequential remap policy
and natural browser-session expiry remain separate unproved concerns; production
GitHub reconciliation omits task IDs, so dormant private/task-bound fixtures are
not claimed as another reachable defect.
Timo separately authorized merging and a first Cloudflare beta deployment after
the product-beta work is verified, followed by deployed smoke checks. No rollout
has occurred and execution-lane implementation remains excluded. Execution-owned
consumers and destructive private retention remain open; status, reconciliation
and the selected manual-key hold are certified. Private creation and inherited
private children stay unavailable; sharing and checkpoint controls alone do
not activate them. Local checkpoint delivery and publication remain held.
C11 is in progress,
C12 planned, and the other mandatory product features remain unfinished. Their
planned owners are now C13 project knowledge, C14 skill catalogs, C15 business
secrets, A05 passive checkpoint reminders, A06 human contribution history and
W04 distinct task content views. Reserved target/manifest names are not
implemented acceptance commands or certificates.
Pinned Cloudflare CLI authentication and read-only resource inventory are
available for the later beta rollout. No beta resources, rollout or pilot changed.

## Ownership boundary

- This lane: task/project content, isolated artifact viewing and review,
  privacy and explicit sharing, canonical project knowledge, skill catalogs,
  light/dark core UI, business secrets, contribution views and checkpoint
  reminder policy/integration that cannot start a provider turn.
- Other lane: provider launch/resume, containment and checkout recovery,
  runner/app operation, provider adapters for these paths and supervised agent
  discussions.
- Shared contracts: sequence D1 migrations, authorization changes, Hub commands
  and generated protocols. A product feature cannot silently change provider
  authority or consume an uncertified remote-start/discussion dependency.
- Do not operate the enrolled pilot, edit provider configuration, or enable held
  features on its persistent state as part of a synthetic product test.

## Delivery order and observable checks

Current goal, 6 October: complete the remaining product-beta scope in the
isolated product worktree. [W03](work-packages/WP-W03-progressive-disclosure-ui.md)
is locally certified; its approved light/dark design and two-command default
budget carry into new product surfaces. Use Impeccable to build and verify those
surfaces without restarting visual-direction approval.

[C11](work-packages/WP-C11-private-task-delivery.md) is the active package.
Finish current-authority child/artifact delivery, recipient-safe replay and
metadata, then creator-only sharing and private checkpoints. Its stage-one
certificate remains historical; private creation stays disabled until all
stages pass together. Publication follows in C12. Knowledge, skills, secrets,
reminders and contribution views now have scoped planned packages; their owning
contracts/ADRs and executable acceptance must be frozen before implementation.
After the product-beta work is verified, Timo
has authorized merge and a first Cloudflare beta deployment with deployed smoke
checks. Operating the enrolled pilot or changing execution-lane scope remains
separate.

1. Re-certify V02 isolated viewing against the current V01 contract. Reproduce
   and fix same-clock consumption and body-bound errors, connect metadata-only
   audit dispatch, and prove the compiled viewer through browser-authenticated
   production Worker/Hub/D1/R2 paths. Keep hostile iframe/top-level tests.
2. Re-certify V03 immutable review after V02 is `done`. A new artifact version
   must not inherit approval; authorized review, rejection and explicit timers
   must survive reload without implying task acceptance.
   Then re-certify X03's existing authenticated MCP extensions: exact retries,
   current authority before cached replies, metadata-only audit and current
   attention/result/artifact parity, without widening OAuth scopes.
3. Formalize privacy/publication and cloud project knowledge in ADRs and scoped
   packages. Freeze ownership, ACL, sharing audience, instruction precedence
   and immutable delivery lineage before consumers change.
4. Build the product core: coherent theme tokens/preferences, project-lane
   navigation, distinct task summary/plan/graphics/progress views, clear
   human/agent routing, loading/empty/error/stale/denied states and compact
   contribution history. Prove keyboard, reflow, reduced-motion and contrast
   in both themes; keep truthful unavailable data.
5. Add pinned workspace/project skill catalogs and business-secret sharing
   under their approved contracts. Catalog sync is not permission to execute
   code; secret values never enter task context or ordinary telemetry.
6. Extend authenticated MCP and explicit publication to the approved product
   contracts. Recheck current access before cached replies, delivery and
   redemption. Define checkpoint reminders separately from provider delivery;
   hooks cannot manufacture business progress or start a turn.

This is sequencing, not a claim that planned contracts or feature certificates
already exist. The eight requirements are mandatory; unimplemented capabilities
remain visible rather than becoming implied by foundation tests.

## Remaining package owners

Implement one package at a time after its dependencies are `done`. C11 remains
active; planning later packages does not consume its unfinished delivery contract.

| Package | Product outcome | Boundary before implementation |
| --- | --- | --- |
| [C12](work-packages/WP-C12-selected-content-publication.md) | Explicit immutable selected-content publication | Publisher/selection/audience ADR, exact target and evidence path |
| [C13](work-packages/WP-C13-project-knowledge.md) | BFB-canonical project instructions/docs/artifact references and inherited context | Ownership, precedence, multiline bounds and immutable delivery ADR/contract; local instructions untouched |
| [C15](work-packages/WP-C15-business-secret-vault.md) | Scoped encrypted business-secret management and sharing | Key custody/recovery/rotation, value grants, step-up and separate redemption ADR/contract |
| [C14](work-packages/WP-C14-skill-catalogs.md) | Pinned workspace Git skills plus project additions and explicit enablement | C13 composition and C15 private-source references; Git fetch/discovery/collision/enablement contract |
| [A05](work-packages/WP-A05-checkpoint-reminders.md) | Passive checkpoint guidance and bounded reminder policy | Explicit cadence/sources, suppression/ack/expiry and dedupe; no provider turn or hook installation |
| [A06](work-packages/WP-A06-human-contributions.md) | Compact explicit human contribution history | Canonical source/actor/time/lineage allowlist, source dedupe and privacy-safe counts/paging |
| [W04](work-packages/WP-W04-task-content-views.md) | Distinct on-demand Summary, Plan, Graphics and Progress | Explicit content classification and exact version/audience mapping over completed feature contracts |

C13 and C15 can start only after C11 is done; W03 is already certified. C14
consumes C13's composition and C15's private-source credential references. A05
consumes C13's base/context guidance;
A06 follows C11/W03. W04 integrates completed A06/C12/C13 into the existing W03
design. This graph describes dependencies, not parallel schema work or a release
promise. Provider reminder delivery, knowledge/skill adoption by local harnesses
and agent secret injection remain separate execution-lane integrations.

## Mandatory feature ledger

| Requirement | Delivered foundation | Still to build in this lane |
| --- | --- | --- |
| Project board and human/agent tasks | Project lanes, typed context, routing and explicit progress records; current isolated viewer/review proofs | W04 distinct summary/plan/graphics/progress navigation; C13 inherited base/project instructions |
| Authenticated MCP and private work | Scoped OAuth/local run authority, retry/audit repairs, dormant C10 kernel, creator sharing, browser/OAuth author-private checkpoints and retained inheritance preparation | Private-create registration/UI and complete C11 activation, execution-owned local checkpoint delivery; C12 immutable selected-content publication |
| Project-root prompts and documentation | Task-local context and immutable delivery lineage, not project-wide knowledge | C13 canonical BFB project instructions/docs/artifact references, versioning and explicit precedence without overwriting local instructions |
| Workspace/project Git skills | Configuration snapshot foundation only | C14 pinned catalogs, sync, collision resolution and explicit enablement without automatic code execution |
| Clean neon UI, light/dark | W03 certified locally: compact board/attention, on-demand task/comments, two default item commands, neutral lime/cyan light/dark/system themes, keyboard/mobile/contrast proof | Integrate/release the product branch with the separately owned execution lane; new product surfaces still use their own feature packages |
| Workspace/project business secrets | Infrastructure/Keychain credentials only; BFB-encrypted vault direction approved, not built | C15 encryption/key lifecycle, scoped grants/revisions, recovery, revocation and value-redaction proof |
| Reminders to update BFB | Constant launch bootstrap and telemetry-only hooks, not checkpoint reminders | A05 passive checkpoint cadence, suppression, acknowledgement/expiry and dedupe; no automatic publication or model turn; provider hook delivery remains separate |
| Minimal human contribution history | Attributed comments, attention, result/artifact decisions and author-private checkpoints; explicit timers remain measurements | A06 compact privacy-aware cross-record projection/view with source dedupe; no presence-derived contribution or labor |

The ledger separates existing records from missing product behavior. It does
not certify the whole board, private content, a vault or the live-provider flow.
Root instructions, publication authority, vault keys/grants and skill enablement
still require explicit owning contracts/ADRs before implementation. New package
target and manifest names are reserved; no command stub or passing evidence is
created by the plan. The eight-feature acceptance definitions remain in the
linked MVP plan.

## Confirmed defaults — 6 October

Timo answered **“defaults”** to the three proposed choices:

- Private work: creator plus explicitly shared humans, without automatic
  workspace-owner access or an administrator ACL override.
- Business secrets: a BFB-managed encrypted vault, separate from infrastructure
  secrets and local provider credentials. Key lifecycle/recovery/agent grants
  still require their owning contract before values ship.
- Core UI: electric lime/cyan accents and neutral light/dark themes. Palette
  approval is not a completed design or accessibility certificate.

[ADR 0015](adr/0015-private-work-authorization.md) fixes the privacy boundary.
C10 establishes its dormant authorization kernel; C11 gates activation on
cross-surface delivery and sharing enforcement. C12 separately owns immutable
selected-content publication. Knowledge precedence and skill enablement remain
separate contracts. No secret is implicitly delivered in a prompt.

## Verification and running state

Use one active package in this lane, exact clean-checkout acceptance, bounded
redacted evidence and full `pnpm verify` before handoff. Preserve historical
manifests; current runtime proof must have its own explicit scope.

- Frozen dependency install and the unchanged exact `pnpm test:v02` baseline
  pass at `7b8620c`: 1,154 protocol tests, 87 focused tests, real D1 harness and
  11 Chromium containment tests. This baseline does not cover the recorded
  same-clock race or compiled-viewer/browser-auth integration gaps.
- V02 is re-certified at `4e4fb70`: exact clean acceptance passes 141 focused
  and 16 browser cases; full verification passes 2,905 TypeScript cases, Go
  and 16 Swift cases. The separate current viewer certificate closes its
  recorded gaps without altering historical evidence.
- V03 is re-certified at `c20648a`: clean exact acceptance passes 62 focused
  cases, 14 real-D1 checks and nine browser scenarios. V02 regression stays
  green; full verification passes 2,908 TypeScript cases, Go and 16 Swift
  cases. The review surface wraps at narrow widths.
- X03 is re-certified at `edac71e`: clean exact acceptance passes 71 cases,
  11 real-Worker/D1/R2 checks and both OAuth browser scenarios. Full verification
  passes 2,923 TypeScript cases, Go and 16 Swift cases. Exact retries and current
  authority fence private cached replies; receipts exclude private bodies.
  Privacy/knowledge/design work follows the confirmed defaults. Remaining
  foundation integrations keep their own gates.
- No pilot configuration, production deployment or live-provider outcome is
  changed or claimed by this lane.
- C10 is clean-certified at `a7edf14`: exact acceptance passes 86 cases and nine
  real-D1 checks; C08/X03 regressions stay green. Full verification passes
  2,987 TypeScript cases, Go and all 16 Swift cases. Existing task records are
  unchanged by migration `0045_private_task_authority`. Private policies/grants
  are dormant until C11's complete delivery gate passes. C11 is in progress:
  stage 1 fences human task/board/deck and delegated task reads, work actions
  and cached responses. Its [checkpoint](work-packages/evidence/WP-C11/manifest.json)
  is clean-certified at `02dffa6`: 121 focused cases, nine real-D1 checks and
  retained C10/C08/X03 regressions; full verification passes 3,089 TypeScript
  cases, Go and 16 Swift cases. Strict task-tool schemas reject unsupported
  private intent without shared insertion. The
  [child-delivery checkpoint](work-packages/evidence/WP-C11/stage-two-manifest.json)
  is clean-certified at `21e6d8b`: 821 focused cases, 14 real-D1 checks and
  retained C10/C08/X03 regressions; full verification passes 3,296 TypeScript
  cases, Go and all 16 Swift cases. Current task-parent child/content and
  artifact authority are fenced through synthetic domain and authenticated
  transport proofs, including fake-R2 revoke/expiry races and real-D1 atomic
  receipt rollback. The
  [partial metadata checkpoint](work-packages/evidence/WP-C11/stage-three-manifest.json)
  is clean-certified at `1e6b710`: 1,079 focused cases, 20 real-D1 checks and
  retained C10/C08/X01/X04/X05/X03 regressions. Full verification passes 3,420
  TypeScript cases, Go and all 16 Swift cases. Recognized result references now
  have uniform resource denial, current cache authority and atomic source
  guards; notifications, GitHub and operations have partial shared-only content
  fences. This does not settle held external-package dependencies or complete
  C11. Opaque positions, GitHub unbound-key collisions, operations aggregates,
  diagnostics, audit, retention/recovery, coordination consumers and
  creation/sharing remain open. Natural credential/lease expiry during an
  in-flight D1 batch is explicitly uncertified. The
  [retention/upload-recovery checkpoint](work-packages/evidence/WP-C11/retention-recovery-manifest.json)
  is clean-certified at `de4f5fe`: 1,179 C11 cases, 24 real-D1 checks and exact
  X05 acceptance; full verification passes 3,520 TypeScript cases, Go and all
  16 Swift cases. It closes current human shared-only retention counts/delivery
  and atomic Owner upload recovery, with separate configured-system selection
  and post-Hub browser checks. Destructive private retention and complete
  operations audit, aggregates, diagnostics and other recovery remain open.
  The [canonical artifact audit checkpoint](work-packages/evidence/WP-C11/artifact-audit-manifest.json)
  is clean-certified at `80abaa6`: 1,373 C11 cases, 30 real-D1 checks and exact
  X05 acceptance; full verification passes 3,714 TypeScript cases, Go and all
  16 Swift cases. Nine canonical artifact actions and strict paired dispatch
  wrappers use exact current shared parents and typed reconstructed sources
  before page/count/anchor delivery. Owner/epoch loss denies even empty pages;
  NUL-suffixed typed fields and serialized object envelopes are rejected.
  The [upload-recovery audit checkpoint](work-packages/evidence/WP-C11/recovery-audit-manifest.json)
  is clean-certified at `ac3f86e`: 1,574 C11 cases, 37 real-D1 checks and exact
  X05 acceptance; full verification passes 3,915 TypeScript cases, Go and all
  16 Swift cases. Strict receipt/ledger/failed-target lineage omits mixed hidden
  targets, preserves legitimate older/retry history and reconstructs redacted
  metadata. Valid UTC pages/anchors normalize microseconds and equal-instant
  insertion ties without changing display timestamps or recovery execution.
  Other audit families, live queue/health aggregates and frozen diagnostics
  remain open. The prior in-flight credential/lease expiry reproducer remains
unresolved; live private R2 byte delivery remains uncertified. C12 stays planned.
  The [scoped operations aggregate checkpoint](work-packages/evidence/WP-C11/operations-aggregate-manifest.json)
  is clean-certified at `2a38b63`: 1,800 C11 cases, 45 real-D1 checks across two
  harnesses and exact X05 acceptance; full verification passes 4,141 TypeScript
  cases, Go and all 16 Swift cases. Supported queue totals, workspace token
  counts and hydrated work share one final current-observer selection. Typed
  shared lineage and all-target recovery prevent hidden source contributions;
  genuine run-free uploads survive while malformed run parents do not.
  Concise visible-count copy adds no default controls. Frozen diagnostics,
  other audit/recovery families, opaque positions, complete delivery and the
  in-flight expiry barrier remain open. Private creation remains disabled.
  The [diagnostic quarantine checkpoint](work-packages/evidence/WP-C11/diagnostic-manifest.json)
  is clean-certified at `03c0b81`: 1,828 C11 cases, 49 real-D1 checks across
  three harnesses and exact X05 acceptance; full verification passes 4,169
  TypeScript cases, Go and all 16 Swift cases. Legacy snapshots are uniformly
  unavailable before source/cache/proof/business effects; diagnostic copies
  are omitted before visible audit/semantic limits while stored history remains
  unchanged. A compact unavailable notice replaces controls and diagnostic
  fetches; its explanation is keyboard-operable and on demand. Current X05 D9
  proves the hold rather than v1 upload. Other audit/recovery families, opaque
  positions, composite board/deck delivery, coordination and the prior natural
  expiry barrier remain open. Private creation/sharing/checkpoints stay disabled.
  The [canonical board/deck checkpoint](work-packages/evidence/WP-C11/board-manifest.json)
  is clean-certified at `014f73b`: 1,877 invocation cases, 55 real-D1 checks,
  exact W03 acceptance (179 unit and 87 shared browser cases), and full
  verification with 4,219 TypeScript cases, Go and all 16 Swift cases. Current
  authority, role/body/policy/name/run history and independent board/deck bounds
  share one final selector. Recent event details are held within existing
  disclosures, with stale metadata suppressed and no new default action.
  Routine browser captures no longer overwrite historical evidence; a fresh
  clean certificate passes. Remaining unsupported audit/recovery, opaque
  positions, coordination, natural expiry and activation barriers stay open.
  The [unsupported audit/recovery quarantine checkpoint](work-packages/evidence/WP-C11/quarantine-manifest.json)
  is clean-certified at `b085cb9`: 1,904 invocation cases, 58 real-D1 checks,
  exact X05 and full verification with 4,246 TypeScript cases, Go and all
  16 Swift cases. Only certified artifact/upload receipts enter audit pages;
  three unproved legacy recoveries are held before proof/source/cache/effects.
  Stored history and normal integrations remain unchanged. Concise supported-
  scope copy adds no controls. Current X05 D6/D7 prove held state and unused
  proofs, not legacy recovery success. Remaining privacy barriers still gate
  activation; human coordination-history readers are the next bounded slice.
  The [human coordination-history checkpoint](work-packages/evidence/WP-C11/coordination-manifest.json)
  is clean-certified at `7a34404`: 1,958 invocation cases, 63 real-D1 checks,
  exact D01/W02 regressions and full verification with 4,300 TypeScript cases,
  Go and all 16 Swift cases. Shared discussion/status readers bind current exact
  parents and the retained first viewer epoch at final delivery; empty lists and
  replacement lease occupants are covered. Private creator/grantee history is
  still held. A stale profile migration fixture was repaired before fresh clean
  certification. Participant/runner/cleanup and the natural-expiry barrier remain
  outside this checkpoint. The included public-position contract is not its
  implementation certificate; private creation stays disabled and C12 planned.
  The [public-position quarantine checkpoint](work-packages/evidence/WP-C11/public-positions-manifest.json)
  is clean-certified at `9220606`: 1,999 C11 invocation cases, 67 real-D1
  checks, exact E01/E02/A04/X03/X05/W03 regressions and full verification with
  4,335 TypeScript cases, Go and all 16 Swift cases. Public raw feeds and browser
  sockets are deliberately unavailable before source access; public receipts
  omit only the Hub cursor. Internal order, runner nudges and arithmetic remain.
  Compact notices stay within existing disclosures, suppress stale history and
  add no default actions. W03 passes 186 unit and all 83 shared browser cases.
  Independent legacy retirement survives runner alarm scheduling. Two initial
  clean failures were corrected without weakening business response or signed-
  ingestion controls. Notification identities, audit anchors, GitHub key policy,
  execution-owned consumers, destructive private retention and natural expiry
  remain barriers. Private creation/sharing/checkpoints stay disabled; C11 remains
  in progress and C12 planned. Knowledge, skills, vault, reminders and contribution
  views remain unbuilt; the wider MVP and deployment are not complete.
  The [notification identity checkpoint](work-packages/evidence/WP-C11/notification-identities-manifest.json)
  is clean-certified at `4f156f5`: 2,044 C11 invocation cases, eight stage runtime
  harnesses, exact X01/X05 and full verification with 4,380 TypeScript cases,
  Go and all 16 Swift cases. Additive migration 0046 and bounded Hub repair retain
  historical bookkeeping while browser/push/native wires use immutable random
  public identities without raw positions. Native v1 tuple and whole-batch
  validation, legacy resume and post-await parent/project/epoch checks pass.
  Two stale acceptance fixtures were corrected before final clean certification.
  Complete deployed cutover and installed native delivery are not claimed.
  Security-audit opaque anchors are the next product-side slice. Remaining
  GitHub, execution-owned, destructive retention and natural-expiry barriers
  still gate private creation/sharing/checkpoints; C11 stays in progress and
  C12 planned. Knowledge, skills, vault, reminders, contributions and the wider
  MVP remain unfinished. No UI or live-pilot rollout changed in this checkpoint.
  The [security audit position checkpoint](work-packages/evidence/WP-C11/audit-positions-manifest.json)
  is clean-certified at `23c8930`: 2,298 C11 stage invocation cases, 79 D1
  checks across eight harnesses, the separate notification runtime, exact
  X01/X05 and full verification with 4,422 TypeScript cases, Go and all 16
  Swift cases. Random ten-minute positions bind exact current audiences,
  inherited capture/expiry and canonical anchors; whole-page commit guards
  and final delivered-cut checks close security-audit position v1. Internal
  business history is unchanged. Current board UI workspace-selection races
  are the next bounded correction. GitHub key policy, execution-owned consumers,
  destructive private retention and natural expiry still gate activation.
  Private creation/sharing/checkpoints remain disabled; C11 is in progress,
  C12 planned, and the other mandatory product features remain unfinished.
  No deployment or live-pilot/provider operation changed.

  The [browser board selection checkpoint](work-packages/evidence/WP-C11/browser-board-manifest.json)
  is clean-certified at `320b23a`: W03 passes 205 unit and 85 shared browser
  cases, C11 passes 2,317 stage invocation cases and 79 D1 checks across eight
  harnesses plus the separate notification runtime. Full verification passes
  4,441 TypeScript cases, Go and all 16 Swift cases. Current selection and newest
  request guards suppress old boards, profiles, roles and callbacks; failed
  reads clear stale content and keep one keyboard-operable retry. Impeccable
  distill guidance preserves on-demand details, existing themes and two default
  task actions. Synthetic browser interception is not cross-workspace server
  authority or native popup-key proof. GitHub, execution-owned delivery,
  destructive private retention and natural expiry still gate activation.
  Private creation/sharing/checkpoints remain disabled; C11 stays in progress,
  C12 planned, and the other mandatory product features remain unfinished.
  No deployment or live-pilot/provider operation changed.
  The [delegated-result expiry checkpoint](work-packages/evidence/WP-C11/result-expiry-manifest.json)
  is clean-certified at `6df0fce` through exact C11, X03 and full verification.
  Database-clock expiry is now checked atomically at the delegated-result guard;
  delayed live controls preserve observation history. This is not certification
  of other commands, later statements, response delivery or runner/lease expiry.
  GitHub key policy, execution-owned delivery, destructive private retention and
  other expiry boundaries still gate activation. Private creation/sharing/
  checkpoints remain disabled; C11 stays in progress and C12 planned. The other
  mandatory product features remain unfinished. No rollout or pilot changed.

  The [delegated artifact commit checkpoint](work-packages/evidence/WP-C11/delegated-artifacts-manifest.json)
  is clean-certified at `026be0b`: C11 passes 2,344 stage invocation cases and
  96 D1 checks across nine harnesses, with exact X03 and full verification
  passing 4,468 TypeScript cases, Go and all 16 Swift cases. Artifact creation
  and finalization repeat retained current authority and exact publication
  targets before effects, with a separate database-clock credential ceiling
  that preserves observations. Initial unseeded boundary fixtures are excluded;
  corrected old-source reproducers fail meaningfully. The next product-side
  slice is delegated attention commit authority, preserving Reviewer request
  permission. GitHub key policy, execution-owned delivery, destructive private
  retention and other expiry boundaries still gate activation. Private
  creation/sharing/checkpoints remain disabled; C11 stays in progress, C12
  planned, and the other mandatory product features unfinished. No rollout or
  pilot changed.

  The [delegated attention read checkpoint](work-packages/evidence/WP-C11/attention-delivery-manifest.json)
  is clean-certified at `3a2b0a6`: C11 passes 2,427 stage invocation cases and
  140 D1 checks across twelve harnesses, with exact X03 and full verification
  passing 4,551 TypeScript cases, Go and all 16 Swift cases. Final canonical
  attention selection retains exact historical lineage and original OAuth
  restrictions. Current answers, read-only roles and ended historical
  executions remain readable without read effects. Its evidence remains
  unchanged.

  The [delegated task read checkpoint](work-packages/evidence/WP-C11/task-delivery-manifest.json)
  is clean-certified at `4fc181e`: C11 passes 2,459 stage invocation cases and
  160 D1 checks across thirteen harnesses; X03 and full verification pass with
  4,583 TypeScript cases, Go and all 16 Swift cases. Final task selection repeats
  current read authority and original OAuth restrictions, returns current
  canonical fields and redacts unreadable parents without read effects. Its
  evidence remains unchanged.

  The [delegated list selection checkpoint](work-packages/evidence/WP-C11/list-delivery-manifest.json)
  is clean-certified at `8e04700`: C11 passes 2,495 stage invocation cases and
  181 D1 checks across fourteen harnesses; X03 and full verification pass with
  4,619 TypeScript cases, Go and all 16 Swift cases. Final project/task page
  selection retains current authority, authorized empty pages, captured project
  ceilings, readable-root traversal and parent masking without read effects.
  Its evidence remains unchanged.
