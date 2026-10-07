# BFB product beta lane

Status: implementation in progress, 7 October 2026.

This lane owns the board, product UI, authenticated MCP product features and
the eight [mandatory requirements](../mvp.plan.md#mandatory-product-scope-extension--5-october).
Timo split it from remote start and agent-to-agent work on 6 October. It starts
from the integrated `7b8620c` checkpoint, preserving the existing implementation
and certificates. Package metadata remains the source of truth for completion.

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
reminders and contribution views receive their own contracts and acceptance
packages before implementation. The locally verified product branch is the
deliverable; deployment and live-pilot operation are separate rollout decisions.

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

This is sequencing, not a claim that new package IDs, architecture decisions or
feature certificates already exist. The eight requirements are mandatory;
unimplemented capabilities remain visible rather than becoming implied by
foundation tests.

## Mandatory feature ledger

| Requirement | Delivered foundation | Still to build in this lane |
| --- | --- | --- |
| Project board and human/agent tasks | Project lanes, typed context, routing and explicit progress records; current isolated viewer/review proofs | Distinct summary/plan/graphics/progress navigation and inherited base/project instructions |
| Authenticated MCP and private work | Scoped OAuth/local run authority, retry/audit repairs and clean-certified dormant C10 creator/grant kernel | C11 enforcement on every delivery/projection/transport before private creation; C12 immutable selected-content publication |
| Project-root prompts and documentation | Task-local context and immutable delivery lineage, not project-wide knowledge | Canonical BFB project instructions/docs/artifacts, versioning and explicit precedence without overwriting local instructions |
| Workspace/project Git skills | Configuration snapshot foundation only | Pinned catalogs, sync, collision resolution and explicit enablement without automatic code execution |
| Clean neon UI, light/dark | W03 certified locally: compact board/attention, on-demand task/comments, two default item commands, neutral lime/cyan light/dark/system themes, keyboard/mobile/contrast proof | Integrate/release the product branch with the separately owned execution lane; new product surfaces still use their own feature packages |
| Workspace/project business secrets | Infrastructure/Keychain credentials only; BFB-encrypted vault direction approved, not built | Encryption/key lifecycle, scoped grants/revisions, recovery, revocation and value-redaction proof |
| Reminders to update BFB | Constant launch bootstrap and telemetry-only hooks, not checkpoint reminders | Explicit checkpoint cadence, suppression, acknowledgement/expiry and dedupe; no automatic publication or model turn |
| Minimal human contribution history | Attributed comments, attention and result/artifact decisions; explicit timers remain measurements | Compact privacy-aware cross-record projection/view with source dedupe; no presence-derived contribution or labor |

The ledger separates existing records from missing product behavior. It does
not certify the whole board, private content, a vault or the live-provider flow.
Root instructions, publication authority and skill enablement still require
explicit contracts/ADRs before implementation. The current eight-feature
acceptance definitions remain in the linked MVP plan.

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
