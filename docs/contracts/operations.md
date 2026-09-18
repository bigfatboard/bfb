# Operations contract (WP-X05)

Status: frozen for v0.1. Changes require a work package and a contract revision.

X05 owns the Operations surface: role-gated audit and activity reads,
privileged recovery, retention policy and sweep, redacted diagnostic bundles,
and workspace health. It consumes C01 (command kernel, audit rows, abuse
budgets), C03 (fresh action-bound step-up), C04 (roles), C06 to C09
(runner, project, work, launch records), E01 (event ledger), L01 to L03 and
L08 (daemon, checkout, provider integration records), V01 (artifact hashes
and metadata that retention must keep), W01 (product shell), X01 (delivery
and DLQ rows), and X04 (GitHub outbox and DLQ rows). Provider-specific
packages remain responsible for populating their integration records; X05
reads them generically (presence, freshness, status enum) and never
interprets provider-specific capability fields.

## Security-audit read model

- `GET /api/v1/workspaces/:ws/operations/security-audit` — Owner only.
  Rows come from `audit_events`, ordered by `audit_id`, paginated with
  `after`/`limit` (max 100). Each entry carries `audit_id`,
  `actor_principal_id`, `action`, `created_at`, and a `payload` passed
  through the sanitizer below.
- The sanitizer drops any key naming a secret, path, or private payload
  (secret, token, bearer, cookie, password, credential, grant secrets,
  prompts, task bodies, hook payloads, terminal output, artifact bytes,
  paths, executables) and any free-text content key (title, body, text,
  question, answer, comment, description, summary, prompt, instruction,
  brief, transcript, output, payload, message, label) except identifier
  suffixes (`*_hash`, `*_id`, `*_at`, `*_cursor`, `*_count`, `*_version`,
  `*_epoch`). Strings longer than 256 chars or matching a prohibited
  pattern (cookies, bearer secrets, private keys, `gh[pousr]_` tokens,
  webhook/VAPID markers, local absolute paths, launch commands) become
  `[redacted]`. Nested objects and arrays are summarized by shape beyond
  depth 2, 25 keys, or 25 items.

## Activity read model

- `GET /api/v1/workspaces/:ws/operations/activity` — owner, member, and
  reviewer (reviewers are filtered to their projects). Rows come from
  `event_ledger` (`workspace_cursor`, `kind`, `actor_type`, `actor_id`,
  `source_id`, `source_provider`, `project_id`, `task_id`, `run_id`,
  `occurred_at`, `received_at`). Ledger `payload_json` is excluded by
  construction and never leaves this endpoint.

## Privileged recovery

- `POST /api/v1/workspaces/:ws/operations/recovery` — Owner plus a fresh
  action-bound step-up proof for action `ops.recover` and target
  `ops-recover:<kind>:<workspace>`. Body: `request_id`, `kind`, `target`.
- Kinds and effects (all idempotent via `ops_recovery_ledger`, whose
  `action_id` is `ops:<kind>:<sha256hex(canonical target)[:32]>`):
  - `retry_notification_dispatch` `{cursors: number[1..50]}` — every cursor
    must exist in `semantic_events`; rewinds
    `notification_dispatch_state.last_cursor` to `min(cursors) - 1` so X01's
    own idempotent dispatch redelivers. Replays return the stored outcome.
  - `requeue_github_outbox` `{outbox_ids: string[1..50]}` — only rows in
    `dlq` or `dispatched` return to `pending` with attempts reset; the X04
    reconciler converges them. Done/pending rows are rejected.
  - `resolve_stuck_upload` `{version_ids: ULID[1..50]}` — only versions in
    `uploading` with no live grant past TTL plus grace move to `failed`,
    with an `artifact.abandoned` audit-outbox row (the exact V01
    abandonment predicate). Anything else is rejected.
  - `clear_recovery_state` `{action_ids: string[1..50]}` — deletes ledger
    rows so a failed recovery can be attempted again.
- Every recovery writes one `audit_events` row (`ops.recover`) with the
  sanitized kind, action id, and replay flag.
- Recovery runs outside hub transactions (D1 batches forbid reads after a
  queued write); the step-up consume uses the same single-winner guarded
  UPDATE the hub commands use.

## Retention policy and sweep

- `GET /api/v1/workspaces/:ws/operations/retention` — owner/member. Shows
  the policy (default 30 days when unconfigured) and the currently
  eligible chunks with the cutoff.
