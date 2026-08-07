# WP-A03 — Result submission and acceptance

Status: `planned`

Risk: High

## Outcome

An agent explicitly submits an immutable result with evidence and limitations; a human accepts it or requests changes without conflating provider/process end with task completion.

## Dependencies

- **Requires:** A01, C08, E01, W01.
- **Unlocks:** A04, P01, P02, V03, X01, X02, X03, X04.
- **Can run with:** A02 once shared run/task transitions are sequenced.

## Scope

- Add immutable result submissions binding summary, bounded typed evidence references, limitations, Git facts, config snapshot/hash, and timestamp.
- Add MCP/CLI/API submission through `bfb_submit_result`/`run submit` with idempotency.
- Implement run result transitions: open, submitted, changes requested, accepted, failed, cancelled.
- Move task active → review on submission, review → active on changes, review → done only on permitted human acceptance.
- Mark a submission outdated when bound Git/config facts or a generic evidence-reference version changes; never rewrite history.
- Revoke run-scoped agent write capability on acceptance while retaining checkout lock until verified process end.
- Permit only documented unambiguous headless-success submission; interactive Stop/exit never qualifies.
- Build result/review state on task/run UI without artifact rendering yet.

## Non-goals

- Automatic merge/deploy, self-acceptance, approval inheritance, or terminal prose scraping for success.
- Validating artifact-version references or deriving artifact-driven outdated state; V01/V03 own that extension once artifact identities exist.

## Work plan

1. Add submission/evidence migrations and transition invariants.
2. Implement scoped submit and human changes/accept actions.
3. Implement outdated detection and capability revocation.
4. Test duplicate/stale evidence, interactive exit, headless rule, revocation race, and changes cycle.

## Acceptance

- Stop, tool failure, terminal close, session end, and process exit never submit/accept a result.
- Agent cannot accept its result; Reviewer/Member/Owner behavior matches policy.
- Changes requested reopens the same run and later submission creates a new immutable version.
- Later repository/config or generic evidence-reference change marks the prior submission outdated without mutation.
- Acceptance revokes agent writes but does not release a live checkout lock.
- Idempotent retries create one submission.

## Evidence and handoff

- Commit transition matrix, malicious/duplicate fixtures, capability-revocation trace, and UI state snapshots.
- V01/V03 extend the generic evidence-reference contract with immutable artifact-version validation and artifact-driven outdated state.

## Risks and decisions

- “Agent finished” is not a trustworthy event. Only explicit submission and human acceptance drive completion.
