# BFB MVP plan: remote start and agent discussion

Status: Approved for local implementation

Date: 11 September 2026

Review baseline: `13e1e21`

## Goal

Make the next release deliver two concrete actions: **Start this task on my Mac** and **Ask X and Y to discuss this issue**.

The existing architecture supports that direction. The main missing piece is the local execution system; discussion also needs an explicit domain model.

Timo approved updating and implementing this plan on 11 September 2026. The discussion design is recorded in [ADR 0002](docs/adr/0002-human-initiated-discussions.md) before runtime changes. The autopilot authority below governs necessary operational actions; an unrelated production rollout is outside this local MVP. The [work-package roadmap](docs/work-packages/README.md) and [acceptance matrix](docs/work-packages/ACCEPTANCE.md) remain authoritative for dependencies and completion; [MVP progress](mvp.progress.md) records implementation checkpoints, verification, and remaining work.

The approved [ADR 0003](docs/adr/0003-local-mvp-account-test-scope.md) moves L01's genuinely fresh macOS user-account check to G02 release certification. L01 still requires clean-checkout tests against empty private BFB state, real native lifecycle checks and its existing safety assertions. This is a narrow environment-test deferral, not a release pass or a waiver of other package gates.

### Explicit autopilot authority

Timo explicitly grants Codex authority to finish this entire goal on its own, on autopilot. This authorization was reaffirmed on 11 September 2026 with an instruction to record it in the current goal and plan, then resume.

Codex owns the necessary engineering decisions and operational follow-through within this approved local MVP: implementation, configuration, local migrations, builds, provider integration, testing, fixes, coherent commits, and leaving the application and runner running. Make reasonable in-scope decisions independently, keep `mvp.progress.md` current, and continue across packages without routine approval pauses or stopping at an intermediate milestone.

The goal remains the fully working and verified local MVP described here, including remote Claude/Codex launch and bounded read-only discussions. Autopilot does not permit silently shrinking that outcome, fabricating evidence, weakening the architecture's trust boundaries, or treating unfinished acceptance as passed. Exhaust safe in-scope remedies before reporting a genuine blocker. Timo's updated instructions on 12 September authorize necessary shared-state and production actions within full autopilot without repeated rollout confirmation; the task remains the local MVP, so this does not add an unrelated production rollout. Timo also explicitly approved the BFB development App ID, Associated Domains and Mac provisioning setup.

## Where we are

At the review baseline, the roadmap records 12 completed packages: platform foundations, identity and authorization, projects, task/run/context records, the board, and remote MCP core.

Three important gaps:

- The runner and macOS app remain scaffolds: [Go entry point](cmd/bfb/main.go), [macOS entry point](apps/macos/Sources/BFB/BFBApp.swift).
- Remote MCP supplies delegated task access, not remote process control. Its [committed provider-compatibility evidence](docs/work-packages/evidence/WP-X03A/provider-compat.md) also contains incomplete OAuth flows.
- Discussion is not covered by task comments. Normal [run creation](packages/domain/src/work-records.ts) requires a ready task and advances its state, so simply starting two ordinary runs against an existing issue would be wrong.

The product direction remains sound: help humans understand, start, redirect, and decide work across agents and projects.

## Proposed delivery sequence

