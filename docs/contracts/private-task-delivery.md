# Private task delivery v1

Owner: C11. Direction: [ADR 0015](../adr/0015-private-work-authorization.md).
Dependency: [task-access kernel v1](task-access.md), migration 0045.

## Activation and implementation stages

Private creation is unavailable in every transport until the complete matrix
below passes. There is no environment flag, fixture endpoint or partial opt-in
that activates it. Existing tasks stay shared. Synthetic tests may insert
policies; these inserts are not a product command or deployment instruction.

1. Fence human/delegated task reads, board/deck pagination and the shared work
   commands, including cached outcomes. Internal callers without a human access
   context exclude private tasks. Child creation under a private task is rejected
   until inheritance is implemented. This stage does not certify child delivery.
2. Fence task descendants, run/execution/session/attention/result/measurement
   reads and mutations, artifact issue/consume/redeem, local agent delivery and
   pending operations. Re-check parent authority in the byte-delivery query.
3. Replace outward ordering metadata with principal-bound opaque positions;
   fence diagnostics/audit/notifications/integrations and coordination consumers.
4. Add creator-only private creation/sharing and author-private checkpoints,
   browser controls and full-surface adversarial proof. Enable only after all
   stages pass together from the same clean committed checkout.

`pnpm test:c11` composes the implemented C11 suites plus C10 and C08 regressions.
Its current stage coverage must be explicit in the evidence manifest; a green
partial stage never changes C11 to `done` or enables privacy. Evidence lives at
`docs/work-packages/evidence/WP-C11/manifest.json`.

## Frozen authority and command shapes

- Task reads use current membership epoch, role, project and creator/grant in
  the query before LIMIT. Unscoped internal task readers exclude private rows.
  Missing/denied parent reads return the same `not_found`, never owner override.
- Delegated task selection retains the credential-bound membership epoch, never
  adopts a newer human epoch, and checks the current delegation's sponsor,
  revocation, expiry and project/task boundary in the selection query.
- Only the unscoped internal `getTask` reader supports pre-0045 schemas, whose
  task records are structurally shared. It checks the SQLite catalog before and
  after the historical read, discards the result if the privacy table appeared,
  and reselects through the shared-only predicate. Schema absence is never
  cached; catalog errors never authorize delivery. Explicit human reads require
  the privacy schema and never fall back. This supports monotonic migrations,
  not removal of an installed authority table or historical-schema public APIs.
- Human and delegated work commands use `read`, `contribute` or `edit` according
  to the kernel, in addition to their existing scopes/boundaries. Fresh checks
  run before idempotent responses. Canonical input fingerprints prevent changed
  retries; receipts contain identifiers/versions, not titles, prose or context.
  Previously stored outcomes without fingerprints reject safely; no historical
  rows are rewritten or purged. Cached task relations are re-projected against
  current access and credential boundaries, not blindly replayed.
- `task.private.create` takes the existing human task-create fields, without a
  caller-selected owner. It is a distinct command: existing `task.create` never
  silently changes visibility. Only direct member/owner humans can invoke it.
- Browser routes are `POST /api/v1/workspaces/:workspaceId/tasks/private`,
  `GET /api/v1/workspaces/:workspaceId/tasks/:taskId/sharing`,
  `POST /api/v1/workspaces/:workspaceId/tasks/:taskId/sharing/grants` and
  `POST /api/v1/workspaces/:workspaceId/tasks/:taskId/sharing/grants/:grantId/revoke`.
  Bodies use existing snake-case fields and required `request_id`. These routes
  do not exist at stage 1; unsupported calls fail closed.
- `task.sharing.grant` takes `taskId`, `humanId`, `permission`,
  `expectedAccessVersion`; `task.sharing.revoke` takes `taskId`, `grantId`,
  `expectedAccessVersion`. Creator-only, current project access, explicit named
  recipient/current epoch and existing role ceilings. A grant never changes
  project access. No ACL mutation tool is exposed to agents or integrations.
- Private child tasks inherit the root privacy authority; they do not fake a
  human creator on agent-authored records. A dedicated retained root association
  must resolve the root policy before children are supported. Parent/dependency
  IDs are returned only when the recipient may read both endpoints. A shared
  task cannot depend on private work: explicitly publish selected output first.
