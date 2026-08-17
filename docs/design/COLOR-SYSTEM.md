# BFB board color system

The board has two color channels and three neutral state layers:

- Project identity lives in the lane header, project swatch, pale card tint, and 3px full-width card top edge.
- Task priority lives in a fixed top-right marker.
- Human attention lives in a labeled full-width row inside the card.
- Behind lives in a neutral footer with the missed commitment.
- Selection and keyboard focus live outside the card.

No layer may recolor another layer.

## Base tokens

```css
:root {
  --board-bg: oklch(0.985 0.004 70);
  --card-bg: oklch(0.995 0.002 70);
  --card-border: oklch(0.840 0.012 27);
  --text: oklch(0.145 0.012 25);
  --text-muted: oklch(0.420 0.018 27);
  --brand-crimson: oklch(0.464 0.169 26.9);
}

[data-theme="dark"] {
  --board-bg: oklch(0.130 0.014 27);
  --card-bg: oklch(0.170 0.014 27);
  --card-border: oklch(0.340 0.018 27);
  --text: oklch(0.965 0.008 70);
  --text-muted: oklch(0.730 0.018 35);
  --brand-crimson: oklch(0.750 0.170 27);
}
```

## Project identity

Each project stores a stable `project_color_slot` from 1 to 10. Auto-assignment uses the first unused slot. Lane order, project name, task state, and theme never change the slot.

The palette skips the 15 to 40 degree crimson band so BFB attention remains distinct.

### Light mode

```css
--project-01-edge: oklch(0.540 0.130 55);
--project-01-tint: oklch(0.965 0.018 55);

--project-02-edge: oklch(0.570 0.105 85);
--project-02-tint: oklch(0.965 0.018 85);

--project-03-edge: oklch(0.500 0.100 125);
--project-03-tint: oklch(0.965 0.018 125);

--project-04-edge: oklch(0.480 0.105 155);
--project-04-tint: oklch(0.965 0.018 155);

--project-05-edge: oklch(0.480 0.075 190);
--project-05-tint: oklch(0.965 0.018 190);

--project-06-edge: oklch(0.500 0.080 220);
--project-06-tint: oklch(0.965 0.018 220);

--project-07-edge: oklch(0.480 0.140 255);
--project-07-tint: oklch(0.965 0.018 255);

--project-08-edge: oklch(0.480 0.150 280);
--project-08-tint: oklch(0.965 0.018 280);

--project-09-edge: oklch(0.500 0.150 310);
--project-09-tint: oklch(0.965 0.018 310);

--project-10-edge: oklch(0.520 0.150 345);
--project-10-tint: oklch(0.965 0.018 345);
```

### Dark mode

```css
--project-01-edge: oklch(0.730 0.130 55);
--project-01-tint: oklch(0.205 0.024 55);

--project-02-edge: oklch(0.760 0.120 85);
--project-02-tint: oklch(0.205 0.024 85);

--project-03-edge: oklch(0.720 0.120 125);
--project-03-tint: oklch(0.205 0.024 125);

--project-04-edge: oklch(0.720 0.120 155);
--project-04-tint: oklch(0.205 0.024 155);

--project-05-edge: oklch(0.720 0.100 190);
--project-05-tint: oklch(0.205 0.024 190);

--project-06-edge: oklch(0.740 0.100 220);
--project-06-tint: oklch(0.205 0.024 220);

--project-07-edge: oklch(0.720 0.140 255);
--project-07-tint: oklch(0.205 0.024 255);

--project-08-edge: oklch(0.720 0.140 280);
--project-08-tint: oklch(0.205 0.024 280);

--project-09-edge: oklch(0.730 0.140 310);
--project-09-tint: oklch(0.205 0.024 310);

--project-10-edge: oklch(0.740 0.150 345);
--project-10-tint: oklch(0.205 0.024 345);
```

Saturated project color occupies only the lane rule, 3px full-width card top edge, and one compact swatch. A very pale project tint may fill the card, but it must remain visually quieter than the priority marker and attention row. The project code and full name are always present.

## Task priority

Priority is explicit task data. It never inherits the project hue and is never inferred from wait time, tokens, provider, or model output.

### Light mode

