# BFB MVP progress

Updated: 11 September 2026

Status: In progress — roadmap amended; preparing L01

Plan: [Remote launch and agent discussion MVP](mvp.plan.md)

## Current checkpoint

- Implementation authorized; feature branch: `codex/remote-launch-discussion-mvp`, based on `main` at `e1bc7a0`.
- Plan updated; ADR 0002 accepted; D01–D03 assigned with dependency edges, test targets and evidence paths. Roadmap generation now covers 45 packages.
- Next package: L01, the daemon/CLI kernel. Its F01/F02 dependencies are done.
- No new runtime capability has been implemented or certified yet. No production action has been taken.

## Milestones

| Milestone | Packages | State | Completion check |
| --- | --- | --- | --- |
| Trusted Mac | L01–L03, C06, L08, L04 | Pending | Enroll, register exact checkout, probe providers, reconnect, revoke |
| Remote launch | C09, L05, W02 | Pending | Card starts fake provider; contention, expiry, revocation and containment fail safely |
| Real agent work | L06, E01–E02, A01–A04, L07, P01 | Pending | Claude/Codex start, scoped context, attention, explicit result and human acceptance |
| Discussion | D01–D03 | Planned; ADR and gates recorded | Two read-only participants, bounded turns, recovery, intervention, human decision |
| Running local delivery | Integrated MVP | Pending | Start services, full browser/runner/provider smoke, negative checks and health instructions |

## Verification

- Starting repository baseline: 12 completed work packages; previous `pnpm verify` passed with 343 TypeScript tests plus Go and Swift checks.
- The baseline is not evidence for the new MVP features.
- Provider discovery: Codex `0.153.4`, Claude Code `2.1.268`. Only version/help inspection has run; live adapter acceptance remains pending.
- IC-1 baseline attempt reached browser tests but could not launch because this machine lacks the Playwright-pinned Chromium build. Installing the declared test browser and rerunning; no product failure established by this attempt.

## Decisions and limitations

- Fresh BFB-owned discussion sessions first; existing live-session invitations deferred.
- An early L03 capability experiment validates continuation, fork, identity, read-only boundaries, cancellation, and native delivery before adapter contracts freeze.
- D1/WorkspaceHub owns business state; the Mac executes; peer text grants no human authority.
- No automatic worktrees, extra room backend, external room dependency, or production deployment.
- Package status changes require the exact clean-checkout gate and committed redacted evidence. Milestone progress does not bypass this rule.

## Checkpoint log

- 11 September: began the approved MVP implementation and incorporated the follow-up agent-chat research into the plan.
- 11 September: assigned D01–D03 and DG-01–DG-03; generated roadmap passes with 45 packages. Added a regression for discussion-package generation. `pnpm verify` passed with 344 TypeScript tests, Go checks and Swift/Xcode checks.
