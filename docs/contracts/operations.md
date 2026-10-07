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

- C11's current delivery policy holds all unsupported audit families. Only the
  certified canonical artifact/dispatch and upload-recovery receipts described
  below are eligible; the historical generic sanitizer is not authority to
  deliver another family. Omission precedes limits, `has_more` and anchors.
  Current Owner/retained-epoch scope still precedes unknown/hidden cursor denial,
  including empty pages. Stored history is unchanged. The
  [C11 delivery contract](private-task-delivery.md) freezes this quarantine.
- `GET /api/v1/workspaces/:ws/operations/security-audit` — Owner only.
  Rows come from `audit_events`, ordered chronologically by `created_at`
  (insertion order breaks ties: audit ids carry no time component, so id
  order is not time order). Paginated with `after`/`limit` (max 100):
  `after` is an `audit_id` cursor resolved to its row's timestamp, so pages
  advance in time, not id space; an unknown cursor is rejected. Each entry
  carries `audit_id`, `actor_principal_id`, `action`, `created_at`, and a
  `payload` passed through the sanitizer below.
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
- C11's bounded artifact-receipt projection requires explicit retained human
  `options.access`, current Owner/epoch scope even for empty pages, and exact
  shared source lineage before pagination. It recognizes only the nine canonical
  artifact actions and their strict dispatch wrapper; unsupported artifact-family
  receipts are unavailable. Canonical source fields replace arbitrary historical
  payloads. Hidden and missing anchors share the existing cursor denial. This
  does not certify unrelated audit families, diagnostics or opaque positions;
  see the [C11 delivery contract](private-task-delivery.md) for the source,
  grant, normalization and final-delivery rules. Internal dispatch/history and
  the browser response/cursor envelope remain unchanged.
  Its [clean checkpoint](../work-packages/evidence/WP-C11/artifact-audit-manifest.json)
  certifies the canonical artifact subset, not the entire audit feed.
- The bounded C11 read projection covers only
  `ops.recovery.resolve_stuck_upload`. Its strict Hub receipt resolves an applied
  same-workspace ledger and every current failed shared/run-free target before
  page, count and anchor delivery. Mixed hidden targets omit the whole receipt;
  reconstructed input arrays retain the current `[redacted]` display. Original
  and target-ledger retry history have distinct actor/time rules. The
  [C11 contract](private-task-delivery.md) freezes normalization and delivery
  boundaries. Its [clean checkpoint](../work-packages/evidence/WP-C11/recovery-audit-manifest.json)
  certifies this subset, not recovery execution or the complete audit feed.
  Its chronology repair uses a normalized internal UTC key in both page and
  anchor comparison, preserving raw display timestamps and insertion-order ties.

## Scoped queue and health projections

C11's bounded read repair follows the [queue/health delivery contract](private-task-delivery.md).
It requires an explicit current Owner/member observer and retained epoch, then
selects all supported visible queue/token totals and hydrated stuck/retention
references together as the final query. Existing response envelopes remain.
Task-bound sources stay shared-only even for private creators/grantees.
Notification operator authority is distinct from recipient/contact authority;
GitHub binds exact outbox/delivery/installation/project/evidence lineage;
applied recovery authorizes every supported target, including legitimate
duplicate notification/GitHub target lists. Unsupported sources are uniformly
excluded, not hidden only when private work exists. Failed recovery and cleared
history lack a retained producer/source contract and contribute zero.

These numbers mean currently visible supported sources, not that physical
queues are drained. Use concise scoped count labels rather than adding default
controls or diagnostic detail. Frozen diagnostic inventory retains its separately
named legacy counts and remains uncertified. No execution or provider authority
changes. Its [clean checkpoint](../work-packages/evidence/WP-C11/operations-aggregate-manifest.json)
certifies these projections, not complete operations privacy.

## Activity read model

Current [C11 public-position policy](private-task-delivery.md) uniformly holds
this route and `readActivityFeed` before source/high-water queries. After
credential/role and pure method/query admission, valid browser requests return
fixed 409 `request_rejected` with `event feeds are unavailable` and no-store.
The UI issues no activity-feed request and shows unavailable history; current
health, supported receipts and explicit commands remain. The row projection
below is retained historical wire, not an available raw-position feed.

- `GET /api/v1/workspaces/:ws/operations/activity` — owner, member, and
  reviewer (reviewers are filtered to their projects). Rows come from
  `event_ledger` (`workspace_cursor`, `kind`, `actor_type`, `actor_id`,
  `source_id`, `source_provider`, `project_id`, `task_id`, `run_id`,
  `occurred_at`, `received_at`). Ledger `payload_json` is excluded by
  construction and never leaves this endpoint.

## Privileged recovery

Current C11 policy holds `retry_notification_dispatch`, `requeue_github_outbox`
and `clear_recovery_state`. After existing current Owner/admission and pure
structural checks, the browser returns fixed 409 `request_rejected` with
`recovery kind is unavailable`, before proof, target, ledger or cached-outcome
access. The exported helper rejects them before all database access. Proofs,
watermarks, outbox, ledger, audit and ordinary consumers remain unchanged.
Only proof-bound upload recovery is available; no new recovery UI is added.

