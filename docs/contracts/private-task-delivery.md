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

### Retained inheritance preparation

[ADR 0017](../adr/0017-retained-private-task-inheritance.md) freezes the effective
root association, exact-root sharing and authority-family child quota. Prepare
the additive schema, common kernel and direct-human private creation command
without registering that command in a production transport or command catalog.
With a shared or absent parent, the future command creates an inferred-owner
private root; with an editable private parent it creates a descendant inheriting
the existing root. Actual creation authorship is never replaced by root ownership.
Private creation and existing private-parent creation stay unavailable until
their full activation/integration gates pass. Local execution proposals and
checkpoint delivery are not opened by this preparation.

`task.private.create` remains absent from the production command catalog and
every transport. Its prepared domain command accepts the existing closed
`CreateTaskInput` fields only; inferred direct-human ownership is not
`nextOwnerId` routing. Return a minimal canonical receipt containing only
`task_id`, `project_id`, nullable `parent_task_id` and `privacy_root_task_id`.
Current original role/project ceilings, exact parent edit access and effective
root lineage fence admission, cached replies, atomic commit and final response.
Changing input on retry rejects; successful receipts remain historical without
asserting current task state or grant activity. The same committing batch inserts
the task plus either its direct policy or retained association. Association or
authority failure cannot leave a shared task or Hub bookkeeping behind.

`pnpm test:c11:inheritance`, composed once by `pnpm test:c11`, owns the finite
migration, kernel/metadata, prepared-creation and disposable native-D1 proofs.
It does not register the prepared command, open ordinary private-parent creation,
certify execution delivery or complete the activation matrix.

### Author-private checkpoint slice

The first checkpoint transport slice is direct browser humans and authenticated
remote OAuth delegations. It does not activate private task creation or add local
execution tools, IPC fields or offline replay. Ordinary `progress.report` and
comments keep their existing task-visible behavior.

- `progress.private.report` accepts only `taskId` and `body`. Infer the owner
  from the authenticated human or delegation sponsor; never accept owner,
  audience, origin or run fields. Trim a nonempty body of at most 2,048 Unicode
  characters, rejecting control characters as ordinary progress does. Reporting
  requires current task `contribute` authority and existing role and credential
  ceilings, including `bfb:task:write` for OAuth. A write-only delegation may
  report and receive its minimal receipt without gaining checkpoint read access.
- Append immutable `task_private_checkpoints` rows with exact task/project,
  owner, nullable originating delegation/client pair, body/hash and timestamp.
  Human origins have both origin fields absent; delegated origins have both
  present and bind the sponsor to the owner. Use existing task, retained human
  identity and OAuth tuple foreign keys. No local-origin placeholders, historical
  epoch cutoff, checkpoint update/delete or independently selectable owner.
- Reads require current task `read` authority and existing ceilings, including
  `bfb:read` for OAuth. Direct humans see only their own human and delegated
  checkpoints. A delegation sees only its exact delegation/client origin, never
  another delegation with the same sponsor. Origin revocation does not erase
  the human owner's history. Sharing a task never shares checkpoints.
- Return `{ task_id, checkpoints, has_more }`; checkpoint entries contain only
  `id`, `body`, `content_hash`, `created_at` and `origin` (`human` or `delegation`).
  Filter author/origin before newest-first ordering and a 100-row limit plus
  lookahead. Retain an authorized-empty sentinel in the final coherent parent
  selection; missing/inaccessible parents remain uniformly `not_found`.
- Reuse the existing public-business command factory, transaction guards and
  final selections. Retain requesting epoch, role/project vector, credential
  scopes/boundaries and expiry across batch, cache and actual body delivery.
  Canonical fingerprints reject changed retries. Receipts contain only exact
  `task_id`, `checkpoint_id` and `content_hash`, reselected against current
  owner/origin authority; do not return body prose or assert current task state.
- Browser GET/POST use `/api/v1/workspaces/:workspaceId/tasks/:taskId/checkpoints`
  with required `request_id` on writes. Remote MCP exposes only
  `bfb_get_private_progress` and `bfb_report_private_progress` with strict fields.
  The task panel reveals a “Private checkpoints” section only on demand; loading
  it is not a business command. Scope drafts to task/human and discard stale
  responses. Denials clear delivered bodies and actions, with explicit retry.
- Add no comments, context injection, task versions, measurement, notification,
  runner command or generic feed category. The new command family stays omitted
  from unsupported outward audit projections. Publishing selected checkpoint
  contents remains C12; local checkpoint delivery remains an execution-owned gate.

`pnpm test:c11:private-checkpoints` owns domain, migration, mounted browser/MCP,
native D1 and compiled UI proofs for this finite slice. Clean evidence belongs
in `docs/work-packages/evidence/WP-C11/private-checkpoint-manifest.json`. Passing
it does not certify private creation, inheritance, local delivery or full C11.

### Creator sharing lifecycle checkpoint

Stage four starts with creator-only sharing over the retained 0045 policy and
grant storage. This checkpoint does not expose private creation, inherit private
children, add agent ACL tools or activate the complete privacy feature.

- `task.sharing.grant` and `task.sharing.revoke` accept only their frozen fields
  above. Require a direct current Owner/Member human, the retained requesting
  membership epoch, current project access and `manage_sharing` on the exact
  private task. A shared, missing or inaccessible task has the same `not_found`
  response. Delegation, runner and system actors cannot use either command.
- Read sharing metadata only for that same current creator. One final coherent
  selection returns the task ID, access version and current effective grants;
  it must retain an authority sentinel for an authorized empty list. Select
  grants whose recipient still has the recorded current membership epoch and
  project access. Return at most one hundred ordered grants with truthful
  `has_more` from a one-row lookahead; do not expose a workspace cursor or
  pretend a truncated list is complete. This is not a sharing-history API.
- Grant recipients are explicit current named humans in the same workspace
  with project access. Bind their current membership epoch; their existing role
  remains a ceiling on `read`, `contribute` and `edit`. The immutable creator
  needs no self-grant. An already active grant for that recipient/epoch rejects
  with `already_exists`; changing its permission requires explicit revoke and
  re-share, never an update to immutable grant authority. Old inert grants stay
  retained and cannot block an explicit grant at a newer membership epoch.
- Compare `expectedAccessVersion` for fresh mutations only after creator
  authority. A successful grant or revoke increments the policy version once.
  Revocation targets an exact active grant on that task and retains its identity
  and revocation. A missing, foreign-task or already revoked grant is uniformly
  unavailable. Never remove policy or grant records or rewrite the creator.
- Repeat creator/current-project/retained-epoch/version authority and the exact
  recipient or grant witness inside the committing D1 batch. Independent loss
  before commit rolls back all business and Hub bookkeeping effects. Use the
  existing transaction-guard contract; no shared kernel, Hub or schema changes.
