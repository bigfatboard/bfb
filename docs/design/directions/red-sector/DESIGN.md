---
name: BFB Red Sector
description: A broadcast-scale system for directing live human and agent work.
colors:
  red-stage: "oklch(0.464 0.169 26.9)"
  red-live: "oklch(0.620 0.205 27)"
  red-dark: "oklch(0.280 0.105 27)"
  switcher: "oklch(0.130 0.014 27)"
  switcher-high: "oklch(0.205 0.028 27)"
  chalk: "oklch(0.965 0.008 70)"
  chalk-muted: "oklch(0.760 0.020 35)"
  red-rule: "oklch(0.360 0.095 27)"
typography:
  display:
    fontFamily: "Anybody, Arial Black, sans-serif"
    fontSize: "clamp(3.5rem, 7.8vw, 6.5rem)"
    fontWeight: 720
    lineHeight: 0.9
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Onest, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 470
    lineHeight: 1.5
  label:
    fontFamily: "Onest, Arial, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "0.055em"
rounded:
  none: "0px"
  control: "5px"
  stage: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
  section: "120px"
components:
  button-primary:
    backgroundColor: "{colors.switcher}"
    textColor: "{colors.chalk}"
    rounded: "{rounded.control}"
    padding: "15px 22px"
  button-primary-hover:
    backgroundColor: "{colors.chalk}"
    textColor: "{colors.switcher}"
    rounded: "{rounded.control}"
    padding: "15px 22px"
  broadcast-stage:
    backgroundColor: "{colors.switcher}"
    textColor: "{colors.chalk}"
    rounded: "{rounded.stage}"
    padding: "24px"
---

<!-- SEED CANDIDATE -->

# Design System: BFB Red Sector

## Overview

**Creative North Star: "The Live Switcher"**

The physical scene is a live broadcast switcher under red studio lamps: matte black keys, hard cuts, a single program feed, and no ambiguity about what is live. BFB becomes a directing surface, not a place where agents disappear behind task cards.

This is the most visually committed candidate. Crimson is the page environment, not a timid accent. A near-black product stage cuts through it and carries the truthful board: a cross-project Needs Timo deck above horizontal project lanes. The hero is image-as-canvas, with the product occupying the visual center and the headline anchored low. The landing page remains one red-and-black theme throughout.

**Design dials:** variance 9, motion 8, density 5.

**Key characteristics:**

- Crimson owns 45 to 60 percent of each marketing viewport.
- Near-black product stages behave like broadcast program windows.
- Wide variable display type expands and contracts with hierarchy.
- Hard scene cuts and state transitions replace ambient animation.
- A compact Needs Timo deck can interrupt the composition like a live cue without replacing the project lanes.

## Colors

Red is the marketing atmosphere. Black is the work surface. Chalk is the reading layer. Inside the product stage, the canonical project and task-priority colors from `docs/design/COLOR-SYSTEM.md` appear only in fixed operational positions; they never become competing page accents.

### Primary

- **Red Stage** (`oklch(0.464 0.169 26.9)`): dominant page field and brand ownership.
- **Live Red** (`oklch(0.620 0.205 27)`): hover, transient committed-event feedback, and focus with switcher text.
- **Backstage Oxblood** (`oklch(0.280 0.105 27)`): pressed controls and darker tonal zones.

### Neutral

- **Switcher** (`oklch(0.130 0.014 27)`): product stage, primary button, and high-contrast type on red.
- **Switcher High** (`oklch(0.205 0.028 27)`): selected product region and input surface.
- **Chalk** (`oklch(0.965 0.008 70)`): text on switcher and inverse action.
- **Chalk Muted** (`oklch(0.760 0.020 35)`): supporting product copy.
- **Red Rule** (`oklch(0.360 0.095 27)`): structure inside crimson fields.

**The Red Is the Room Rule.** Do not reduce crimson to buttons and badges. If this direction wins, the landing page must visibly belong to red before the logo is read.

### Product Board Color

- **Project identity:** one stable low-chroma hue per project, confined to the lane header, compact swatch, very dark card tint, and 3px full-width task-card top edge.
- **Task priority:** a fixed top-right marker with color, shape, and literal label. P0 is bright crimson, P1 amber, P2 cool graphite blue, and P3 muted gray.
- **Current state:** written in chalk or chalk muted. The neutral `Now` label never borrows the surrounding red environment.
- **Human attention:** a labeled crimson-tinted row or action with an exact authority or delegation reason.

## Typography

**Display Font:** Anybody with Arial Black fallback

**Body Font:** Onest with Arial fallback

**Label Font:** Onest, 700 weight

**Character:** Anybody supplies a wide, physical headline without relying on condensed poster clichés. Onest stays legible in the product and keeps human language warm enough to balance the aggressive field. System mono is permitted only for hashes and branch identifiers.

### Hierarchy

