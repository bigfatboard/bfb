# BFB MVP progress

Updated: 11 September 2026

Status: In progress — L01 complete; certifying L02 exact checkout registry

Plan: [Remote launch and agent discussion MVP](mvp.plan.md)

## Current checkpoint

- Timo explicitly authorized Codex to finish the full local MVP independently on autopilot, without routine approval pauses, and instructed work to resume. This authority is recorded in the plan's Goal section. Feature branch: `codex/remote-launch-discussion-mvp`, based on `main` at `e1bc7a0`.
- Plan updated; ADR 0002 accepted; D01–D03 assigned with dependency edges, test targets and evidence paths. Roadmap generation now covers 45 packages.
- L01, the daemon/CLI kernel, is done under ADR 0003's approved local scope. Its exact target, uncached native tests, full repository verification, IC-1 and clean-worktree check passed at `f19d188`; evidence is committed.
- L02 now implements local checkout link/list/verify/unlink, immutable filesystem/Git identity, path-free summaries and tightening-only repository policy. Its local target passed; clean-checkout certification and committed evidence are next, before L03.
- L01 implements private socket/CLI dispatch, SQLite WAL migrations/recovery, redacted logs, credential interfaces and per-user launchd installation, including real process restart, launchd and Swift-to-UDS tests. The genuinely fresh-account environment check remains untested and owned by G02. No production action has been taken.

## Milestones

| Milestone | Packages | State | Completion check |
| --- | --- | --- | --- |
| Trusted Mac | L01–L03, C06, L08, L04 | L01 done; L02 in progress | Enroll, register exact checkout, probe providers, reconnect, revoke |
| Remote launch | C09, L05, W02 | Pending | Card starts fake provider; contention, expiry, revocation and containment fail safely |
| Real agent work | L06, E01–E02, A01–A04, L07, P01 | Pending | Claude/Codex start, scoped context, attention, explicit result and human acceptance |
| Discussion | D01–D03 | Planned; ADR and gates recorded | Two read-only participants, bounded turns, recovery, intervention, human decision |
| Running local delivery | Integrated MVP | Pending | Start services, full browser/runner/provider smoke, negative checks and health instructions |

## Verification

- Starting repository baseline: 12 completed work packages; previous `pnpm verify` passed with 343 TypeScript tests plus Go and Swift checks.
- The baseline is not evidence for the new MVP features.
- Provider discovery: Codex `0.153.4`, Claude Code `2.1.268`. Only version/help inspection has run; live adapter acceptance remains pending.
- IC-1 passed in an isolated clean baseline checkout after installing the pinned Chromium build, building workspace packages and rebuilding the declared native SQLite dependency. This includes 14 browser scenarios and the dedicated two-scenario OAuth rerun. The initial environment failures were missing test dependencies, not established product failures.
- Added `pnpm build` before the aggregate IC-1 domain tests so the command does not depend on previously generated package output.
- L01 `pnpm test:l01` passed from a clean checkout with 136 TypeScript protocol tests, Go protocol checks and race-tested daemon/auth/CLI/binary packages, including real subprocess crash/restart, per-user launchd installation and a compiled Swift Unix-socket client. Clean-checkout `pnpm verify` passed 348 TypeScript tests plus Go and Swift/Xcode checks; `pnpm worktree:check` confirmed no tracked drift.
- The updated `pnpm test:ic1` command also passed in the L01 clean checkout at `2ef952a`, including all 14 browser scenarios and the two-scenario dedicated OAuth rerun; the worktree remained clean afterward.
- L02 local acceptance passed: real APFS aliases/case spelling, linked worktrees/common-directory retargeting, directory replacement/removal, dirty/unborn/detached Git states, zero Git metadata writes, policy hash changes, default/pagination/restart behavior, and real CLI/RPC path redaction. Five shared policy fixtures pass through both Go YAML parsing and canonical cloud commands.
- New conditional RPC fixtures exposed a diagnostic-category mismatch: both codecs rejected response paths, but TypeScript lacked Go's generic constant-error mapping. The mapping is aligned, with shared differential regression fixtures; 139 protocol tests pass.

## Decisions and limitations

- Fresh BFB-owned discussion sessions first; existing live-session invitations deferred.
- An early L03 capability experiment validates continuation, fork, identity, read-only boundaries, cancellation, and native delivery before adapter contracts freeze.
- D1/WorkspaceHub owns business state; the Mac executes; peer text grants no human authority.
- No automatic worktrees, extra room backend, external room dependency, or production deployment.
- Package status changes require the exact clean-checkout gate and committed redacted evidence. Milestone progress does not bypass this rule.
- L01's native lifecycle checks use empty BFB state under the current macOS account. A genuinely new macOS account has not been tested; this is distinct from clean-checkout certification and remains an explicit acceptance limitation.
- Timo approved deferring that specific fresh-account check to G02. ADR 0003 records the exception, preserves the existing safety tests, and forbids describing the release environment check as passed.

## Checkpoint log

- 11 September: began the approved MVP implementation and incorporated the follow-up agent-chat research into the plan.
- 11 September: assigned D01–D03 and DG-01–DG-03; generated roadmap passes with 45 packages. Added a regression for discussion-package generation. `pnpm verify` passed with 344 TypeScript tests, Go checks and Swift/Xcode checks.
- 11 September: committed the plan/roadmap as `8e27776`; F02 prerequisite gate passed (132 TypeScript tests plus Go). Began L01 with isolated local-state, socket, storage, logging, credential-interface and lifecycle tests.
- 11 September: first complete L01 local gate passed; added canonical daemon-status/error fixtures and documented CLI, storage recovery, limits and the native Keychain boundary still owned by L08/L04.
- 11 September: committed L01 implementation as `2ef952a`; clean-checkout target, full verification and worktree check passed. Recorded bounded evidence and retained review status because the specified clean macOS account check has not run. L02 remains pending under dependency discipline.
- 11 September: resumed with Timo's approval to move the fresh-account environment test to G02. Recorded ADR 0003 before revising L01 acceptance; recertifying the approved local scope before consuming the package.
- 11 September: recorded explicit authority to finish the full MVP independently on autopilot. L01 clean-checkout certification passed at `f19d188`, including an uncached native rerun and IC-1 regression; marked L01 done with the fresh-account G02 deferral preserved in evidence.
- 11 September: implemented L02 and passed its local target, including race-tested checkout operations and the previous-head SQLite migration/rollback case. Clean-checkout certification is pending; no later package has consumed L02 yet.