- Bind idempotency to closed canonical input. Check current creator authority
  before cached replies; changed retries reject. Receipts contain only task,
  grant and access-version identifiers, not task content or recipient lists.
  Successful historical receipts do not assert that a grant is still active.
  Recheck creator authority after awaited command delivery before a browser
  receives any receipt or sharing metadata. Sharing never publishes author-
  private checkpoints or changes another transport's credential ceiling.

Prove useful creator and empty-list controls, no Owner override, all permission
intersections, recipient/project/role/epoch loss, removal/rejoin, optimistic
version conflicts, exact and changed retries, immutable retained revocation,
late final-selection loss and native commit rollback. Synthetic dormant policy
setup is labelled; passing this finite checkpoint cannot enable private creation
or substitute for destructive-retention and execution-owned delivery gates.

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

### Frozen beta manual GitHub linking hold

Timo chose uniform unavailability for manual linking on 8 October, leaving
webhook reconciliation enabled. This availability policy is not a scoped-key
migration or complete GitHub delivery certificate.

- Hold registered `github.evidence.link` and browser `/github/evidence/links`
  for all human/runner-observed manual attempts, independent of key presence or
  prior project/task association. After existing identity, current epoch,
  role/project and pure closed-shape/bounds validation, valid attempts return
  fixed `request_rejected / manual GitHub evidence linking is unavailable`.
  The browser uses the existing 409 mapping and no-store envelope.
- The domain authorization hold must precede task/evidence lookup and Hub cache
  lookup. Omitted-task, shared/private/unknown task and absent/visible/hidden key
  attempts cannot distinguish persisted evidence through manual linking. Fresh,
  historical cached and changed-key retries create no business, cursor, audit,
  semantic, outbox or idempotency effects. Malformed/authentication/role/project
  admission and existing HTTP abuse-budget behavior remain distinct.
- Keep every historical evidence association, version, state, timestamp and
  receipt unchanged. Do not detach private history or rewrite caches to simulate
  successful commands. Existing authorized history/provenance readers remain;
  independent public observations retain their established visibility.
- Preserve webhook receive, queue reconciliation, dedupe/latest-wins behavior,
  installation/token authority, repository mapping, schema uniqueness and
  internal queue identity. Test setup formerly using a now-held manual command
  must use clearly labelled historical fixtures, not a business bypass.
- Prove identical bounded outcomes and complete canonical no-effects snapshots
  for absent/visible/hidden keys and historical caches, plus retained malformed,
  role and CSRF controls. Use mounted synthetic browser auth and disposable
  native production-Hub proof separately; retain exact X04 regression and full
  repository/platform verification. Native bounds exclude setup and snapshots.

The owning additive target will be composed by C11 once implemented. Internal
reconciliation source fences, post-await historical delivery, scoped keys,
execution-owned consumers and full private activation remain separate. Browser
session identity is not a captured workspace authorization epoch: its first
workspace membership lookup establishes that request's retained authority.

### Frozen GitHub status delivery

The next bounded GitHub read slice is workspace status, not an internal
reconciliation or scoped-key migration. The frozen source prediction is now
reproduced against unchanged `21e4d69`: two awaited status reads can outlive the
handler's first workspace membership capture and combine metadata from different
selections. Staged and native OLD probes retain useful healthy controls; neither
the first fixture failures nor separate internal concerns supply that evidence.

- Keep the existing workspace-wide Owner/Member audience and exact installation
  and active repository-link DTOs, fields, ordering and useful empty status.
  Reviewer admission stays denied. This slice does not add project filtering
  to the documented status audience.
- The browser retains the human and epoch from its first workspace membership
  lookup. Pass that retained ceiling into status selection; never replace it
  with a newly loaded epoch after an await. Browser session identity alone is
  not a prior workspace capture.
- One final coherent database selection must bind canonical installations and
  links with current membership, retained epoch and Owner/Member authority,
  including an empty-result authority sentinel. A late removal, demotion or
  epoch loss returns fixed `forbidden / github status is unavailable` and the
  existing browser 403/no-store mapping, with neither partial array delivered.
  Healthy authorized emptiness remains a 200 with both arrays empty.
- Keep direct internal status fixtures usable without inventing browser
  authority. Current business state and display fields come from the final
  selection; an earlier installation array cannot survive a later lifecycle or
  repository-link change. Reads create no business, audit, cursor, cache or
  OAuth effects. Classify HTTP budgets and explicit independent source changes
  separately and compare full canonical snapshots with clean foreign keys.
- Prove useful Owner/Member controls, initial Reviewer denial, retained late
  epoch/removal/demotion, empty-status loss and a changed installation/link
  selection. An explicitly synthetic membership reinstatement at the same
  still-revoked authorization epoch must not restore access; do not claim that
  this bypasses the real service's epoch bump. Use actual mounted synthetic cookies
  separately from direct selectors and disposable native D1. Instrumented SQL
  bounds exclude unobserved Worker/DO internals, setup and snapshots. Preserve
  the certified manual hold, history/provenance selectors and exact X04.

No shared auth, Hub, step-up, runner/provider, webhook/upsert, repository mapping
or schema changes belong to this read slice. Browser natural session expiry,
internal reconciliation remap/conflict lineage and commit-time installation
authority remain separate, unproved concerns. Status certification alone cannot
activate private creation, sharing or publication.

### GitHub repository reconcile commit authority

A separate disposable native probe at unchanged `cd69f42` reproduced one
reachable repository-reconcile race. After real installation/link captures, an
independent native client completed the production revocation helper before the
original bound batch. OLD still committed evidence and an applied receipt; its
same-key follow-on replayed that result. The follow-on is derivative, not a
second independent race. Healthy and already-revoked controls both passed.

- Before committing repository evidence, require the delivery's installation
  to remain active in its exact workspace and its captured repository/project
  link to remain active there. Put this assertion in the same atomic batch as
  default-branch, evidence, latest-wins, delivery/outbox and Hub bookkeeping
  writes. Independent source loss rejects through the existing `command_failed`
  transaction outcome and rolls back the complete batch.
- A retry after rejected commit has no applied cache to replay and follows the
  existing revoked-to-ignored path. Preserve legitimate historical applied
  receipts, webhook ingress, Queue attempt policy, lifecycle handling, schema
  keys, manual hold and repository mapping behavior. No new credential, clock,
  shared Hub or installation-helper policy belongs to this bounded repair.
- Prove actual native captures, completed independent production-helper
  revocation, unmodified forwarding of bound statements, snapshots taken after
  revocation, full canonical rollback, clean foreign keys and empty transient
  guards. Classify budgets separately and retain useful healthy and pre-revoked
  controls. Bounds cover direct instrumented domain-Hub SQL only.

This is not a same-Hub competing mutation: FIFO serializes those commands.
Sequential remap/conflict policy remains unchanged and unproved by this cut.
Production reconciliation omits task IDs and uses the reserved GitHub observer;
historical human/runner observations cannot collide with it. Dormant synthetic
private/task-bound GitHub rows do not establish another reachable bug. This
finite repair does not activate private creation or certify execution consumers.

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

### Frozen delegated result commit expiry

