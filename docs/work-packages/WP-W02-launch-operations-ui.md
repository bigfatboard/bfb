# WP-W02 — Runner and launch operations UI

Status: `planned`

Risk: High

Test target: `pnpm test:w02`

Evidence manifest: `docs/work-packages/evidence/WP-W02/manifest.json`

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

## Contracts

### Consumes

- `docs/contracts/launch-orchestration.md` (C09: typed Start/launch/control/wake commands, states, timeouts, fencing, and uniform-failure rules).
- `docs/contracts/runner-enrollment.md` and `docs/contracts/runner-channel.md` (C06, L08: runner identity, grants, inventory, and capability rules).
- `docs/contracts/execution-supervisor.md` (L05 states and daemon-local Terminal intent).
- `docs/contracts/macos-app.md` (L04 wake-link handling and local recovery ownership).
- The C03 step-up flow (`runner.grants.replace` and `runner.revoke` actions with exact target binding).
- L03's fake provider and synthetic C09 launches driven by `tools/launches/run.ts`.

### Produces

- `pnpm test:w02` — stable gate covering fixture checks, builds, protocol checks, launch domain and W02 unit suites, the synthetic C09 launch drive, and the Playwright suite at `apps/web/test/e2e/w02-launch.spec.ts`.
- `docs/work-packages/evidence/WP-W02/manifest.json` — stable evidence-manifest path consumed by checkpoint/release automation.
- Browser reads (additive; C09 command semantics unchanged): `GET .../runners/:runner/checkouts`, `GET .../launches?task_id=`, `GET .../launches/:launch` — sanitized projections with no absolute paths, no secrets, and no clear affordance for `containment_unknown`. Launch reads classify as abuse-budget `poll`, matching the runner surface; commands stay `attempt`.

## Work plan

1. Build runner/checkout administration, action-bound runner-sharing step-up, and grant-aware selection.
2. Implement Start and durable command state presentation.
3. Add typed interrupt/cancel/return/retry actions and local-only recovery handoff.
4. Execute all safe-blocking cases against L03's fake provider and L05 supervisor. L07 later repeats the integration with real Claude without gating this checkpoint.

## Acceptance

- [x] An ungranted teammate cannot select/wake another human’s runner.
- [x] Adding/removing a named runner launcher requires a fresh action-bound passkey assertion; Reviewer, stale-session, and mismatched-action assertions fail.
- [x] The UI never receives or displays the absolute checkout path.
- [x] Double Start creates one effective launch.
- [x] Duplicate wake-link/socket/UI signals preserve one durable command/claim, and no cloud wake-intent value reaches the Terminal command.
- [x] Expired reconnect requires another explicit click.
- [x] Every architecture-defined blocking condition has a specific state and next safe action.
- [x] Interrupt/resume/focus/cancel targets only the selected immutable execution assignment, and duplicate/stale controls cannot affect another process.
- [x] `containment_unknown` cannot be cleared from the web; the UI remains blocked until the local daemon reports inspected recovery.
- [x] Terminal close/process end does not mark the task done.

## Evidence

- `docs/work-packages/evidence/WP-W02/manifest.json` — manifest for this package, conforming to `docs/work-packages/evidence/manifest.schema.json`.
- `docs/work-packages/evidence/WP-W02/command-result.json` — bounded command/outcome log for the gate.
- Provider-neutral fake-launch recording at `docs/work-packages/evidence/WP-W02/fake-launch-recording.md`.
- All blocked/local-recovery screenshots (`start-pending`, `expired-retry`, `containment`, `process-ended`, `member-start`, `wake-link`, `runners`, `grants`) indexed by `docs/work-packages/evidence/WP-W02/blocked-states.md`.
- Run-control and wake-intent idempotency traces at `docs/work-packages/evidence/WP-W02/idempotency-traces.md`.
- Step-up trace at `docs/work-packages/evidence/WP-W02/step-up-trace.md` and permission test report at `docs/work-packages/evidence/WP-W02/permission-matrix.md`.

## Risks and decisions

- Avoid a generic “failed” bucket; typed launch states are operational safety information.
- Launch status reads initially consumed the 20/minute command abuse budget and starved legitimate commands on long-lived servers; reads now classify as `poll` exactly like the runner surface, with a regression test pinning the split.
- Concurrent same-tick duplicate Starts may return 201+403 while still recording exactly one launch; the gate asserts one effective launch plus deterministic same-key replay instead of mandating both responses succeed, and C09 command semantics are unchanged.

## Handoff

- Implementation, gate (`pnpm test:w02`), and evidence are complete on this branch, but this package stays `planned`: L05 is still `blocked` on its Terminal acceptance, and `pnpm roadmap:check` rejects any status beyond `planned` while a dependency is not `done`. Do not touch L05's status; the `done` transition waits for it.
- Commit provider-neutral fake-launch recording, all blocked/local-recovery screenshots, run-control and wake-intent idempotency traces, step-up trace, and permission test report (all under `docs/work-packages/evidence/WP-W02/`).
- E02 later adds live invalidation without replacing durable launch reads.
- Run `pnpm test:w02` (browser tests use `BFB_E2E_PORT=4174`) or `pnpm test:w02:browser` for the UI suite alone; `BFB_CAPTURE_W02_EVIDENCE=1 pnpm test:w02` regenerates the evidence.
- Known limits: status polling is interval-based (5s while a launch awaits claim); inventory freshness is display-only and never gates Start (the server decides); the fixed-clock e2e server never advances launch expiry, so expiry/retry is proven through seeded chains plus domain-driven expiry tests.
