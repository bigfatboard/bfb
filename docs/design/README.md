# BFB visual direction study

This study compares four landing-page directions against one product position, one crimson brand anchor, and one realistic product scenario. The goal is to choose a visual operating system, not pick the prettiest isolated screenshot.

The canonical product context lives in `PRODUCT.md`. No root `DESIGN.md` exists yet because choosing one before comparing the candidates would turn a hypothesis into a rule. Once a direction is selected, its candidate system becomes the basis for the root design system and implementation tokens.

## Shared position

**Product category:** provider-neutral coordination for humans and coding agents.

**Primary promise:** see who is working where, what needs you now, and what another agent can review.

**Brand stance:** Traditional project software is over. Use BFB. Fork it. Or build your own.

The literal profanity behind that stance is attitude, not headline filler. The public voice stays controlled enough to earn trust with local execution, human authority, immutable evidence, and honest measurement.

## Shared brand seed

- Anchor hue: `oklch(0.464 0.169 26.9)`, a darkroom crimson derived from Impeccable's `seed-024` palette.
- Color rule: crimson is the shared brand and human-attention anchor. The product board adds stable project colors and fixed task-priority markers in separate positions; status still uses words, icons, weight, and structure.
- Accessibility: WCAG 2.2 AA minimum, AAA target for body copy, visible keyboard focus, no state conveyed by color alone, and a reduced-motion equivalent for every moving element.
- Product truth: the mockup may show live activity, but it cannot infer completion from a process exit, socket, terminal, or heartbeat.
- Imagery rule: the product itself is the visual. No robot, glowing brain, prompt cloud, fake terminal, abstract AI orb, or decorative dashboard mosaic.

## The four candidates

| Direction | Current hero | Physical read | Theme | Dials (variance / motion / density) | Best quality | Main risk |
| --- | --- | --- | --- | --- | --- | --- |
| [Redline Control Room](directions/redline-control-room/DESIGN.md) | [View](directions/redline-control-room/landing-project-board-v2.png) | A night operations room under a red photographic safelight | Dark | 8 / 7 / 6 | Makes live coordination feel immediate and consequential | Can become terminal cosplay if red is used as decoration |
| [Public Notice](directions/public-notice/DESIGN.md) | [View](directions/public-notice/landing-project-board.png) | A demolition notice pasted across an active operations room | Light | 9 / 5 / 6 | Expresses the anti-system stance most clearly | The poster can overpower the actual product |
| [Work Map](directions/work-map/DESIGN.md) | [View](directions/work-map/landing-project-board.png) | A daylight dispatch floor with visible people, agents, delays, and handoffs | Light | 8 / 6 / 8 | Makes the board hierarchy and attention routing easiest to judge | Can look ordinary if project lanes lose typographic character |
| [Red Sector](directions/red-sector/DESIGN.md) | [View](directions/red-sector/landing-project-board.png) | A live broadcast switcher under red studio lamps | Crimson | 9 / 8 / 5 | Feels unlike conventional developer SaaS without hiding the product | Can become campaign art if the board loses visual priority |

The [canonical product board](directions/work-map/project-board-v2.png) is shared across all four hero studies. The surrounding brand register changes; the product hierarchy does not.

## Secondary surface study

[Machine Ledger](directions/machine-ledger/DESIGN.md) remains useful for task and run detail. It is no longer a landing or home-board candidate. Provenance, separate measurements, immutable versions, and acceptance belong there after the board has answered who is working, what needs a person, and what can be passed on.

## Comparison rules

Judge each mockup on the same six questions:

1. Can a new visitor explain BFB in one sentence after five seconds?
2. Is the product visibly agent-native without generic AI imagery?
3. Is human authority more visible than automation theater?
4. Does the direction scale from landing page to a dense daily work surface?
5. Could only BFB credibly own this visual language?
6. Does the first viewport make `Why me?` and `Can an agent review this?` obvious?

The chosen direction should survive all six. A hybrid is allowed only after one system wins. Combining the strongest detail from every candidate before choosing would erase the point of the exercise.

## Type sources

The candidate display families are real open-source families available through Google Fonts:

- [Geologica](https://fonts.google.com/specimen/Geologica)
- [Archivo Black](https://fonts.google.com/specimen/Archivo+Black)
- [Schibsted Grotesk](https://fonts.google.com/specimen/Schibsted+Grotesk)
- [Anybody](https://fonts.google.com/specimen/Anybody)

Final font delivery, self-hosting, subsetting, and license files belong to implementation after the direction is chosen.
