---
name: BFB Machine Ledger
description: A secondary task and run-detail surface where evidence and claims carry provenance.
colors:
  ledger: "oklch(0.970 0.006 235)"
  ledger-low: "oklch(0.935 0.009 235)"
  graphite: "oklch(0.185 0.018 245)"
  graphite-muted: "oklch(0.485 0.018 245)"
  graphite-faint: "oklch(0.785 0.012 245)"
  crimson: "oklch(0.464 0.169 26.9)"
  crimson-active: "oklch(0.600 0.190 27)"
  crimson-wash: "oklch(0.940 0.032 27)"
typography:
  display:
    fontFamily: "Schibsted Grotesk, Arial, sans-serif"
    fontSize: "clamp(2.5rem, 4.4vw, 4rem)"
    fontWeight: 650
    lineHeight: 0.98
    letterSpacing: "-0.03em"
  body:
    fontFamily: "Schibsted Grotesk, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 440
    lineHeight: 1.55
  label:
    fontFamily: "Azeret Mono, ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontWeight: 550
    lineHeight: 1.3
    letterSpacing: "0.035em"
rounded:
  none: "0px"
  control: "3px"
  artifact: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "32px"
  section: "104px"
components:
  button-primary:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.ledger}"
    rounded: "{rounded.control}"
    padding: "14px 20px"
  button-primary-hover:
    backgroundColor: "{colors.crimson}"
    textColor: "{colors.ledger}"
    rounded: "{rounded.control}"
    padding: "14px 20px"
  ledger-surface:
    backgroundColor: "{colors.ledger}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.none}"
    padding: "24px"
---

<!-- SEED CANDIDATE -->

# Design System: BFB Machine Ledger

## Overview

**Creative North Star: "The Audited Machine Log"**

The physical scene is an audited machine log printed on cool archival stock with one crimson approval stamp: every entry has an actor, source, time, and disposition. It feels sober enough to trust and specific enough to reject the friendly gray sameness of normal B2B software.

This is a secondary task and run-detail surface, not the landing page or home board. It makes one architectural idea visible after the board has established current work and attention: event, activity, result, and human decision are separate facts. The ledger follows current truth, attention, and handoff in the detail sheet. Its default mode is light; an alternate product mode uses graphite as canvas and ledger as text without changing the crimson role.

**Design dials:** variance 6, motion 4, density 7.

**Key characteristics:**

- Cool paper and graphite with one oxblood approval channel.
- Rows organized as semantic records, not draggable ticket cards.
- Human and machine typography deliberately separated.
- Dense information with generous outer margins and few containers.
- Motion limited to replay, review, and state transitions.
- No competing home-board summary, project lanes, or landing-page proposition.

## Colors

The neutral field is cool and archival, never beige. Crimson functions like a signed mark: rare, accountable, and tied to consequence.

### Primary

- **Approval Crimson** (`oklch(0.464 0.169 26.9)`): accepted review, human-needed callout, selected action, and focus emphasis.
- **Fresh Mark** (`oklch(0.600 0.190 27)`): hover and brief replay feedback with graphite text.
- **Carbon Copy** (`oklch(0.940 0.032 27)`): low-emphasis attention background.

### Neutral

- **Ledger** (`oklch(0.970 0.006 235)`): page canvas and inverse text.
- **Ledger Low** (`oklch(0.935 0.009 235)`): grouped record background.
- **Graphite** (`oklch(0.185 0.018 245)`): headline, primary text, and button fill.
- **Graphite Muted** (`oklch(0.485 0.018 245)`): supporting text and secondary metadata.
- **Graphite Faint** (`oklch(0.785 0.012 245)`): structural rule.

**The Stamp Must Be Signed Rule.** Crimson never means generic importance. It marks a named human gate, a selected operation, or a committed review with provenance.

## Typography

**Display Font:** Schibsted Grotesk with Arial fallback

**Body Font:** Schibsted Grotesk with Arial fallback

**Label/Mono Font:** Azeret Mono with `ui-monospace` fallback

**Character:** Schibsted is contemporary and direct without looking like a default product template. Azeret Mono makes machine-owned facts scannable, but it never speaks for a person or carries long prose.

