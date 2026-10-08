# WP-W04 — Distinct task summary plan graphics and progress views

Status: `planned`

Risk: High

Test target: `pnpm test:w04`

Evidence manifest: `docs/work-packages/evidence/WP-W04/manifest.json`

## Outcome

A human opens a task into its summary, then deliberately reveals plans,
graphics/diagrams or progress. Content stays distinct, useful and authorized
without turning the compact board into an always-visible toolbar.

## Dependencies

- **Requires:** A06, C12, C13, W03.
- **Unlocks:** none.
- **Can run with:** execution-lane work only with disjoint task UI and content contracts; no parallel artifact-purpose, context, projection or task-detail changes.

## Scope

- Keep Summary as the initial focused task view and introduce named Plan,
  Graphics and Progress choices through the existing on-demand section control.
- Freeze explicit, version-bound content classification/reference metadata;
  current artifact roles are `review`/`log`, not diagram or plan roles.
- Reuse isolated artifact preview and immutable review rather than embedding
  arbitrary HTML or treating a thumbnail/content title as a classification.
- Show shared progress, author-private checkpoints, A06 human contributions and
  C12 published copies with explicit distinctions; do not merge their audiences.
- Make inherited C13 instruction/knowledge lineage discoverable on demand.
- Preserve current routing, command handlers and feature gates without adding
  launch/resume controls or redesigning the other lane's execution UI.

## Non-goals

A new editor/framework, automatic plan/diagram inference, activation of private
creation, provider execution, auto-publication, fabricated progress percentages
or letting presentation-only filtering stand in for authorization.

## Contracts

### Consumes

- W03 Work Map action budget, themes, disclosure, selection and draft behavior.
- C12 exact published content/audience/provenance; C13 versioned project/task
  context; A06 source-labelled human history and current-authority projections.
- Existing immutable artifact viewer/review and C11 private authority, reached
  through completed dependencies. Artifact purpose does not change review role.

### Produces

- A versioned explicit task-content classification/reference contract with
  author/audience/version rules and any required common domain commands.
- Distinct content views using existing semantic components and isolated preview,
  plus the reserved owning clean test target and bounded browser manifest.

## Work plan

1. Freeze which canonical records feed each view, explicit content-purpose
   metadata, author/edit rules and wire limits; write an ADR before any invariant
   change. Preserve existing review/log semantics and compatibility.
2. Implement only classification/association records required by this package
   through shared commands, with migration/retry/stale/authority tests.
3. Build the views using Impeccable and the already approved Work Map direction.
   Prove positive discovery, useful empty/error/denied states and draft retention.
4. Inspect compiled browser views in both themes and narrow/wide/zoomed layouts;
   certify the exact clean target and full repository verification.

## Acceptance

- Summary opens by default. Plan/Graphics/Progress have labelled keyboard/touch
  entry points; choosing a section neither writes nor starts work.
- At most two item-level actions are visible by default. Revealed Save/Cancel,
  review or publication decisions are necessary, named and tested exceptions.
- Unclassified existing artifacts remain reachable without fabricated purpose;
  references identify exact immutable versions and retain isolated preview.
- Shared progress, private checkpoints and human contributions have truthful
  source/audience labels. No transport/prose/presence inference supplies progress.
- Private content does not appear in summary labels, counts, hidden-section
  notices or published history. Late denied/stale responses clear old delivered
  data and cannot replace a newer selection or silently rebase an unsaved draft.
- Both themes meet WCAG AA; focus, touch targets, reduced motion, 320px reflow
  and zoom preserve all functions. No action relies on hover or an unknown shortcut.

## Evidence

Not run. Future evidence separates content/authority contracts from intercepted
presentation fixtures and mounted transport proof. Use synthetic versions,
action counts, state/selection tests and bounded compiled-browser captures.

## Risks and decisions

Explicit classification is a new contract, not a rename of existing artifact
roles. Before `ready`, freeze source-to-view mapping, metadata ownership and
version behavior. Palette and progressive-disclosure direction are already
approved; this package does not reopen visual-direction approval.

## Handoff

Planned; C12/C13/A06 are unfinished. The certified W03 shell remains the working
UI foundation, not acceptance of the missing distinct content capabilities.