This bounded C11 correction owns `result.submit.delegation` only. The existing
preflight, exact target/source selection, scopes, epoch and credential boundary
remain necessary. It does not change shared preparation-time authority helpers,
local agent capabilities, runner leases, cleanup or provider execution.

- A delegated submission additionally requires its exact workspace/delegation
  row to have an expiry strictly later than the database execution clock when
  a write-only CHECK guard runs inside the committing D1 batch. Missing, NULL,
  invalid or elapsed expiry fails closed, including empty evidence. Comparing
  against a JavaScript time captured while preparing the batch is insufficient.
- Keep the temporal CHECK separate from the existing all-reference guard so
  their atomic conjunction does not deepen the bounded source query. Both must
  pass before submission effects; failure retains uniform `command_failed`
  and rolls back state, versions, receipts, audit, events, outbox and cursor.
  Do not perform reads after queued writes or branch on queued change counts.
- Preserve `ctx.now` for submission and audit observation timestamps. Database
  execution time is an additional authorization ceiling, not a rewrite of
  observed history or a new clock contract for other commands.
- Prove actual delayed D1 execution after natural expiry while the complete
  credential row remains unchanged. Assert the batch was reached while valid,
  then use the database clock to confirm expiry before flushing it. Compare all
  effects against baseline, with a comfortably unexpired delayed control and
  empty evidence so source presence cannot supply the temporal check.
- Align successful test credentials with the database clock without faking SQL
  time. Historical observation clocks remain deliberate; elapsed read tests
  advance to their stored expiry rather than relying on obsolete constants.

The additive target is `pnpm test:c11:result-expiry`, composed by C11. Actual-D1
domain/Hub proof is not by itself authenticated transport, runner/lease expiry,
every later statement's temporal boundary or complete private activation proof.
D1 [batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/)
provide transaction rollback; SQLite's [date functions](https://www.sqlite.org/lang_datefunc.html)
define the UTC execution-clock `now` used by this additional guard.

### Frozen delegated artifact commit authority

This corrective C11 slice owns `artifact.create_version.delegation` and
`artifact.finalize_version.delegation`. It completes their committing authority
boundary without changing shared preparation-time helpers, runner/local agent
capabilities, provider execution, upload grant wire/TTL or replay rejection.

- Before artifact effects, a write-only CHECK inside the committing D1 batch
  repeats the exact retained run→task→project tuple, work-run purpose, sponsor
  membership/retained epoch, Owner/Member ceiling, kernel `contribute`, and the
  exact delegation's sponsor/client, revocation, valid write scope and current
  project/task-subtree boundary. Preserve the existing `bfb:task:write` scope
  requirement; do not newly require a read scope or adopt a newer sponsor epoch.
- A separate execution-clock CHECK requires the exact credential's expiry to
  be strictly later than database `now`. Invalid, NULL, missing and elapsed
  expiry fail closed. Keep the prepared clock predicates and `ctx.now` work/audit
  observations unchanged; this is an additional authorization ceiling.
- Creating another version pins the existing logical artifact's exact
  workspace/run/format/role. A new artifact retains server-generated identity.
  Finalization pins the retained version/artifact/run/task tuple, `uploading`
  state, matching format/role/digest/size, verified receipt and exact canonical
  object key/hash/size before its UPDATE. A legitimate competing finalization
  cannot produce a second receipt after a zero-row UPDATE. Consumed upload
  grants and immutable verified history are not required to regain freshness.
- Reads precede queued writes. Guard failures keep uniform `command_failed`
  and atomically roll back artifact/version/grant/audit effects, semantic/audit
  receipts, outbox, idempotency and cursor. Do not branch on queued change counts.
  Failed keys may retry after valid current authority is restored; completed
  keys retain the existing replay rejection.
- Prove new/existing artifact and genuine receipt/object-backed finalization
  controls, independent current-authority loss before batch execution, private
  contribution loss, reachable competing finalization, and unchanged-credential
  natural expiry. Use genuine mounted OAuth admission plus separate actual-D1
  Hub witnesses and delayed live controls retaining observation timestamps.
  Never rewrite immutable grant permissions or lineage as a purported reachable
  attack; label any deliberately malformed disposable fixture as robustness,
  distinct from production race proof. Persist no plaintext upload secret.

The additive target is `pnpm test:c11:delegated-artifacts`, composed once by C11.
This proves these command-local guard statements, not every subsequent statement
or response delivery, artifact byte retrieval, other OAuth commands, runner
leases, complete private activation or the pending GitHub collision policy.

### Frozen delegated attention commit authority

This corrective C11 slice owns `attention.request.delegation` creation inside
its committing D1 batch. It does not change shared preparation-time helpers,
runner/local capabilities, execution assignment freshness, provider behavior,
attention wire shapes, exact idempotent retries or changed-input rejection.

- Before attention effects, a write-only CHECK repeats the retained
  run→task→project tuple, work-run purpose and permitted result states (`open`,
  `changes_requested`, `submitted`). Repeat sponsor membership/retained epoch,
  the existing Owner/Member/Reviewer request ceiling, kernel `contribute`,
  current project access and private contribution, plus the exact delegation's
  sponsor/client, revocation, valid write scope and current project/task-subtree
  boundary. Preserve the existing `bfb:task:write` requirement without adding
  `bfb:read` or adopting a newer sponsor epoch.
- A separate execution-clock CHECK requires the exact credential's expiry to
  be strictly later than database `now`. Missing, invalid, NULL and elapsed
  expiry fail closed. Prepared predicates, request/observation/audit timestamps
  and `ctx.now` stay unchanged.
- Retain the exact execution/assignment generation as waiter context for the
  same workspace/run/task/project. Its immutable historical tuple remains
  valid context: do not require an active execution/lease, a newer latest
  assignment, runner acknowledgement or new execution authorization.
- Finish reads before queued writes. Guard failure returns uniform
  `command_failed` and atomically rolls back attention request/observation,
  semantic/audit/outbox receipts, idempotency and cursor. Independent authority
  changes remain. Failed keys may retry after valid current authority returns;
  successful exact retries retain the original record without duplicate effects
  and changed inputs still reject.
- Prove healthy delayed Owner/Member/Reviewer and write-only-scope requests,
  including a submitted run's review question. Prove independent production
  `revokeDelegation` before flush, private contribution loss, current scope/
  project/epoch/boundary loss and unchanged-credential natural expiry. Genuine
  mounted OAuth MCP requests and separate actual-D1/native-statement Hub
  witnesses must retain valid positive controls and complete effect snapshots.
  Witness successful independent mutations; create genuine boundary tasks and
  revoke/regrant immutable permissions rather than rewriting history. A cursor,
  FK or competing-Hub backstop that already rejects on old source is a control,
  not new committing-authority proof.

The additive target is `pnpm test:c11:delegated-attention`, composed once by C11.
This proves command-local creation guard statements, not cached/read response
delivery, every later statement, runner/lease expiry, private activation or the
pending GitHub collision policy.

