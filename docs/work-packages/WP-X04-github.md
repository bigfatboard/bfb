# WP-X04 — GitHub evidence integration

Status: `planned`

Risk: High

Test target: `pnpm test:x04`

Evidence manifest: `docs/work-packages/evidence/WP-X04/manifest.json`

> Status note: implementation, gate, and evidence are complete and green on
> this branch, but `roadmap:check` rejects any status beyond `planned` while
> a dependency is not `done`. A03 and E01 are merged in this worktree but
> still report `planned`, so this package stays `planned` pending A03 and
> E01. The same note is recorded in `mvp.progress.md` and the Handoff below.

## Outcome

A workspace links one GitHub App installation and repository to one BFB
project, and GitHub branch/commit/PR/check/deployment signals converge into
GitHub-observed evidence while BFB tasks stay canonical and runner claims
keep their own provenance.

## Dependencies

- **Requires:** C01, C03, C04, C07, E01, A03, F03.
- **Unlocks:** X05, G01.
- **Can run with:** L05, E02, V02, D02, P02, A04, L07 recertification (no
  shared unstable contracts or files; D1 migration number `0028` is
  reserved for this package).

## Scope

- D1 migration `0028` only: GitHub App installation, repository link,
  webhook delivery, integration outbox, visible DLQ, GitHub evidence, and
  per-stream reconcile state; exactly-one workspace/project mapping and
  latest-wins convergence enforced by constraints.
- Owner + fresh action-bound step-up management commands: install,
  repository mapping (strengthened by the immutable GitHub repository id),
  permission changes, and removal.
- Least-privilege setup (read-side metadata, PR, check, status, issue,
  and deployment webhook permissions) recorded in code and contract and
  enforced as an allowlist.
- Webhook HMAC verification before parsing; atomic insert of the unique
  received delivery plus integration outbox; enqueue after commit with
  Cron/redelivery recovery for the missed-enqueue gap.
- Installation access tokens minted only when needed, kept short-lived and
  in memory only, never persisted or logged.
- Queue batches with per-message `try/catch` and explicit `ack()`/`retry()`;
  poison messages retire to DLQ state without replaying successful siblings.
- Idempotent reconcile through typed hub commands; link issue, branch,
  commit, PR, check, and deployment evidence while keeping the BFB task
  canonical; preserve runner-observed vs GitHub/CI-verified provenance.
- Frozen contract `docs/contracts/github.md`, recorded fixtures, a local
  GitHub double, and an automated gate across real Workers and D1 with a
  local Queue.

## Non-goals

- No real GitHub App is created, registered, or modified; no issue
  synchronization, PAT storage, PR creation, merge, or deploy.
- No background backfill or full sync; redelivery converges live events.
- No evidence board UI (REST reads only; surfacing is a follow-up).
- No write-side App permissions; granting any needs a later package.

## Contracts

### Consumes

- C01 `WorkspaceHub` lanes, idempotency, boxPods, and durable abuse budgets.
- C03 action-bound step-up proofs (`github.install`, `github.remove`,
  `github.repository.map`, `github.permissions.update`).
- C04 Owner/member/reviewer roles and project grants.
- C07 project and repository identity (`repository_host`,
  `hosted_repository_id`).
- E01 event-ledger and tick→dispatch conventions
  (`docs/contracts/event-ledger.md`).
- A03 generic evidence-reference shape (`docs/contracts/results.md`).
- F03 Queues, Cron, and wrangler substrate
  (`apps/control-worker/wrangler.toml`, `tools/substrate`).

### Produces

- Frozen link and evidence contract `docs/contracts/github.md` (permission
  inventory, webhook/Queue/token semantics, evidence refs, browser routes).
- Stable test target `pnpm test:x04` and evidence-manifest path
  `docs/work-packages/evidence/WP-X04/manifest.json` consumed by
  checkpoint/release automation.

## Work plan

1. Domain kernel (`packages/domain/src/github.ts`), migration `0028`, and
   unit tests — verify with `vitest run packages/domain/test/github.test.ts`.
2. Control Worker webhook, management, Queue, Cron, and token paths plus
   route/queue tests — verify with the worker test files.
3. Contract, recorded fixtures, local double, and the E2E harness —
   verify with `pnpm test:x04` from a clean checkout.

## Acceptance

- Invalid HMAC signatures are rejected before operation parsing.
- A crash after the D1 commit and before enqueue is recovered; the delivery
  is not marked processed early.
- Duplicate and out-of-order webhooks converge to current GitHub state with
  one domain effect.
- An installation/repository maps to exactly one authorized
  workspace/project.
- A non-Owner or a stale/missing step-up cannot install, remap, change
  permissions, or remove.
- Tokens and private keys appear in no D1 row, Queue body, URL, log,
  diagnostic, or retained evidence.
- One poison Queue message retries/DLQs independently; successful siblings
  are acknowledged once.
- BFB task state does not silently follow issue state.
- Runner claims are never upgraded to GitHub/CI verification without
  matching evidence.
- The exact gate passes from a clean checkout: `pnpm test:x04`.

## Evidence

- E2E command result, fault matrix, delivery effects, and token/key canary
  scan indexed by `docs/work-packages/evidence/WP-X04/manifest.json`, which
  conforms to `docs/work-packages/evidence/manifest.schema.json` and records
  the tested commit, protocol/schema heads, environment, commands, outcome,
  and redaction status.
- Evidence is bounded and redacted: no secrets, private keys, tokens, local
  absolute paths, or raw terminal output.

## Risks and decisions

- No real GitHub App exists, so REST behavior is proven against recorded
  fixtures and a local double instead of GitHub; the Handoff lists exactly
  what a real installation needs.
- Queue delivery is at least once and out of order, so reconcile is
  idempotent with a per-stream latest-wins guard rather than relying on
  delivery order.
- Suspended installations park deliveries without state, but `unsuspend`
  and `deleted` lifecycle events flow through so suspension can clear.

## Handoff

- Implementation, gate (`pnpm test:x04`), and evidence are complete on this
  branch; status stays `planned` pending A03 and E01 per the note at the top
  (mirrored in `mvp.progress.md`).
- A real GitHub App installation needs: App permissions exactly the
  read-side inventory in `docs/contracts/github.md` (metadata, pull
  requests, checks, commit statuses, issues, deployments); webhook events
  exactly the subscribed set (installation, installation_repositories, push,
  pull_request, check_run, check_suite, status, issues, deployment,
  deployment_status); webhook secret via `wrangler secret put
  GITHUB_WEBHOOK_SECRET`; App id and private key via `wrangler secret put
  GITHUB_APP_ID` and `wrangler secret put GITHUB_APP_PRIVATE_KEY`;
  `GITHUB_API_BASE` only to point at an enterprise host (default is
  `https://api.github.com`); the `[[queues.consumers]]` wiring in
  `apps/control-worker/wrangler.{toml,staging.toml,production.toml}` (added
  here, not deployed); and an Owner completing install plus repository
  mapping in BFB with fresh step-up before GitHub delivers (unknown
  installations answer `404` with no state; redeliver after install).
- Known limitations: no backfill (map first; historical same-ID redeliveries
  stay `ignored`); prolonged suspension parks deliveries in DLQ (unsuspend
  resumes new events; DLQ rows are visible for ops); duplicate webhook
  replays re-enqueue idempotently; evidence reads are REST-only (no board
  UI yet).