### Hierarchy

- **Display** (650, `clamp(40px, 4.4vw, 64px)`, 0.98): artifact or decision headline, maximum two lines.
- **Headline** (620, `clamp(32px, 3.8vw, 52px)`, 1.02): major propositions.
- **Title** (590, 19px, 1.25): task, review, and artifact titles.
- **Body** (440, 16px, 1.55): explanation and human-authored content, maximum 72ch.
- **Label** (550, 11px, 0.035em): event IDs, source, duration, hash, cursor, and provenance quality.

**The Attribution Before Abbreviation Rule.** A reader sees who acted and what happened before seeing the hash, cursor, token count, or provider code.

## Elevation

The system uses no ambient shadows. The live ledger is a continuous plane. Selected records use graphite fill or crimson wash, while opened evidence uses a 6px artifact frame and a tight 1px keyline. Depth is structural, never cosmetic.

**The Record Owns Its Space Rule.** Related facts align in columns or grouped blocks. They are not scattered into metric cards that force the eye to reconstruct one event.

## Components

### Buttons

- **Shape:** 3px radius.
- **Primary:** graphite with ledger text, 14px by 20px padding.
- **Hover / Focus:** approval crimson with ledger text; focus adds a 2px graphite outline with 2px offset.
- **Secondary:** text link with an underline that thickens from 1px to 2px.

### Cards / Containers

- **Corner Style:** none for records, 6px only for artifacts.
- **Background:** ledger or ledger low.
- **Shadow Strategy:** none.
- **Border:** 1px graphite faint between meaningful groups. Long lists use alternating spatial rhythm, not borders on every side.
- **Internal Padding:** 12px record, 20px group, 32px artifact.

### Inputs / Fields

- **Style:** ledger-low fill, persistent label, 1px graphite-faint border, 3px radius.
- **Focus:** graphite border plus crimson focus outline.
- **Error / Disabled:** explicit state word, icon, and reason. Disabled fields retain readable text.

### Navigation

A compact detail header keeps the task title, project, run, revision, and `Back to board` action visible. Detail tabs are Current, Handoff, Evidence, Measurements, and Ledger. Active state uses weight and underline, never a pill or decorative dot.

### Event Ledger

Each record starts with a plain-language action, then actor, source, committed time, and provenance. Human review, process presence, agent activity, token observation, and result submission use distinct row structures. A reconnect replay animates only entries that were actually committed since the last cursor.

### Measurement Cluster

Human review time, agent active time, elapsed process time, waiting, and token usage are separate labeled values. Estimated and unavailable token data are never summed as exact. Numbers use mono; explanations use the body face.

### Motion

Initial records enter in cursor order with a 50ms stagger. Replayed entries briefly receive a crimson-wash background. Opening evidence uses a simple shared-position transition. Reduced motion renders all committed entries immediately and retains the cursor label.

## Do's and Don'ts

### Do:

- **Do** put actor, action, source, time, and provenance in a stable reading order.
- **Do** distinguish activity, process presence, result submission, and human acceptance.
- **Do** show estimated, unavailable, and provider-reported tokens honestly.
- **Do** use outer whitespace to balance dense operational detail.
- **Do** let one named human decision interrupt the ledger with crimson.
- **Do** preserve the originating project lane, task, and run context.

### Don't:

- **Don't** reproduce Jira-style density, configurable workflow theater, or enterprise procurement language.
- **Don't** use generic purple AI SaaS, glowing brains, floating prompt boxes, decorative glass, or vague productivity claims.
- **Don't** use terminal cosplay, green-on-black output, matrix rain, or monospace as the main voice.
- **Don't** hide the product behind polite corporate minimalism, soft gray cards, or empty whitespace.
- **Don't** imply autonomous completion, treat a heartbeat as work, or remove human authority without evidence.
- **Don't** fabricate precise performance scores, perfect token savings, or decorative progress bars.
- **Don't** turn the ledger into a spreadsheet with a rule above and below every row.
- **Don't** promote evidence history above the board's current punchline, attention route, or handoff.
