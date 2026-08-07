# WP-W02 — Runner and launch operations UI

Status: `planned`

Risk: High

## Outcome

A permitted human selects a named profile, enrolled Mac, and linked checkout on a card, presses Start, and sees every launch/blocked/recovery state truthfully.

## Dependencies

- **Requires:** C03, C06, C09, L03, L04, L05, L08, W01.
- **Unlocks:** G01.
- **Can run with:** E02 only after shared run-state responses freeze.

## Scope

- Add runner/checkouts operations with owner, project, launch-grant, capability, availability, branch/HEAD/dirty summary, and last validation. Adding/removing a named launcher uses the C03 action-bound passkey step-up flow and cannot be performed by a Reviewer or stale session.
- Add card/task Start flow selecting profile, runner, and checkout while hiding absolute paths.
- When useful on the selected Mac, open only C09's short-lived cloud wake link; treat it as an optional wake signal distinct from L05's daemon-local Terminal intent and never as command delivery.
- Show pending, claimed, launching, attached, waiting-user-submit, rejected, expired, blocked, detached, and ended execution states separately from result state.
- Add return-to-existing-session, interrupt, cancel, and retry-after-expiry through C09's typed, authenticated, idempotent run-control commands.
- For `containment_unknown`, show inspection status and a handoff that opens the local BFB app; no web/API action may clear the daemon's recovery marker or claim that recovery succeeded.
- Surface exact typed failures for offline/locked runner, consent denial, moved/mismatched/occupied checkout, capability drift, stale config, revoked grant, and containment unknown.
- Ensure duplicate clicks/reloads operate through idempotent commands.

## Non-goals

- Arbitrary commands, web-cleared local containment recovery, remote native permission approval, worktree creation, branch mutation, or pretending runner offline means run failure.

## Work plan

1. Build runner/checkout administration, action-bound runner-sharing step-up, and grant-aware selection.
2. Implement Start and durable command state presentation.
3. Add typed interrupt/cancel/return/retry actions and local-only recovery handoff.
4. Execute all safe-blocking cases against L03's fake provider and L05 supervisor. L07 later repeats the integration with real Claude without gating this checkpoint.

## Acceptance

- An ungranted teammate cannot select/wake another human’s runner.
- Adding/removing a named runner launcher requires a fresh action-bound passkey assertion; Reviewer, stale-session, and mismatched-action assertions fail.
- The UI never receives or displays the absolute checkout path.
- Double Start creates one effective launch.
- Duplicate wake-link/socket/UI signals preserve one durable command/claim, and no cloud wake-intent value reaches the Terminal command.
- Expired reconnect requires another explicit click.
- Every architecture-defined blocking condition has a specific state and next safe action.
- Interrupt/resume/focus/cancel targets only the selected immutable execution assignment, and duplicate/stale controls cannot affect another process.
- `containment_unknown` cannot be cleared from the web; the UI remains blocked until the local daemon reports inspected recovery.
- Terminal close/process end does not mark the task done.

## Evidence and handoff

- Commit provider-neutral fake-launch recording, all blocked/local-recovery screenshots, run-control and wake-intent idempotency traces, step-up trace, and permission test report.
- E02 later adds live invalidation without replacing durable launch reads.

## Risks and decisions

- Avoid a generic “failed” bucket; typed launch states are operational safety information.
