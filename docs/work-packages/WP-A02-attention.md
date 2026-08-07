# WP-A02 — Human attention workflow

Status: `planned`

Risk: High

## Outcome

An agent can request a typed human decision, a permitted human can answer it from the cross-project Attention view, and the agent can wait briefly or retrieve the durable answer later.

## Dependencies

- **Requires:** A01, E02, W01.
- **Unlocks:** A04, X01, X02, X03.
- **Can run with:** A03 after shared run-state mutations freeze.

## Scope

- Add attention request kind, referenced immutable object, required permission, blocking flag, open/answered/resolved state, answer, and timestamps.
- Add MCP `request_human`, `get_attention`, and 30-second bounded `wait_for_attention`.
- Add human answer/resolution API with permission recheck and optimistic version.
- Build ranked cross-project Attention home with clarification, review, credential/capability, destructive-action, and blocker distinctions.
- Add in-app signaling and runner notification of committed answers; X01 owns external delivery.
- Commit first-response and final-resolution timestamps plus uniquely identified raw observations; A04 owns latency derivation, aggregation, and display.
- Keep provider-native permission dialogs distinct and never claim BFB can answer them uniformly.

## Non-goals

- Remote native permission approval, infinite Worker waits, notification transport, or treating any human answer as privileged authorization.

## Work plan

1. Add attention migrations/state/permission tests.
2. Implement MCP request/get/wait and durable answer APIs.
3. Build ranked Attention UI and run integration.
4. Test permission mismatches, disconnect/reconnect, duplicate answers, timeout/retry, and revocation.

## Acceptance

- Agent requests attention, permitted human answers, current waiter returns, and later retrieval returns identical resolution metadata.
- Wait returns pending within 30 seconds and can be repeated safely.
- Reviewer can answer a clarification/review request but cannot satisfy an owner-only policy/credential approval.
- Duplicate answer attempts do not overwrite the committed response silently.
- An answer survives disconnect and is not dependent on WebSocket delivery.
- Native provider permission remains visibly separate.

## Evidence and handoff

- Commit end-to-end recording, permission matrix, timeout/reconnect trace, and raw timing observations consumed by A04.
- X01 consumes actionable committed events; it does not own attention truth.

## Risks and decisions

- Ranking must remain explainable and deterministic in v0.1; avoid an opaque AI priority model.
