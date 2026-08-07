# WP-X01 — Actionable notifications

Status: `planned`

Risk: Medium

## Outcome

Humans receive deduplicated browser/macOS notifications for actionable committed events without turning normal agent telemetry into noise.

## Dependencies

- **Requires:** A02, A03, E02, L04.
- **Unlocks:** G01, X05.
- **Can run with:** P01/P02/X04 after event kinds freeze.

## Scope

- Add notification subscriptions/preferences and delivery bookkeeping.
- Deliver attention requested, launch blocked, run failed, and configured result submitted/accepted events. Here “review requested” means the A03 result submission that moves a task into review; artifact-specific review workflow remains owned by V03 and may request attention through A02.
- Implement Browser Push and native macOS notification delivery with exact workspace/project access recheck.
- Use Queue/DLQ for retryable delivery; stable delivery identity makes retries idempotent.
- Deep-link only to authorized BFB objects or opaque local wake intents.
- Suppress ordinary tool/turn/heartbeat events by default.
- Add per-user/workspace/project/channel preferences and revocation cleanup.

## Non-goals

- Transactional email, Slack/Teams, native provider permission approval, or notification state as durable domain truth.
- A separate artifact-review notification state machine or a dependency on uncommitted V03 event kinds.

## Work plan

1. Add subscription/preference/delivery records and event selection.
2. Implement Browser Push and macOS delivery adapters.
3. Add Queue/DLQ retry/dedupe and revoked-access checks.
4. Test duplicates, out-of-order events, disabled preferences, expired endpoints, and malicious deep links.

## Acceptance

- One committed actionable event produces at most one logical delivery per channel despite Queue retries.
- The event-selection fixture covers A02 attention and each retained A03 result/review transition without requiring V03-specific events.
- Revoked/inaccessible objects never appear in a notification.
- Ordinary telemetry generates no notification by default.
- Deep links contain no task text, local path, token, command, or provider arguments.
- Failed endpoints retry/bound/fall to visible DLQ without blocking product commands.

## Evidence and handoff

- Commit delivery fixture matrix, duplicate/revocation traces, and browser/macOS captures.
- G01 verifies notifications remain non-authoritative and non-blocking.

## Risks and decisions

- Notification usefulness depends more on filtering than delivery volume. Defaults stay sparse.
