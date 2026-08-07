---
name: BFB Public Notice
description: A controlled public declaration that traditional project software is over.
colors:
  paper: "oklch(0.985 0.005 70)"
  paper-red: "oklch(0.955 0.024 27)"
  ink: "oklch(0.145 0.012 25)"
  ink-muted: "oklch(0.460 0.022 27)"
  rule: "oklch(0.840 0.018 27)"
  crimson: "oklch(0.464 0.169 26.9)"
  crimson-active: "oklch(0.590 0.205 27)"
  crimson-dark: "oklch(0.290 0.110 27)"
typography:
  display:
    fontFamily: "Archivo Black, Arial Black, sans-serif"
    fontSize: "clamp(3.5rem, 7.5vw, 6rem)"
    fontWeight: 400
    lineHeight: 0.9
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Archivo, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 450
    lineHeight: 1.5
  label:
    fontFamily: "Archivo, Arial, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "0.07em"
rounded:
  none: "0px"
  control: "2px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "32px"
  section: "112px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.none}"
    padding: "15px 22px"
  button-primary-hover:
    backgroundColor: "{colors.crimson}"
    textColor: "{colors.paper}"
    rounded: "{rounded.none}"
    padding: "15px 22px"
  notice-surface:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "32px"
---

<!-- SEED CANDIDATE -->

# Design System: BFB Public Notice

## Overview

**Creative North Star: "The Demolition Notice"**

The physical scene is a citywide demolition notice pasted across the glass door of a still-running operations room: municipal black type, one oxblood overprint, and real machine evidence visible beneath it. The voice is confrontational because the product is specific, inspectable, and open source.

This is the clearest expression of the brand stance. The hero behaves like a declaration, while an edge-attached product board prevents the page from collapsing into a poster. That board opens with a cross-project Needs Timo deck above project lanes. The landing page is theme-locked light. A future dark mode swaps paper and ink roles without changing the typography, hard rules, or crimson meaning.

**Design dials:** variance 9, motion 5, density 6.

**Key characteristics:**

- Oversized black type with one decisive crimson overprint.
- A hard 12-column public-information grid.
- Square geometry, uncoated-paper texture, and no atmospheric shadow.
- The real project-lane board attached to the viewport edge rather than framed as a screenshot.
- Defiance stated in plain language, never dressed as punk, hacker, or military cosplay.

## Colors

Paper and ink do nearly all the marketing work. Crimson interrupts the page like a correction, a decision, or a notice that cannot be ignored. Inside the product board, project identity and task priority use the canonical palettes in `docs/design/COLOR-SYSTEM.md` and remain confined to their fixed functional positions.

### Primary

- **Notice Crimson** (`oklch(0.464 0.169 26.9)`): primary action, manifesto overprint, human-needed block, P0 marker, and active navigation.
- **Fresh Overprint** (`oklch(0.590 0.205 27)`): short interaction feedback with ink text.
- **Dried Oxblood** (`oklch(0.290 0.110 27)`): pressed and selected state.

### Neutral

- **Notice Paper** (`oklch(0.985 0.005 70)`): page canvas and primary inverse text.
- **Pink Stock** (`oklch(0.955 0.024 27)`): supporting context region, never a priority signal or generic card fill.
- **Municipal Ink** (`oklch(0.145 0.012 25)`): headline, body, controls, and the attached product board.
- **Faded Ink** (`oklch(0.460 0.022 27)`): supporting copy.
- **Rule** (`oklch(0.840 0.018 27)`): structural separation.

### Product Board Color

- **Project identity:** one stable low-chroma hue per project, used in the lane header, compact swatch, very pale task-card tint, and 3px full-width card top edge.
- **Task priority:** a fixed top-right marker with color, shape, and literal label. P0 is crimson, P1 amber, P2 graphite blue, and P3 muted gray.
- **Current state:** written in municipal ink. The `Now` label stays neutral while its one-line punchline carries the strongest task text after the title.
- **Human attention:** a labeled crimson-tinted region with exact authority or delegation copy, never a generic alert badge.

**The One Overprint Rule.** Crimson may cross the marketing grid once per viewport. Repeating red bands, stamps, and highlights turns urgency into wallpaper. Functional priority and attention markers inside the product board do not count as marketing overprints.

## Typography

**Display Font:** Archivo Black with Arial Black fallback

**Body Font:** Archivo with Arial fallback

**Label Font:** Archivo, 700 weight

**Character:** The pairing is public, direct, and highly legible. The display face acts as a declaration; the wider family handles the product without changing register. Machine identifiers use the system monospace stack only where necessary.

### Hierarchy

