# BFB UI redesign brief

Draft for direction confirmation, 6 October 2026.

BFB should present a quiet overview and reveal rich detail only when requested.
The proposed first delivery covers the authenticated shell, project board,
pending human decisions, task detail and comments. It preserves existing
business actions and authorization; remote start and agent-to-agent execution
remain outside this lane.

## Direction proposed for confirmation

Use compact project lanes and one focused task panel, with neutral light/dark
surfaces, a single familiar sans-serif family and restrained electric lime/cyan
accents. People checking the board at a desk or on a phone should immediately
recognize what needs them, without reading execution history or configuration.

The board keeps title, state, priority and a short next-action summary. A task
opens through its title; details and commands live behind clear named entry
points. Pending decisions keep the question and essential permission/blocking
context visible, but do not open every answer form by default. Comment history
and the composer appear when requested.

The task-specific scope is production-ready interaction, not a static mock.
Confirm the brief first, then lock the palette and a representative visual
direction before frontend changes. The existing palette approval does not
certify a finished composition or contrast.

## Reference patterns

| Reference | Useful pattern | BFB application |
| --- | --- | --- |
| [Linear display options](https://linear.app/docs/display-options) | Visible properties can be reduced without filtering items out. | Hide repetitive metadata by default; do not hide work merely to make the board look quiet. |
| [Linear preview](https://linear.app/docs/peek) | Details can be inspected without leaving the list or board. | Keep board position and use one focused panel; provide mouse/touch entry rather than a shortcut-only preview. |
| [Linear comments](https://linear.app/docs/comment-on-issues) | One comment entry point and overflow management commands. | A small explicit composer and a quiet comment surface, without inventing automatic progress. |
| [YouTrack issue list](https://www.jetbrains.com/help/youtrack/cloud/issues-list.html) | Compact modes, sidebar previews and a single expanded inline preview. | Borrow density and stable selection, not numerous counters or toolbars. |
| [YouTrack issue detail](https://www.jetbrains.com/help/youtrack/cloud/issue-full-page-view.html) | Secondary commands and relations can be disclosed. | Keep essential warnings visible while secondary properties stay on demand. |
| [Asana navigation](https://help.asana.com/s/article/navigating-asana?language=en_US) | Main work inventory and focused task detail are separate. | Preserve overview context when opening and closing a task. |
| [GitHub board fields](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-board-layout) | Card fields are configurable. | Start with a small deliberate field set rather than permanently displaying every field. |

These applications are design choices for BFB, not claims that the reference
products implement its complete action limit or architecture.

## Disclosure and action budget

| Surface | Visible by default | On demand |
| --- | --- | --- |
| Project task | Title, state/priority, next-action summary; one Open action and at most one secondary entry. | Ownership reasons, events, run details and secondary commands. |
| Pending human decision | Question, blocking/permission distinction and answer state; one Answer/Review action and optional Details. | Answer editor, timestamps, rank explanation and operational provenance. |
| Task panel | Title, current state and next action; one contextual command and a More entry. | Editing, handoff, comments, context, measurements, history and existing review surfaces. |
| Comment | Author and text when conversation is opened; no permanent management toolbar. | Composer, attribution/progress detail and supported secondary commands. |
| Active form or review | Only controls necessary for the explicit action. | Save/Cancel or Accept/Request changes are documented exceptions, not always-visible default toolbars. |

Navigation and close controls are separate from item commands, but must remain
quiet. “More” must have an accessible name and work without hover. Safety and
authorization context must appear before the corresponding decision. Opening a
view never mutates business state or loads executable artifact bytes.

## Current UI findings

Source-derived rendered-control counts, including disabled controls, show
eleven owner Work-shell buttons plus the workspace selector before item
controls. The member shell renders ten buttons and the reviewer shell eight.
With artifact/discussion features disabled, no prior launch and no open timer,
an owner/member ready-task sheet renders nine buttons, a source disclosure and
twelve form fields. Review, proposals and active timers add more. These counts
are not all first-viewport controls; the task sheet eagerly mounts ten
top-level blocks.

Board cards repeat event timestamps, run state and agent availability beneath
their title and next-action text. Attention requests eagerly show answer forms.
Below 900px, account security and sign-out are hidden without an alternate
entry. These are concrete redesign targets; the current role and API contracts
remain the authority.

## Baseline verification

The unchanged `f0f01fc` baseline passes 137 focused unit tests and 61 browser
cases in `pnpm test:w01`. Two browser cases fail and seven following serial
cases do not run. These failures precede frontend changes and are not a new
redesign certificate.

The combined suite exposes shared-fixture dependencies: A04 display fixtures
insert ledger identities that fail the E02 decoder, and earlier passkey
registration leaves the L07 security test without its expected registration
field. E02 remains connected while history is unavailable; test HTTP/socket
origins follow the selected port. Acceptance must resolve or isolate these
fixtures and preserve the related user-facing security behavior rather than
silently skipping the cases.

## Completion checks

The [owning package](work-packages/WP-W03-progressive-disclosure-ui.md) defines
the exact delivery and evidence gate. Acceptance includes default action
counts, complete action discovery, keyboard focus restoration, retained drafts,
stable board position, safe text rendering, role and conflict behavior, light
and dark contrast, narrow/zoomed reflow and honest unavailable states. Static
screenshots alone cannot satisfy it.
