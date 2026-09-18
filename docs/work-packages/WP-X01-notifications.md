# WP-X01 — Actionable notifications

Status: `done`

Risk: Medium

Test target: `pnpm test:x01`

Evidence manifest: `docs/work-packages/evidence/WP-X01/manifest.json`

> Settled 18 September: `done` — `pnpm test:x01` passed in a detached clean
> checkout at `9372c0f`; see Handoff.

## Outcome

Humans receive deduplicated browser/macOS notifications for actionable committed events without turning normal agent telemetry into noise.

## Contracts

### Consumes

- A02 attention records and `attention.request`/`attention.answer`/`attention.resolve` semantic events as the notification trigger source; X01 owns no attention truth.
- A03 result submission/review transitions (`submitted`, `accepted`, `failed`, changes requested, cancelled) as trigger sources; artifact-specific review workflow stays with V03.
- L04 macOS pull/ack transport boundary for the signed poller path proven by the bridge proof.

### Produces

- Actionable notification selection and delivery, frozen in `docs/contracts/notifications.md`: `0030_notifications` records, `selectNotificationEvent` over retained A02 attention and A03 result/review transitions, stable ULID-shaped delivery identity, per-user/workspace/project/channel preferences, and revocation purge.
- Stable test target `pnpm test:x01` and evidence manifest `docs/work-packages/evidence/WP-X01/manifest.json`.
- `packages/domain/src/notifications.ts`: event selection, delivery identity, deep links, preference resolution, fan-out with `INSERT OR IGNORE`, and access rechecks consumed by dispatch, routes, and the harness.
- `apps/control-worker/src/notifications/`: WebPush delivery with VAPID, the `bfb-notify-*` Queue/DLQ consumer with per-message isolation and explicit ack/retry, outbox dispatch with watermark, and the expired/revoked/suppressed sweep.
- `apps/control-worker/src/api/notifications.ts` and `notification-runner.ts`: subscription/preference/delivery routes and the signed macOS pull/ack transport.
- `internal/notify/notify.go`: the macOS poller; `internal/appbridge/notify_x01_test.go`: the bridge proof; the runner manager hook for wake intents.
- `tools/notifications/run.ts`: the real-Worker/D1/Queue harness writing `recording.jsonl`, with a fake push origin and a DLQ collector observing every delivery.

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

- `docs/work-packages/evidence/WP-X01/manifest.json` indexes the tested commit, migration head, toolchains, commands, and redaction status per the evidence manifest schema.
- `recording.jsonl` traces one end-to-end run across real Workers, D1, and a local Queue with DLQ (migration fresh and upgrade, seed, attention push plus macOS pull/ack with duplicate convergence, submit/accept/fail/changes/cancelled-defaults, launch-blocked, telemetry silence, revocation purge, poison-to-DLQ, expired-endpoint delete, canary redaction scan) with cursors, counts, and link shapes only.
- `command-result.json` records the `pnpm test:x01`, `pnpm verify`, `pnpm worktree:check`, Linux cross-build, and clean-checkout gate outcomes.
- Evidence contains synthetic identities only: no secret, VAPID private key, push endpoint, task body, local absolute path, environment value, or raw terminal output.
- G01 verifies notifications remain non-authoritative and non-blocking.

## Handoff

- Settled 18 September: `done`. A02, A03, and E02 are `done`, and `pnpm test:x01` passed in a detached clean checkout at `9372c0f` (install, build, exact target with the real-Worker/D1/Queue harness). The evidence manifest is re-based on that rerun; the implementation evidence stays listed as manifest artifacts. Structural repair in this flip: the package declared its contract under a `## Produces` heading with no `### Consumes`, which `pnpm roadmap:check` rejects for any status beyond `planned`. It now uses a `## Contracts` section with `### Consumes` (A02/A03 trigger sources and the L04 pull/ack boundary, all restated from the Scope and Handoff) and the unchanged `### Produces` content; no product claim was added.
- Commands: `pnpm test:x01`; `pnpm verify`; `pnpm worktree:check`. The Worker/D1/Queue flow is `tools/notifications/run.ts`; the macOS poller cases are `internal/notify/notify_test.go` and the bridge proof is `internal/appbridge/notify_x01_test.go`.
- X04 shares the Queue/DLQ machinery with distinct additive `bfb-notify-*` names and consumer registrations; X01 consumes committed `attention.request` and A03 result events and never notification state as domain truth.
- X05 consumes the delivery records and DLQ visibility; notification content stays redacted and preference-gated.

## Risks and decisions

- Notification usefulness depends more on filtering than delivery volume. Defaults stay sparse.
- The `bfb-notify-*` queues and consumers are additive and distinct from X04's GitHub queues, so parallel Queue work does not collide.
- Unconfigured VAPID is terminal per endpoint, expired endpoints delete without retry, and revoked or suppressed recipients recheck at send time, so access loss converges without blocking product commands.