- `PUT .../retention` — Owner plus step-up `ops.retention` on target
  `ops-retention:<workspace>`. Window is an integer 1 to 365 days; each
  change bumps the policy version and writes a hub audit row.
- Eligibility is narrow: `artifacts.role = 'log'`, version state
  `available`, `available_at` older than the cutoff, key under
  `workspaces/<ws>/runs/*/logs/*`, never under `artifacts/sha256/`.
  Review artifacts, shared content-addressed bytes, D1 rows, hashes, and
  metadata are never eligible.
- The Cron sweep (`runRetentionSweep`, also deliverable as an OPS queue
  `retention.sweep` message) deletes only eligible R2 objects, records one
  `retention_runs` row per configured workspace, and never deletes without
  an explicit Owner-configured policy. A failed object delete is recorded
  in the run row, never retried blindly.

## Diagnostic bundles

- `POST .../diagnostics` — Owner plus step-up `diagnostic.generate` on
  target `diagnostic:generate:<workspace>`. Builds the explicit inventory
  (sections `identity`, `work`, `delivery`, `execution`, `integrations`;
  counts and cursors only), scans the rendered JSON for prohibited content,
  and stores the bundle as `pending_consent` with a 24h expiry. A scan hit
  aborts generation.
- `GET .../diagnostics` and `GET .../diagnostics/:id` — owner/member. The
  inventory is the explicit consent record: reviewers see section names
  and field counts before anyone may consent.
- `POST .../diagnostics/:id/consent` — Owner plus step-up
  `diagnostic.upload` on target `diagnostic:<bundleId>`. Moves
  `pending_consent` to `consented` (idempotent with a fresh proof) and
  enqueues one stable `diagnostic.upload` job (`x05:<ws>:<bundle>`).
- The OPS consumer re-scans the stored inventory, writes it to
  `workspaces/<ws>/diagnostics/<bundle>.json`, and marks the bundle
  `uploaded`. Failures park the bundle as `failed` with a bounded code and
  forward an IDs-only copy to the OPS DLQ. There is no external upload
  destination in v0.1 by design: no silent exfiltration path exists.
- Bundles never contain cookies, bearer/grant secrets, task bodies,
  prompts, paths, hook payloads, artifact bytes, or terminal output.

## Health-check contract

- `GET /api/v1/workspaces/:ws/operations/health` — owner/member. Returns
  `health` (schema_version 1) plus `migrations` (`ok`, `missing`).
- Checks, all computed from committed rows at read time (no sampled logs
  presented as exact metrics):
  - `migrations`: every table the operations surface reads is present.
  - `retention`: configured flag, days, policy version, eligible chunks.
  - `queues`: pending/dead-lettered/failed notification deliveries;
    pending/stale-dispatched/DLQ GitHub outbox rows; applied/failed
    recovery ledger rows.
  - `launches.stuck`: pending commands past expiry; claimed commands
    without final authorization older than 10 minutes.
  - `uploads.stuck`: uploading versions with no live grant past the
    15-minute grant TTL plus 5-minute grace (same predicate as the V01 sweep).
  - `tokens`: runner tokens revoked-null and expiring within 24h; active
    API key bindings. Secret/key presence (VAPID, webhook, auth keys) is
    reported as configured flags by the Worker, never values.
  - `providers`: one entry per unrevoked runner — inventory present flag,
    received age, stale flag (older than 5 minutes), and the generic
    provider list (provider, status, version, observed age, expired flag).
- Queue lag is reported as pending-row counts plus the oldest stuck age;
  the Worker additionally reports binding presence.

## Queues, DLQ, and Cron

- X05 owns `bfb-ops(-staging|-local)?` and `bfb-ops-dlq(-staging|-local)?`
  with `OPS_JOBS`/`OPS_DLQ` bindings, a bounded consumer batch (10, 5s,
  5 retries), and per-message isolation: one poison job retries into the
  DLQ without replaying successful siblings.
- The existing `*/5 * * * *` Cron also runs the operations sweep
  (retention plus bundle expiry) in its own isolated step; an operations
  failure never blocks the artifact, GitHub, or notification sweeps.

## Test target and evidence

- Test target: `pnpm test:x05`.
- Evidence manifest: `docs/work-packages/evidence/WP-X05/manifest.json`.