- An author-private checkpoint is separate from consumer audience. New explicit
  `progress.private.report` binds author/sponsor, task and optional originating
  run/delegation. Only that current human and the exact originating authorized
  agent boundary can retrieve it. Ordinary comments/progress remain task-visible.
  Agents cannot select another human owner or change that privacy. Sharing the
  task does not share these checkpoints; C12 publishes selected contents.
- A local agent needs current requesting-human task access plus the existing
  run/session/execution/assignment/runner authority. Remote clients need current
  sponsor task access plus delegation scope/boundary. Neither may enumerate
  another author's private checkpoints. Revocation fences cached/pending calls.

## Frozen replay contract

Server ledger cursors and runner source-stream acknowledgements remain internal
and unchanged. Human browser/CLI/MCP delivery gets a separate versioned envelope:
opaque random positions, scoped to workspace, human, membership epoch and exact
query audience. Persist only hashed position handles and their internal capture
watermark; do not expose raw workspace/source/measurement sequence numbers.
Expired, foreign and malformed handles have one bounded rejection.

At replay and every live nudge, query current parent task ACL and consumer
audience. Never broadcast hidden event IDs, titles, counts, timestamps or cursor
advancement. A hidden event alone produces no invalidation. Visible revisions
invalidate only authorized recipients. ACL revocation clears affected browser
state and closes/rebinds affected sockets; reconnect re-authorizes before replay.
Old raw-cursor endpoints must not become a private-work back door. Activation
requires their safe version transition, including shared command receipts,
measurement-source cursors and security-audit pagination, not just `/events`.

## Delivery inventory and required proof

| Surface | Existing owner / entry points | C11 completion check |
| --- | --- | --- |
| Board / deck / task pages | `projections.ts`, `work-commands.ts`, `api/work.ts` | ACL before pagination; no hidden parent IDs or deck slot consumption |
| Human CLI / delegated MCP | `api/cli-human.ts`, `mcp/server-factory.ts`, `oauth.ts` | Same read predicate; narrower credential boundaries; all cached replies fenced |
| Work / context / comment / links | `work-commands.ts` | Action-specific ACL; fresh cache check; safe audit receipt; private-child rejection until inherited |
| Local agent / pending replay | `agent-work.ts`, `agent-sessions.ts`, `agent-capture.ts`, offline policies | Current sponsor ACL at bootstrap/write/replay; no audience widening |
| Runs / execution / sessions / result | `work-records.ts`, `results.ts`, agent/remote result commands | Exact parent task at read/write/cache, no evidence crossing task visibility |
| Attention / wait / answer | `attention.ts`, `agent-attention.ts`, `api/attention.ts`, remote parity | Exact parent ACL; no unshared required-human notification or answer bypass |
| Measurements / review timers | `measurements.ts`, `measurement-sources.ts`, work API | ACL before totals/page; no global source/committed cursor exposure |
| Artifact issue / upload / finalize / list / review | `artifacts.ts`, agent authority, reviews, control and artifact Workers | Task ACL at issue AND conditional consumption/redemption; current private authority before bytes |
| Event ledger / realtime / timeline / latest work | `events.ts`, browser sockets, web realtime | Opaque recipient positions; no hidden event or source sequence hints; revocation/reconnect race proof |
| Notification delivery / retry | `notifications.ts`, dispatch/queue/sweep | Private records rejected until recipient recheck at dispatch and retry is proven |
| GitHub / external publication | `github.ts`, integration routes/queues | No private task links/content delivered externally; fail closed until C12 selection |
| Operations / security audit / recovery / diagnostics | `operations.ts`, control operations | Owner is not private reader; hidden task IDs, receipts, counts and ordering omitted |
| Launch / run control / discussion | launch/discussion authorization consumers | Reject private records until owner lane certifies the same parent guard; no provider/execution changes in C11 |
| Search / export / private creation / ACL UI | No current search/export implementation | No speculative endpoint; creation/sharing UI stays unavailable until complete matrix passes |

Every row needs missing/private/other-tenant/current-grant/role/epoch/revocation
negatives, as applicable. Race cases cover queued mutation vs revoke, cached
reply vs revoke, replay subscription, artifact consume vs revoke and notification
retry. HTTP/MCP proofs use real authority boundaries; a kernel call on D1 is not
a transport certificate. Fixtures and evidence remain synthetic and redacted.
