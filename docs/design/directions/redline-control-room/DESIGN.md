---
name: BFB Redline Control Room
description: Live agent coordination with the pressure and clarity of a darkroom operations desk.
colors:
  blackout: "oklch(0.135 0.014 26)"
  chamber: "oklch(0.185 0.024 27)"
  raised-metal: "oklch(0.235 0.032 27)"
  bone: "oklch(0.945 0.010 72)"
  smoke: "oklch(0.705 0.018 35)"
  crimson: "oklch(0.464 0.169 26.9)"
  crimson-active: "oklch(0.625 0.190 27)"
  hairline: "oklch(0.335 0.040 27)"
typography:
  display:
    fontFamily: "Geologica, Arial Narrow, sans-serif"
    fontSize: "clamp(3.25rem, 6.6vw, 5.75rem)"
    fontWeight: 650
    lineHeight: 0.94
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Geologica, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 430
    lineHeight: 1.5
  label:
    fontFamily: "Azeret Mono, ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.055em"
rounded:
  none: "0px"
  control: "4px"
  panel: "8px"
spacing:
  hairline: "1px"
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
  section: "96px"
components:
  button-primary:
    backgroundColor: "{colors.crimson}"
    textColor: "{colors.bone}"
    rounded: "{rounded.control}"
    padding: "14px 20px"
  button-primary-hover:
    backgroundColor: "{colors.crimson-active}"
    textColor: "{colors.blackout}"
    rounded: "{rounded.control}"
    padding: "14px 20px"
  board-surface:
    backgroundColor: "{colors.chamber}"
    textColor: "{colors.bone}"
    rounded: "{rounded.panel}"
    padding: "24px"
---

<!-- SEED CANDIDATE -->

# Design System: BFB Redline Control Room

## Overview

**Creative North Star: "The Safelight Desk"**

The physical scene is a night operations room under a red photographic safelight: matte black equipment, one active crimson channel, restrained reflections, and enough light to read every control. BFB feels alive because committed state moves through the surface, not because the page pretends to be a terminal.

This is the most product-forward candidate. A large continuous work surface occupies the hero while the value proposition sits above and partly beside it. The surface opens with a cross-project Needs Timo deck above horizontally arranged project lanes. The landing page is theme-locked dark. The product can later gain a light token map, but it must preserve the same hierarchy and crimson role.

**Design dials:** variance 8, motion 7, density 6.

**Key characteristics:**

- Near-black marketing fields with one darkroom-crimson channel; the product board adds restrained project and priority color in fixed positions.
- Wide, slightly mechanical grotesk typography without sci-fi cosplay.
- Continuous operational surfaces separated by space and thin internal rules.
- Motion that reports committed activity, state transition, or user feedback.
- Human attention rendered as a hard gate, never as another notification badge.

## Colors

Blackout and chamber surfaces provide depth. Bone carries primary text. Crimson is scarce enough to mean intervention, P0 blocking priority, active control, or a deliberate action. Inside the product board, project identity and task priority use the canonical palettes in `docs/design/COLOR-SYSTEM.md`; those colors never leak into the marketing frame.

### Primary

- **Darkroom Crimson** (`oklch(0.464 0.169 26.9)`): primary action, attention gate, P0 marker, and focus emphasis.
- **Active Safelight** (`oklch(0.625 0.190 27)`): transient committed-event feedback and hover. It always carries blackout text.

### Product Board Color

- **Project identity:** one stable low-chroma hue per project, confined to the lane header, compact swatch, pale dark-surface tint, and 3px full-width task-card top edge.
- **Task priority:** a fixed top-right marker with color, shape, and literal label. P0 is crimson, P1 amber, P2 graphite blue, and P3 muted gray.
- **Current state:** written in neutral bone or smoke. The `Now` label never becomes a third urgency color.
- **Human attention:** a labeled crimson-tinted row or action, spatially separate from project and priority color.

### Neutral

- **Blackout** (`oklch(0.135 0.014 26)`): page canvas.
- **Chamber** (`oklch(0.185 0.024 27)`): main product surface.
- **Raised Metal** (`oklch(0.235 0.032 27)`): selected or locally elevated controls.
- **Bone** (`oklch(0.945 0.010 72)`): primary copy and high-contrast labels.
- **Smoke** (`oklch(0.705 0.018 35)`): supporting copy and inactive metadata.
- **Hairline** (`oklch(0.335 0.040 27)`): structural dividers only.

**The Red Means Consequence Rule.** Crimson appears only on an action, a P0 marker, an active selection, committed-event feedback, or a human gate. It never decorates an empty corner.

## Typography

**Display Font:** Geologica with Arial Narrow fallback

**Body Font:** Geologica with Arial fallback

**Label/Mono Font:** Azeret Mono with `ui-monospace` fallback