### Frozen delegated context delivery

This corrective C11 slice owns delegated task-context selection, committing
delivery records, cached retries and the final `bfb_get_context` response.
Run/local context delivery, shared clock helpers and provider operations stay
unchanged. Context items and delivery records remain immutable history.

- Use one delegation-only selector for fresh and retained delivery. In its
  selection statement repeat current kernel `read`, sponsor membership and the
  authenticated epoch, project access and private read permission, exact
  credential/sponsor/client identity, revocation, valid all-string read scope,
  current project/task-subtree boundary and strict database-clock expiry.
  Retain the authenticated boundary and target project; do not adopt a newer
  epoch or a different task. Authorized empty context differs from denial.
  MCP supplies its original nullable project/task boundary and client as an
  internal command-input ceiling, never tool arguments. It cannot grant access;
  current canonical authority is still required. Fingerprints and audit input
  remain `{taskId}`, preserving historical retry identity and receipt shape.
- Fresh delivery selects only `agent`/`both` items in version order. Before
  delivery writes, write-only CHECK statements repeat that authority and the
  exact selected immutable identities, including an empty-context sentinel.
  Finish reads before staging writes. A failed committing guard returns uniform
  `command_failed` and rolls back deliveries, receipts, idempotency and cursor;
  independent permission changes remain. Prepared and audit timestamps stay
  unchanged.
- A cached retry reselects canonical immutable items for the original bounded,
  unique identity/version/hash/audience list, not newly appended context. An
  empty list still checks authority. Missing or malformed retained identity
  fails closed without returning any cached body or creating another delivery.
  Each retained item also matches an immutable delivery for the same
  delegation/client and task/version/hash. This proves prior delivery under that
  credential, not provenance from a particular request key.
  Changed-input rejection and the original successful history remain intact.
- After the Hub result, MCP applies the same retained selector with the
  original authenticated delegation and actual outcome before serialization.
  There is no further asynchronous boundary before the response body is built.
  Denial withholds context; it does not erase already committed history.
- Prove independent production revocation before fresh selection, committing
  batch, cached-result return and post-Hub response. Cover current epoch,
  project, read scope, subtree and private read-grant loss; use genuine task
  boundaries and revoke/regrant immutable permissions. Include natural expiry
  of an unchanged credential, delayed healthy read-only Owner/Member/Reviewer,
  empty context, appended context after delivery and exact/changed retries.
  Mounted OAuth MCP and separate actual-D1/native-statement witnesses retain
  complete effect snapshots and healthy controls. Immutable-row corruption is
  robustness testing, not a production permission-race claim.

The additive target is `pnpm test:c11:delegated-context`, composed once by C11.
This does not certify every OAuth read tool, later statements, private
activation, artifact bytes, runner leases or the pending GitHub collision
policy.

### Frozen delegated attention read delivery

This corrective C11 slice owns the final `bfb_get_attention` response. Attention
creation, human answers, run-scoped readers, leases and shared clocks remain
unchanged. Reading creates no business record or attention observation.

- After preliminary selection and every advisory await, select the canonical
  attention record with current kernel read authority in one final statement.
  Match its original workspace, task, project, run, recorded execution ID and
  assignment generation; join that historical execution and exact immutable
  assignment without adopting a different parent. Repeat sponsor
  membership and retained epoch, project access and private read permission,
  exact credential/sponsor/client identity, revocation, valid all-string read
  scope, original nullable project/task-subtree boundaries and strict database
  clock expiry. Serialize immediately without another asynchronous boundary.
- Missing and denied records return the same existing `not_found` tool error,
  without attention bodies or identifiers. Current canonical answers may be
  newer than the preliminary selection. Preserve historical `open`, `answered`
  and `resolved` requests, read-only Owner/Member/Reviewer authority and answers
  for ended runs. Do not require creation state, a latest assignment, live lease,
  requester equality or answer-role authority merely to read history.
- Prove independent production revocation after preliminary body selection,
  current read-scope/client/nullable-boundary loss and natural expiry of an
  unchanged credential before final selection. Include private read-grant,
  epoch/project loss, exact parent misbinding and missing/denied equivalence.
  Delayed healthy controls and canonical answer updates must remain readable.
  Mounted genuine OAuth MCP and separate actual-D1/native-statement witnesses
  distinguish permission races from malformed-history robustness checks.
  Snapshot business history and cursor; HTTP abuse accounting is separate from
  business effects. No cached body or new delivery record is required.

The additive target is `pnpm test:c11:attention-delivery`, composed once by C11.
This does not certify other OAuth read tools, authority after the final
selection statement, provider/run capability expiry, private activation,
artifact bytes or the pending GitHub collision policy.

### Frozen delegated task read delivery

This corrective C11 slice owns the final `bfb_get_task` response. Shared task
reads, work commands, lists, pre-0045 fallback, leases and shared clocks remain
unchanged. Reading creates no business record or context delivery.

- After preliminary selection and every advisory await, select the current
  canonical task in one final statement. Retain its workspace, task ID and
  project ID, not its version, title, state or parent ID. Reuse the current
  task projection so an unreadable parent becomes `parent_task_id: null`
  inside that same selection, without a separate parent fetch.
- Repeat current sponsor membership and retained epoch, project access and
  private read permission, exact credential/sponsor/client identity,
  revocation, valid all-string read scope, original nullable project and
  task-subtree boundaries and strict database-clock expiry. Serialize the
  canonical task immediately without another asynchronous boundary.
- Preserve successful `{task}` replies, read-only Owner/Member/Reviewer access
  and completed/cancelled task history. All valid-ID missing or authority-denied
  paths use the same canonical `not_found` error, including the initial child
  guard, preliminary absence, late advisory denial and final absence. Preserve
  the pinned SDK's existing `isError: true` and `task not found` text for a
  missing task. Do not mask malformed input, database or transport failures.
- Prove production delegation revocation after preliminary body selection;
  scope/client/original nullable-boundary loss; private read-grant, epoch and
  project loss after a successful advisory read; and natural expiry of an
  unchanged credential between final SQL preparation and execution. A genuine
  concurrent task edit returns new canonical fields. Parent-only grant loss
  must still return the readable child with a null parent; a task-bound root
  must not reveal its out-of-subtree parent even in a healthy read.
- Mounted genuine OAuth MCP and native-D1 statements witness the final response
  boundary separately from malformed retained-identity robustness. Snapshot
  business history and cursor after any independent mutation. HTTP abuse
  accounting is not a business read effect.

The additive target is `pnpm test:c11:task-delivery`, composed once by C11.
This does not certify delegated lists, command caches, authority after the final
statement, provider or run capability expiry, artifact bytes or private
activation. The pending GitHub collision policy remains separate.

### Frozen delegated list selection

This corrective C11 slice owns final `bfb_list_projects` and `bfb_list_tasks`
selection. Shared collection readers, the task-access kernel, work commands,
pre-0045 fallback, leases and shared clocks remain unchanged. Reads create no
business or delivery record.

