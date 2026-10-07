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
  Task-tool arguments are closed shapes: unsupported private visibility,
  ownership or audience fields reject before a shared business write, never
  silently become shared creation or progress through SDK field stripping.
   Attention/result/artifact tools and nested evidence references follow the
   same closed-shape rule; unsupported private intent cannot become a shared
   child write through SDK normalization.
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

## Child delivery implementation and remaining checks

The child-delivery suites derive local task authority from the authenticated
assignment's requesting human and retained epoch, not the runner's owner.
Reads require `read`; comments, results, attention and review timers require
`contribute`; task changes and fail/cancel require `edit`, in addition to their
existing role and credential ceilings. Runner-observed measurement capture is
telemetry and requires current requester read authority, not contribute authority.
Human artifact issue/finalize and agent artifact issue require contribution;
upload/view consumption repeats the current parent check in the committing SQL.

Run creation remains shared-only, including cached responses. Its audit receipt
contains run/task/snapshot identifiers and versions, not the task title or the
configuration body. Private execution support belongs to its owning lane.

Known private artifact evidence cannot be copied into a different task even
when the submitting human can read both. Current reads re-project historical
evidence links through recipient access without rewriting submissions.

Stage 3 reserves evidence kind `artifact_version` for an exact existing immutable
artifact version. Supported identities are `{ref: artifactId, version: versionId}`
and the retained version-ID alias `{ref: versionId}`. An artifact ID without a
version is not an exact version reference. Missing artifact/version, hidden or
other-tenant source, wrong-artifact version, dangling/mismatched task parent and
private evidence crossing tasks have one fixed `not_found` reference denial.
Validate before cached submission delivery as well as before a fresh write.
Select all recognized references together so an earlier source cannot survive
access loss during a later reference lookup. Cached delivery reuses the current
authenticated request, not authority reconstructed from cached metadata, and
checks the actual retained references after the cache read. Fresh submissions
also require same-batch current target/credential/source guards; independent
revocation before commit rolls back submission, state, receipt and audit
effects. A stale-authorized batch guard uses the existing uniform `command_failed`
transaction outcome, not a new semantic reference-error contract. These checks
do not rewrite historical rows or cached receipts.
The checkpoint preserves shared authority helpers' server-observed authorization
time. It does not certify natural credential/lease expiry while a D1 batch is
in flight; that temporal boundary needs coordinated proof before activation,
not a silent clock-policy change in result-reference code.
Historical invalid or inaccessible recognized references are omitted from
current delivery without rewriting the submission or its receipt. Other
evidence kinds remain opaque and retain their existing version-map behavior;
they are not looked up as artifact IDs. Run-free artifacts retain workspace
membership authority rather than gaining a fabricated project/task association.
Credential boundaries also apply to the source lookup, not just the destination:
delegated references require the current active delegation, scope and exact
project/task/subtree boundary in that query. A bound delegation does not gain
workspace-wide run-free artifact authority. Local-agent references remain in
their exact originating run; the sponsor's broader personal access cannot
authorize a foreign run or run-free source. Direct human submissions retain
authorized shared cross-task and run-free source references. These rules do not
change provider execution or runner acknowledgement wire.

The stage-two checkpoint predates this uniform policy: it accepts some unknown
recognized references while rejecting hidden sources, which distinguishes
presence. Its certificate proves content/access fences, not this remaining
existence check. Private creation stays unavailable until the stage-three
regressions and complete matrix pass. Live private R2 byte delivery is a
separate proof, not implied by either reference validation or synthetic races.

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

### Frozen security-audit position v1

This version replaces the public audit-ID `after` wire without changing the
certified artifact/recovery receipt allowlist, payload projection or chronological
ordering. It is a contract, not implementation or activation evidence.

- `after` is a canonical 43-character base64url encoding of 32 cryptographically
  random bytes. Old audit IDs, malformed, oversized, unknown, expired and foreign
  positions all receive `invalid_argument / unknown audit cursor`. Current
  direct-human Owner and retained membership-epoch scope is checked first, even
  for empty or run-free pages. There is no raw-ID fallback.
- Persist only a domain-separated SHA-256 position hash. Plaintext positions
  never enter Hub input, results, fingerprints, idempotency, audit, semantic or
  outbox receipts. The browser receives the plaintext only after the final
  authorized read. Issuance is a registered direct-human Owner Hub command with
  a safe boolean receipt; it derives the cut server-side, not from a supplied
  audit ID. Issuance retries do not replay a cached success. Read positions are
  reusable until their fixed expiry.
- Each position binds workspace, human, retained epoch, projection/order version
  `1`, effective page size, and the exact sorted current project audience. This
  audience is re-derived from canonical project access, not a caller's retained
  project list. Same-epoch audience expansion or contraction invalidates it.
  Audience metadata is bounded to 32 KiB; exceeding that bound fails closed,
  never truncates the audience.
- A root page captures a same-workspace audit insertion ceiling and a ten-minute
  expiry using the database clock. Descendants inherit both, without sliding the
  expiry or admitting newer backdated rows. Stored anchor audit identity,
  normalized UTC sort key and insertion tie-breaker must still match a currently
  authorized canonical receipt. Historical payload alone cannot validate an
  anchor. Audit row-ID rebuilding while positions are live is unsupported;
  tuple drift invalidates the position rather than reinterpreting it.
