# WP-W03 — Clean board and task interface

Status: `done`

Risk: Medium

Test target: `pnpm test:w03`

Evidence manifest: `docs/work-packages/evidence/WP-W03/manifest.json`

## Outcome

An authorized human can scan current work and pending decisions, open one
focused item, and reveal its details without navigating a wall of forms or
operational metadata. Each item exposes one primary command and at most one
secondary command by default.

## Dependencies

- **Requires:** A02, A03, A04, V03, W01, W02.
- **Unlocks:** A06, C13, C15, W04.
- **Can run with:** remote-start and agent-discussion work only when files and contracts are disjoint; this package does not operate the enrolled pilot.

## Scope

- Simplify the authenticated shell, project board, attention view, task detail
  and comment entry using progressive disclosure.
- Preserve horizontally scrolling project lanes and the bounded Needs Now
  projection. Keep project, priority, task state and intended ownership distinct.
- Replace repeated card-level history, measurement and transport explanations
  with information available on demand. Keep essential next-action reasons,
  unavailable state, conflicts and safety warnings visible where decisions occur.
- Keep task editing, ownership changes, context, comments, result review,
  artifact review and measurements reachable with familiar named controls.
- Add coherent neutral light/dark themes with the approved lime/cyan accents,
  system preference and an explicit personal override. Theme preferences are
  presentation only, not workspace mutations or authorization.
- Preserve account/security navigation on narrow screens; do not hide a
  function without a discoverable replacement.
- Add a dedicated root test target, action-count tests, interaction regression
  cases and bounded synthetic visual evidence before certification.
- Resolve existing shared UI-fixture interference where necessary for complete
  regression coverage; do not reinterpret failures as a passing certificate.

## Non-goals

- Remote start, agent-to-agent execution, provider adapters, runner/app
  operation, Terminal consent, native permission changes or live pilot testing.
- New task/business commands, API or D1 schema changes, privacy activation,
  publication, project knowledge, skills catalogs or a business-secret vault.
- A configurable Jira replacement, additional frameworks, fabricated activity,
  metrics inferred from presence, or rasterized product text and controls.

## Contracts

### Consumes

- W01 authenticated routes, role-aware task commands, project lanes, canonical
  Needs Now projection, comments and typed context audiences.
- A02 committed attention questions, answers, permission distinctions and
  optimistic versions; A03 explicit result review and acceptance; A04 separate
  provenance-labelled measurements and human-controlled timers.
- V03 exact artifact-version review and V02's isolated click-initiated viewer.
- W02's existing launch component remains reachable without changing its
  commands, failure semantics or provider execution behavior.
- Existing React/Vite pipeline and shared component/style conventions.

### Produces

- A documented default action budget and discovery model for each core surface,
  with a confirmed visual direction and updated product design guidance.
- Accessible disclosure, selection, menus, comment entry and theme preference
  behavior without changing the domain or authorization contracts.
- Stable acceptance target `pnpm test:w03` covers the web build, all web unit
  tests and the complete shared browser suite, including the W03 interaction
  cases. Bounded evidence belongs at the declared manifest path; planning and
  baseline checks are not an implementation certificate.

## Work plan

1. Compare official Linear, YouTrack and comparable-tool patterns with the
   existing BFB screens. Use Timo's requested progressive-disclosure brief and
   approved lime/cyan defaults for an existing-UI simplification, preserving
   business behavior and rendering semantic, editable controls.
2. Implement shell/theme and compact board presentation against that direction;
   check role access, project identity, unavailable states and action counts.
3. Implement focused task details, on-demand forms and pending-decision/comment
   entry. Preserve version conflicts, escaped content, explicit review and
   existing feature gates.
4. Verify keyboard and touch discovery, focus restoration, stable reading,
   mobile/tablet/desktop reflow, both themes and reduced motion. Inspect the
   rendered screens and correct material defects.
5. Run exact acceptance and full repository verification from a clean checkout;
   commit bounded evidence before marking the package `done`.

## Acceptance

- Default task, attention and comment surfaces expose at most two item-level
  commands. Opening an item is a command; incidental close/navigation chrome
  is counted separately and cannot conceal a second business toolbar.
- A revealed form or explicit review decision may expose necessary Save/Cancel
  or Accept/Request changes controls. Every exception is named and tested.
- An error arriving in a hidden mounted section surfaces a label-only notice
  and one explicit reveal action. It never copies private failure bodies into
  the overview or automatically expands new activity.
- Details and secondary commands remain discoverable with mouse, touch and
  keyboard, never only on hover or through an undocumented shortcut.
- Opening, closing or changing a displayed section never launches, completes,
  approves, publishes or edits work. Drafts survive non-destructive section
  changes; successful submission and failures follow the actual API outcome.
- Unsaved edit/handoff drafts retain their base version across unrelated saves.
  An explicit conflict reload replaces those drafts with canonical state;
  background refresh never silently rebases an old edit onto a newer version.
- Closing task detail restores the originating focus and preserves board
  position. New activity does not automatically expand hidden sections. Rapid
  selection cannot replace the selected task with an older read response.
- Narrow sheets use modal semantics and bounded keyboard focus; background
  controls are inert until close. Wide sheets remain contextual/non-modal.
- Owner/member/reviewer actions, current access, context audiences, feature
  flags and stale-version recovery retain their existing behavior.
- Titles, questions, comments and metadata render as escaped text. Artifact
  bytes remain isolated and load only after an explicit preview action.
- Both themes meet WCAG AA contrast and independent state labels; keyboard
  focus is visible, touch targets remain usable, reduced motion is respected,
  and 320px/narrow/zoomed layouts do not lose account or task functions.
- Empty, loading, error, offline, denied, conflict and long-content states
  have bounded, truthful presentation without fake measurements or activity.
- Exact `pnpm test:w03` and `pnpm verify` pass from a clean checkout; the
  evidence manifest identifies the tested commit, toolchain and redaction.

## Evidence

- The declared manifest will index synthetic screenshots, interaction/state
  coverage, action counts, contrast and responsive checks, and command outcomes.
- Research and the proposed brief live in
  [the redesign brief](../ui-redesign-brief.md). They do not certify shipped UI.
- No secrets, real task content, raw terminal output or local absolute paths
  belong in committed evidence. Existing package certificates remain intact.
- `BFB_CAPTURE_W03_EVIDENCE=1 pnpm test:w03:browser` owns the bounded
  synthetic viewport captures and bounded `browser/ui-checks.json` report.

## Risks and decisions

- Hidden complexity can become undiscoverable functionality. Use familiar
  labelled entry points and test every existing core action through the new UI.
- The action budget is a default, not permission to hide necessary decision
  evidence, errors or authorization/safety distinctions.
- Visual hiding is not access control. Private-work activation continues to
  require the complete C11 gate and is not consumed by this redesign.

## Handoff

- Requested 6 October: simple, clean UI inspired by Linear and YouTrack, details
  on demand and one or at most two default actions for tasks, pending work and
  comments. Lime/cyan and neutral light/dark are already approved defaults.
- Implementation uses the existing-product distill workflow against the stated
  brief and approved defaults, not a new-brand or raster-mock workflow. The
  previous planning checkpoint added an unnecessary visual approval gate;
  that gate is removed. No release or pilot change is implied by this work.
- Certified from committed source `ebc8da0` in a fresh checkout:
  exact W03 acceptance passed 178 focused unit checks and all 85 shared browser
  cases; full verification passed 3,130 TypeScript tests, Go and 16 Swift tests.
  The committed manifest and synthetic captures index that proof. No deployment
  or remaining privacy/MCP product package is implied by this UI completion.
