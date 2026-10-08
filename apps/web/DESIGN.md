---
name: BFB Work Map
description: A compact attention-first project board with details available on demand.
colors:
  canvas: "oklch(0.985 0.003 160)"
  surface: "oklch(0.968 0.004 160)"
  surface-strong: "oklch(0.928 0.006 160)"
  surface-raised: "oklch(1 0 0)"
  ink: "oklch(0.23 0.008 160)"
  ink-muted: "oklch(0.47 0.011 160)"
  rule: "oklch(0.86 0.008 160)"
  action-surface: "oklch(0.9 0.16 125)"
  action-ink: "oklch(0.25 0.05 125)"
  cyan-text: "oklch(0.39 0.066 200)"
  focus: "oklch(0.48 0.09 200)"
  dark-canvas: "oklch(0.16 0.008 160)"
  dark-surface-raised: "oklch(0.24 0.009 160)"
  dark-ink: "oklch(0.955 0.004 160)"
  dark-action-surface: "oklch(0.84 0.14 125)"
  dark-action-ink: "oklch(0.21 0.025 125)"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0.015em"
rounded:
  control: "4px"
  task: "6px"
  surface: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  section: "32px"
---

# Design System: BFB Work Map

## Creative direction

The product is a quiet dispatch floor: scan current work and pending decisions, then open one item when more information is useful. Neutral surfaces carry the content; restrained lime actions and cyan focus provide orientation. The metaphor stays structural. The interface never draws fake control hardware, adds decorative glass, or uses terminal cosplay.

The board is one continuous plane. A cross-project Needs Now deck of at most three tasks sits above horizontally arranged project lanes. Task detail opens from the right without destroying lane position. Details are hidden by default, not removed: named controls keep evidence, measurements, comments, ownership and existing commands reachable.

## Discovery and action budget

- Work and Attention are primary navigation. More contains the existing secondary routes, with the current route named when selected. The account menu contains role, Account security, Sign out and Appearance; these functions remain available on narrow screens.
- A task card exposes Open and Details by default. Its title, literal state, priority and punchline remain visible. Routing explanations, intended agent owner, Pass, latest event and run summary belong inside Details.
- Task detail starts at Overview with one contextual primary command and the labelled Task section selector. Forms, comments, context, handoff, review, artifacts, activity, measurements and feature-gated sections are revealed deliberately. Revealed sections retain their state; selecting a section does not execute a business command.
- An attention request exposes Answer or Mark resolved and Details. Answer composition opens only after Answer. Permission distinctions, errors, conflicts and safety notices remain visible where a decision is made.
- Comments show their content and attribution. Composition is on demand. An explicit form or review can show the necessary Save/Cancel or decision pair; these are named exceptions to the default two-command budget.
- Disclosure and menu headings are labelled native controls with button semantics, visible focus and Escape-to-close behavior. No function depends on hover or an undocumented shortcut. Closing task detail returns focus to its origin.

## Color roles

- Neutral canvas, surfaces and ink carry daily-use density without card shadows. `surface-raised` is a theme-dependent surface, never an alias for action text.
- Lime identifies deliberate primary actions. `action-surface` and `action-ink` are separate paired tokens; links use the contrast-safe `accent-text` token rather than the bright fill color. Lime never asserts activity, approval or completion.
- Cyan identifies focus and the active primary-navigation underline. Literal labels remain the source of state and urgency.
- Each project retains its stable tint, swatch, lane header and full-width 3px task-card top edge. Card bodies stay neutral in both themes.
- Priority owns only the fixed top-right marker and its literal label. It never recolors a project card.
- Success, error and unavailable states use independent tokens plus explicit text; transport presence never implies business progress.
- Selection uses a focus outline. Keyboard focus remains visible in both themes and forced-colors mode.

`src/styles.css` owns the complete light and dark semantic tokens. Appearance offers System, Light and Dark. System follows the operating-system preference; a personal local override persists as presentation only, without a workspace mutation or authorization effect. Text/action token pairs meet WCAG AA; focus has at least 3:1 contrast against its surrounding surface.

## Typography

Use the native system sans stack for human language and controls. Reserve monospace for IDs, versions, timestamps and machine-owned values. Product headings use a fixed compact scale; labels avoid wide decorative tracking. Form content uses normal weight at 1rem rather than inheriting a label's emphasis.

## Components

- Buttons and fields have 4px corners, visible focus, explicit disabled states, and a minimum 44px target.
- Task cards use 6px corners, a neutral keyline, project-colored top edge and no ambient shadow. Compact default content has no fixed decorative height.
- Menus use bounded raised surfaces and 8px corners. The desktop task sheet is non-modal and uses a neutral separating rule, not a glass overlay or shadow. At narrow widths it becomes a labelled modal dialog with bounded keyboard focus and an inert background, restored on close.
- Project lanes use one native horizontal scroll. Lanes never become workflow-state columns or vertical scroll traps.
- New activity does not expand hidden sections. Empty, loading, offline and failure states describe actual outcomes, not fabricated activity or progress.
- Result, measurement and artifact-review details install coherent bodies only for the current selection and newest operation. Denied details remove old records and actions, with one keyboard-operable retry inside the existing detail section. A hidden section reports only its label until the human chooses to open it.
- Unsent review notes stay local. Artifact notes belong to their task and artifact; switching artifacts restores each note without moving it to another review. Saving an earlier note does not erase edits made while that save is pending.
- Private checkpoints are a named on-demand task section, not a board action or shared comment. Show one Add checkpoint control; composition reveals Save private checkpoint and Cancel. Scope unsent notes to the human/task, keep newer edits during an earlier save, clear denied delivered history, and confirm only after a canonical refresh. Name the owner/origin boundary and unavailable local-run/publication paths without implying private-task activation.
- Empty states teach the next action and may use one dry line. Permission, credential, destructive, and acceptance copy never jokes.

## Responsive behavior

Wide screens show multiple project lanes. At 720px and below, a lane fits the viewport with the project jump control retained. The shell reflows into compact rows rather than hiding account, workspace or navigation functions. At 1120px and above, a 544px task sheet reserves space beside the board; narrower screens use a viewport-bounded sheet with its close and section controls retained. Long text wraps without forcing document-level horizontal scrolling. Keyboard, touch, zoom and reduced-motion behavior are required parts of the layout.

## Motion

Use short ease-out transitions only for selection, sheet entry and committed state feedback. Reordering waits until interaction ends. Reduced motion removes travel and preserves the final state immediately.

## Product and authority boundaries

This design implements progressive disclosure, not new authorization or business behavior. Existing routes, role access, context audiences, review decisions, feature gates and handlers remain authoritative. Artifact bytes load only after explicit preview. Theme and disclosure changes never launch, approve, complete or publish work. Remote start, provider operation, agent discussions and private-work activation retain their separate contracts and gates. `PRODUCT.md` remains the product source of truth.

`pnpm test:c11:detail-panels` owns mounted task-detail race controls and the compiled Chromium denial/retry/disclosure checks. Synthetic intercepted browser responses certify presentation only, not server authority; the owning domain and mounted API suites retain that separate responsibility.

`pnpm test:c11:private-checkpoints` owns the author-private checkpoint section's presentation checks and separate browser/MCP/domain/native authority proofs. Its intercepted light/dark browser cases prove keyboard composition and reflow, not server access control.
