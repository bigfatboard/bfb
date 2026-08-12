---
name: BFB Work Map
description: An attention-first dispatch board for humans and coding agents.
colors:
  canvas: "oklch(0.976 0.005 75)"
  surface: "oklch(0.944 0.012 35)"
  surface-strong: "oklch(0.905 0.020 30)"
  ink: "oklch(0.160 0.015 30)"
  ink-muted: "oklch(0.490 0.020 30)"
  rule: "oklch(0.820 0.018 30)"
  crimson: "oklch(0.464 0.169 26.9)"
  priority-p0: "oklch(0.420 0.180 25)"
  priority-p1: "oklch(0.450 0.140 55)"
  priority-p2: "oklch(0.420 0.120 255)"
  priority-p3: "oklch(0.400 0.025 260)"
typography:
  body:
    fontFamily: "Schibsted Grotesk, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 440
    lineHeight: 1.5
  label:
    fontFamily: "Azeret Mono, ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontWeight: 560
    lineHeight: 1.25
    letterSpacing: "0.035em"
rounded:
  control: "4px"
  task: "6px"
  surface: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "32px"
---

# Design System: BFB Work Map

## Creative direction

The product is a daylight dispatch floor: routes, owners, delays, and handoffs are visible without opening ticket machinery. The metaphor stays structural. The interface never draws fake control hardware or uses terminal cosplay.

The board is one continuous plane. A cross-project Needs Now deck sits above horizontally arranged project lanes. Task detail opens from the right without destroying lane position. Evidence, measurements, and event history remain one level deeper than the current decision.

## Color roles

- Canvas and ink carry daily-use density without card shadows.
- Crimson means a named human gate, P0 blocking priority, focus, or a deliberate primary action. Every red state must explain the consequence in text.
- Each project owns a stable low-chroma tint, swatch, lane header, and full-width 3px task-card top edge.
- Priority owns only the fixed top-right marker and its literal label. It never recolors a project card.
- Selection uses an ink outline and focus ring rather than another semantic color.

## Typography

Use Schibsted Grotesk or the system sans fallback for human language and controls. Use Azeret Mono or `ui-monospace` only for IDs, versions, timestamps, and machine-owned values. Product headings use a fixed compact scale; labels stay readable and avoid wide decorative tracking.

## Components

- Buttons and fields have 4px corners, visible focus, explicit disabled states, and a minimum 44px target.
- Task cards use 6px corners, a neutral keyline, pale project tint, and no ambient shadow.
- The outer board and detail sheet use 8px corners. Only the detail sheet may use a compact directional shadow.
- Project lanes are 300–340px wide with one native horizontal scroll. Lanes never become workflow-state columns or vertical scroll traps.
- Empty states teach the next action and may use one dry line. Permission, credential, destructive, and acceptance copy never jokes.

## Responsive behavior

Three to four lanes are visible on a laptop, two and a half below 1180px, and one lane below 768px with the project jump control retained. Navigation collapses structurally. No essential action depends on hover, drag, or color.

## Motion

Use 150–220ms ease-out transitions only for selection, sheet entry, and committed state feedback. Reordering waits until interaction ends. Reduced motion removes travel and preserves the final state immediately.