- **Display** (400, `clamp(56px, 7.5vw, 96px)`, 0.9): two-line hero declaration.
- **Headline** (700, `clamp(34px, 4vw, 58px)`, 0.98): section propositions.
- **Title** (700, 20px, 1.2): task and attention titles.
- **Body** (450, 16px, 1.5): explanatory copy, maximum 65ch.
- **Label** (700, 11px, 0.07em, uppercase): navigation and functional categories only.

**The Poster Stops at the Product Rule.** Marketing statements may be condensed and loud. Product task names, questions, and evidence remain mixed-case, spacious, and easy to read.

**The Dry Correction Rule.** One line may expose the absurdity of ticket theater with a concrete product truth. It reads like an operator's observation, not a comedian's setup, and never appears inside critical decision copy.

## Elevation

There are no shadows. Depth is conveyed by black and crimson fields meeting the paper, content cropping at a viewport edge, and the visual weight of type. Paper texture is a fixed, almost imperceptible grain layer and never sits on a scrolling container.

**The Ink Has No Glow Rule.** Focus, hover, and live state use fill, outline, weight, and brief inversion. Nothing emits light.

## Components

### Buttons

- **Shape:** square, 0px radius.
- **Primary:** municipal ink with notice-paper text, 15px by 22px padding.
- **Hover / Focus:** notice crimson fill; focus adds a 3px ink outline with 2px offset.
- **Secondary:** underlined text link with a short arrow. It never resembles the primary button.

### Cards / Containers

- **Corner Style:** 0px. Containers and task cards remain square page regions, not floating objects.
- **Background:** paper and municipal ink for major regions, with very pale project tint on task cards.
- **Shadow Strategy:** none.
- **Border:** one neutral 1px rule at a group boundary and a 3px full-width project-color top edge on task cards. Priority remains in the fixed top-right marker.
- **Internal Padding:** 20px compact, 32px standard, 48px large.

### Inputs / Fields

- **Style:** paper fill with a 2px ink bottom rule or full border, selected consistently per surface.
- **Focus:** crimson fill or outline plus a visible label.
- **Error / Disabled:** icon, state word, and explanation. Never color alone.

### Navigation

The landing masthead is bounded by one bottom rule with Docs, Source, and Enter Board at the right. Inside the attached product fixture, one 64px row carries workspace and project scope, Work, Attention, Latest, Load, search, live freshness, and the current person. No pill, locale, weather, build number, or decorative status dot appears.

### Attached Project Board

The product plane consumes at least 38 percent of the first viewport. It is municipal ink with paper text and thin low-contrast rules, attached to the right edge rather than tilted or framed. A cross-project Needs Timo deck sits above horizontally arranged project lanes. At most three blocking-or-due P0 or P1 requests state the exact `Why Timo` or why agent review works.

Each 300 to 340px lane is one project, never a workflow state. Task cards stack vertically and sort deterministically by explicit priority, attention or behind state, due time, unresolved-attention age, and stable creation time. Every card shows a strong one-line neutral-color `Now` punchline, actor, truthful state, next gate, and separate agent and human work.

### Motion

A crimson rule prints downward once over 450ms. Headline lines reveal through a vertical clip. A newly committed event inverts for 150ms and settles. Card reordering waits until focus, hover, or expansion ends. Buttons fill from the left. Reduced motion renders the final composition instantly and replaces transient updates with a visible committed timestamp.

## Do's and Don'ts

### Do:

- **Do** reserve at least 38 percent of the hero for the truthful project-lane board.
- **Do** make the stance legible in five seconds without hiding what BFB does.
- **Do** show the Needs Timo deck above project lanes and preserve lane equals project.
- **Do** keep project color, priority color, and neutral `Now` text in separate positions.
- **Do** use real provider names, sanitized checkout identity, and committed review provenance.
- **Do** use state labels and icons alongside the controlled functional color channels.
- **Do** preserve hard grid logic when the layout stacks on mobile.
- **Do** allow one dry correction such as `The ticket says IN PROGRESS. BFB says Claude needs you.`

### Don't:

- **Don't** reproduce Jira-style density, configurable workflow theater, or enterprise procurement language.
- **Don't** use generic purple AI SaaS, glowing brains, floating prompt boxes, decorative glass, or vague productivity claims.
- **Don't** use terminal cosplay, green-on-black output, matrix rain, or monospace as the main voice.
- **Don't** hide the product behind polite corporate minimalism, soft gray cards, or empty whitespace.
- **Don't** imply autonomous completion, treat a heartbeat as work, or remove human authority without evidence.
- **Don't** use workflow-state columns, a persistent attention rail, or full-card priority color.
- **Don't** promote token provenance, evidence, or the event ledger above current work and attention.
- **Don't** use distressed texture, torn paper, stickers, warning tape, ransom typography, or fake government seals.
- **Don't** repeat the manifesto in every section. One declaration is stronger than six slogans.