- Each collection uses one final statement that returns current authority
  together with canonical page rows. An authorized empty or cursor-terminal
  page retains the existing empty DTO. Credential or sponsor denial must not
  masquerade as that page, including when the captured project set is empty.
- Retain workspace, sponsor, authenticated epoch, exact credential/client and
  original nullable project/task ceilings. Repeat current membership/role and
  epoch, revocation, valid all-string read scope and strict database-clock
  expiry in the final statement. Reuse the existing delegation conditions;
  do not create task-shaped authority for project metadata.
- Intersect captured project IDs with current project policy/grants before
  lookahead and pagination, without adopting newly granted projects mid-call.
  Task candidates also repeat current kernel private-read authority and use
  the same-statement parent projection. For a task-bound collection, require
  current root access before cursor filtering and traverse only readable
  branches; a readable grandchild cannot cross an unreadable ancestor.
- Preserve ascending-ID order, valid cursor behavior, visible-only `has_more`
  and last-delivered-row continuations. Keep project DTO keys `hasMore` and
  `nextCursor`, and task DTO keys `limit`, `has_more` and `next_cursor`.
  Project metadata follows project authority, not a fabricated task ACL.
  Read-only Owner/Member/Reviewer and completed/cancelled task history remain
  readable. Serialize the selected page without another advisory await.
- Normalize valid collection authority denial, including task-root denial,
  to the SDK `isError: true` plain-text `delegated list not available` reply.
  Preserve initial scope admission, malformed-input and unexpected database
  errors. Invalid authority exposes no collection bodies or identifiers.
- Reproduce production revocation and current project loss after project
  capture, current task-list read-scope/client/original-boundary loss, and
  unchanged credential expiry after SQL and arguments are prepared. Cover
  task-root scope loss after a successful advisory check in the unfixed path,
  authorized empty/terminal pages versus revoked empty pages, current role/
  epoch, canonical concurrent edits and parent masking. Current task-grant/
  project/epoch filtering and branch pruning are retained controls, not new
  exposure claims. Mounted genuine OAuth MCP and separate native-D1 witnesses
  retain complete business/OAuth and cursor snapshots after independent
  changes, and bounded statements even for large captured project sets.

The additive target is `pnpm test:c11:list-delivery`, composed once by C11.
This certifies only the final delegated collection statements, not opaque
task cursors, later delivery, caches, other transports, private activation,
provider/run expiry or the pending GitHub collision policy.

### Frozen human detail and cached business delivery

This C11 checkpoint owns browser/CLI attention detail and cached task create/update,
human attention answer/resolve and delegated attention request replies. The Hub
FIFO, idempotency envelope, execution infrastructure and observation clocks are
unchanged. Fresh writes retain their separate committing authority contracts.

- Attention detail selects the canonical request and its ordered observations
  together under current membership/epoch, project authority and task read access.
  Captured project IDs remain a ceiling, including the CLI binding subset. An
  authorized request with no observations returns the existing empty array; a
  missing or denied parent returns the same 404. Answered/resolved requests and
  historical ended executions remain readable without active-session checks.
  Browser attention replies, like CLI replies, carry no-store and no-referrer.
- Cached business replies retain historical fields, versions and cursor. They
  do not become fresh reads or create observations, audit, outbox or new cursor
  positions. Command-owned replay hooks repeat current authority in a final
  selection after the idempotency read. Command-owned, request-lifetime state
  retains the business authorizer's authenticated principal and nullable
  OAuth/client ceilings across that await; no new shared Hub context or
  transport wire is introduced. This capture does not certify a transport
  ceiling that changed before Hub admission.
- Task retries require the original operation's role and access, exact current
  task/project lineage and current read authority. Their historical parent ID is
  masked in the same statement when that parent is no longer readable. A parent
  mask must not permit a target task whose authority was lost during the old
  second read. Write-only delegations need write scope, not additional read scope.
- Human attention retries require the current kind's answer role, contribute
  access and exact retained attention/run/task/project lineage. Delegated
  requests retain Reviewer support, write-only scope, permitted run result state
  and their original immutable waiter assignment; they do not require a live
  lease or adopt a newer execution. Their final selection repeats current
  credential/sponsor/client, all-string write scope, original nullable resource
  boundaries and strict database-clock expiry.
- Reproduce the old attention body/observation composition race and old cached
  task parent-read and attention idempotency-read races. Include healthy empty
  detail, historical cached results, read/contribute/edit distinctions,
  Reviewer and write-only cases, immutable lineage and original-boundary changes.
  Snapshot canonical business/authority state and cursors after independent
  changes; native D1 witnesses are separate from mounted transport tests.

The additive target is `pnpm test:c11:human-detail-cache`, composed once by C11.
This checkpoint does not certify authority after the final selection, CLI
credential lifetime (binding revocation, scope/subset changes and admission role)
or cached command binding subsets, provider/run capability expiry, fresh command response
delivery, destructive retention, artifact bytes, private activation or the
pending GitHub collision policy.

### Frozen public business delivery and CLI ceilings

This finite C11 pass closes public task-business admission, committing authority,
cached replies and delivery after the actual Hub response/body await. It extends
the existing delivery invariant; it does not change Hub FIFO, execution,
observation clocks, command names, stored business results or transitions.

- Owned commands are task create/update; comment/progress/context/dependency/link;
  attention answer/resolve/delegated request; human/delegated result submission,
  request-changes/accept/fail/cancel; human/delegated artifact create/finalize,
  upload grant, view grant and review; timer start/stop and browser activity.
  Delegated context delivery retains its existing canonical selection as a
  control. Local-agent result submission is excluded, including its admission,
  commit and reply. One-use artifact commands continue to reject cached success.
- The public transport retains its authenticated human, epoch, role, effective
  projects and original credential identity/scope ceilings. Current
  authority can narrow these ceilings but cannot enlarge them. CLI authority
  includes its exact exchanged binding and current Owner/Member admission,
  revocation, database-clock expiry, safe required scopes and current subset.
  OAuth includes its exact client and nullable project/task restrictions.
  Write-only business actions do not acquire an unrelated read requirement.
- An internal capsule is not caller input. Closed public schemas reject it;
  command adapters strip it before original validation, business logic,
  fingerprints, cursor reservation and audit input. It is never a business
  result, cache payload or persisted audit field. Original command hooks and
  historical retry identity remain intact. Commands without authorization hooks
  retain that absence and their existing observation-time semantics.
- Command-owned typed SQL predicates govern admission, staged commit guards,
  replay and final public delivery. Every guard inserts exactly one CHECK row,
  including on absent targets, so late denial aborts all staged command effects.
  Its typed selection is materialized separately from the VALUES expression to
  remain within native D1's expression-depth limit; no authority term is removed.
  Artifact owners supply their canonical admission SELECT directly rather than
  wrapping it in an additional EXISTS expression that exceeds the same limit.
  Final delivery runs after Hub RPC and body parsing; only synchronous secret
  attachment/projection/serialization may follow. Delivery denial withholds the
  reply, not the already committed command. No generic recursive scrubbing or
  fresh transition/version authorizer is used for historical replies.
