# GitHub evidence integration (X04)

| Version | Date | Change |
| --- | --- | --- |
| 1 | 2026-09-18 | Freeze link, webhook, Queue, token, and evidence rules. |

Consumers: X05 (audit/retention), G01 (redelivery/revocation hardening).

This contract freezes the GitHub App link and read-side evidence surface.
BFB links immutable GitHub repository identity and branch/commit/PR/check
evidence to work; GitHub Issues are never the task system and BFB task state
never follows issue state. No real GitHub App exists yet: the REST shapes
below follow GitHub's documented App, installation-token, and webhook
semantics and are proven against recorded fixtures plus a local double. D1
migration head after this package is `0028_github_integration`.

## Permission inventory (least privilege, frozen)

The App requests read-side metadata only. Install and permission-change
commands reject anything outside this table; no write permission may be
granted without a later package.

| Permission | Access |
| --- | --- |
| `metadata` | `read` |
| `pull_requests` | `read` |
| `checks` | `read` |
| `commit_statuses` | `read` |
| `issues` | `read` |
| `deployments` | `read` |

Subscribed webhook events: `installation`, `installation_repositories`,
`push`, `pull_request`, `check_run`, `check_suite`, `status`, `issues`,
`deployment`, `deployment_status`.

## Hub commands

All commands run on the workspace lane (`WorkspaceHub`); reads go directly
to D1.

- `github.install` (Owner + fresh `github.install` step-up bound to
  `github-installation:<installation_id>`): registers one installation as
  `pending`. Rejects permissions/events outside the inventory above.
- `github.remove` (Owner + fresh `github.remove` step-up): flips the
  installation to `revoked` and closes its repository links atomically.
- `github.repository.map` (Owner + fresh `github.repository.map` step-up
  bound to `github-link:<repository_id>`): links one repository to one
  project. Requires an `active` installation and requires the project to
  already declare `repository_host: github.com` with the identical immutable
  `hosted_repository_id`; otherwise `repository_identity_mismatch`. Remap
  closes the previous active link for the repository or the project first, so
  exactly one active link exists per repository and per project (partial
  unique indexes backstop the command).
- `github.permissions.update` (Owner + fresh `github.permissions.update`
  step-up, version-guarded): replaces the recorded permission/event set
  within the inventory.
- `github.webhook.receive` (system actor `github-webhook`): atomically
  inserts one unique received delivery plus its `github.reconcile` outbox
  row. Unknown installations fail with `unknown_installation` and commit
  nothing; suspended installations fail without state (GitHub redelivery
  converges later); revoked installations record one `ignored` delivery and
  no outbox row. Duplicate delivery ids return the stored outcome with no
  new effect.
- `github.reconcile` (system actor `github-queue`): converges one delivery
  to current GitHub state. The per-repository, per-stream latest-wins guard
  (`code`, `pull`, `check`, `issue`, `release`) marks stale deliveries
  `superseded` without writes; unmapped repositories are `ignored`;
  exhausted attempts move to visible `github_dlq` state.
  `installation.created` flips `pending` to `active`, `deleted` revokes and
  closes links, `suspend`/`unsuspend` move between `active` and `suspended`.
  `installation_repositories` is recorded only: repository mapping stays
  Owner-only.
- `github.evidence.link` (owner/member with project access): records a
  `runner`- or `human`-observed evidence row, optionally bound to a task in
  the same project. The `github` observer is reserved for reconcile, and no
  command in this package writes task, run, or result state.

## Webhook route

`POST /webhooks/github` (no browser cookie; `credential_confusion` otherwise):

1. Durable attempt budgets (IP plus installation dimensions), then the raw
   body is read with a 262,144-byte bound.
2. `x-hub-signature-256` (`sha256=` HMAC over the exact raw bytes) is
   verified before any JSON parsing. Failures are `401`; oversized bodies
   are `413`; the budget is a uniform `403`.
3. `x-github-event` outside the subscribed set is acknowledged `202` with
   no state. Malformed JSON is `400`; unknown installations are `404` with
   no state.
4. The receive command commits delivery plus outbox atomically, and only
   then the route sends `{schema_version: 1, kind:
   "github.outbox.dispatch", workspace_id, outbox_id, delivery_id, attempt}`
   to the `JOBS` queue and answers `202`. Queue messages carry bounded IDs
   only: never a token, a private key, or a payload body. Suspended
   installations fail without state (`503`) except the `unsuspend` and
   `deleted` lifecycle events, which flow through so suspension can clear.

## Queue and Cron

- The consumer isolates every message with its own `try/catch` and calls
  per-message `ack()`/`retry()`; one failure never replays successful
  siblings. Malformed envelopes retry into the platform DLQ; well-formed but
  unprocessable messages are recorded in `github_dlq` and acked.
- Retryable GitHub outages increment the outbox attempt counter with
  backoff (`60 * 2^attempts`, capped at 30 minutes); attempts past 5 park
  the message in `github_dlq` with the delivery marked `failed`.
- The 5-minute Cron trigger claims due `pending` rows (the
  D1-commit-before-enqueue crash gap, including lost Queue messages via
  stale `dispatched` rows) and re-sends them, bounded to 25 rows per tick.
- Queue delivery is at least once and out of order: reconcile is idempotent
  and the latest-wins guard gives one domain effect per delivery set.

## Installation tokens

- Installation access tokens are minted only when a live repository delivery
  needs a GitHub REST read (lifecycle events reconcile with no token).
- Tokens live in worker memory with at most a 10-minute cache entry; they
  are never written to D1, Queue bodies, URLs, logs, or diagnostics. The App
  private key arrives only as a Worker secret and is used only to sign the
  short-lived App JWT for the token endpoint.
- A `401`/`403`/`404` from GitHub marks the installation revoked, closes
  its links, and records later deliveries ignored without minting again.

## Evidence and provenance

- `github_evidence` rows bind `(project, optional task, repository, kind,
  ref, version_token, state)` with observer `github`, `runner`, or `human`.
  Runner and GitHub observations are separate rows; reconcile upserts only
  the `github` row and never rewrites runner claims.
- Result-submission refs use `kind: "github"` with
  `ref: "github:<repository_id>:<kind>:<name>"`. Verification resolves to
  `github_verified` only with a matching `github`-observed row (and a
  matching version when the ref carries one); a runner-only row resolves to
  `runner_observed`; anything else is `unverified`. Non-`github` kinds stay
  `opaque` per the results contract.
- BFB task state never follows issue state: `issues` events upsert issue
  evidence only.

## Browser routes

All under `/api/v1/workspaces/:ws/github` (browser session + CSRF; bearer
confusion rejected by the shared router):

- `POST /installations`, `POST /installations/:id/remove`,
  `POST /installations/:id/permissions`, `POST /repository-links`:
  Owner-only mutations with per-request idempotency keys and fresh step-up
  proofs, forwarded into the hub commands above.
- `POST /evidence/links` (owner/member), `POST /evidence/verification`
  (owner/member/reviewer), `GET /status` (owner/member),
  `GET /evidence?project_id=&task_id=&repository_id=&limit=` (reviewers
  project-scoped).

## Verification ownership

The X04 gate covers HMAC rejection before parsing, the crash gap plus Cron
recovery, duplicate/out-of-order convergence with one domain effect,
exactly-one workspace/project mapping, the Owner step-up matrix,
token/key absence from D1/queues/logs/evidence (canary scan), poison
isolation with visible DLQ state, task canonicality under issue events, and
the runner-vs-GitHub provenance ladder across real Workers and D1 with a
local Queue and GitHub double. D1 migration head after this package is
`0028_github_integration`.
