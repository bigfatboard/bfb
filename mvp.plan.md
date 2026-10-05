# BFB MVP plan: remote start and agent discussion

Status: Approved for local implementation

Approved: 11 September 2026. Integration review updated: 5 October 2026.

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

The integrated feature branch at `472f007` includes the reviewed fixes history and passes the full repository verification suite. The reconciliation reopened A01 for missing runtime integration and held its previously certified descendants; current package metadata records 26 done, one in progress, 11 blocked and seven planned. Historical component evidence remains intact. The current implementation/verification/running distinction and next closure sequence are maintained in [MVP progress](mvp.progress.md).

The 5 October audit found production gaps in A01's online MCP/replay path and D02's discussion scheduling/provider execution, beyond missing live acceptance. A01's combined online/policy checkpoint at `88fbffa` now passes clean-checkout certification through the compiled stdio binary, signed daemon and real Worker/Hub/D1, including canonical session binding and all four online writes. Protected daemon capture and replay are implemented in the next slice and undergoing integrated certification; A01 remains incomplete. Close that package, then re-prove its dependents and the real end-to-end pilot. The [current agent-to-agent research](docs/research/agent-to-agent.md) informs provider experiments without replacing BFB's authority or durable turn model.

### Original planning baseline — 11 September

At the original review baseline, the roadmap recorded 12 completed packages: platform foundations, identity and authorization, projects, task/run/context records, the board, and remote MCP core.

The three original gaps were:

