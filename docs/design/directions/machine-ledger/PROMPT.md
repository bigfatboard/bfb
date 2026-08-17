# Machine Ledger mockup prompt

Built-in ImageGen mode. Taxonomy: `ui-mockup`.

```text
Use case: ui-mockup
Asset type: one above-the-fold desktop landing-page hero for BFB
Primary request: Create one premium horizontal 1536x960 website hero for BFB, an evidence-first control plane for humans coordinating coding agents. Show exactly one website viewport and one section. Do not create a full-page collage, design-system board, browser frame, device frame, or multiple screens.

Scene/backdrop: Machine Ledger. The physical feeling is an audited machine log printed on cool archival stock with one crisp crimson approval mark. Sober, precise, inspectable, and consequential. It must not resemble a spreadsheet, Jira board, terminal, or generic SaaS dashboard.

Style/medium: shippable high-fidelity web UI mockup, straight-on, implementation-ready, not concept art.

Composition/framing: deliberately invert the common SaaS hero. A dense continuous product ledger fills the left two-thirds of the viewport. A concise value proposition occupies the right third. A 68px navigation row spans the top. Keep generous cool-white outer margins around the ledger. The right column is vertically centered and quieter than the operational surface.

Color palette: cool archival white `oklch(0.970 0.006 235)`, pale grouped surface `oklch(0.935 0.009 235)`, graphite `oklch(0.185 0.018 245)`, muted graphite `oklch(0.485 0.018 245)`, faint structural rules `oklch(0.785 0.012 245)`, and one approval crimson anchored at `oklch(0.464 0.169 26.9)`. A pale crimson wash may support the human acceptance gate. No other accent hue.

Typography: contemporary direct grotesk similar to Schibsted Grotesk for headline, body, human names, task title, and actions. Compact Azeret Mono-like face only for event IDs, timestamps, measurements, checkout identity, hashes, versions, and provenance. The right headline is bold, maximum 80px, two lines. Do not make the whole interface monospace.

Product structure: build the left ledger as one continuous information plane, not a set of cards. Organize content through alignment, whitespace, restrained background changes, and only a few meaningful horizontal rules. Do not outline every row. No ambient shadows. Square record regions, 3px controls, and one 6px frame around immutable artifact evidence.

At the top of the ledger, keep run result, execution state, and human acceptance visibly separate. Below it, show one integrated measurement cluster with five aligned values: agent active, human review, elapsed, waiting, and provider-reported tokens. These are records for one run, not promotional statistics. Do not render them as cards, charts, progress bars, or marketing claims.

Below the measurements, show committed event provenance in stable order: action, actor and source, committed time, then identifier or disposition. Include immutable artifact evidence for runner-isolation.mmd version 3. Show that Timo reviewed version 2 and that version 3 superseded that review. Interrupt the lower ledger with one restrained crimson-wash acceptance gate. State that completion is not recorded until a permitted human accepts this exact version.

Text (verbatim):
"BFB"
"PRODUCT"
"ARCHITECTURE"
"SOURCE"
"ENTER BOARD"
"RUN LEDGER"
"Harden runner enrollment"
"Codex / bfb-main@76ab1f9"
"RUN RESULT"
"SUBMITTED"
"EXECUTION"
"ENDED 16:24:08"
"ACCEPTANCE"
"HUMAN REQUIRED"
"AGENT ACTIVE"
"01:42:16"
"HUMAN REVIEW"
"00:08:04"
"ELAPSED"
"03:18:40"
"WAITING"
"01:28:20"
"TOKENS"
"84,210"
"PROVIDER REPORTED"
"COMMITTED EVENTS"
"RESULT SUBMITTED"
"Codex / provider hook"
"Committed 16:24:08"
"ARTIFACT PUBLISHED"
"Codex / local MCP"
"runner-isolation.mmd / version 3"
"ATTENTION REQUESTED"
"Human decision required"
"CHECKOUT VERIFIED"
"BFB daemon / signed runner event"
"bfb-main@76ab1f9"
"IMMUTABLE EVIDENCE"
"runner-isolation.mmd"
"VERSION 3"
"SHA-256 9ef0c1a7b8d2...c41b"
"UNREVIEWED"
"Review of version 2 does not apply."
"TIMO REVIEWED VERSION 2"
"SUPERSEDED BY VERSION 3"
"HUMAN ACCEPTANCE REQUIRED"
"Result submitted by Codex."
"No completion is recorded until a permitted human accepts this version."
"REVIEW EVIDENCE"
"ACCEPT RESULT"
"EVERY CLAIM NEEDS PROOF."
"See who acted, what changed, what it cost, and exactly which human accepted the result."
"INSPECT THE LEDGER"
"VIEW SOURCE"
"Events are committed."
"Reviews bind to versions."
"Completion belongs to people."
"USE IT. FORK IT. OR BUILD YOUR OWN."

Constraints: Keep visible copy spelled exactly. Preserve the inverted two-thirds ledger and one-third statement composition. Human acceptance is the only strong crimson interruption. Make every visible claim carry an actor, source, time, version, quality, or disposition. Honor WCAG AA contrast.

Avoid: spreadsheet grids; Jira columns; ticket cards; floating metric cards; fake KPIs; terminal windows; command output; green-on-black styling; decorative code; purple or blue accents; gradients; glassmorphism; glow; soft shadows; pill controls; sci-fi HUDs; fake charts; progress bars; robot imagery; testimonial faces; vague productivity claims; tiny illegible text; watermarks.
```
