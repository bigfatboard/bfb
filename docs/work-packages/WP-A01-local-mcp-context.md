# WP-A01 — Run-scoped local MCP and context

Status: `planned`

Risk: Very high

## Outcome

An active local provider process can use stdio MCP to read exactly its run context and perform permitted task/comment/progress/proposal actions without receiving a human, runner, or reusable cloud credential.

## Dependencies

- **Requires:** C08, E01, L01, L03, L05, L06, L08.
- **Unlocks:** A02, A03, D02, L07, P01, P02, V01, X03.
- **Can run with:** E02 and W02 after the run/context contracts freeze.

## Scope

- Implement `bfb mcp stdio` with JSON-RPC stdout only and diagnostics on stderr/local logs.
- Verify peer UID, owned process ancestry/group, active immutable execution assignment/generation, and correlation before creating a provisional connection.
- While L06 has not yet bound a trusted observed provider session, permit only the explicitly safe read-only bootstrap tools needed to load context. Reject every mutation; atomically activate the full run-scoped capability only after the connection observes the matching trusted session binding.
- Create an in-memory capability bound to one stdio connection, assignment, observed session, and workspace/project/task/run. It is never reconstructed from caller-supplied IDs.
- Implement `get_context`, `get_task`, permitted `update_task`, `add_comment`, `report_progress`, and policy-limited `propose_task`.
- Record delivered immutable context version/hash/time/run and recheck current authorization on every retrieval.
- Enforce request IDs, idempotency, optimistic versions, input bounds, and caller-independent boundary derivation.
- Add a durable pending-operation journal for policy-permitted offline business mutations. Persist originating agent-run principal/grant, immutable assignment/session binding, request/idempotency key, expected resource version, bounded payload hash, local capture proof, capture/expiry times, and policy decision; replay through L08 rechecks current runner credential, epoch, run capability, policy, and resource version.
- Close capabilities on revocation, execution end, or accepted result.

## Non-goals

- Remote HTTP MCP, attention tools, result submission, artifact bytes, workspace administration, self-approval, unrestricted enumeration, or cloud bearer credentials in the provider environment.

## Work plan

1. Implement stdio host, provisional read-only state, trusted-session activation, and local process/capability verification.
2. Implement context/read tools and delivered-version recording.
3. Implement bounded write/proposal tools and the fully evidenced offline operation journal.
4. Test cross-run/process/UID/session attacks, revocation, version conflicts, startup race, and stdout purity.

## Acceptance

- Wrong UID/process group/run/task/workspace/assignment/session cannot acquire/use a capability.
- Caller-supplied IDs cannot escape the derived boundary.
- Agent cannot read human-only context, promote a root proposal, administer policy, or launch another root run.
- Initial MCP startup can load context before session binding but every mutation fails until L06 commits the matching trusted binding; a competing session can never activate it.
- Offline operation either returns durable `pending_sync` or visible failure exactly by policy.
- Restarted replay preserves and validates the originating assignment/principal, capture proof, expiry, and request identity; it fails visibly after revocation, execution end, expiry, accepted result, policy change, or version conflict.

## Evidence and handoff

- Commit MCP inspector transcript, provisional/binding race matrix, malicious-process suite, context snapshots, pending-record fixtures, and offline replay results.
- A02/A03/V01 extend the same scoped tool server; they do not introduce another agent credential.

## Risks and decisions

- Provider MCP hosting can alter ancestry. Test per supported provider/version instead of weakening checks globally.