The following records historical v1 effects for the three held kinds, not a
working outside-Hub recovery path after quarantine:

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
    reconciler converges them. Done/pending rows are rejected. Every id is
    validated before the first write, so a rejected target leaves all rows
    untouched and writes no ledger row.
  - `resolve_stuck_upload` `{version_ids: ULID[1..50]}` — only versions in
    `uploading` beyond TTL plus grace, with no grant expiry within the
    five-minute grace even when consumed, move to `failed`,
    with an `artifact.abandoned` audit-outbox row (the exact V01
    abandonment predicate). Anything else is rejected.
  - `clear_recovery_state` `{action_ids: string[1..50]}` — deletes ledger
    rows so a failed recovery can be attempted again.
- Each historical recovery writes one `audit_events` row (`ops.recover`) with
  the sanitized kind, action id, and replay flag. The C11 Hub command writes
  its safe command-named audit receipt in the atomic batch instead.
- Historical recovery runs outside hub transactions because its effects
  interleave reads and writes. C11 narrows this exception for stuck-upload
  resolution: `ops.recovery.resolve_stuck_upload` reads all targets before
  queuing writes, and serializes through WorkspaceHub. Its proof, current
  authority/state guards, artifact effects, target ledger and safe Hub audit
  commit atomically. The other three kinds are unavailable under the C11 policy.
- The C11 command accepts `{versionIds, stepUpProofId}` while the browser keeps
  the existing recovery body and nested result shape. It rejects Hub cache
  replay, uses a request/proof-bound key and requires a fresh proof for each
  target-ledger retry. Current Owner/retained epoch and shared-parent contribution
  authority apply on fresh and stored outcomes; genuine run-free uploads use
  workspace authority. The old unguarded resolution branch is unavailable.
  Private, absent and non-stuck targets have one resource denial. A stored
  outcome must match kind/target and a closed resolved-count result, with current
  failed targets, before delivery. The browser rechecks after Hub response
  hydration. Later revocation hides stale success without reversing valid
  committed work. See the [C11 contract](private-task-delivery.md) for the
  checkpoint and remaining activation limits.

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
  metadata are never eligible. Already purged versions (state `retained`)
  are never eligible again.
- C11 tightens human retention reads to an explicit current owner/member access
  context and shared-only exact version→artifact→run→task/project lineage. Keys
  must equal `workspaces/<ws>/runs/<run>/logs/<version>.jsonl.zst`; run-free logs,
  dangling parents and mismatched keys are omitted before read counts. Health
  rechecks eligible references with stuck work in its final selection.
- Configured system selection is separately named and requires a configured
  policy plus exact lineage/key binding; no missing human context implies Owner
  read access. Existing configured workspace-policy authority is not human
  authority. Private destructive retention, its lifecycle/count projections and
  full operations privacy remain uncertified; this slice does not change R2
  deletion or version marking.
- The Cron sweep (`runRetentionSweep`, also deliverable as an OPS queue
  `retention.sweep` message) deletes only eligible R2 objects, moves each
  purged version to `retained` with its hash, key, and metadata preserved
  as the purge record, records one `retention_runs` row per configured
  workspace, and never deletes without an explicit Owner-configured
  policy. Only the transition counts bytes, so a `retained` row is never
  re-deleted or re-counted and its view grants stop redeeming. A failed
  object delete keeps the version `available` for the next tick and is
  recorded in the run row, never retried blindly.

## Diagnostic bundles

C11 clean-certifies a [uniform diagnostic snapshot quarantine](private-task-delivery.md)
at source `03c0b81`. After existing authority and structural gates,
browser list/detail/generation/consent use fixed 409 `request_rejected` with
`diagnostic bundles are unavailable`. Both Hub commands deny before cache/proof
effects; production inventory/body rendering and diagnostic queue uploads are
unavailable. Valid diagnostic jobs acknowledge without storage/DLQ effects.
Diagnostic audit/semantic copies are omitted before page/anchor/limit selection.
Rows and stored objects remain unchanged; no private-presence branch or body
schema claim confers authority. The UI shows an unavailable state without
mutation controls or requests. Its
[bounded checkpoint](../work-packages/evidence/WP-C11/diagnostic-manifest.json)
does not certify a source-backed replacement format or complete C11 delivery.

The following records the historical v1 behavior, not an enabled private-safe
snapshot contract after the quarantine repair:

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
  - `uploads.stuck`: uploading versions older than the 15-minute TTL plus
    five-minute grace, with no grant expiry within that grace even when consumed
    (the same predicate as the V01 sweep).
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
- The drill retains dated evidence only at its original `0034_operations`
  migration head. Current-head regression runs report bounded scenario outcomes
  to their command log; they do not replace the historical package certificate.

Routine X05 browser captures use ignored test output. The owning
`BFB_CAPTURE_X05_EVIDENCE=1 BFB_E2E_PORT=4196 pnpm exec playwright test apps/web/test/e2e/x05-operations.spec.ts --config tools/e2e/playwright.config.ts`
command explicitly updates
the historical browser evidence path; ordinary regression runs preserve it.