- Creation retains project/parent gates as well as the new target. Historical
  attention/result/timer replies retain exact lineage but not pre-effect state
  or latest-version requirements. Artifact references and recognized submission
  evidence remain one current-authority selection. Parent and timer masks are
  recomputed only where already established. Run-free records use membership
  authority rather than a fabricated task ACL.
- Human CLI project/task/run/attention/artifact list/detail and session reads
  compose binding authority with final canonical selection, including empty and
  terminal pages and multi-source artifact details. The captured effective
  project vector intersects current binding restrictions and project policy.
  Version/device issuance and successful self-revoke acknowledgement remain
  unchanged. Cancellation keeps its existing action-bound step-up proof.
- Prove actual old-source failures and healthy controls for original ceiling
  loss before Hub admission, missing cache hooks, post-Hub fresh/cache delivery,
  committing expiry/revocation and final CLI reads. Distinguish denied admission
  (no effects), failed committing guards (rollback), read-only/cache delivery
  (no new effects) and withheld post-commit replies (committed effects retained).
  Native D1 witnesses and mounted browser/CLI/OAuth witnesses are separate.

GitHub key-collision policy and its internal helper bypass, provider/runner and
local-agent delivery, destructive retention, artifact-byte consumers and private
activation are excluded. No new private controls or live operation are enabled.
The additive target is `pnpm test:c11:public-business`, composed once by C11.

### Frozen browser task child-collection selection

This finite corrective C11 slice owns browser task comments, context (all and
agent audiences), dependencies, links and work-run collections. Their current
child predicates suppress bodies after parent revocation, but a late denial
must not be reported as an authorized empty collection.

- Select the exact readable parent, its authority sentinel and the child page in
  one final statement. Retain the originally loaded human, authorization epoch
  and project vector alongside current task-kernel read authority. A project
  gained or task moved during an await cannot widen that captured ceiling.
- Missing or currently denied parents return the existing uniform
  `{ "error": "not_found" }` HTTP 404, including collections with no rows or a
  terminal cursor. Authorized empty collections retain their current HTTP 200
  DTO. No advisory read or post-selection asynchronous work replaces the final
  authority-bearing statement.
- Preserve existing fields, comment attribution, context audience filtering and
  version order, dependency-target read checks, exact work-run/task/project joins,
  ordering, limit-plus-one lookahead and cursor fields. Reviewer read access
  remains valid. This does not certify opaque continuations or new context
  delivery/receipt semantics.
- Reproduce loss of a named read grant immediately before the real final child
  selection using genuine synthetic browser sessions. Record the original
  failure as HTTP 200 empty versus required 404, not as a demonstrated body leak.
  Retain healthy empty/terminal-page controls, representative late membership,
  epoch and project loss, clean foreign-key checks and unchanged canonical rows
  after each independent fixture mutation.

Run execution/session collections, review timers, shared agent/delegated context
consumers, mutations, clocks, leases, cleanup and private activation are excluded.
The additive target is `pnpm test:c11:task-collections`, composed once by C11.
The contract is preparation only until its source and exact target receive their
own clean-checkout acceptance.

### Frozen browser task child-position v1

[ADR 0016](../adr/0016-browser-task-collection-positions.md) records Timo's approved
wire transition and the read-position bookkeeping exception. This finite slice
replaces raw-ID continuations on browser comments, dependencies, links and
work-run pages only. Both context views remain unpaged.

- Keep route names, ascending record-ID order, visible-only limit-plus-one
  selection, record fields and attribution. `cursor` accepts only canonical
  43-character base64url encodings of 32 random bytes. No raw-ID fallback,
  restart, conversion or feature flag exists. Every paged response contains
  `next_cursor`, a new position iff `has_more`, otherwise `null`.
- Check the current readable parent and originally captured human, epoch and
  project vector before cursor denial, including empty and terminal pages.
  Absent/denied parents retain uniform HTTP 404 `{ "error": "not_found" }`.
  Successful pages and their admission/cursor/authority failures carry
  `Cache-Control: private, no-store`; browsers must not retain position pages.
  All malformed, unknown, expired, foreign and drifted positions return
  `invalid_argument / unknown task collection cursor` without source metadata.
- Persist a domain-separated SHA-256 hash only. Each position binds workspace,
  human, retained epoch, projection version `1`, task and project, one of the
  four collections, effective page size and the exact sorted canonical project
  audience. Re-derive that audience in the authority-bearing selection; either
  same-epoch expansion or contraction invalidates a position. Bound audience
  metadata to 32 KiB and reject overflow without truncation.
- A root captures the same-workspace/task collection insertion ceiling and a
  ten-minute expiry using the database clock. Descendants inherit both without
  sliding expiry. Store the last delivered row's identity and insertion tuple,
  never the lookahead. The anchor must remain a currently readable canonical
  child of this exact parent, including dependency-target access and work-run
  purpose/project checks. Anchor deletion, tuple drift or parent movement
  invalidates a position. Newer backdated IDs remain outside the capture.
- Issue through a registered direct-human read-authorized Hub command with
  a boolean receipt and rejected cached-success replay. Derive cuts server-side;
  transport captures may narrow authority but cannot supply an anchor or ceiling.
  Plaintext positions never enter Hub inputs, results, fingerprints, receipts,
  idempotency, audit, semantic events or outbox. Ordinary redacted Hub issuance
  bookkeeping is the approved exception, not a task/progress/interaction action.
- Finish all reads before queued writes. A database-clock commit guard repeats
  parent authority, audience, expiry, anchor and the complete bounded selection,
  including lookahead. Loss or drift rolls back position and Hub bookkeeping.
  After the actual Hub response, final selection repeats current authority
  under the issued capture and verifies its cut. Check expiry synchronously
  after the final awaited read too. Withhold stale replies without rolling back
  an already committed position. Terminal reads create no position; issuance
  unavailability must never expose raw IDs or falsely claim a terminal page.

The additive target is `pnpm test:c11:task-positions`, composed once by C11.
Migration preservation, hash grammar, direct-human/Reviewer authority, every
collection binding, malformed/raw/foreign positions, fixed capture/expiry,
audience changes, dependency filtering and committing/post-Hub races require
mounted and native D1 evidence. This contract is not implementation proof,
private activation or certification of other raw collection wires.

### Frozen historical attention sources for measurements

This finite corrective C11 slice owns only attention-derived run, task and
aggregate measurement projections. Historical requests and observations remain
stored; fixing their selection does not repair or rewrite malformed history.

- Before delivering request IDs, kinds, state, latencies, blocking waits,
  observation provenance or aggregate counts, select exact historical lineage:
  workspace/project/task/run, execution belonging to that run, and the immutable
  assignment at the request's generation belonging to that same run/task/project.
  A declared readable run or task cannot substitute for its retained private
  assignment. Foreign-key validity alone is insufficient for this relationship.