- **Display** (720, `clamp(56px, 7.8vw, 104px)`, 0.9): hero statement, maximum two lines.
- **Headline** (680, `clamp(36px, 4.6vw, 64px)`, 0.96): section statements.
- **Title** (620, 20px, 1.2): task, review, and attention titles.
- **Body** (470, 16px, 1.5): supporting copy, maximum 66ch.
- **Label** (700, 11px, 0.055em, uppercase only for active semantic categories): navigation and state categories.

**The Width Signals Hierarchy Rule.** Variable width may expand a headline or compress a navigation label. It never animates continuously or deforms paragraph text.

## Elevation

The product stage uses one compact, nearly black shadow only where it overlaps the crimson field. Internal regions stay flat and are separated by spacing, tonal change, or a single rule. Nothing floats independently.

### Shadow Vocabulary

- **Stage Cut** (`0 22px 70px oklch(0.12 0.03 27 / 0.32)`): only on the main product stage against red.

**The One Stage Rule.** One object may cast the stage shadow in a viewport. Every nested control remains flat.

## Components

### Buttons

- **Shape:** 5px radius.
- **Primary:** switcher fill with chalk text, 15px by 22px padding.
- **Hover / Focus:** chalk fill with switcher text; focus adds a 3px switcher outline with 2px offset.
- **Secondary:** a plain underlined link. No second filled button competes with the primary.

### Cards / Containers

- **Corner Style:** 10px on the single stage and 5px on interactive controls and task cards.
- **Background:** switcher for the board, with subtle project-tinted switcher surfaces on task cards.
- **Shadow Strategy:** stage cut on one surface only.
- **Border:** neutral low-contrast separators plus a 3px full-width project-color top edge on task cards. Priority stays in the fixed top-right marker.
- **Internal Padding:** 16px compact, 24px standard, 40px large.

### Inputs / Fields

- **Style:** switcher-high fill, persistent chalk-muted label, 1px transparent border.
- **Focus:** chalk border plus a visible focus outline.
- **Error / Disabled:** explicit icon, state word, and reason. The red environment cannot carry error semantics by itself.

### Navigation

The landing masthead sits directly on the red stage with Product, Architecture, Source, and Enter Board on one line. Inside the product fixture, one 64px switcher row carries workspace and project scope, Work, Attention, Latest, Load, search, live freshness, and the current person. Hover inverts text against a small black rectangular field, never a pill.

### Program Board

The central product stage opens with a cross-project Needs Timo deck containing at most three blocking-or-due P0 or P1 requests for the current person. Each request states project, task, a neutral-color `Now` punchline, exact `Why Timo` or delegation reason, and safe actions. The source task remains in its project lane with the same ID and `Pinned above`.

Below it, 300 to 340px project lanes run horizontally and task cards stack vertically. Every lane is one project, never a workflow state. Lane headers show stable project identity and separate agent and human work. Cards sort deterministically by explicit priority, attention or behind state, due time, unresolved-attention age, and stable creation time.

The one-line `Now` punchline is the strongest line after the task title. Actor, truthful state, sanitized checkout, next gate, and work split follow. Provider, activity, human review, and result state remain distinct; a heartbeat never claims work or completion.

### Launch Cue

The Start control names provider, runner, and sanitized checkout before the action. When pressed, the black control becomes chalk for 120ms, then returns with a committed queued or blocked state. No web action pretends that a Mac launched until the durable command is claimed.

### Motion

The headline resolves through one width change over 480ms. The product stage enters with a 560ms hard-edged wipe. Project navigator jumps use a 180ms cut-through-red transition while native lane scrolling remains direct. Committed events invert once, and card reordering waits until focus, hover, or expansion ends. Reduced motion shows the final width and swaps stage content instantly with a committed timestamp.

## Do's and Don'ts

### Do:

- **Do** let crimson own the composition while the product remains the largest detailed object.
- **Do** keep the Needs Timo deck above horizontal project lanes.
- **Do** keep project color, priority color, and neutral `Now` text in separate positions.
- **Do** reveal provider, runner, and checkout before Start.
- **Do** use hard cuts to communicate a changed source or committed state.
- **Do** maintain readable black-on-red and chalk-on-black contrast.

### Don't:

- **Don't** reproduce Jira-style density, configurable workflow theater, or enterprise procurement language.
- **Don't** use generic purple AI SaaS, glowing brains, floating prompt boxes, decorative glass, or vague productivity claims.
- **Don't** use terminal cosplay, green-on-black output, matrix rain, or monospace as the main voice.
- **Don't** hide the product behind polite corporate minimalism, soft gray cards, or empty whitespace.
- **Don't** imply autonomous completion, treat a heartbeat as work, or remove human authority without evidence.
- **Don't** use workflow-state columns, a persistent attention rail, or full-card priority fills.
- **Don't** promote evidence or the event ledger above current work and attention.
- **Don't** turn red into danger styling, warning tape, cyberpunk glow, or a dozen badge colors.
- **Don't** let the page become campaign art with a tiny decorative product screenshot.