- The runner and macOS app were scaffolds: [Go entry point](cmd/bfb/main.go), [macOS entry point](apps/macos/Sources/BFB/BFBApp.swift).
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
- Native capabilities are evolving. The 5 October review found documented [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) and [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), but these are not interchangeable external coordination APIs. Installed Claude `2.1.289` and Codex `0.159.0` need exact-version experiments. The [Codex app-server command](https://learn.chatgpt.com/docs/app-server) is documented as experimental; a changelog mention alone does not establish a supported external-message contract. See the [versioned research and experiment matrix](docs/research/agent-to-agent.md). This does not authorize an SDK/runtime replacement.
- Treat repository licenses as version-specific. [mcp-huddle](https://github.com/kolotovalexander/mcp-huddle) identifies its current source as PolyForm Noncommercial and an older published release as MIT. Reuse concepts without adding that implementation as a dependency.

The capability experiment must exercise duplicate input, wrong-session targeting, a busy source session, cancellation, process loss before/after provider acknowledgement, inherited MCP/tool permissions, and attempts to write or escalate from peer content. Capture only bounded synthetic fixtures and redacted version/capability results, not personal session history.

## Mandatory product scope extension — 5 October

Timo requires all eight capabilities below. They extend product scope; they are not optional backlog and are not already delivered by existing component certifications. Provisionally, **org** maps to **workspace** and **work item** to **task**. The approved local-MVP authority and remote-start/discussion closure sequence remain unchanged. Shared schema and authorization changes must be sequenced through their owning packages, and consumers may use only dependencies marked `done`.

This section records requirements and gaps, not implementation approval for unresolved designs or acceptance evidence. The expanded product delivery must prove every row. Its minimum document/artifact and publication capabilities are mandatory; the broader full-v0.1 artifact, provider, external-integration and release certification remain distinct from the existing local-MVP gate.

| Mandatory capability | Existing foundation and real gap | Observable acceptance | Dependencies / likely ownership |
| --- | --- | --- | --- |
| Project board and human/agent tasks; summary, graphics, diagrams, plans and progress; inherited prompt | C08/W01 provide lanes, next-owner routing, summary and typed context. Progress is a comment; artifact roles are only `review`/`log`. Separate content navigation and composed base/project instructions are missing. | Create and version-edit a task; assign one human/profile without starting work; inspect distinct content sections. MCP checkpoints preserve supported fields and truthful authorship. Delivered prompts identify inherited versions/hashes. | C08/W01; A01/X03 for delivery; V01–03 for artifacts; new knowledge/context-composition area. |
| Authenticated MCP; private tasks/internal progress; explicit intermediate/final sharing | X03A has scoped OAuth; A01 has clean-certified reads, canonical binding and all four attributed online writes. Protected capture/replay certification remains incomplete. `human`/`agent`/`both` controls consumer audience, **not per-person privacy**. | Confirmed private-owner/ACL rules hold on every transport. Preview and explicitly publish selected immutable content to a named audience without exposing other notes/history. Duplicate, stale, revoked and cross-scope requests fail safely. Publication never implies acceptance. | New privacy/publication area; C04/C08/A01/X03/E02/V01–03/X01/X04/X05; web/CLI parity. |
| BFB-canonical project-root instructions, documents and artifacts | Immutable task context/artifact versions exist; no canonical root-knowledge model or inheritance contract exists. Native local instructions currently remain untouched. | Manage authorized cloud versions; freeze inheritance/precedence and task/run delivery lineage. Later edits do not rewrite delivered history. No silent overwrite/deletion of `AGENTS.md`/`CLAUDE.md`; provider handling of conflicts or unavailable knowledge is explicit. | New knowledge area and ADR; C07/C08/V01; C09/A01/X03 for snapshots/delivery. |
| Workspace Git skill catalog plus project additions | No catalog/sync/enablement contract exists. Configuration snapshots are reusable, not skill support. | Sync a configured repository at an exact commit/hash with visible failures; resolve project additions/collisions explicitly; inspect and enable pinned versions. Catalog inclusion/sync never installs or executes trusted code automatically or widens permissions. | New catalog/enablement area; C04/C07, knowledge lineage and scoped delivery; approved secret references if source auth is needed. |
| Clean, intense/neon core UI with light/dark | Existing BFB is warm/crimson and light-only; shared UI package is only a boundary. Reference patterns were inspected, not adopted. | After confirming scope/direction, prove coherent light/dark tokens/preferences and all loading/empty/error/stale/denied states. Test keyboard/focus, narrow views/zoom, reduced motion and WCAG 2.2 AA in both themes; color alone never carries meaning. | Core UI/design extension over W01/W02 and the new contracts; PRODUCT/DESIGN revision only after confirmation. |
| Workspace/project secret sharing | Infrastructure secrets and Keychain/local credential slots are separate existing systems. Shared application business secrets are absent. | Authorized principals manage scoped secrets, revisions, grants, rotation/revocation and recovery under the chosen store. Agent access is separately authorized. Prove cross-scope denial and redaction: no values in context, artifacts, ordinary events, audit, argv or evidence. Local provider credentials remain local. | New business-secret area and ADR; C03/C04/X05/G01; backing-store choice pending. |
| Hooks/reminders to update BFB | L06 reports telemetry; X01 delivers selected actionable events. No checkpoint/reminder policy exists. | Constant integration reminders direct agents to explicit BFB commands at defined points. Prove cadence, suppression, acknowledgement/expiry, dedupe, access recheck and offline behavior. Hooks/reminders cannot infer progress/completion, auto-publish or start a model turn. | L03/L06/provider integrations, knowledge/A01; X01 reminder extension. |
| Minimal explicit human messages/interactions/contributions | Comments, attention answers and review/timer records exist; no compact contribution view or separation from agent progress exists. | Record bounded, attributed human contributions with immutable actor/time/object lineage and dedupe; display them separately from agent checkpoints/telemetry under privacy rules. Reuse existing records; presence, delivery and browser-open time are never contributions or inferred labor. | C08/W01/A02/A03/V03; A04 only for explicit measurement provenance. |

### Decisions and cross-surface proof still required

User responses are pending on **private ownership/ACL and administrator exceptions**, **application-encrypted values versus an external secret manager**, and **production-ready core UI scope**. Also make publication audience/publisher authority, root-instruction precedence, and skill enablement explicit. Do not convert these pending choices into silent defaults. Record new ADR/package areas for privacy/publication, canonical knowledge/context composition, catalog versus executable enablement, and business secrets before implementing new invariants; do not invent package IDs or alter generated roadmap state here.

Privacy must cover board/list/count/search/export projections, direct task/run reads, comments/progress/context, local and remote MCP, ledger replay/timelines/latest-work/measurements, artifacts and view-grant redemption, attention/notifications, external publication, audit/diagnostics, cached outcomes and pending replay. Current workspace-wide owner/member event replay and shared realtime high-water hints are not private-task enforcement; decide whether existence/cursor/count metadata may be visible, including privileged audit metadata. Recheck current authority before cached return, dispatch and redemption. Revocation prevents future delivery but cannot erase context already received by a provider.

The inspected **Review Tool** reference (`src/appearance.js`, `src/styles.js`) uses six named neon/electric accents on a dark panel with a persistent composer and separate saved-state/export footer; its small controls are not BFB accessibility acceptance. **NovaName** (`src/styles/tokens.css`, `src/components/Workspace.tsx`, `src/components/SharingPanel.tsx`) separates lime action color from status meanings, preserves project navigation, and separates private notes from exact sharing previews, independently written public rationale and consent. Neither inspection proves a complete light/dark design. Impeccable shape remains discovery until clarification and direction selection; no final palette, UI implementation or runtime/auth substitution is approved by these observations.

The 6 October reminder/contribution audit found one constant instruction on fresh provider launches, no prompt on exact resume, and telemetry-only hook receipts. These are not repeated checkpoint reminders. Task context is additive, task-local and currently rejects line breaks; it cannot simply stand in for versioned project Markdown instructions or skills. Prefer a constant context-retrieval/checkpoint bootstrap followed by separately certified provider reminder delivery, without starting model turns or manufacturing business progress. A minimal human-contribution projection should reuse direct human comments, attention observations and result/artifact reviews with exact actor, time and source identity; context edits require Hub provenance because their rows do not retain authors. Deduplicate source rows against events, keep explicit timers labelled measurements, and exclude presence, browser-open time, provider turns and context delivery. These remain scoped integration proposals pending their dependencies and privacy contract.

## Priority and verification

Defer further landing-page work, broad GitHub integration, additional providers, and the full artifact suite. After discussion works, **“Pass this for independent agent review”** is the next valuable action: it can reuse the same participant, context, and decision machinery.

The pilot is successful when a human can start real work remotely, initiate a two-agent discussion, close the browser, reconnect without losing its state, and make the final decision without manually copying messages between terminals. Final local delivery leaves the application and runner running, documents their start/stop/health commands, and tests the complete browser-to-runner flow, provider turns, attention, result review, discussion cancellation/recovery, and permission failures. Cross-device reachability is verified where an authorized second device or equivalent independent client is available; localhost-only checks must not be labelled cross-device proof.

Update `mvp.progress.md` whenever a package changes state, a material test or limitation changes, and periodically during longer implementation. It must distinguish implemented, verified, running, and still-pending capabilities. Local completion is not full v0.1 release certification: the deferred artifact, Grok, external-integration, and release packages remain outside this MVP.

Each implemented package must pass its exact test target from a clean checkout, commit its bounded evidence manifest, and pass `pnpm verify` before handoff. Any deployment within the authorized task requires deployed smoke tests; green CI alone is insufficient.

At the review baseline on 11 September 2026, `pnpm verify` passed: 343 tests, Go checks, and macOS checks. This records the starting point, not acceptance evidence for the proposed capabilities. No runtime implementation or deployment was performed for this plan.
