---
name: BFB Work Map
description: A board-first system that shows people, agents, work, handoffs, and attention without ticket theater.
colors:
  canvas: "oklch(0.976 0.005 75)"
  surface: "oklch(0.944 0.012 35)"
  surface-strong: "oklch(0.905 0.020 30)"
  ink: "oklch(0.160 0.015 30)"
  ink-muted: "oklch(0.490 0.020 30)"
  rule: "oklch(0.820 0.018 30)"
  crimson: "oklch(0.464 0.169 26.9)"
  crimson-live: "oklch(0.610 0.195 27)"
  crimson-wash: "oklch(0.930 0.038 27)"
  priority-p0: "oklch(0.420 0.180 25)"
  priority-p1: "oklch(0.450 0.140 55)"
  priority-p2: "oklch(0.420 0.120 255)"
  priority-p3: "oklch(0.400 0.025 260)"
  project-01: "oklch(0.540 0.130 55)"
  project-02: "oklch(0.570 0.105 85)"
  project-03: "oklch(0.500 0.100 125)"
  project-04: "oklch(0.480 0.105 155)"
  project-05: "oklch(0.480 0.075 190)"
  project-06: "oklch(0.500 0.080 220)"
  project-07: "oklch(0.480 0.140 255)"
  project-08: "oklch(0.480 0.150 280)"
  project-09: "oklch(0.500 0.150 310)"
  project-10: "oklch(0.520 0.150 345)"
typography:
  display:
    fontFamily: "Schibsted Grotesk, Arial, sans-serif"
    fontSize: "clamp(3rem, 5.2vw, 4.75rem)"
    fontWeight: 680
    lineHeight: 0.96
    letterSpacing: "-0.03em"
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
  none: "0px"
  control: "4px"
  task: "6px"
  surface: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "32px"
  section: "96px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
  button-attention:
    backgroundColor: "{colors.crimson}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
  board-surface:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "20px"
  task-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.task}"
    padding: "16px"
---

<!-- SEED CANDIDATE -->

# Design System: BFB Work Map

## Overview

**Creative North Star: "The Dispatch Floor"**

The physical scene is a railway dispatch wall seen in daylight: routes, operators, delays, and handoffs visible without opening a ticket. The metaphor stays structural. The interface does not draw tracks, signals, maps, or fake control hardware.

This is the board-first candidate and the clearest product UX baseline. The landing page lets the live board occupy most of the viewport. The product opens with a cross-project Needs Timo deck above project lanes containing stacked task cards. Evidence and the event ledger live in detail.

**Design dials:** variance 8, motion 6, density 8.

**Key characteristics:**

- Warm white, dense ink, stable low-chroma project colors, and a separate task-priority system.
- Project lanes instead of status columns.
- One sentence of live truth above the board.
- Attention grouped by who may resolve it.
- Separate work and waiting measurements with no productivity score.
- Dry copy that exposes a bad abstraction, then gets out of the way.

## Colors

Canvas and ink keep the board readable at daily-use density. Crimson remains the BFB brand and human-attention color. Project identity adds a controlled low-chroma palette, while priority uses a separate semantic marker. Project and priority colors never occupy the same visual position.

### Primary

- **Dispatch Crimson** (`oklch(0.464 0.169 26.9)`): human-required action, selected attention, and primary focus.
- **Live Mark** (`oklch(0.610 0.195 27)`): brief committed-event feedback with ink text.
- **Attention Wash** (`oklch(0.930 0.038 27)`): selected attention background.

### Project Identity

Ten stable project slots cover hues 55 through 345 while skipping the BFB crimson band. Saturated color appears in the lane header, compact swatch, and 3px full-width card top edge. A pale project tint fills the card without competing with its fixed top-right priority marker. The project code and full name are always printed. Dark-mode colors and pale tints are defined in `docs/design/COLOR-SYSTEM.md`.

### Task Priority

- **P0 Blocking** (`oklch(0.420 0.180 25)`): octagonal top-right marker with `! P0`.
- **P1 High** (`oklch(0.450 0.140 55)`): clipped-corner top-right marker with `P1`.
- **P2 Normal** (`oklch(0.420 0.120 255)`): square top-right marker with `P2`.
- **P3 Low** (`oklch(0.400 0.025 260)`): outlined rounded marker with `P3`.

### Neutral

- **Canvas** (`oklch(0.976 0.005 75)`): page and main board.
- **Surface** (`oklch(0.944 0.012 35)`): grouped project and analytics region.
- **Surface Strong** (`oklch(0.905 0.020 30)`): selected request and control surface.
- **Ink** (`oklch(0.160 0.015 30)`): headline, body, and high-emphasis control.
- **Ink Muted** (`oklch(0.490 0.020 30)`): supporting metadata.
- **Rule** (`oklch(0.820 0.018 30)`): structural separation.

**The Explain Every Red Rule.** A red state always names the person, gate, or missed commitment. If the interface cannot explain the red in one sentence, the red is removed.

## Typography

**Display Font:** Schibsted Grotesk with Arial fallback

**Body Font:** Schibsted Grotesk with Arial fallback

**Label/Mono Font:** Azeret Mono with `ui-monospace` fallback

**Character:** Schibsted keeps human and product language plain, compact, and contemporary. Mono appears only for machine-owned facts: checkout, branch, hash, time, tokens, cursor, and event source.

