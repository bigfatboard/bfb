# WP-X04 — GitHub evidence integration

Status: `planned`

Risk: High

## Outcome

BFB links immutable GitHub repository identity and read-side branch/commit/PR/check evidence to work without making GitHub Issues the task system.

## Dependencies

- **Requires:** A03, C01, C03, C04, C07, E01, F03.
- **Unlocks:** G01, X05.
- **Can run with:** P01/P02/X01 after event contracts freeze.

## Scope

- Add GitHub App installation/repository/link/webhook-delivery/integration-outbox records.
- Restrict GitHub App install, repository mapping, permission changes, and removal to Owners with fresh action-bound step-up.
- Request only repository metadata and selected read-side pull request/check/status/issue webhook permissions.
- Verify webhook HMAC before parsing.
- Atomically insert unique received delivery plus integration outbox; enqueue after commit and recover missed enqueue by Cron/redelivery.
- Mint installation access tokens only when needed, keep them short-lived and in memory, and never persist or log the token or App private key.
- Consume Queue batches with per-message `try/catch` and explicit `ack()`/`retry()`; poison messages exhaust into visible DLQ state without replaying successful siblings.
- Reconcile current GitHub state idempotently through typed hub commands.
- Link issue, branch, commit, PR, check, or deployment evidence while keeping BFB task canonical.
- Preserve runner-observed vs GitHub/CI-verified provenance.
- Use immutable GitHub repository ID to strengthen checkout/project identity.

## Non-goals

- Full issue synchronization, PAT storage, PR creation, merge, deploy, or write permissions without a later explicit action.

## Work plan

1. Add App installation/link/delivery/outbox migrations, Owner/step-up management commands, and least-privilege setup.
2. Implement HMAC receive + D1 outbox + Queue dispatch/recovery.
3. Implement short-lived token acquisition, per-message Queue disposition, idempotent reconcile, and evidence UI/API.
4. Test duplicates, out-of-order delivery, D1/Queue crash gap, poison-message isolation/DLQ, revoked installation, repository remap, and management authorization.

## Acceptance

- Invalid HMAC is rejected before operation parsing.
- Crash after D1 commit/before Queue enqueue is recovered; delivery is not marked processed early.
- Duplicate/out-of-order webhooks converge to current GitHub state with one domain effect.
- Installation/repository maps to exactly one authorized workspace/project.
- Non-Owner or stale/missing step-up cannot install, remap, change permissions, or remove the GitHub App.
- Installation tokens and the App private key appear in no D1 row, Queue body, URL, log, diagnostic, or retained evidence.
- One poison Queue message retries/DLQs independently while successful siblings are acknowledged once.
- BFB task state does not silently follow issue state.
- Runner claims are never upgraded to GitHub/CI verification without matching evidence.

## Evidence and handoff

- Commit webhook/Queue fault traces, management authorization matrix, token canary scan, permission inventory, reconciliation fixtures, and provenance screenshots.
- G01 exercises redelivery/revocation and confirms no write-side GitHub authority.

## Risks and decisions

- D1 and Queue do not share a transaction; the durable outbox is mandatory.
