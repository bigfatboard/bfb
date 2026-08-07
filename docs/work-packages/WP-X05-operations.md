# WP-X05 — Operations, audit, and retention

Status: `planned`

Risk: High

## Outcome

Owners can inspect security-relevant changes, failed background work, runner/integration health, retention state, and diagnostics without exposing product secrets or private payloads.

## Dependencies

- **Requires:** C01, C03, C04, C06, C07, C08, C09, E01, L01, L02, L03, L08, V01, W01, X01, X04.
- **Unlocks:** G01, G02.
- **Can run with:** X02/X03 after audit/event schemas freeze.

## Scope

- Build Operations UI for the implemented members/grants/runners/checkouts/policies, GitHub integration, notifications, retention, and audit surfaces.
- Add query/read models for security audit distinct from ordinary activity.
- Configure Queue/DLQ visibility, retry controls, and durable integration/audit outbox monitoring.
- Configure Cron for outbox dispatch, missed nudges, stuck uploads, independently keyed raw-log retention, and notification recovery.
- Implement retention policy metadata and delete only eligible raw log chunks; retain immutable hashes/metadata and artifact blobs in v0.1.
- Add structured Cloud/local diagnostics with strict redaction and explicit diagnostic-bundle inventory/consent.
- Add health checks for migrations, bindings, queue lag, stuck commands/uploads, token/key rotation, and the generic provider integration records exposed by L03; provider-specific packages remain responsible for populating their records.
- Require Owner authorization plus fresh action-bound step-up for retrying privileged jobs, clearing recovery state, changing retention, or generating/uploading a diagnostic bundle.

## Non-goals

- Using sampled logs as exact product metrics, hard-deleting audit/events/reviews/artifact versions, artifact blob GC, or silently uploading diagnostic bundles.

## Work plan

1. Implement audit/operations read models and permission-aware UI.
2. Add DLQ/outbox/Cron health and bounded step-up-protected recovery actions.
3. Add retention and diagnostic bundle flows.
4. Scan logs/bundles for secrets/content and drill stuck job/upload/command conditions.

## Acceptance

- Only Owners see security audit and privileged recovery actions.
- Privileged recovery, retention changes, and diagnostic generation/upload fail with stale, replayed, missing, or action-mismatched step-up proof.
- Activity and security audit remain distinct and attributable.
- DLQ/stuck outbox/upload/launch conditions become visible and recoverable/idempotent.
- Retention removes only eligible raw chunks and never shared artifact hashes.
- Logs/bundles exclude cookies, bearer/grant secrets, task bodies, prompts, paths, hook payloads, artifact bytes, and terminal output.
- Diagnostic upload requires explicit inventory review and action.

## Evidence and handoff

- Commit operational drill results, redaction scan, retention fixtures, and Operations UI recording.
- G02 consumes runbooks/health endpoints; it does not invent operational behavior at release time.

## Risks and decisions

- Core packages must emit audit facts when they implement mutations; this package cannot retrofit missing audit correctness later.