First, record the discussion design in an ADR and amend the affected planned packages. In particular, extend [L03's provider contract](docs/work-packages/WP-L03-provider-kit.md) before it freezes: launching and resuming a session are insufficient without a tested way to deliver another turn and identify its response. L03 includes an early, bounded provider-capability experiment covering fresh sessions, exact-session resume, fork, structured identity/output, cancellation, read-only enforcement, and native external-message delivery. Record support against exact installed versions; CLI help and upstream feature announcements are discovery evidence, not acceptance proof.

Then implement one package at a time along this sequence. Package lists identify milestone scope, not an override of dependency order; every consumed dependency must be marked `done`.

| Milestone | Work packages | Observable completion |
| --- | --- | --- |
| **1. A trusted, usable Mac** | L01–L03, C06, L08, L04 | Enroll a Mac, register an exact checkout, discover supported providers, reconnect, and revoke access. The board sees sanitized availability and actionable failures. |
| **2. Reliable remote launch** | C09, L05, W02 | A card starts the fake provider in precisely the selected checkout. Duplicate clicks, competing starts, expired commands, revoked grants, and occupied checkouts fail safely. |
| **3. Real agent work** | L06, E01–E02, A01–A04, L07, P01 | Start Claude and Codex, receive truthful activity, answer a BFB question, resume the correct session, and review an explicitly submitted result. Prioritize P01 immediately after its prerequisites. |
| **4. Human-initiated discussion** | D01–D03 below | Select two agents on an issue, watch a bounded exchange, intervene or stop it, and receive recommendations with disagreements preserved. |

Milestone 2 is an engineering checkpoint, not a claim that real-agent remote start is finished. Milestone 3 delivers that claim.

For the first remote-start pilot, use a browser on another device and one enrolled Mac. Test the actual cross-device path, not just a link opened on the executing Mac. Interactive launch requires an available GUI session and Terminal consent; a wake link does not remotely wake a sleeping computer.

## What “Discuss with X and Y” should do

The MVP uses **fresh BFB-owned discussion sessions for two named profiles**, initially Claude and Codex. BFB owns each session's execution lifecycle and resumes its exact observed identity for subsequent turns; two provider processes need not remain running between turns. Existing working-session invitations are deferred. A later explicit context-sharing action may fork a conversation if the tested provider supports it, but it must revalidate context access and permissions and never take over or concurrently resume a live user session.

The first version should have this flow:

1. **Human starts it from an issue.** Select X, Y, the question, permitted runner/checkouts, and a bounded duration.
2. **BFB freezes the shared brief.** Include agent-visible context, acceptance criteria, relevant decisions, and Git revision. Exclude human-only notes.
3. **Each agent gives an initial position.** Keep these independent until both have responded.
4. **They exchange challenges and revise their recommendations.** Default to three rounds, at most six participant turns.
5. **Return the decision to the human.** Show recommendations, supporting reasons, agreement, unresolved disagreement, and questions requiring human judgment.

The human can add context, stop the discussion, record a decision, or explicitly start implementation. Completing a discussion must not complete the issue or authorize code changes.

### Discussion work packages

These packages are recorded in the roadmap with dependencies, test targets, and evidence-manifest paths. They remain planned until their prerequisites and executable acceptance contracts are ready.

- **D01 — Discussion records and permissions.** Discussion, participants, messages, turn state, and conclusions. Give participant runs an explicit discussion purpose that does not drive the issue's normal work lifecycle. Bind actions to actual runs/sessions and the initiating human, not merely profile names.
- **D02 — Discussion execution and delivery.** Supervised headless execution, exact-session continuation, durable message delivery, cancellation, deadlines, and recovery. Reuse runner authorization, checkout protection, and event infrastructure.
- **D03 — Discussion UI and decisions.** Task-sheet action, participant selection, attributed messages, current speaker, failures, intervention, and a conclusion the human can act on.

### First-version constraints

- **Read-only discussion**, enforced through provider/tool permissions, not just a prompt.
- Serialize execution on a shared checkout; do not weaken occupancy protection or introduce automatic worktree creation.
- Keep discussion messages as intentional business records. Do not upload whole provider transcripts.
- If delivery is ambiguous after a crash, reconcile or pause; do not blindly resend and create duplicate turns.
- Persist single-writer ownership per provider session with a fencing generation and local execution guard. An in-memory mutex alone is insufficient. Keep message acceptance, dispatch, provider acknowledgement, turn completion, and discussion conclusion distinct and correlated by stable IDs.
- Deliver peer messages as attributed external context, not as new human authorization. Prefer a tested native lower-authority input mechanism where available; otherwise the trusted turn instruction asks the agent to evaluate bounded peer content under unchanged read-only permissions. Never interpolate peer text into shell commands or route arbitrary mentions as launch authority.
- Use typed recommendations, evidence references, agreement, disagreement, and human questions. A textual marker such as `[DONE]` or `[DECISION]` cannot complete an issue, grant permission, or replace a committed human decision.
- Stop on the turn limit, deadline, cancellation, or lost authorization. Token limits are only enforceable where the provider supports them.
- If repository/context changes invalidate the shared brief, surface that explicitly.

## What to borrow from Herdr

Herdr has useful control primitives: address an agent explicitly, submit work, wait, inspect, and return to it. Its background runtime also separates closing the UI from stopping the process. Those are good interaction patterns for BFB. See [agent automation](https://herdr.dev/docs/agent-automation/) and [session persistence](https://herdr.dev/docs/session-state/).

Do not adopt its terminal-input mechanism as BFB's coordination protocol. Herdr documents that prompting sends text plus Enter, and its waits do not track individual turns. Claude/Codex status can also depend on screen recognition. BFB needs stronger correlation for durable discussion and human decisions. See [prompt/wait semantics](https://herdr.dev/docs/agent-automation/#choose-the-control-surface) and [status authority](https://herdr.dev/docs/agents/#status-authority).

For the first discussion adapter, prefer documented non-interactive output and exact-session resume. Both [Codex](https://learn.chatgpt.com/docs/non-interactive-mode) and [Claude Code](https://code.claude.com/docs/en/headless) document those capabilities. The official documentation reviewed for this plan supports that direction, but exact installed-version fixtures still need proving before implementation relies on them.

## Agent-room research incorporated

Separate three responsibilities: D1/WorkspaceHub owns the discussion and permissions; the enrolled Mac supervises provider turns; MCP is an optional business-command surface, not the execution scheduler. No additional Redis room service, public relay, or external room dependency is required.

- Borrow controlled rounds and deliberate outputs from [Agent Room](https://github.com/agent-room-alkl/agent-room), and shared evidence, proposal versions, independent review, and human decisions from [Mohamed's Agent Room](https://github.com/mohamedadelfouda/agent-room). Do not adopt its automatic disposable clones.
- Borrow the distinction between a trusted inbox nudge and untrusted message content from [agent-talk's delivery design](https://github.com/xhluca/agent-talk/blob/main/docs/codex-auto-receive.md). Its documented one-loaded-thread idle-wake arrangement is not BFB's multi-session addressing contract.
- Native capabilities are evolving. Local discovery found Codex `0.153.4` with `exec fork` and Claude Code `2.1.268`; [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) and the [Codex Python SDK external-message release](https://learn.chatgpt.com/docs/changelog#github-release-386577294) justify an early experiment. They do not authorize an SDK/runtime replacement or an unsupported production app-server transport.
- Treat repository licenses as version-specific. [mcp-huddle](https://github.com/kolotovalexander/mcp-huddle) identifies its current source as PolyForm Noncommercial and an older published release as MIT. Reuse concepts without adding that implementation as a dependency.

The capability experiment must exercise duplicate input, wrong-session targeting, a busy source session, cancellation, process loss before/after provider acknowledgement, inherited MCP/tool permissions, and attempts to write or escalate from peer content. Capture only bounded synthetic fixtures and redacted version/capability results, not personal session history.

## Priority and verification

Defer further landing-page work, broad GitHub integration, additional providers, and the full artifact suite. After discussion works, **“Pass this for independent agent review”** is the next valuable action: it can reuse the same participant, context, and decision machinery.

The pilot is successful when a human can start real work remotely, initiate a two-agent discussion, close the browser, reconnect without losing its state, and make the final decision without manually copying messages between terminals. Final local delivery leaves the application and runner running, documents their start/stop/health commands, and tests the complete browser-to-runner flow, provider turns, attention, result review, discussion cancellation/recovery, and permission failures. Cross-device reachability is verified where an authorized second device or equivalent independent client is available; localhost-only checks must not be labelled cross-device proof.

Update `mvp.progress.md` whenever a package changes state, a material test or limitation changes, and periodically during longer implementation. It must distinguish implemented, verified, running, and still-pending capabilities. Local completion is not full v0.1 release certification: the deferred artifact, Grok, external-integration, and release packages remain outside this MVP.

Each implemented package must pass its exact test target from a clean checkout, commit its bounded evidence manifest, and pass `pnpm verify` before handoff. Any deployment within the authorized task requires deployed smoke tests; green CI alone is insufficient.

At the review baseline on 11 September 2026, `pnpm verify` passed: 343 tests, Go checks, and macOS checks. This records the starting point, not acceptance evidence for the proposed capabilities. No runtime implementation or deployment was performed for this plan.
