# WP-W01 — Authenticated app and Work surface

Status: `done`

Risk: Medium

Test target: `pnpm test:w01`

Evidence manifest: `docs/work-packages/evidence/WP-W01/manifest.json`

## Outcome

An authorized human can navigate an attention-first BFB shell, select an explicit workspace/project, and manage the core task board without any launch or realtime illusion.

## Dependencies

- **Requires:** C02, C03, C04, C08, F03.
- **Unlocks:** A02, A03, A04, D03, E02, V02, V03, W02, X05.
- **Can run with:** local execution packages after APIs stabilize.

## Scope

- Build authenticated routing and explicit `/w/<slug>` workspace resolution.
- Add workspace/project switcher that treats last selection as preference, never authorization.
- Build the Work surface as horizontally scrolling project lanes, never status columns. Cards use stable project tint/swatch/full-width 3px top edge, an independent fixed priority marker, compact task state/owner/dependencies, latest committed event, and current run summary.
- Add a cross-project `Needs <current human> Now` deck of at most three canonical C08 projection results, ordered deterministically. Each projected card links to the same task in its project lane.
- Give each card one neutral `NOW` label and a strong one-line punchline derived from committed semantic state. Show the persisted next-action reason as `Why <human>` or `Why delegable`.
- Let an authorized human hand a task to a policy-allowed agent profile or another human without claiming a run started. Keep project color, priority color, state, and ownership as separate visual channels.
- Add task detail/edit, comments, typed context audiences, proposed-task promotion, project/profile/policy administration, and version-conflict UI.
- Render all task, comment, context, provider, and event-controlled strings as escaped text or through one reviewed allowlisted Markdown renderer with raw HTML disabled. Executable HTML belongs only to V02's isolated artifact origin.
- Invoke action-bound C03 step-up for sensitive policy/privilege changes rather than treating an ordinary authenticated session as fresh proof.
- Establish shared loading/empty/error/forbidden/offline patterns and accessible responsive navigation.
- Leave Attention, Run timeline, Review, runner launch, and Operations as honest placeholders linked to owning packages.
- Add browser tests for role/project visibility and stale-version conflict.

## Non-goals

- Realtime state, runner controls, artifact rendering, notifications, full visual polish, or fabricated sample activity.


## Contracts

### Consumes

- C02/C03/C04/C08/F03 authenticated APIs and projections.

### Produces

- Authenticated Work surface with project lanes and Needs Now deck.
- Stable test target `pnpm test:w01` and evidence path `docs/work-packages/evidence/WP-W01/manifest.json`.

## Work plan

1. Implement auth/workspace shell and permission-aware routing.
2. Implement project/task/context/comment/profile/policy screens.
3. Add optimistic version handling, safe-content rendering, step-up handoff, and accessible states.
4. Run multi-role browser tests against IC-1 fixtures.

## Acceptance

- Owner, Member, and Reviewer see only permitted navigation/actions/projects.
- Changing URL IDs cannot cross workspace/project boundaries.
- Stale edits produce a recoverable conflict instead of lost updates.
- Human-only context never renders in an agent-view preview.
- Proposed agent root tasks are visibly distinct and require promotion.
- UI never labels a task live/working without committed state.
- Project-lane and attention-deck ordering is deterministic; the attention deck contains only the current human's eligible C08 projection and never duplicates canonical task state.
- Project identity uses a full-width top edge/tint/swatch and no side stripe; priority remains visually independent.
- Handoff changes intended ownership only. The UI does not claim agent activity, time, tokens, or completion until later records provide it.
- Malicious task/comment/context/provider strings cannot create DOM elements, execute script, navigate a privileged frame, or access authenticated APIs through rendering.
- Sensitive policy/privilege actions cannot complete without the action-bound fresh assertion required by the API.

## Evidence and handoff

- Commit browser recordings/screenshots for three roles, hostile-content report, step-up trace, accessibility report, and API fixture coverage.
- Feature packages extend the established surfaces rather than creating parallel navigation shells.

## Risks and decisions

- Keep the board compact. BFB is an attention router, not a configurable Jira clone.
