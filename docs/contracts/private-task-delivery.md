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
delivery rows. Existing cursor-derived delivery identities and outward raw
cursors remain activation barriers until the recipient-position transition.

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