### Hierarchy

- **Display** (680, `clamp(48px, 5.2vw, 76px)`, 0.96): landing proposition, maximum two lines.
- **Headline** (640, `clamp(30px, 3.6vw, 50px)`, 1): major product statement.
- **Title** (600, 18px, 1.25): task, attention, and project title.
- **Body** (440, 16px, 1.5): explanation and human-authored content, maximum 70ch.
- **Label** (560, 11px, 0.035em): machine values and operational categories.

**The Person Reads First Rule.** Actor, project, task, and requested outcome use the body family. IDs and machine values follow. The task must make sense before its hash is read.

## Elevation

The board is one continuous plane containing a top action deck and project lanes. Task cards use flat project-tinted surfaces, a 1px neutral keyline, and a 3px full-width project-color top edge. There are no ambient card shadows. A detail sheet uses one compact directional shadow so it is clearly above the retained board context.

### Shadow Vocabulary

- **Detail Sheet** (`-18px 0 48px oklch(0.16 0.02 30 / 0.16)`): side sheet only.

**The Board Stays Put Rule.** Opening a task keeps the board visible and preserves scroll, filter, and selection state.

## Components

### Buttons

- **Shape:** 4px radius, minimum 44px height.
- **Primary:** ink with canvas text.
- **Attention:** dispatch crimson with canvas text, only for the named next action.
- **Hover / Focus:** surface-strong hover; 2px crimson focus outline with 2px offset.
- **Secondary:** plain underlined text or a 1px ink outline, never another filled peer.

### Cards / Containers

- **Corner Style:** 8px on the outer board and detail sheet, 6px on task cards.
- **Background:** low-chroma project tint for task cards, attention wash for the selected human request.
- **Shadow Strategy:** no shadow on the board.
- **Border:** one 1px neutral keyline plus a 3px full-width project-color top edge. Selection adds an ink outline; priority never becomes the entire border.
- **Internal Padding:** 16px card, 20px lane, 32px detail.

### Inputs / Fields

- **Style:** surface fill, persistent label, 1px transparent border, 4px radius.
- **Focus:** ink border plus crimson outline.
- **Error / Disabled:** explicit reason and icon. Color never carries the state alone.

### Navigation

One 64px row with workspace and project scope, search, live freshness, and person menu. Product routes are Work, Attention, Latest, and Load. The truth strip directly below is one clickable sentence built from committed state.

### Needs Timo Deck

At most three P0 or P1 requests for the current person that are blocking or due sit above every project lane. Each card names the task, current punchline, `Why Timo`, blocking consequence, and safe actions. Order is P0 before P1, then blocking, earliest response target, oldest request, and stable task ID. Delegable work shows `Pass to Codex` or another eligible reviewer. The same task remains anchored in its project lane with `Pinned above` and the same task ID.

### Project Lane

Each 300 to 340px lane is one project. The header uses the stable project color, project name, open task count, agent work, human work, and human-attention total. Cards sort by explicit priority, then attention or behind state, due time, unresolved-attention age, and stable creation time. Lanes scroll horizontally; cards flow vertically with the page.

### Task Card

Cards use a low-chroma project surface tint and 3px full-width project-color top edge. A fixed top-right flag carries priority color, icon, and text. The strongest line after the title is the deterministic one-line `Now` punchline; the `Now` label itself stays neutral. Actor, state, where, next gate, work split, and attention actions follow. No card shows a completion percentage.

### Workload Summary

The top strip shows separate agent work, human work, attention wait, and the project receiving the most human attention. Full ranked analysis remains on Load. Selecting a value filters the lanes and top deck.

### Motion

Committed changes invert once for 140ms, then settle. Moving a card within its project lane uses a 220ms layout transition. Pinning an attention projection into the top deck uses position continuity without suggesting a duplicated task. Opening detail retains board context through a directional sheet. Reduced motion swaps every state immediately and leaves the new committed time visible.

## Do's and Don'ts

### Do:

- **Do** answer who, where, what, truth, next gate, and work split in each card.
- **Do** use project tint and a full-width top edge for project identity, with priority only in the corner flag.
- **Do** state `Why Timo` or `Why delegable` in plain language.
- **Do** keep permission gates human-only even when an agent prepares advice.
- **Do** show an explicit missed commitment before labeling work behind.
- **Do** let one dry line expose ticket theater, such as `Your agents are working. Your tickets are guessing.`
- **Do** keep evidence and the event ledger one click behind the current decision.

### Don't:

- **Don't** reproduce Jira-style density, configurable workflow theater, or enterprise procurement language.
- **Don't** use generic purple AI SaaS, glowing brains, floating prompt boxes, decorative glass, or vague productivity claims.
- **Don't** use terminal cosplay, green-on-black output, matrix rain, or monospace as the main voice.
- **Don't** hide the product behind polite corporate minimalism, soft gray cards, or empty whitespace.
- **Don't** imply autonomous completion, treat a heartbeat as work, or remove human authority without evidence.
- **Don't** use status columns. BFB lanes are projects and task state belongs inside the card.
- **Don't** fill a whole card with priority color, mix project and priority color in one marker, or create rainbow confetti.
- **Don't** use completion percentages, capacity scores, utilization scores, or hours-saved claims.
- **Don't** let a joke enter permission, destructive action, credential, or acceptance copy.
