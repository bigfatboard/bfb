# ADR 0002 — Human-initiated agent discussions

Status: Accepted for local MVP implementation, 11 September 2026

## Context

Timo requested remote task start and a human-initiated discussion between two agents. Ordinary runs advance a ready task into active work; task comments do not express participant turns, delivery acknowledgement, or discussion completion. Reusing those transitions would allow a conversation to alter work state without a human decision.

The follow-up agent-room research supports separating durable discussion state from provider execution and transport. Provider capabilities are changing quickly and must be established by exact-version fixtures rather than inferred from generic MCP support or terminal presence.

## Decision

- Add a first-class discussion linked to a task, with its initiating human, permitted participants, immutable agent-visible brief, Git revision, bounded rounds/deadline, messages, deliveries, turns, and conclusions. D1 remains canonical and all business mutations serialize through WorkspaceHub.
- Give participant runs an explicit discussion purpose. Creating, completing, failing, or cancelling a participant run never advances the parent task's normal work/result lifecycle. Normal work-run semantics remain unchanged.
- Start fresh, named-profile sessions for Claude and Codex in the first version. The enrolled Mac owns these sessions, observes their identities, and serializes exact-session continuation. No user-owned live session is resumed or intercepted. Explicit history-sharing/fork and live-session invitation remain future actions requiring separate consent and tested capabilities.
- Enforce discussion as read-only through provider/tool configuration and tested execution boundaries, not merely a prompt. Inherited tools, MCP servers, hooks, and settings must not silently widen that boundary. Fail closed if the installed provider cannot enforce it.
- Retain checkout occupancy protection and serialize participants that share a physical worktree. Do not create clones/worktrees or change Git state automatically.
- Persist session ownership with a fencing generation and a local execution guard. Track accepted message, dispatch attempt, provider acknowledgement, and correlated turn completion separately. An uncertain external effect after a crash must reconcile or pause; no blind resend.
- Treat peer content as attributed external data, never human authorization. Where a tested native external-message primitive exists it may be used; otherwise a fixed trusted instruction evaluates bounded peer context under unchanged permissions. A peer cannot select executables, paths, tools, permissions, recipients outside the roster, or an unbounded next turn.
- Use independent initial positions followed by controlled exchanges: by default three rounds and at most six participant turns. Enforce deadline, cancellation, authorization, and message/output bounds in BFB. Token budgets are enforced only where the adapter actually supports them.
- Store deliberate discussion messages and structured conclusions, not provider transcripts. Recommendations, evidence references, agreement, disagreements, and questions remain attributable. Human intervention is explicit; a human decision is distinct from an agent recommendation.
- A process exit, completed turn, textual marker, or discussion conclusion never accepts work or authorizes implementation. Starting implementation remains a separate human command.
- Extend L03's provider contract for discussion-turn planning, observed identity, exact-session continuation, output normalization, and capability-tested fork/native delivery. Its early experiment produces synthetic versioned fixtures. The Go runner remains the execution runtime; no third-party room backend or new SDK runtime is adopted implicitly.

## Consequences and proof

D01 owns the records and authorization, D02 owns supervised delivery and recovery, and D03 owns the task-sheet workflow and human decisions. These packages are scheduled after their existing execution/domain prerequisites and cannot consume unfinished dependencies.

Acceptance must cover cross-workspace/participant isolation, read-only enforcement, single-writer/session ownership, wrong or busy session rejection, duplicate and ambiguous delivery, cancellation/deadlines, reconnect, context revision changes, and peer attempts to widen authority. Provider fixtures are bounded and synthetic. Native delivery remains optional unless its exact-version contract passes; unsupported app-server transport is not a production dependency.

This ADR extends the run-purpose and discussion domain. It does not alter tenant isolation, cloud/local trust boundaries, normal task completion, credential ownership, or the separate approval required for production rollout.
