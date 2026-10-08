# Incident recovery runbook (DLQ, stuck outbox, uploads, containment)

All four recoveries below are Owner-gated, idempotent privileged operations
from [../contracts/operations.md](../contracts/operations.md). Each needs a
fresh action-bound step-up proof for `ops.recover` on target
`ops-recover:<kind>:<workspace>` and runs through
`POST /api/v1/workspaces/:ws/operations/recovery` with
`{request_id, kind, target}`. Replays return the stored outcome from
`ops_recovery_ledger`; a failed recovery is retried only after
`clear_recovery_state` deletes its ledger row.

## 1. Dead-letter queues

Poison messages land in the per-pipeline DLQ (`bfb-jobs-dlq`,
`bfb-notify-dlq`, `bfb-ops-dlq`, each with `-staging`/`-local`/`-selfhost`
siblings) with IDs only, never payloads. Triage:

1. Read the DLQ depth from the Operations surface; the drill records IDs
   and states, never bodies.
2. Fix the root cause in the owning package (consumer bug, bad deploy,
   revoked credential). Do not edit the DLQ row.
3. Requeue with `requeue_github_outbox` (GitHub rows in `dlq` or
   `dispatched` return to `pending` with attempts reset) or the owning
   pipeline's retry; the reconciler converges them exactly once.
4. If the message is permanently invalid, leave it in the DLQ as the
   visible record. There is no silent drop path.

`pnpm test:g02` proves poison-to-DLQ isolation and sibling-sweep
convergence on local fixtures via the X05 drill contract.

## 2. Stuck GitHub outbox

Outbox rows commit to D1 before enqueue, so a crash between commit and
enqueue is a normal state, not data loss. The Cron/GitHub sweep reclaims
them (`reclaimStaleGitHubOutbox`); rows stuck in `dlq` or `dispatched`
return via `requeue_github_outbox`. `done` and `pending` rows are rejected
from requeue: a row that already had its effect is never re-applied.
Duplicate and out-of-order deliveries converge on one effect through the
X04 dedupe the G01 gate proves.

## 3. Stuck artifact uploads

`resolve_stuck_upload` moves only versions in `uploading` with no live
grant past TTL plus grace to `failed`, writing one `artifact.abandoned`
audit-outbox row (the exact V01 abandonment predicate). Live versions and
grants are rejected. Retention afterwards deletes only eligible raw-log R2
objects (`workspaces/<ws>/runs/*/logs/*`); review artifacts,
content-addressed bytes, D1 rows, hashes, and metadata are never eligible.

## 4. Containment and launch recovery

A stuck launch claim (claimed without final authorization for over
`STUCK_LAUNCH_CLAIM_MS`) is visible as stuck; live claims are untouched.
Recovery is explicit and local: `bfb execution recover` re-checks the
original checkout, provider, and lease binding before any retry, and the
supervisor reconciles the local single-use intent first. Cloud links never
carry shell text; the hook launcher path stays `Contents/Helpers/bfb
__launch <terminal-intent-uuid>`.

## After every recovery

Record the recovery kind, action id, replay flag, and outcome next to the
incident id. If the incident involved a secret, rotate it per
[key-rotation.md](key-rotation.md) before closing.
