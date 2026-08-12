# WP-W01 API and fixture coverage

Tested commit: `8e19c6e59339e865bda2234246fb94d9ced1e716`

| Boundary | Retained coverage |
| --- | --- |
| Session and workspace selection | Owner, Member, and Reviewer sign in through real fixture sessions, load the authorized workspace list, and resolve the `synthetic` slug to its retained workspace ID. |
| Workspace and project authority | Owner and Member receive Alpha and Beta; the restricted Reviewer receives Alpha only. A guessed workspace slug renders unavailable and sends no board request using that slug. |
| Board projection | The fixture retains one human-blocked P0 task, one proposed root task, and one delegable P1 task with committed latest events and a recorded open run whose measurements remain unknown. |
| Attention and lanes | The current-human deck is projected from C08 results, project lanes remain canonical, and project identity is visually independent from priority. |
| Task mutations | Browser flows create a task, promote a proposal, reproduce and recover from an optimistic-version conflict, and change intended ownership to a permitted human without starting a run. |
| Context audience | Human view includes human-only and agent-visible context; agent preview excludes the human-only item. |
| Project, profile, and policy administration | Owner creates a restricted project and an agent profile, then updates workspace policy through a real virtual user-verifying passkey bound to the exact action and target. |
| Hostile rendering | A script-shaped task title remains text, adds no DOM script node, and does not change the page script count. |
| Accessibility and responsive behavior | Named regions, labels, skip navigation, keyboard task opening, minimum target size, and a 390px viewport with internal lane scrolling are captured in the browser report. |

The browser harness uses an isolated local server and disposable SQLite state. It does not use production or shared state and does not claim realtime presence, agent work, time, tokens, completion, or review without retained records.