```css
--priority-p0-bg: oklch(0.420 0.180 25);
--priority-p0-fg: oklch(0.985 0.005 70);

--priority-p1-bg: oklch(0.450 0.140 55);
--priority-p1-fg: oklch(0.985 0.005 70);

--priority-p2-bg: oklch(0.420 0.120 255);
--priority-p2-fg: oklch(0.985 0.005 70);

--priority-p3-bg: oklch(0.400 0.025 260);
--priority-p3-fg: oklch(0.985 0.005 70);
```

### Dark mode

```css
--priority-p0-bg: oklch(0.720 0.160 25);
--priority-p0-fg: oklch(0.145 0.012 25);

--priority-p1-bg: oklch(0.780 0.140 70);
--priority-p1-fg: oklch(0.145 0.012 25);

--priority-p2-bg: oklch(0.720 0.120 255);
--priority-p2-fg: oklch(0.145 0.012 25);

--priority-p3-bg: oklch(0.680 0.030 260);
--priority-p3-fg: oklch(0.145 0.012 25);
```

| Priority | Label | Shape |
| --- | --- | --- |
| P0 | `P0 BLOCKING` | octagonal marker with exclamation icon |
| P1 | `P1 HIGH` | clipped-corner marker |
| P2 | `P2 NORMAL` | square marker |
| P3 | `P3 LOW` | rounded outline marker |

Accessible names expand the shorthand, for example `Priority 0, blocking`.

## Card layers

```text
  outer keyboard-focus ring
┌════════ project-color top edge ═══════════════════════┐
│ Project swatch  Task title                [! P0]      │
│                 NOW punchline                          │
│                                                       │
│ HUMAN REQUIRED / Approve runner access                │
│                                                       │
│ Agent 1h42 / Human 8m / Waiting 42m                   │
│ ----------------------------------------------------  │
│ BEHIND 18M / Review handoff was due at 15:24          │
└────────────────────────────────────────────────────────┘
```

Layer order:

1. keyboard focus outside the card;
2. neutral selection outline inside the boundary;
3. project-color top edge and compact swatch;
4. priority marker at the top right;
5. labeled attention row below the current truth;
6. neutral behind footer at the bottom.

### Selection

```css
--selected-bg: oklch(0.965 0.008 27);
--selected-outline: oklch(0.220 0.015 27);

--selected-bg-dark: oklch(0.220 0.020 27);
--selected-outline-dark: oklch(0.900 0.012 70);
```

Selection adds a 2px inner outline and checked control. Project and priority remain unchanged.

### Human attention

```css
--attention-bg: oklch(0.950 0.035 27);
--attention-fg: oklch(0.350 0.140 27);
--attention-rule: oklch(0.464 0.169 26.9);

--attention-bg-dark: oklch(0.235 0.055 27);
--attention-fg-dark: oklch(0.820 0.100 27);
--attention-rule-dark: oklch(0.750 0.170 27);
```

The row always contains actor and action text:

```text
HUMAN REQUIRED / Approve runner access
AGENT REVIEW WORKS / Check artifact v4
```

### Behind

Behind is a missed explicit commitment, not a priority. It uses a neutral footer, dashed top rule, divergence icon, and exact reason.

```css
--behind-bg: oklch(0.955 0.010 80);
--behind-fg: oklch(0.320 0.020 70);
--behind-rule: oklch(0.600 0.020 70);

--behind-bg-dark: oklch(0.220 0.012 70);
--behind-fg-dark: oklch(0.780 0.015 70);
--behind-rule-dark: oklch(0.450 0.020 70);
```

### Keyboard focus

```css
--focus-ring: oklch(0.464 0.169 26.9);
--focus-gap: oklch(0.985 0.004 70);

--focus-ring-dark: oklch(0.750 0.170 27);
--focus-gap-dark: oklch(0.130 0.014 27);
```

Use a 3px ring with 3px offset and a 2px gap. Under forced colors, use `Highlight`.

## Guardrails

- Project color never means state, success, warning, failure, or priority.
- Priority color never appears in lane headers or project-color top edges.
- Providers, agents, avatars, task states, tokens, and metrics get no additional color families.
- Body text always uses neutral text tokens.
- Every priority marker contains its literal priority label.
- Every semantic state has an icon and explicit text.
- Focus, selection, sorting, and filtering never depend on perceived hue.
- No gradients, colored shadows, glow, rainbow borders, or hue animation.
- If a workspace has more than 10 projects, reuse slots only with visible project codes and avoid adjacent duplicate slots.