**Character:** Geologica brings controlled width and engineered forms without becoming a fake command line. Mono is limited to identifiers, branches, durations, hashes, token provenance, and machine-owned values.

### Hierarchy

- **Display** (650, `clamp(52px, 6.6vw, 92px)`, 0.94): hero statement, at most two lines.
- **Headline** (620, `clamp(32px, 4vw, 56px)`, 1): page and major surface titles.
- **Title** (580, 20px, 1.2): task, attention, and artifact names.
- **Body** (430, 16px, 1.5): explanatory copy, maximum 68ch.
- **Label** (600, 11px, 0.055em, uppercase only for machine-owned categories): identifiers and provenance.

**The Human Voice Is Sans Rule.** Human questions, decisions, and review notes never use mono. Machine facts may use mono. This difference makes provenance visible before color does.

## Elevation

The system is flat at rest. Depth comes from nested tonal surfaces, occlusion, and local contrast. No ambient card shadows are used. An opened detail sheet may gain a tight black shadow, but a whole dashboard never floats above the page.

**The Surface Is the Room Rule.** Product UI touches or grows from the page grid. It is not displayed inside a laptop frame, glass bubble, or decorative browser window.

## Components

### Buttons

- **Shape:** 4px radius, no pill treatment.
- **Primary:** darkroom crimson with bone text, 14px by 20px padding.
- **Hover / Focus:** active safelight with blackout text; focus adds a 2px bone outline with 2px offset.
- **Secondary:** transparent with a 1px hairline border and bone text.

### Cards / Containers

- **Corner Style:** 8px for the outer product surface and 6px for task cards.
- **Background:** chamber for the board, subtle project-tinted chamber surfaces for task cards, and raised metal for selected controls.
- **Shadow Strategy:** none at rest.
- **Border:** one neutral hairline plus a 3px full-width project-color top edge on task cards. Priority remains in the fixed top-right marker.
- **Internal Padding:** 16px compact, 24px standard, 40px hero product edge.

### Inputs / Fields

- **Style:** raised-metal fill, 1px transparent border, 4px radius.
- **Focus:** crimson border plus bone outline. Labels stay visible above the value.
- **Error / Disabled:** explicit icon and text label. Color alone is never the state.

### Navigation

The landing masthead keeps Product, Architecture, GitHub, and Get BFB on one line. Inside the product fixture, one 64px row carries workspace and project scope, Work, Attention, Latest, Load, search, live freshness, and the current person. Active items use weight and a short crimson rule, not a decorative dot.

### Needs Timo Deck

At most three P0 or P1 requests for the current person that are blocking or due sit above the project lanes. Each card states the project, task, neutral `Now` punchline, exact `Why Timo` or delegation reason, and safe actions. The source task remains in its lane with the same ID and `Pinned above`.

### Project Lanes

Each 300 to 340px lane represents one project, never a workflow state. Lanes run horizontally and task cards stack vertically. Lane headers carry stable project identity plus separate agent work and human work. Cards sort deterministically by explicit priority, attention or behind state, due time, unresolved-attention age, and stable creation time.

### Task Card

The strongest line after the title is one neutral-color `Now` punchline derived from committed semantic state. Actor, truthful activity, sanitized checkout, next gate, and separate agent and human work follow. A process being alive is not working, and an ended process is not done.

### Motion

The initial product surface resolves from blackout to chamber in a 500ms exposure. New committed events flash active safelight for 150ms, then settle. Human gates remain still and high-contrast. Task reordering waits until focus, hover, or expansion ends. Reduced motion removes exposure and travel while preserving every final state and committed timestamp.

## Do's and Don'ts

### Do:

- **Do** make the attention gate the strongest semantic interruption on the page.
- **Do** place the Needs Timo deck above project lanes and keep every lane tied to one project.
- **Do** keep project color, priority color, and neutral `Now` text in their fixed positions.
- **Do** show exact, sanitized checkout identity and real provider names.
- **Do** separate human minutes, agent active time, elapsed time, waiting, and token provenance.
- **Do** use text, icon, and structure with color for every state.
- **Do** keep the hero headline to two lines and supporting copy below 20 words.

### Don't:

- **Don't** reproduce Jira-style density, configurable workflow theater, or enterprise procurement language.
- **Don't** use generic purple AI SaaS, glowing brains, floating prompt boxes, decorative glass, or vague productivity claims.
- **Don't** use terminal cosplay, green-on-black output, matrix rain, or monospace as the main voice.
- **Don't** hide the product behind polite corporate minimalism, soft gray cards, or empty whitespace.
- **Don't** imply autonomous completion, treat a heartbeat as work, or remove human authority without evidence.
- **Don't** use workflow-state columns, a persistent attention rail, or a full-card priority fill.
- **Don't** promote evidence or the event ledger above the current work and attention view.
- **Don't** use gradient text, neon outer glows, robot imagery, fake metrics, pill clusters, or three equal feature cards.
