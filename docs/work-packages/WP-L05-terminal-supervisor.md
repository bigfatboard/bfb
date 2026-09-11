# WP-L05 — Terminal execution supervisor

Status: `planned`

Risk: Very high

## Outcome

A claimed launch starts only the locally allowlisted fake provider in the exact registered working directory, under a BFB-owned lock and process supervisor that fails safely.

## Dependencies

- **Requires:** C09, L01, L02, L03, L04, L08.
- **Unlocks:** A01, D02, L06, L07, P01, P02, W02, X02.
- **Can run with:** W01 and other web work after the C09/F02 launch contracts freeze.

## Scope

- Consume a C09-claimed launch and its already-acquired cloud lease/fencing generation, then create/claim a distinct one-time daemon-local Terminal intent for fixed `bfb __launch <uuid>` bootstrap.
- Register supervisor PID/executable/start identity before returning execution configuration.
- Create the random run-scoped correlation capability, authenticated local execution-assignment record, scoped `BFB_*` environment, and run-specific artifact directory outside the checkout. Never put an MCP mutation capability in the provider environment.
- Obtain final online authorization and revalidate checkout, repository config, assignment, cancellation, expiry, provider executable canonical identity/version, provider integration hash, and capability-manifest identity immediately before execution.
- Acquire only the local physical-worktree lock after validating C09's fencing generation; retain its recovery marker across crash. Renew/release the cloud lease through C09 only while supervisor PID/start, provider group, and local lock remain verified, and never ignore a live local lock because cloud TTL expired.
- `chdir` to the exact linked project directory and spawn explicit local argv in an owned process group.
- Transfer PTY foreground ownership with `tcsetpgrp`, block `SIGTTOU` around transfers, verify `tcgetpgrp` before restoration, and distinguish terminal job control from remote `killpg`.
- Verify PID/start/group before interrupt/escalation and wait for the whole owned group.
- Execute only authenticated, bounded C09 run-control intents for focus-existing, resume, interrupt, or terminate/cancel; recheck assignment and process identity before every local effect.
- Detect observed session/process-group escape, retain the lock, and enter `containment_unknown` until an explicit local inspection proves no owned/ambiguous process and no live lock remain. A cloud/web command can never clear this marker.
- Emit verified process/session observations and a 15-second process heartbeat while the provider group is alive through the local event sink, separate from L08 connection heartbeat and normalized hook activity.
- Close the event-creation window only after verified group end plus the bounded final-hook grace period, while leaving already captured envelopes replayable.
- Report execution/block/end facts without changing run result.

## Non-goals

- Claude-specific flags, arbitrary remote commands, server cwd/argv, cloud reacquisition of a claimed lease, web-cleared containment recovery, killing ambiguous processes, macOS sandboxing, or protection from deliberately untracked human processes.

## Work plan

1. Build isolated PTY/process-control proof with the fake provider.
2. Integrate distinct local intent, correlation/assignment record, scoped environment, final authorization, pre-exec identity checks, fencing generation, and local lock.
3. Add verified heartbeats, typed run controls, descendants, crash recovery, final-hook grace, and local-only containment recovery.
4. Run real Terminal integration tests for Ctrl-C, close, child survival, escape, and PID reuse.

## Acceptance

- Fake provider starts in the exact linked root or project subdirectory and records actual Git facts.
- Moved/replaced/occupied checkout, expired/cancelled command, revoked grant, stale snapshot, locked session, and consent denial block safely.
- Two aliased concurrent starts yield one execution.
- A replaced binary/symlink target, version, provider integration, repository config, or capability manifest after claim blocks before `exec` and cannot be grandfathered by a prior probe.
- The provider receives only the documented scoped BFB environment plus its normal local environment; task text and MCP mutation authority are absent, and `BFB_ARTIFACTS_DIR` resolves outside the checkout.
- Parent exit with live owned child retains the lock; PID reuse never signals another process.
- Escape/ambiguous ownership enters persistent `containment_unknown`; remote recovery cannot clear it, and local recovery fails until process/lock absence is proved.
- Process heartbeat continues while an owned child survives the parent, stops only after verified group end, and does not label an idle prompt as working.
- Duplicate run controls have one effective local action; stale/expired controls and controls for another assignment cannot focus, signal, resume, or terminate a process.
- Captured shell command contains no cloud/task/profile/checkout data and never contains a cloud wake-intent value.

## Evidence and handoff

- Commit PTY traces, process tree/lock/lease-renewal tests, correlation/environment and heartbeat traces, run-control matrix, crash/local-recovery record, pre-exec swap tests, and malicious-input capture.
- Real provider adapters supply only a validated local `LaunchPlan`.

## Risks and decisions

- This is the highest-risk macOS component. Do not debug provider behavior until the fake-provider supervisor suite is clean.
