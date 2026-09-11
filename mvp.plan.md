# BFB MVP plan: remote start and agent discussion

Status: Draft for review

Date: 11 September 2026

Review baseline: `13e1e21`

## Goal

Make the next release deliver two concrete actions: **Start this task on my Mac** and **Ask X and Y to discuss this issue**.

The existing architecture supports that direction. The main missing piece is the local execution system; discussion also needs an explicit domain model.

This document records the proposed delivery priorities. It does not approve architecture changes, authorize deployment, or change work-package status. The [work-package roadmap](docs/work-packages/README.md) and [acceptance matrix](docs/work-packages/ACCEPTANCE.md) remain authoritative for dependencies and completion.

## Where we are

At the review baseline, the roadmap records 12 completed packages: platform foundations, identity and authorization, projects, task/run/context records, the board, and remote MCP core.

Three important gaps:

- The runner and macOS app remain scaffolds: [Go entry point](cmd/bfb/main.go), [macOS entry point](apps/macos/Sources/BFB/BFBApp.swift).
- Remote MCP supplies delegated task access, not remote process control. Its [committed provider-compatibility evidence](docs/work-packages/evidence/WP-X03A/provider-compat.md) also contains incomplete OAuth flows.
- Discussion is not covered by task comments. Normal [run creation](packages/domain/src/work-records.ts) requires a ready task and advances its state, so simply starting two ordinary runs against an existing issue would be wrong.

The product direction remains sound: help humans understand, start, redirect, and decide work across agents and projects.

## Proposed delivery sequence

First, document the discussion design in an ADR and amend the affected planned packages. In particular, extend [L03's provider contract](docs/work-packages/WP-L03-provider-kit.md) before it freezes: launching and resuming a session are insufficient without a tested way to deliver another turn and identify its response.

Then implement one package at a time along this sequence. Package lists identify milestone scope, not an override of dependency order; every consumed dependency must be marked `done`.

| Milestone | Work packages | Observable completion |
| --- | --- | --- |
| **1. A trusted, usable Mac** | L01–L03, C06, L08, L04 | Enroll a Mac, register an exact checkout, discover supported providers, reconnect, and revoke access. The board sees sanitized availability and actionable failures. |
| **2. Reliable remote launch** | C09, L05, W02 | A card starts the fake provider in precisely the selected checkout. Duplicate clicks, competing starts, expired commands, revoked grants, and occupied checkouts fail safely. |
| **3. Real agent work** | L06, E01–E02, A01–A04, L07, P01 | Start Claude and Codex, receive truthful activity, answer a BFB question, resume the correct session, and review an explicitly submitted result. Prioritize P01 immediately after its prerequisites. |
| **4. Human-initiated discussion** | Proposed D01–D03 below | Select two agents on an issue, watch a bounded exchange, intervene or stop it, and receive recommendations with disagreements preserved. |

Milestone 2 is an engineering checkpoint, not a claim that real-agent remote start is finished. Milestone 3 delivers that claim.

For the first remote-start pilot, use a browser on another device and one enrolled Mac. Test the actual cross-device path, not just a link opened on the executing Mac. Interactive launch requires an available GUI session and Terminal consent; a wake link does not remotely wake a sleeping computer.

## What “Discuss with X and Y” should do

The draft assumes **fresh discussion sessions for two named profiles**, initially Claude and Codex. Existing working-session invitations would follow. Fresh versus existing sessions remains a product choice to confirm before discussion implementation.

The first version should have this flow:

1. **Human starts it from an issue.** Select X, Y, the question, permitted runner/checkouts, and a bounded duration.
2. **BFB freezes the shared brief.** Include agent-visible context, acceptance criteria, relevant decisions, and Git revision. Exclude human-only notes.
3. **Each agent gives an initial position.** Keep these independent until both have responded.
4. **They exchange challenges and revise their recommendations.** Default to three rounds, at most six participant turns.
5. **Return the decision to the human.** Show recommendations, supporting reasons, agreement, unresolved disagreement, and questions requiring human judgment.

The human can add context, stop the discussion, record a decision, or explicitly start implementation. Completing a discussion must not complete the issue or authorize code changes.

### Proposed discussion work packages

These are proposed package names and scopes, not existing or ready packages. Their exact contracts, dependencies, test targets, and evidence manifests must be assigned during the roadmap amendment.

- **D01 — Discussion records and permissions.** Discussion, participants, messages, turn state, and conclusions. Give participant runs an explicit discussion purpose that does not drive the issue's normal work lifecycle. Bind actions to actual runs/sessions and the initiating human, not merely profile names.
- **D02 — Discussion execution and delivery.** Supervised headless execution, exact-session continuation, durable message delivery, cancellation, deadlines, and recovery. Reuse runner authorization, checkout protection, and event infrastructure.
- **D03 — Discussion UI and decisions.** Task-sheet action, participant selection, attributed messages, current speaker, failures, intervention, and a conclusion the human can act on.

### First-version constraints

- **Read-only discussion**, enforced through provider/tool permissions, not just a prompt.
- Serialize execution on a shared checkout; do not weaken occupancy protection or introduce automatic worktree creation.
- Keep discussion messages as intentional business records. Do not upload whole provider transcripts.
- If delivery is ambiguous after a crash, reconcile or pause; do not blindly resend and create duplicate turns.
- Stop on the turn limit, deadline, cancellation, or lost authorization. Token limits are only enforceable where the provider supports them.
- If repository/context changes invalidate the shared brief, surface that explicitly.

## What to borrow from Herdr

Herdr has useful control primitives: address an agent explicitly, submit work, wait, inspect, and return to it. Its background runtime also separates closing the UI from stopping the process. Those are good interaction patterns for BFB. See [agent automation](https://herdr.dev/docs/agent-automation/) and [session persistence](https://herdr.dev/docs/session-state/).

Do not adopt its terminal-input mechanism as BFB's coordination protocol. Herdr documents that prompting sends text plus Enter, and its waits do not track individual turns. Claude/Codex status can also depend on screen recognition. BFB needs stronger correlation for durable discussion and human decisions. See [prompt/wait semantics](https://herdr.dev/docs/agent-automation/#choose-the-control-surface) and [status authority](https://herdr.dev/docs/agents/#status-authority).

For the first discussion adapter, prefer documented non-interactive output and exact-session resume. Both [Codex](https://learn.chatgpt.com/docs/non-interactive-mode) and [Claude Code](https://code.claude.com/docs/en/headless) document those capabilities. The official documentation reviewed for this plan supports that direction, but exact installed-version fixtures still need proving before implementation relies on them.

## Priority and verification

Defer further landing-page work, broad GitHub integration, additional providers, and the full artifact suite. After discussion works, **“Pass this for independent agent review”** is the next valuable action: it can reuse the same participant, context, and decision machinery.

The pilot is successful when a human can start real work remotely, initiate a two-agent discussion, close the browser, reconnect without losing its state, and make the final decision without manually copying messages between terminals.

Each implemented package must pass its exact test target from a clean checkout, commit its bounded evidence manifest, and pass `pnpm verify` before handoff. A production rollout requires a separately confirmed plan followed by deployed smoke tests.

At the review baseline on 11 September 2026, `pnpm verify` passed: 343 tests, Go checks, and macOS checks. This records the starting point, not acceptance evidence for the proposed capabilities. No runtime implementation or deployment was performed for this plan.
