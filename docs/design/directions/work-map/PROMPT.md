# Work Map project-lane board prompt

Built-in ImageGen mode. Taxonomy: `ui-mockup`.

```text
Use case: ui-mockup
Asset type: full desktop product screen for the BFB home board
Primary request: Create one polished horizontal 1600x1000 desktop product UI mockup for BFB. Show exactly one full application viewport, straight-on, with no browser chrome, device frame, perspective, or presentation frame. This is the daily home board for three humans coordinating five coding agents across ten projects.

Core information architecture: this is Kanban-like only in the physical stacking of task cards. Columns are projects, never workflow states. Put a cross-project stack of high-priority tasks waiting for Timo at the top. Below it, show horizontally arranged project lanes. Each project lane contains vertically stacked task cards.

Style/medium: shippable high-fidelity web application UI, implementation-ready, not a marketing page and not concept art.

Composition:
- 64px global header.
- 48px compact workload and truth strip.
- 220px cross-project NEEDS TIMO NOW deck with three cards side by side.
- 42px project navigator with ten stable project-color swatches and names.
- Project-lane board filling the rest of the viewport. Show three complete 320px lanes, most of a fourth, and the edge of a fifth so horizontal continuation is obvious.
- Lanes flow horizontally. Task cards stack vertically. No status columns.

Color architecture has two independent channels:

1. PROJECT IDENTITY. Each lane owns one stable low-chroma hue. Use that hue as a strong but tasteful lane-header block, a compact project swatch, a very pale task-card surface tint, and a 3px full-width top edge on every task card. Use visibly different colors for BFB CORE, BFB MAC, BFB CLOUD, ARTIFACTS, and OAUTH. Project text remains explicit, so color is redundant. Do not use a thick colored left or right card stripe.

2. TASK PRIORITY. Priority occupies only the top-right corner flag of each task card and includes color, icon shape, and exact text. Use deep crimson for P0 BLOCKING, amber for P1 HIGH, graphite-blue for P2 NORMAL, and muted gray for P3 LOW. Never fill the whole card with priority color. Never use project color in the priority flag.

Use warm off-white page canvas, dark ink, 6px task-card radii, 8px outer surfaces, 1px neutral keylines, and almost no shadow. Selected attention may use a pale crimson wash. Use Schibsted Grotesk-like humanist sans throughout and compact mono only for time, checkout, branch, hash, and measured values.

Header text:
"BFB"
"TENIRA"
"ALL PROJECTS"
"WORK"
"ATTENTION"
"LATEST"
"LOAD"
"SEARCH"
"LIVE / 8S AGO"
"TIMO"

Truth and workload strip, one continuous line with separators, not KPI cards:
"5 agents active"
"2 need Timo"
"1 checkpoint behind"
"Agent work 21h18"
"Human work 4h06"
"Most human attention: BFB Mac 1h24"

Top deck heading:
"NEEDS TIMO NOW / 3"
"High-priority work blocked on you. No pressure."
Use the second sentence as the one dry joke. Keep all critical card copy serious and exact.

Top attention card 1:
Project surface and label: "BFB MAC"
Priority flag: "P0 BLOCKING"
Title: "Approve runner wake"
Punchline label: "NOW"
Punchline: "Claude is blocked on your runner approval."
"WHY TIMO"
"You own this runner."
"Waiting 22m / blocks launch"
Actions: "REVIEW" and "APPROVE"

Top attention card 2:
Project surface and label: "BFB CORE"
Priority flag: "P1 HIGH"
Title: "Choose review policy"
Punchline label: "NOW"
Punchline: "Codex can prepare the comparison. You own the product decision."
"HUMAN DECISION / AGENT CAN PREPARE"
Actions: "PASS TO CODEX" and "DECIDE NOW"

Top attention card 3:
Project surface and label: "BFB CLOUD"
Priority flag: "P1 HIGH"
Title: "Review reconnect plan"
Punchline label: "NOW"
Punchline: "Grok can review the event gaps. No human permission is required."
"AGENT REVIEW WORKS"
Actions: "PASS TO GROK" and "KEEP IT"

Project navigator labels:
"ALL"
"BFB CORE"
"BFB MAC"
"BFB CLOUD"
"ARTIFACTS"
"OAUTH"
"CLI"
"MCP"
"GITHUB"
"OPERATIONS"
"SELF-HOST"

Lane 1 header:
"BFB CORE"
"4 tasks / Agent 4h32 / Human 52m"

Task card:
"P1 HIGH"
"Route review to another agent"
"NOW"
"Claude is waiting for your product choice."
"CLAUDE / WAITING 22M"
"Agent 1h05 / Human 12m"
"PINNED ABOVE"

Task card:
"P2 NORMAL"
"Context versioning"
"NOW"
"Codex is validating context hashes."
"CODEX / WORKING / 18S AGO"
"Agent 48m / Human 6m"

Lane 2 header:
"BFB MAC"
"5 tasks / Agent 6h12 / Human 1h24"

Task card:
"P0 BLOCKING"
"Approve runner wake"
"NOW"
"Claude is blocked on your runner approval."
"CLAUDE / WAITING 22M"
"PINNED ABOVE"

Task card:
"P1 HIGH"
"Block launch when checkout is occupied"
"NOW"
"Codex is running checkout lease tests. Next: Claude review."
"CODEX / WORKING / 34S AGO"
"Mac Studio / main@4f7c1e2"
"Agent 42m / Human 4m"

Task card:
"P2 NORMAL"
"Runner enrollment policy"
"NOW"
"Review is ready for another agent."
"GROK / SUBMITTED"
"PASS TO CLAUDE"

Lane 3 header:
"BFB CLOUD"
"3 tasks / Agent 3h48 / Human 31m"

Task card:
"P1 HIGH"
"Replay live events after reconnect"
"NOW"
"Checkpoint missed by 18m. Grok is still working."
"GROK / WORKING / 18S AGO"
"CHECKPOINT BEHIND 18M"
"Agent 1h12 / Human 8m"

Task card:
"P2 NORMAL"
"Browser high-water replay"
"NOW"
"Claude Review is checking event gaps."
"CLAUDE REVIEW / REVIEWING"
"Agent 24m / Human 0m"

Lane 4 header:
"ARTIFACTS"
"3 tasks / Agent 2h06 / Human 44m"

Task card:
"P1 HIGH"
"Review Mermaid sandbox"
"NOW"
"Codex can review artifact v3."
"AGENT REVIEW WORKS"
"PASS TO CODEX"

Task card:
"P3 LOW"
"Image preview sizing"
"NOW"
"No active work or commitment."
"UNASSIGNED"

Card requirements:
- Every card carries its explicit project name or code in addition to the lane position and project color.
- Every NOW label and clock icon uses neutral ink or muted gray, never red or another urgency color.
- The one-line NOW punchline is visually stronger than metadata.
- Every card shows project, priority, task, current truth, actor or assignee, and relevant work split.
- Human-needed cards state WHY TIMO or why agent review works.
- Working, waiting, submitted, process alive, and behind use text plus icons or shapes. Color alone is never the state.
- A top-deck task may reappear in its project lane only with the same title and a clear PINNED ABOVE marker. It must not look like a second task.
- Top-deck order is P0 before P1, then blocking, earliest response target, oldest request, and stable task ID.
- Lane-card order is P0, P1, P2, then P3; within each priority use waiting on human, behind, working or reviewing, ready, queued, then idle, followed by due time and stable creation time.

Constraints: Keep primary text legible and spelled accurately. Preserve project lanes and stacked task cards. Preserve project tint, full-width top edge, and priority flag as separate visual channels. Keep evidence and the event ledger out of the first viewport. Do not show completion percentages, capacity scores, utilization, or tokens. Honor WCAG AA contrast.

Avoid: workflow-state columns; To Do / Doing / Done lanes; Jira styling; Trello clone styling; rainbow card fills; full-card priority colors; mixing project and priority into one badge; thick colored left or right card stripes; floating dashboard tiles; fake KPIs; progress bars; terminal windows; green-on-black styling; purple AI glow; gradients; glass; neon; robots; pill clusters; tiny illegible text; watermarks.
```