- Issuance has a commit-time D1 guard covering current Owner/epoch, exact audience,
  expiry, certified source/parent lineage and the complete bounded selection,
  including lookahead, not only an unchanged last delivered cut. Authority
  or source loss before commit rolls back the position and all Hub bookkeeping.
  All source reads precede queued writes. Final delivery repeats the original
  current-authority selection under the issued capture ceiling and rejects if
  its last delivered row differs from the issued anchor. Never anchor on the
  lookahead row, skip a changed cut or return a mismatched continuation.
- The response adds `next_cursor`: a plaintext position only when `has_more` is
  true, otherwise `null`, including empty pages. Missing issuance capability is
  unavailable when continuation is needed; it cannot expose a raw cursor or
  falsely claim a terminal page. Hidden-only rows do not affect visible page
  membership or `has_more`. Position expiry is checked with the database clock
  and a fresh synchronous clock check after the final awaited selection.

These rules do not replace the remaining public event/realtime position work,
broader natural credential/lease expiry proof, private delivery activation or
execution-owned consumer work. Expired position rows confer no authority;
retention/cleanup is a separately owned bounded policy, not audit-history deletion.

## Fail-closed notification and integration delivery

Until recipient-safe dispatch is certified, private task-bound notifications
are unavailable to every recipient, including creators and named grantees.
Fanout, retry, each push endpoint attempt, historical delivery lists and native
pull/ack resolve the exact same-workspace/project/task parent and exclude private
or missing lineage. Filter before pagination; current recipient membership,
project and credential authority still apply. Recheck at commit and immediately
before external contact, including effective current project/workspace delivery
preferences after signing. Missing/hidden native acknowledgements both return
zero without changing hidden inbox records. Answered shared attention history
remains readable; history selection does not require the attention to be open.
Internal dispatch watermarks may advance over denied events without creating
delivery rows. The [notification identity transition](notifications.md#legacy-identity-transition)
separates immutable random recipient object IDs from the internal source-derived
dedupe key. These IDs are not bearer replay positions and do not bind history to
its creation epoch. Legacy backfill, public-only native acknowledgements,
cursor-free push/history and final authority after maintenance require independent
C11 acceptance before this barrier is closed. Private notification delivery
remains unavailable until the full recipient-safe dispatch matrix is certified.

GitHub evidence may associate shared tasks or remain project-only. It cannot
associate private tasks, even for their creator. Explicit missing/private task
IDs have the same `not_found` outcome. Existing stored task association is also
checked before an omitted-task update or cached return, and at commit. Private
historical rows do not consume pages or count as verification provenance;
hidden-only and unknown references both project to `unverified`. Retain separate
accessible public observations of the same external reference. Receipts contain
bounded identifiers/versions, never arbitrary reference prose or state bodies.

Do not detach or rewrite old private GitHub associations. An unbound absent
evidence key can currently create a project-only row while an existing hidden
key rejects; blocking that write is a content fence, not a reference-presence
certificate. A uniform collision policy is still required before private
activation. Incoming webhook convergence, installation authority and internal
queue identity remain unchanged; there is no new external-publication API.

Operations activity and stuck-work projections exclude private or dangling
task-bound rows, even for the creator, until the complete operations delivery
gate passes. Resolve ledger/launch/artifact children through their exact
same-workspace run, task and project; apply current human membership/epoch/project
authority in the selecting query before LIMIT. Unscoped internal projections
remain shared-only. Run-free uploads retain workspace membership authority.
Composite queue/health delivery rechecks the hydrated upload and launch references
in one final query after other awaited reads; an earlier list cannot survive
parent or credential loss during later hydration.
Do not operate providers or change launch lifecycle through these read repairs.
These content selectors do not certify queue/audit totals, frozen diagnostic
snapshots or raw positions; those remain activation barriers with separate
lineage and count proofs. Never disable a route merely because a private record
exists, since that response would expose its presence.

The bounded retention/recovery contract below has a
[separate clean checkpoint](../work-packages/evidence/WP-C11/retention-recovery-manifest.json).
It does not certify complete operations privacy or enable private work:

- Human retention selection requires an explicit retained human access context,
  current owner/member membership, epoch and project authority. It remains
  shared-only even for private creators and grantees. Resolve the exact version,
  artifact, run and task with matching workspace/project; a run-free log or
  dangling parent is unavailable. The key must exactly equal
  `workspaces/<workspace>/runs/<run>/logs/<version>.jsonl.zst`. Both `examined`
  and `eligible` count only authorized canonical candidates. Composite health
  delivery rechecks eligible references with its stuck-work references in one
  final selection after other awaits.
- Configured system retention has a separately named internal selector with
  the same exact lineage/key requirement and an explicit configured policy.
  Missing human context never means owner authority. Its existing workspace
  policy semantics are distinct from human read authority; private destructive
  retention and its lifecycle/count projections remain uncertified. This slice
  does not change R2 deletion or version-marking policy.
- `ops.recovery.resolve_stuck_upload` is a direct-human, current-Owner Hub
  command. It accepts `versionIds` and `stepUpProofId`; the existing browser
  recovery body and nested `result.replayed` remain unchanged. Shared task
  targets require current contribution authority; genuine run-free uploads
  retain workspace authority. Private, missing and non-stuck targets have one
  fixed resource denial. Duplicate or malformed input rejects before effects.
- Every invocation needs a fresh action-bound `ops.recover` proof for target
  `ops-recover:resolve_stuck_upload:<workspace>`. Hub replay is rejected; the
  browser uses a bounded request/proof-bound key. Target-ledger replay happens
  within the command only after current authority checks, matching kind/target,
  a closed `{resolved: number}` result and failed terminal targets. Historical
  creator metadata cannot supply current authority.
- Reads precede writes. One batch repeats current Owner/epoch, exact parent,
  expected ledger state and every target's exact V01 abandonment witnesses
  (uploading, created beyond the 15-minute TTL plus five-minute grace, with no
  grant expiring within that grace even when consumed),
  then commits proof consumption, abandonment effects, target ledger and safe
  Hub audit together. Failure rolls back the complete batch. Final browser
  delivery rechecks current target authority after the awaited Hub response;
  later revocation can hide the response without undoing a valid prior commit.
  The old unguarded resolution path is unavailable. The other recovery kinds
  keep their existing contract until their own privacy slices are implemented.

These checks preserve the shared authorization-clock semantics and do not
certify natural expiry during an in-flight batch or complete operations privacy.

The bounded security-audit slice covers canonical artifact receipts only. Its
[clean checkpoint](../work-packages/evidence/WP-C11/artifact-audit-manifest.json)
is certified at `80abaa6`; complete audit privacy and activation remain open:

- `readSecurityAudit` requires explicit `options.access`, captured from the
  authenticated browser's human principal. One final selection rechecks current
  Owner membership/retained epoch even for empty pages, then resolves the anchor
  through the same visibility rules. Scope loss returns the fixed operations
  scope denial before anchor validation. Missing, foreign, hidden, malformed and
  unsupported anchors retain the same `invalid_argument / unknown audit cursor`.
- Quarantine the artifact namespace case-insensitively; recognize only the nine
  exact registered `ARTIFACT_AUDIT_ACTIONS` and `artifact.dispatch_audit`.
  Unsupported artifact command receipts are omitted. Unrelated action families
  retain their existing sanitizer and remain explicitly uncertified. No generic
  payload-ID inference or presence-dependent route gating is allowed.
- Direct receipts bind `audit_id = outbox.id` and the exact source action.
  Wrappers need a closed, duplicate-free `{actor,input,result}` envelope with
  matching input/result outbox identities and canonical source tuple. Both use
  the fixed artifact system actor, typed ULID/UTC fields and the source's exact
  dispatch time. A wrapper must also have its matching canonical direct receipt,
  since production dispatch commits both atomically.
  Envelope children must be actual JSON objects, not serialized object strings;
  typed fields explicitly reject embedded NULs that SQLite prefix functions
  would otherwise ignore but JSON delivery would retain.
- Resolve the exact same-workspace outbox→version→artifact→run→task/project.
  Task-bound sources require a shared parent and current read/project authority,
  even for private creators/grantees. Only a genuinely NULL artifact run uses
  workspace authority; a missing non-NULL run is unavailable. Upload-grant
  actions require matching workspace/grant/version and exact nullable run
  association; view actions resolve the view-grant table instead. Finalized,
  abandoned and review-recorded sources require a genuinely NULL grant. Grant
  expiry/consumption and retained artifact state do not erase authorized history.
- Filter malformed or unauthorized sources before chronological ordering,
  `LIMIT + 1` and `has_more`. Materialized normalization/authority boundaries
  must fit actual D1 expression limits. Do not await more hydration after the
  final selection. Direct payloads ignore historical JSON entirely and rebuild
  the six-field canonical projection. Wrappers rebuild that projection inside
  the recognized actor/input/result shape; arbitrary audit/outbox JSON is never
  returned for these families. Stored history and internal dispatch are unchanged.

This slice preserves the historical audit-ID cursor wire form, not a new opaque
recipient position. Complete audit families, global positions, diagnostics and
operations aggregates remain activation barriers.

The bounded `ops.recovery.resolve_stuck_upload` audit slice has its
[separate clean checkpoint](../work-packages/evidence/WP-C11/recovery-audit-manifest.json).
It does not change recovery execution or complete C11:

- Quarantine `ops.recovery.*` case-insensitively. Recognize only the exact
  lowercase registered action. Legacy `ops.recover` and unrelated families
  remain explicitly uncertified, not inferred from arbitrary payload IDs.
- Require a closed, duplicate-free `{actor,input,result}` envelope with actual
  object children. Actor is exactly `{humanId,authorizationEpoch}`: typed human
  ULID matching `audit.actor_principal_id` and a positive safe integer historical
  epoch. Audit identity/time and every source identity/time reject embedded NULs.
  Historical actor membership is not current viewer authority.
- Input is exactly `{version_ids}` with 1–50 distinct typed ULIDs in preserved
  order. Result is exactly `{action_id,kind,replayed,resolved}` with fixed kind,
  genuine boolean replay flag, integer resolved count and a typed action ID
  (`ops:resolve_stuck_upload:` plus 32 lowercase hex digits). Resolve that ID to
  the same-workspace applied ledger of the same kind; do not claim cryptographic
  hash recomputation by D1.
- The ledger target is a closed `{version_ids}` object with an actual distinct
  typed array exactly matching input order and values. Its result is a closed
  `{resolved}` object with integer count equal to the complete target length and
  the receipt count. Stored JSON representation alone is not type validation.
- Select every current failed version→artifact→run→task/project together. Each
  task-bound target requires current shared read/project authority; creators and
  private grants confer no operations override. Only genuinely NULL artifact
  runs use workspace authority. Missing, foreign, mismatched, dangling, nonfailed
  or malformed targets omit the entire receipt; a mixed hidden target list never
  produces a partial count. Do not reapply upload age or live-grant conditions to
  failed history.
- An original receipt binds actor/time to ledger creator/creation time. A
  target-ledger retry permits the same or later time and a different direct human
  actor. Legitimate older ledgers can be retried without a modern original audit
  counterpart or attempt-count-one requirement. Ledger history contains neither
  historical actor epoch nor per-retry proof identity; do not invent either.
- Preserve the certified artifact projection and current final Owner/retained
  epoch sentinel. Filter recovery receipts before ordering, `LIMIT + 1`, counts
  and anchors; scope loss precedes the same hidden/unknown cursor denial, even
  for empty pages. Normalize JSON through materialized boundaries within actual
  D1 limits, then reconstruct synchronously without later awaited hydration.
  Valid UTC timestamps use an internal six-fraction-digit sort key for both page
  and anchor comparison, including the existing recognized artifact receipts and
  valid UTC legacy rows; insertion order breaks equal-instant ties. Original
  displayed timestamps and cursor IDs stay unchanged. Malformed legacy timestamp
  strings retain their historical raw sort key and remain outside certification.
- Reconstruct typed actor/result fields and keep `input.version_ids` displayed
  as the existing literal `[redacted]`, while validating the complete source array
  internally. This avoids expanding the current nested-array outward payload.
  No history rewrite, proof consumption, command/transport envelope change,
  private activation or opaque-position claim is included.

### Scoped operations queue and health totals

The bounded C11 repair covers human queue/health projections, not queue
execution, frozen diagnostics or complete operations privacy. Its
[clean checkpoint](../work-packages/evidence/WP-C11/operations-aggregate-manifest.json)
certifies this subset only:

- Require explicit `TaskAccessContext`, current Owner/member membership and
  retained epoch, even when every source set is empty. Missing context is not
  internal authority; scope loss returns the fixed operations scope denial.
- After all provider/policy/stuck-work hydration, select current scope, visible
  queue totals, token totals and remasked upload/launch/retention references in
  one final query. Queue and health routes use only those returned values, with
  no later awaited hydration. Preserve their existing wire envelopes, upload
  age/grant grace, launch age and exact retention-key rules.
- A shared-only current observer read/project witness governs task-bound
  sources, including private creators/grantees. Typed identities reject NULs;
  malformed, duplicate-key and serialized source objects cannot select lineage.
  Count each stored source row once through authorized sets or `EXISTS`, not
  multiplying joins. Unsupported sources contribute zero independent of whether
  private work exists. These are scoped supported-source totals, not evidence
  that physical queues are empty.
- Notification totals count pending/dead-lettered/failed stored deliveries with
  exact same-workspace semantic cursor and event kind. Observer authority is
  separate from the stored recipient: recipient membership/epoch, preferences,
  endpoint, runner token and current attention-open state do not erase visible
  historical operator rows. Do not reuse an inbox predicate that equates the
  observer with `delivery.human_id`.
- Recognize only the exact category/action/result association below. Resolve
  exact retained child→run→task/project; unrelated result fields never redirect
  a source. `attention` uses `attention.request`, receipt state `open`, actual
  `result.id` and matching retained attention task/run/project. Answered shared
  history remains countable. `launch_blocked` retains the existing reject/claim/
  authorize state/reason/code conditions: reject/claim use `input.launchId`;
  authorize uses `result.launch_id`, agreeing with retained `input.launchId`.
  `result_submitted` uses `result.submit`, `taskState=review` and the exact stored
  submission ID/run/version. Changes-requested/accepted/failed/cancelled use
  their matching command and `runResultState`, selecting producer `input.runId`;
  review submission IDs must belong to that run. No generic `result.run_id`
  fallback or arbitrary identifier heuristic is allowed.
- GitHub totals bind exact same-workspace outbox→delivery and
  `github.reconcile` kind. DLQ rows independently match that same outbox,
  delivery ID and kind; preserve the existing dispatched-stale time condition.
  Stored delivery event/action must agree with typed effect event/action,
  including genuine NULL agreement, before selecting a lifecycle or repository
  branch. Repository events require matching typed stored/effect installation
  and repository identities, current active link and observer-accessible project.
  Every applicable existing `observed_by='github'` evidence task association
  must match that project and remain shared/readable; missing evidence may be
  pending project-only work. Human/runner observations are distinct. Do not
  require the latest evidence version token to equal an older queued effect.
  Push resolves branch at `effect.ref` plus commit at `effect.version` (or
  `<ref>:deleted`); pull-request, check-run/check-suite/status, issues and
  deployment/deployment-status resolve their respective pull-request, check,
  issue and deployment kinds at `effect.ref`. Unrelated evidence families do
  not confer or revoke this association.
- Pure GitHub installation lifecycle recognizes only `created`, `deleted`,
  `suspend`, `unsuspend`, with exact typed stored/effect installation identity
  and genuinely NULL repository/ref/version. Require the installation in this
  workspace, not active status: pending, suspended and revoked lifecycle history
  is legitimate. Uniformly exclude `installation_repositories` and unknown
  actions; their multi-repository detail has no retained single-project lineage.
- Applied recovery counts require closed actual target/result objects and all
  current supported targets. One hidden, missing, foreign or malformed target
  omits the whole ledger row. Upload resolution uses the certified 1–50 distinct
  typed version IDs, matching `{resolved}` count and every current failed
  artifact/shared-parent or genuine run-free association. Notification retry
  uses 1–50 positive integer `{cursors}`, duplicates preserved, and exact
  `{redispatched_from: min-1, cursors: length}`; every semantic event uses the
  recognized notification source rules without requiring a delivery/contact.
  GitHub requeue uses 1–50 bounded typed `{outbox_ids}`, duplicates preserved,
  exact `{requeued: length}` and every GitHub source above, without reapplying
  original mutation-only DLQ/dispatched-state conditions to applied history.
  Do not claim action-hash recomputation or historical creator/proof authority.
- Uniformly exclude failed recovery rows (no implemented producer/result
  contract) and `clear_recovery_state` (deleted targets lose retained lineage).
  Reappearing action IDs cannot reconstruct a historical cleared source set.
- Health token totals share the final scope sentinel: unrevoked runner tokens
  expiring by `now+24h`, including already expired rows, and unrevoked API
  bindings. They are workspace-owned source counts, not usable-credential or
  provider activity claims. Other provider/policy metadata remains unchanged.
- At the aggregate checkpoint, the old raw eight-count helper was privately
  named for legacy diagnostic inventory only. The quarantine below removes it.
  Human `readQueueState` requires context and wraps the same final projection
  with empty work. Legacy v1 bodies have no certified snapshot provenance.
  No schema, mutation, recovery/notification/GitHub execution, provider operation,
  private activation or historical evidence rewrite is included.

### Frozen diagnostic snapshot quarantine

This bounded C11 slice makes uncertified diagnostic delivery uniformly
unavailable. Legacy workspace-wide counts have no immutable source manifest or
recipient/audience provenance. A secret scan, current epoch, recount, hash or
claimed newer body schema cannot supply that missing history. The
[clean checkpoint](../work-packages/evidence/WP-C11/diagnostic-manifest.json)
certifies source `03c0b81` against this frozen quarantine contract, not a new
diagnostic format or complete C11 delivery.

- Preserve authentication, role, CSRF and structural validation. After those
  checks, list/detail/generation/consent use the fixed `request_rejected` denial
  with `diagnostic bundles are unavailable`; browser status is 409. Do not inspect
  bundle existence/state/body/expiry, proof validity or private-task presence to
  choose that denial. Empty, shared-only and private workspaces behave alike.
- Both registered Hub commands require current direct-human Owner and retained
  epoch in a before-cache authorizer, then reject uniformly. Reject before proof
  preparation/consumption, inventory reads, bundle writes, cursor allocation or
  enqueue. Cached successful records remain stored and cannot be delivered.
- Production inventory construction and diagnostic body renderers reject under
  the same policy. Keep pure security scanners/sanitizers separate; they do not
  grant delivery authority. Remove raw-count helpers made orphaned by the repair.
- Validated `diagnostic.upload` jobs acknowledge terminally before bundle lookup,
  without DB/R2/DLQ effects or state-dependent retry. Retention jobs and malformed
  poison-message isolation keep their existing separate contracts. No live
  queue, pilot or provider is operated by this work.
- Omit the whole case-insensitive `diagnostic.*` namespace from security audit
  before ordering, page/count/has-more/anchor selection. Its anchors use the
  existing unknown-cursor denial; final Owner/epoch scope-loss priority remains.
  Apply the same pre-limit namespace fence to exported semantic-event replay.
  Do not claim that every genuine audit row exposes its full inventory: large
  generated strings are normally redacted, but identity/state/hash/time and
  short historical count copies remain uncertified. Other audit families and
  opaque positions retain their separate activation barriers.
- Preserve diagnostic bundles and historical audit/semantic/outbox/idempotency
  rows and R2 objects. Do not delete, relabel, detach, rewrite or reconstruct
  consented inventories. Existing expiry bookkeeping is separate from delivery;
  this repair does not change its retention authority.
- Keep the existing Owner/Member Diagnostics section with a compact accessible
  unavailable notice and optional on-demand explanation. Remove generation and
  consent controls, passkey prompts, diagnostic fetches and stale bundle state.
  Do not present an empty successful inventory or loading state as availability.
- Prove distinct boundaries with bounded domain, mounted, queue and browser
  tests, plus fresh real-D1/Hub rejection/copy checks. Keep dated X05 evidence;
  its current runtime D9 proves the held policy rather than a working v1 upload.
  A future source-backed format needs a separate manifest/audience contract and
  complete recipient delivery certificate, not a v1 schema-version relabel.

### Frozen unsupported audit and legacy recovery quarantine

- Security-audit delivery recognizes only the certified nine canonical artifact
  actions, their exact `artifact.dispatch_audit` wrappers and
  `ops.recovery.resolve_stuck_upload` receipts. Remove the generic fallback:
  every other action is uniformly unavailable before page, `has_more` and
  anchor selection, independently of private presence, payload shape or naming.
  Sanitization is not source lineage. Do not invent workspace-only exemptions.
- Preserve current direct-human Owner/retained-epoch scope before cursor denial,
  including empty pages, and the existing chronology, limits and wire shape.
  Unsupported and unknown anchors share `invalid_argument` with
  `unknown audit cursor`. Already-certified artifact/recovery selectors retain
  their exact current shared/run-free source and historical provenance rules.
- Hold `retry_notification_dispatch`, `requeue_github_outbox` and
  `clear_recovery_state`. The browser retains authentication, current Owner,
  method, abuse-budget, CSRF, closed-body, known-kind, target-object,
  request-ID and nonempty proof-ID structural gates, then returns fixed 409
  `request_rejected` with `recovery kind is unavailable` and no-store headers.
  Denial precedes proof lookup/validation/consumption, target/hash/ledger reads,
  cached outcome interpretation, source checks and business effects. Missing,
  shared, private, already-applied and malformed retained targets cannot select
  different unavailable answers. Admission/abuse bookkeeping is not a business
  effect and remains in place.
- The exported `applyOpsRecovery` helper denies those three known kinds with
  the same fixed policy before hashing, any database access or JSON parsing.
  Preserve unknown-kind structural rejection and the separate
  `upload recovery requires WorkspaceHub` denial for `resolve_stuck_upload`.
  Remove effect/proof helpers orphaned by the hold; no internal bypass remains.
  Retained kind enums and pure historical action-ID helpers remain available.
- No Hub command or queue variant exists for the held legacy kinds. Do not add
  one or fabricate a successful command. The registered proof-bound upload
  command and final browser delivery check remain unchanged. Denied legacy
  calls never rewind notification watermarks, reset GitHub outbox rows, delete
  recovery ledgers, enqueue/dispatch work or append business receipts/events.
- Preserve stored audit/cache/ledger rows, proofs, objects, historical aggregate
  counts and ordinary notification/GitHub consumers. The product currently
  exposes only upload recovery; do not add unavailable recovery controls or
  passkey requests. Audit copy states the supported receipt scope concisely.
- Prove meaningful baseline leaks and side effects, unsupported/malformed/NUL/
  duplicate/serialized-object audit rows before limits/anchors, current-scope
  denial, unused proofs and unchanged business state across the three held
  kinds, direct-helper no-DB denial and retained upload success/retry controls.
  Fresh actual-D1 and current X05 D6/D7 prove the hold rather than historical
  requeue/rewind; dated X05 evidence remains historical. This is not opaque
  paging, complete operations privacy or C11/private-feature activation.

### Frozen canonical board and attention-deck delivery

The next bounded C11 slice replaces multi-await board hydration with one
canonical selection. This preserves the approved W03 design and closes current
task/project/member access loss between task reads and later owner/run/deck
hydration. It does not certify browser-session lifetime, opaque positions,
coordination delivery or private creation.

- Add a required-human `readWorkBoard` domain reader used once by browser
  `GET /board`. It returns lanes and Needs Now together, plus the current viewer
  role and retained epoch. After this selection, only synchronous parsing and
  response projection occur; no later owner, run, policy, event or deck await.
- The final statement includes a current Owner/Member/Reviewer membership and
  retained-epoch sentinel even with zero requested projects/tasks. Scope loss
  uses fixed `not_found` with `board scope not found`; browser status is 404.
  Captured project IDs only narrow current project authority, never restore a
  lost grant or adopt a newer member epoch.
- Select readable tasks through the current creator/named-grant predicate
  before any limit. Private creators and current grantees remain legitimate
  readers; an unshared Owner is not. Source bodies, routing fields, policy
  flags and owner names come from this same selection, not stale hydrated DTOs.
- Lane cards retain the global 50-task bound, task-ID ordering and slug-ordered
  accessible empty lanes. Existing required policy/configuration joins govern
  lanes and effective pass-to-agent metadata. The deck has a separate project
  access set: missing lane-policy rows must not silently hide urgent tasks.
  Preserve the legacy candidate-limit order: take the first 50 readable tasks
  before mapping policy-backed lanes; a candidate in a project missing those
  policy rows still consumes that global candidate budget.
- Needs Now independently ranks all readable tasks, not the first 50 cards:
  at most three P0/P1 items assigned to this human, blocked or due. Preserve P0
  before P1, dated before undated, due time then task ID. Compare valid due UTC
  instants chronologically, including equivalent fractional/seconds spellings.
  Do not introduce a separate terminal-state filter. Invalid supplied `nowIso`
  yields no deck items but never bypasses the human scope sentinel.
- Current owner names require same-workspace current human membership; no
  workspace-wide earlier name snapshot. Effective policy flags do not grant
  execution authority. Preserve card routing, tint, top-edge and side-stripe
  fields and the ordinary recorded run-state summary.
- Work-run summaries require exact workspace/task/project lineage and
  `purpose='work'`, with valid typed identifiers. Discussion, missing and
  cross-project parents do not contribute. Preserve creation-time descending,
  then run-ID ascending ordering; normalize valid UTC spellings for chronology.
  Terminal historical work runs remain legitimate; infer no activity from
  transport presence or semantic prose.
- Uniformly hold heuristic `latestEvent` metadata for every board, independently
  of private-work presence. Do not query or rewrite semantic snapshots to
  manufacture a latest source. The combined response explicitly reports
  `recent_events_available: false`; source-backed event detail needs its own
  recipient-position/lineage contract. The web board ignores stale supplied
  `latestEvent` fields and states unavailability inside existing task Details,
  without another default command or an implied empty activity history.
- Existing lane/deck helpers remain wrappers over the same selector. Omitted
  internal human context stays shared-only; it never infers Owner authority.
  Explicit deck human IDs must match the authenticated context. The mounted
  combined reader never accepts absent human authority.
- Prove meaningful pre-repair hydration races through existing wrappers and
  the mounted cookie route; prove the final selector rechecks scope before
  delivery, independent lane/deck limits and current-role/policy/body coherence.
  Include genuine work-run and discussion negatives, malformed/misbound run
  sources, semantic-decoy independence, keyboard/on-demand UI and fresh actual
  D1 single-selection proof. Repair the existing discussion test's vacuous
  `card.id` lookup to use `taskId`. Preserve stored history and prior evidence.

### Frozen browser board selection

This corrective C11 slice binds already-authorized board delivery to the
currently selected browser scope. Server authorization and the canonical
board/deck contract above remain unchanged; UI suppression is not a new ACL.

- Treat the board, profiles and role as one human/workspace-bound presentation
  snapshot. A mismatched snapshot is unavailable immediately, before a new
  response arrives. Do not carry old cards, profiles, role-dependent controls,
  task selection or an open composer into another workspace or human context.
  A successful board response must identify the captured human before the
  snapshot is installed; a session changed elsewhere cannot relabel its content
  as the previously selected human.
- Every read belongs to a committed selection incarnation and a latest request.
  Fence entry as well as HTTP/body awaits, success, errors and final loading
  updates. An old callback cannot start an old-scope read after a new selection,
  become its newest request or select its committed task in that new scope.
- Returning through A to B to A does not revive the first A request. Concurrent
  reads in one scope retain the newest selection; old HTTP/network failures and
  finalizers cannot replace newer success, error or loading state.
- A current HTTP, network or body failure removes the previous board, profiles
  and role-dependent controls. Account copy reports unavailable role rather
  than substituting cached membership authority. Keep one discoverable retry;
  genuine current callbacks can still refresh and select committed work.
- Workspace changes through the picker or browser history reset selected task
  and composer state. Same-workspace disclosure and navigation preserve their
  existing behavior. Unmounted shells have no completion effects.
- Keep the W03 themes, named disclosures and two default task commands. No
  mutation, launch, provider turn, privacy activation or extra default action
  occurs because a snapshot is hidden, selected, loaded or retried.
- Prove deferred success/body/error/finalizer and old-callback cases through the
  mounted shell with healthy and current-creation controls. Re-authentication
  induced by a public fetch-prop change is labelled a test trigger, not a
  production refresh action. Browser checks cover actual rendered suppression,
  current role, selector focus and keyboard retry without live operation. Native
  popup key presses are not certified by the headless option-selection driver.

### Frozen human coordination-history delivery

This bounded slice owns human product readers only. It does not implement
provider dispatch, private execution, participant-run authority or cleanup.

- Human discussion detail and task discussion lists remain available only for
  exact current shared parents. Private parents are uniformly unavailable to
  everyone, including creators and grantees, until their execution-owning lane
  certifies private coordination. Missing/misbound parents share the existing
  absent-resource denial. No transcript, frozen brief, recommendation, decision,
  participant identity, page count or anchor is delivered through a private task.
- Detail checks exact discussion/workspace/task/project lineage and current
  viewer membership, retained epoch, role and project access before hydration.
  Recheck that same binding after all asynchronous view/advisory reads and
  immediately before returning the wire value. Only synchronous projection may
  follow the final guard. A privacy/current-viewer denial must not be converted
  into the readable `sponsor_revoked` advisory. For a still-shared parent and
  authorized viewer, the existing sponsor-revocation advisory remains readable.
- Lists select the exact shared parent and current viewer together with rows
  in the final statement, before `LIMIT + 1`, `has_more` and next-anchor output.
  An empty page still requires the parent/scope sentinel. Preserve existing ID
  ordering, default/max limits, structural pagination errors and wire shape.
- Human browser launch-status list/detail use final current-viewer and exact
  shared-task predicates, not captured project lists. List filtering precedes
  its existing limit; empty lists still require the shared parent and retained
  epoch. Private, missing and misbound direct reads return the existing uniform
  404/no-store response. Status views retain terminal recorded work history,
  existing fields and bounds; infer no provider activity or task completion.
- Status source joins bind launch, immutable assignment generation, execution,
  run, task/project and snapshot to the same tuple. A checkout lease contributes
  only for that exact execution/assignment, not a replacement occupant sharing
  the physical worktree. Discussion and malformed/misbound sources do not enter
  a visible page. Do not change reservation or provider behavior to repair a view.
- Mounted GET paths retain the first workspace-authority epoch captured for the
  authenticated browser human; the browser identity itself carries no workspace
  epoch. A later principal load cannot adopt a newer epoch. Preserve authentication, route/body
  admission, feature holds and no-store envelopes. Mutation routing stays with
  its existing commands; this is not authorization to change launch/discussion
  execution or add controls.
- Prove genuine shared discussion history and synthetic recommendations/decisions
  followed by parent privatization, including creator/grantee denial; final-read
  privacy/project/epoch loss, empty-page scope, readable shared sponsor advisory
  and pagination controls. Prove genuine launch history, both mounted reads,
  private/absent parity, final-read authority loss, exact source tuples and
  replacement-lease omission. Keep stored records unchanged and add fresh
  actual-D1 selector proof. Do not claim participant or runner delivery.

`readParticipantDiscussion`, runner pull/channel/control delivery and
`readLaunch`/reconciliation are outside this implementation. Cleanup-only
reconciliation intentionally survives human authority loss; a blanket privacy
guard must not strand reservations. Those remaining activation seams require
the execution-owning lane's contract and proof.

### Frozen public-position quarantine

This availability-only C11 slice holds uncertified public ordering metadata.
It does not implement the opaque replay replacement, change internal ordering,
activate private work or change runner/provider execution.

- After existing authentication/current-role, method and pure query/upgrade
  admission, public ledger/high-water, semantic-event, operations activity and
  measurement-source pages return fixed 409 `request_rejected` with
  `event feeds are unavailable` and no-store headers. Hold uniformly for empty,
  shared and private workspaces. Denial precedes source/target/cache/high-water
  reads; a missing/private run must not select the held-page answer. Preserve
  structural invalid-range/query errors without reading a default high-water.
- Exported `readEventHighWater`, `listWorkspaceEvents`, `readLedgerHighWater`,
  `listLedgerEvents`, `listRunMeasurementSources` and `readActivityFeed` retain
  pure argument checks, then deny before database access. No production or test
  bypass is added. Internal ingestion, activity arithmetic and persisted order
  continue through their existing separately scoped paths, not these readers.
- Run/task measurement arithmetic and current parent authority remain intact;
  their public run `sources` field is explicitly `null`, including nested task
  runs. It means unavailable, not an empty source page or an observed zero.
  Internal complete canonical activity identities still govern arithmetic.
- Public browser, human CLI and delegated MCP command replies use one explicit
  allowlisted projection: success `{ok:true,result,replayed}`, failure
  `{ok:false,error}`. Omit only the top-level Hub `cursor`; preserve authorized
  business results, resource versions, errors and one-time artifact grants.
  Apply to fresh/cache, special artifact replies and preference batches. Do
  not rewrite idempotency/history, globally scrub JSON or alter runner/local
  agent acknowledgements or internal `HubCommandOutcome`.
  These exact key shapes describe the Hub receipt portion, not existing
  transport business DTOs. Browser/human-CLI `already_answered` conflicts
  retain authorized current attention detail beside the projected failure.
  Delegated `bfb_get_context` keeps its existing `{context}` read response and
  error read wire after internal command authorization; it is not a mutation
  receipt. Existing artifact/grant, invitation, launch/control and other
  business-only responses stay intact. No nested business field is scrubbed.
- New browser socket admission is held before Durable Object resolution,
  attachment, ready/high-water or frames. Existing browser attachments retire
  on heartbeat/alarm independently of commands. Browser `afterCommand` does
  no reads, sends or command-triggered closes: even close timing is an activity
  hint. Keep runner-channel post-command nudges unchanged. Pure codec/resync
  algorithms may remain tested, but not as a claim of an available public feed.
- Product consumers stop raw-feed and socket attempts, including hidden mounted
  panels, and suppress stale history/source state. Use compact unavailable
  notices in existing disclosures, without extra default actions, false live
  labels, fake empty history or fabricated presence. Authorized discussion and
  launch HTTP reads, explicit mutations, manual refresh and launch polling stay.
- Prove no database/source calls at held helpers, credential/query admission and
  uniform mounted failures, no command-correlated socket frames/closes, runner
  nudge preservation, unchanged arithmetic/null source pages, all public receipt
  paths and browser stale-state/no-attempt behavior. Current E01/E02/A04/X03/G01
  runtime fixtures must assert the hold and internal invariants truthfully;
  preserve historical certificates rather than relabeling replay as available.

The exact additive target is `pnpm test:c11:positions`, composed by C11. This
does not settle notification identities, security-audit opaque anchors, natural
in-flight expiry, GitHub collision policy, execution consumers or activation.

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