- Run attention rows and their observation count, task attention/intervention
  rows and aggregate attention counts use the same complete lineage predicate.
  Malformed rows contribute neither bodies nor existence/count/timing metadata.
  Current parent-task ACLs and the final authority recheck remain unchanged.
- Canonical historical ended executions remain measurable. Do not require an
  active runner, latest generation, live lease, open result or open attention;
  those are execution/transition constraints, not historical read authority.
  Keep interval/token arithmetic, observation clocks and held public sources.
- Reproduce task/run mismatches and a coherent declared shared tuple referring
  to a private execution/assignment. Compare complete readable run/task and
  aggregate projections, including counts and waits, before and after insertion.
  Retain a canonical ended-history control, clean foreign-key checks and exact
  stored-source snapshots. Native D1 witnesses are separate from mounted human
  authentication and provider/runtime operation.

The additive target is `pnpm test:c11:measurement-attention`, composed once by
C11. Human attention-detail delivery, other measurement-source lineages,
ingestion/mutation authority, execution consumers, clocks/leases, private
activation and live rollout are excluded.

### Frozen human attention historical lineage

This finite corrective C11 slice owns the shared attention read primitives used
by human detail, ranked inbox and observation delivery. Declared readable task
and run IDs cannot replace the retained execution and immutable assignment.

- Before selecting attention bodies, answers, origin IDs, observations or rank
  metadata, bind workspace/project/task/run, the execution belonging to that
  run, and the assignment at the request's generation belonging to the same
  run/task/project. Apply this relationship inside all four read selections:
  `getAttention`, `getHumanAttentionDetail`, `listAttention` and
  `listAttentionObservations`, plus the independent final CLI selections
  `readCliAttention` and `readCliAttentionDetail`. Filter ranked requests before
  ordering and limit; malformed high-priority rows cannot displace a valid page
  member. CLI retains its exact captured binding/project subset, read scope,
  Owner/Member ceiling and authorized-empty-page sentinel in the final statement.
- Preserve the existing current parent-task ACL and original human, CLI,
  delegated and local-agent ceilings. These shared read primitives add no
  execution permission and do not change provider or runner consumers. Historical
  canonical ended executions, earlier assignment generations, resolved requests
  and authorized empty observation lists remain readable. Do not require current
  runner authority, a live lease or an active/latest execution.
- Human browser/CLI detail keeps its uniform missing/denied no-store envelope.
  A malformed tuple present before the request, or appearing at the existing
  final detail selection after authentication, must not return the question,
  answer, origin or observations. Reads must not create business records or
  rewrite retained source history. Existing business commands and delegated final
  selection retain their independent admission/replay/delivery checks.
- Use same-project private/shared fixtures, clean foreign-key checks, complete
  read projections and stored-source snapshots. Keep canonical ended-history and
  empty-history controls. A delegated robustness test must independently feed
  its malformed retained record to the delegated final selector even when the
  preliminary shared read now denies it.

The additive target is `pnpm test:c11:human-attention-history`, composed once by
C11. This is historical read selection, not ingestion/transition authority,
provider operation, execution lifetime, metadata positions, private activation,
publication or live rollout.

### Frozen task-detail panel selection

This finite corrective C11 slice owns the result, measurement and artifact-review
panels already exposed through task Details. It hardens their presentation
against concurrent delivery; it does not replace server authorization or enable
private work.

- Bind every panel to its committed workspace/task/API selection incarnation
  and every load to the newest request. Artifact status and decisions also bind
  to the exact selected-artifact incarnation. Returning A to B to A never revives
  the first A response. Retained callbacks cannot start old-scope reads or mutate
  the current pending state; unmounted panels have no completion effects.
- Install result runs and submissions, measurements and timers, and artifact
  lists/origin/selection as coherent snapshots after their required awaits.
  Do not expose a partly loaded body with authority-dependent actions. Artifact
  status belongs only to the current selection and is unavailable immediately
  when that selection changes.
- Only current responses may set body, error, loading or pending state. A
  current 401/403/404 or `not_found`, `forbidden` or `stale_authorization` removes
  delivered records, artifact selections/viewer and actions. Keep one
  keyboard-operable retry inside the unavailable detail panel. A denied body
  must not be represented as an authorized empty collection.
- Mutations retain the original scope and target through POST/body parsing and
  follow-up reads. Only current success clears the submitted note, reloads or
  calls the parent review callback. Old success, failure and finalizers are
  ignored. Ordinary validation/transient failures and version conflicts retain
  the human's draft and the existing conflict/reload semantics; local drafts
  are not published merely because delivery was denied or retried.
- Hidden visited panels stay hidden. Their existing label-only section notice
  remains the opt-in path to the error, without copying record text or expanding
  details automatically. Preserve W03 themes, existing named disclosures and
  the two default task actions. Preserve inert review notes, explicit viewer
  activation, measurement provenance and distinct result/artifact decisions.
- Prove selection/re-entry, newest refresh, delayed HTTP/body/error/finalizer,
  current-denial suppression, retry, mutation and hidden-panel cases with
  mounted consumers and healthy controls. Synthetic browser presentation
  responses are not server-authority proof; existing genuine domain/mounted
  denial controls remain separate witnesses.

The additive target is `pnpm test:c11:detail-panels`, composed once by C11.
Malformed measurement-source lineage, backend authority changes, artifact-byte
delivery, execution consumers, privacy activation and live rollout are excluded.

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

### Frozen human upload reply and local artifact-byte proof

This finite corrective C11 slice owns direct-human upload receipt metadata after
the receipt transaction, and disposable native private artifact delivery proof.
It does not certify agent upload replies, deployed private bytes or activation.

- After the real receipt transaction resolves, the human upload response must
  reselect the exact retained grant/consume attempt, human/epoch, artifact/version,
  nullable run, format/role, verified digest/size/key and canonical receipt source.
  Current member/owner contribution and task/project access are required. Retain
  the project ceiling captured during consume; newly granted projects do not
  widen an in-flight response. No await follows that final selector before JSON.
- Lost authority returns the existing uniform 403 `request_rejected`, no-store,
  without IDs, key, digest, bytes or integrity details. Already committed object,
  receipt, source and verification audit remain unchanged. This is response
  suppression, not rollback, reconsumption, finalization or cleanup.
- Prove the actual post-commit/pre-response seam, not a simulated failed commit.
  Witness successful receipt effects before independent revocation, then compare
  them unchanged. Retain healthy private creator/contributor, shared/run-free
  and same-content convergence controls. Agent upload semantics stay unchanged.
