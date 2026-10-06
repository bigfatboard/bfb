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
  light/dark core UI, business secrets, contribution views and product-facing
  checkpoint policy.
- Other lane: provider launch/resume, containment and checkout recovery,
  runner/app operation, provider adapters and supervised agent discussions.
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

## Outstanding user choices

- Private-task ownership/ACL and workspace-owner exceptions.
- BFB-managed encrypted business secrets versus an external secret manager.
- Electric lime/cyan core UI direction versus the existing crimson palette.

Questions were presented to Timo on 6 October. Viewer/review re-certification
does not depend on their answers. No answer has been silently assumed.

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
  recorded gaps without altering historical evidence. V03 is next; downstream
  features retain their own certification boundaries.
- No pilot configuration, production deployment or live-provider outcome is
  changed or claimed by this lane.
