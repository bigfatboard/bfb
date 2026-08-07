# WP-W01 — Authenticated app and Work surface

Status: `planned`

Risk: Medium

## Outcome

An authorized human can navigate an attention-first BFB shell, select an explicit workspace/project, and manage the core task board without any launch or realtime illusion.

## Dependencies

- **Requires:** C02, C03, C04, C08, F03.
- **Unlocks:** A02, A03, A04, E02, V02, V03, W02, X05.
- **Can run with:** local execution packages after APIs stabilize.

## Scope

- Build authenticated routing and explicit `/w/<slug>` workspace resolution.
- Add workspace/project switcher that treats last selection as preference, never authorization.
- Build the Work surface with compact task state, owner, dependencies, latest committed event, and current run summary.
- Add task detail/edit, comments, typed context audiences, proposed-task promotion, project/profile/policy administration, and version-conflict UI.
- Render all task, comment, context, provider, and event-controlled strings as escaped text or through one reviewed allowlisted Markdown renderer with raw HTML disabled. Executable HTML belongs only to V02's isolated artifact origin.
- Invoke action-bound C03 step-up for sensitive policy/privilege changes rather than treating an ordinary authenticated session as fresh proof.
- Establish shared loading/empty/error/forbidden/offline patterns and accessible responsive navigation.
- Leave Attention, Run timeline, Review, runner launch, and Operations as honest placeholders linked to owning packages.
- Add browser tests for role/project visibility and stale-version conflict.

## Non-goals

- Realtime state, runner controls, artifact rendering, notifications, full visual polish, or fabricated sample activity.

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
- Malicious task/comment/context/provider strings cannot create DOM elements, execute script, navigate a privileged frame, or access authenticated APIs through rendering.
- Sensitive policy/privilege actions cannot complete without the action-bound fresh assertion required by the API.

## Evidence and handoff

- Commit browser recordings/screenshots for three roles, hostile-content report, step-up trace, accessibility report, and API fixture coverage.
- Feature packages extend the established surfaces rather than creating parallel navigation shells.

## Risks and decisions

- Keep the board compact. BFB is an attention router, not a configurable Jira clone.
