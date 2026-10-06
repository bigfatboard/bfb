# BFB product beta lane

Status: implementation in progress, 6 October 2026.

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
| Authenticated MCP and private work | Existing scoped OAuth and local run authority; current delegated retry/audit repairs | Creator-private ACLs on every read/projection/transport and explicit immutable selected-content sharing |
| Project-root prompts and documentation | Task-local context and immutable delivery lineage, not project-wide knowledge | Canonical BFB project instructions/docs/artifacts, versioning and explicit precedence without overwriting local instructions |
| Workspace/project Git skills | Configuration snapshot foundation only | Pinned catalogs, sync, collision resolution and explicit enablement without automatic code execution |
| Clean neon UI, light/dark | Existing core board and narrow-screen review-control repair | Approved visual direction, tokens/preferences, core content navigation and both-theme accessibility/state acceptance |
| Workspace/project business secrets | Infrastructure/Keychain credentials only; not business-secret sharing | Approved backing store, scoped grants/revisions, revocation and value-redaction proof |
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

[ADR 0014](adr/0014-private-work-authorization.md) fixes the privacy boundary.
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