- Disposable local Worker/D1/R2 proof forwards actual stored objects and bodies.
  Use genuine synthetic browser authentication for create/finalize/view issue,
  and the production cookie-less artifact handler. Prove healthy private bytes,
  read denial before consume and after real object/body awaits, contribution
  loss after R2 put before receipt commit, and after successful receipt commit.
  One-use claims and committed history survive response denial; failed receipt
  batches leave no registry/receipt/source/verification audit. R2 orphans are
  not deleted. Compare canonical/FK snapshots after independent mutations.
  Include a healthy named Reviewer read recipient and independently witnessed
  restricted-project access loss after actual R2 get/body. The task read grant,
  role, epoch and parent remain unchanged in those project-loss fixtures. This
  proves existing current read rules; it does not introduce a view-parent move
  policy or copy the Owner/Member upload-role ceiling into view delivery.
- Test-only seam wrappers are confined to disposable tooling. They neither add
  a deployed bypass nor fabricate R2 success. Report bounds and synthetic check
  labels; local native proof is not a live/pilot or browser-presentation claim.

The exact additive target is `pnpm test:c11:artifact-bytes`, composed once by
C11. Cursor compatibility, GitHub collisions, execution consumers, expiry and
destructive retention keep their separate unresolved gates.

### Frozen human artifact grant atomic expiry

This finite C11 slice owns direct-human upload-grant consumption and human
view-grant redemption. A captured request timestamp records an observation; it
cannot extend a one-use grant's redemption deadline across awaited work.

- Retain existing supplied-time checks, observation timestamps, secret/nonce,
  role/epoch/project/task/version and one-use predicates. Add database-execution
  clock expiry to the existing conditional consumption UPDATEs. The grant must
  still be unexpired when that statement executes, not only when its inputs
  were captured or its statement was prepared/bound.
- An expired unchanged grant fails through the existing uniform no-store
  `403 request_rejected`. Its consumption attempt, grant transition and durable
  audit effects roll back together before upload bytes or view R2 reads. No
  transport-owned business logic, kernel clock policy or new protocol is added.
- Once consumption succeeds, grant TTL does not cancel body/R2 completion,
  verified receipt or explicit finalization. Current parent/epoch/role delivery
  fences and exact consumed lineage still apply; a later response denial does
  not undo committed consumption or erase history.
- Reproduce OLD native upload and view consumption using database-clock-aligned
  live grants and an independently witnessed delay after statements are prepared
  and bound, before their actual atomic batch. Grant/credential/authority rows
  and supplied time remain unchanged during the delay. Equally delayed live
  controls preserve useful bytes and original occurrence timestamps.
- Prove expired fixed requests have no body/storage/consume/audit effects,
  canonical rows and FKs remain unchanged apart from separate HTTP budgets, and
  already-consumed live controls can finish after TTL with retained one-use
  history. Short-deadline grant rows are explicitly synthetic; native fixtures
  retain historical issuance offsets. Neither changes production issuance TTL
  or implies a real sign-in ceremony.
- Retain all prior artifact controls. Test-only seams forward native D1 batches
  and R2 operations and report bounded outcomes and measured SQL/binding bounds;
  no installed app, persistent pilot, deployment or private activation is claimed.

The owning target remains `pnpm test:c11:artifact-bytes`, composed once by C11.
Agent upload grants/replies, operations step-up proofs, runner/lease expiry,
destructive retention and the wider temporal matrix remain separately owned.
This contract does not certify its implementation or complete C11 acceptance.

### Artifact receipt D1 expression boundary

The human-grant expiry regression run exposed an existing native agent receipt
batch failure: D1 rejects the composed current-authority CHECK with `Expression
tree is too large`. It reproduces on the unchanged pre-expiry source. This
bounded repair changes only receipt SQL composition, not agent upload authority
or execution behavior.

- Retain the exact grant/consume-attempt identity, matching consumed timestamp,
  canonical artifact/version association and agent-origin grant condition.
  Retain the prepared current-authority witness and every bound value unchanged.
- Evaluate the agent-origin source check and the complete authority witness as
  sibling scalar conditions of the same receipt CHECK, rather than nesting the
  witness inside the source-count WHERE. Both must pass. Keep the human branch
  unchanged, including its current parent/epoch/role predicate.
- All registry, receipt, immutable winning source, audit and CHECK statements
  remain in one D1 batch. A false or missing source/witness aborts the entire
  receipt batch. No extra grant, clock policy, schema, provider or runner helper
  is introduced; physically written R2 objects are not rolled back or deleted.
- The retained exact `pnpm test:v01` native compiled publication regression must
  pass with production D1/R2 and unmodified native helpers. Retain domain agent
  authority/recovery tests, the C11 artifact matrix and full repository checks.
  The failed old-source replay and test-only bounded error diagnosis are separate
  from acceptance; temporary diagnostic headers/wrappers must not be committed.

This is a receipt execution-limit repair, not agent natural-expiry, response
delivery, remote-start, live-provider or private-activation certification.

### Frozen operations step-up atomic expiry

This finite C11 slice owns only the operations-local `prepareStepUp` consumption
used by `ops.retention.set` and `ops.recovery.resolve_stuck_upload`. Retained
request time must not extend an unchanged action-bound proof across awaited work.
This freeze is not implementation or acceptance evidence.

- Retain supplied-time validation, exact human/workspace/action/target/scopes/
  epoch binding, one-use consumption and the unique-stamp winner CHECK. Add
  database-execution-clock expiry only to the existing consumption UPDATE.
  Shared step-up, authorization, runner and lease helpers remain unchanged.
- An unchanged proof that expires before that UPDATE executes must leave no
  consumption, policy/version, artifact abandonment, recovery ledger, Hub audit,
  semantic event, outbox, idempotency or workspace-cursor effects. The existing
  failed batch returns the bounded `command_failed` Hub outcome. Existing route
  admission and error mapping remain unchanged; no new diagnostic body is added.
- Fresh-proof target-ledger recovery retries obey the same consumption boundary,
  even when original artifact effects already exist. Failed consumption retains
  those earlier committed rows unchanged and creates no retry receipt.
- Once the proof has been successfully consumed and the batch committed, expiry
  while awaiting that batch response does not cancel or undo the command. Keep
  original occurrence times and one-use history. The consumption stamp remains
  an opaque winner identity, not a timestamp or a new user-interaction record.
- Reproduce OLD and fixed behavior with SQL-clock-aligned synthetic proofs that
  are live after actual UPDATE preparation/binding. Witness the same explicit
  pre-batch delay for naturally expired and comfortably live controls, forwarding
  the original statements and parameters. Do not rewrite proof, authority or
  target rows during the delay; early rejection is not the temporal reproducer.
- Use mounted/staged SQLite and a separate disposable native-D1 proof. Compare
  complete canonical snapshots and clean FKs; keep engine/migration metadata and
  any HTTP budgets separately named. Measure handler/Hub statement bindings,
  SQL bytes and batch lengths without counting setup or snapshot queries.

The owning additive target is `pnpm test:c11:operations-expiry`, composed once by
C11. Implementation and clean acceptance evidence remain separate. Retain exact
X05 regression and full repository/platform verification. No R2 deletion, private
retention activation, later-statement deadline, broader role/epoch repair, live
provider, installed app, runner/lease or complete C11 claim is included.

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
