# Local run-scoped MCP

Owner: [A01](../work-packages/WP-A01-local-mcp-context.md). Gate: `pnpm test:a01`.

Status: Current `local-mcp/2` implementation under
[ADR 0004](../adr/0004-local-mcp-runtime-authority.md) and
[ADR 0005](../adr/0005-agent-work-session-and-attribution.md). Context/task reads,
canonical session binding, current bound authority and all four online writes
use typed daemon RPC and the possession-authenticated Worker/Hub/D1 path.
The [ADR 0006](../adr/0006-daemon-owned-pending-agent-work.md) implementation adds
daemon-owned protected capture, write-ahead durability and pending replay on a
separate version-3 write lane. The [runtime certificate](../work-packages/evidence/WP-A01/runtime-manifest.json)
records complete A01 clean-checkout acceptance at `adbf740`; earlier partial
checkpoints remain historical. This is synthetic native proof, not live-provider
or Terminal certification.

This contract defines the tool and trust boundary for `bfb mcp stdio`.
A02/A03/V01 extend this same server; they do not introduce another agent
credential or a second local tool endpoint.

## Transport

- `bfb mcp stdio` speaks JSON-RPC 2.0 over standard I/O with one
  newline-delimited value per line. A single stdin line larger than 65,536
  bytes is rejected without a response.
- Standard output carries JSON-RPC responses and notifications only.
  Diagnostics go to standard error and the redacted local log. A test fails
  when any stdout line is not a JSON-RPC value.
- Supported methods: `initialize`, `notifications/initialized`, `ping`,
  `tools/list`, `tools/call`. Every other method returns `method_not_found`.
  There are no prompts, resources, or subscriptions in v2.
- The supported handshake revision is `2025-11-25`, independently of the
  remote MCP protocol. Initialization requires a nonempty `protocolVersion`,
  object `capabilities`, and `clientInfo` with nonempty name/version strings.
  Another requested revision receives the supported `2025-11-25` counteroffer;
  it is never falsely advertised as supported. The initialized notification
  completes the exchange before tool listing or calls. Reinitialization fails.
  `ping` reports transport responsiveness only. Modern `server/discover` is
  unsupported. See [ADR 0011](../adr/0011-local-mcp-handshake-compatibility.md).
  The server name remains `bfb-local-mcp`; `local-mcp/2` identifies the BFB tool
  and trust contract, not MCP's dated transport revision.

## Daemon and cloud bridge

The MCP host has no runner token, signing key, `RunnerConnection`, or human
credential. It calls fixed typed Unix RPC methods on the private daemon socket.
The daemon alone obtains the current L08 connection for the runner derived from
the verified local assignment. Neither RPC nor the cloud work API accepts an
arbitrary URL, HTTP action, shell command, executable, or claimed principal.

The current host negotiates these fixed operations:

| Local RPC method | Runner action | Result |
| --- | --- | --- |
| `mcp.v2.authority` | `work/authority` | Current assignment/run authority disposition |
| `mcp.v2.get_context` | `work/context` | `ContextResult` with committed per-item delivery rows |
| `mcp.v2.get_task` | `work/task` | Agent-visible bound task view |
| `mcp.v2.bind_session` | `work/session-bind` | Canonical association from a daemon-read trusted L06 observation |
| `mcp.v2.bound_authority` | `work/bound-authority` | Current authority for the original confirmed association/session |
| `mcp.v3.add_comment` | `work/comment` | Canonical comment result or bounded delivery receipt |
| `mcp.v3.update_task` | `work/update` | Permitted task revision or bounded delivery receipt |
| `mcp.v3.report_progress` | `work/progress` | Canonical progress-comment result or bounded delivery receipt |
| `mcp.v3.propose_task` | `work/proposal` | Canonical root/child result or bounded delivery receipt |

`local-agent-rpc` is a separate closed document with `schema_version: 2` and
fixed `mcp.v2.*` names. Its four legacy writes share the daemon's write-ahead
admission but keep their committed-result-or-error shapes; they cannot return
pending receipts. The separate closed `local-agent-work-rpc` document has
`schema_version: 3` and only the four `mcp.v3.*` writes. The daemon alone calls
`work/capture-confirmation` and `work/replay`; neither is a provider-facing RPC.
Only implemented handlers are advertised. The original general `local-rpc` document
and the three `mcp.*` read handlers remain version 1 for existing clients, with
no write authority. The Swift app remains on version 1.

Before sending any private version-2 or version-3 input, the client asks the existing
version-1 `daemon.status` for its registered `methods` on the same verified Unix
connection. Unsupported methods produce a visible `protocol_unsupported`
upgrade error, without downgrade, retry or a generic proxy. The exact document
version, method and request ID must match the response. Replacing the socket
pathname after negotiation cannot receive the private request through a new
connection. The complete encoded frame, including its newline, is at most
65,536 bytes.

Runner actions are beneath the existing
`/runner/workspaces/:workspaceId/runners/:runnerId` namespace and use the L08
proof bound to the actual request method, path and body. Browser, human CLI and
OAuth credentials cannot substitute for that proof. Correlation values and
kernel process facts stay local; they are not sent to Cloudflare.

Local requests carry a typed execution reference (execution ID, assignment
generation and same-execution correlation) plus the original tool request ID
where relevant. The daemon resolves all remaining IDs from its assignment and
rejects mismatches with the host's already-verified boundary. Cloud requests
identify the execution/generation; domain commands derive task/project/run
from D1 and verify the authenticated runner owns that assignment.

Wire schemas, method-specific payload validation and deterministic positive and
negative fixtures cover these operations. Canonical schemas
live in `protocol/schema/v1`; owning commands are `pnpm protocol:generate` and
`pnpm protocol:check`. Deterministic version-2 positive/negative fixtures live
in `protocol/fixtures/v2/local-agent-rpc.json`; capture, replay and version-3
fixtures live in `protocol/fixtures/v3/local-agent-work-rpc.json` under those same
owning commands. The cloud execution reference
stays schema version 1, independently of the local IPC version; existing read
operation hashes remain unchanged.

Only percent/confidence in the named progress request, local component and exact
v2/v3 report-progress payloads and the named replay progress request admit finite decimals. Raw out-of-range values and
nonzero underflow fail before effects; integer fields and general v1 retain
their exact numeric rules. The TypeScript `encodeNamedWireDocument` API applies
the same closed named validation and canonicalization as decoding; the legacy
unqualified encoder remains integer-only. Shared generated fixtures pin full
document and typed-progress-request hashes against both TypeScript and Go.
The stdio boundary validates the raw progress and `expected_version` number
spellings before canonicalization. Equivalent accepted spellings, such as
`125e-1` and `12.5` or `3.0` and `3`, share the same local request fingerprint.
Rounded fractional versions and unsafe integers are rejected, not converted into
valid versions. A rejected input does not consume its request identity.

The authenticated Hub transport actor remains `runner`. Current run authority
also checks the assignment's requester membership/project grant and launch
grant, runner authorization/grant epochs, assignment generation/ownership,
checkout lease, execution and result state. Domain effects attribute the
originating `agent_run` separately from the requesting human and executing
runner. A requesting-human or `actorSystemId = run` shortcut is forbidden.
Context delivery is a serialized WorkspaceHub command even though the MCP tool
is permitted as a bootstrap read. Audience filtering and delivery insertion
reuse C08's domain implementation.

## Process verification

Before creating a provisional connection the server verifies, against the
immutable local execution assignment (execution ID plus assignment
generation) and never against caller-supplied identity:

1. The peer UID equals the daemon UID.
2. The peer process (the MCP client, normally the provider CLI) is the
   recorded provider process for the assignment (PID plus start identity) or
   a live member of the assignment's owned process group, with no unknown or
   escaped containment.
3. The assignment is active: claimed, unexpired, not ended, and its run
   result is not terminal.
4. The presented correlation value equals the assignment's correlation
   token, compared in constant time.

Each daemon IPC operation independently validates its kernel-authenticated MCP
host caller and the live provider parent/owned group against that assignment.
It inspects UID, PID/start identity and containment itself; payload-supplied
process identities cannot satisfy this check. Unknown, escaped, stale or
PID-reused containment fails closed. The host's startup check alone cannot
authorize a daemon call.

Before dispatch and again before releasing a cloud response, the production
bridge invokes L05's in-process `CheckAgentOwnership` against the exact
execution/generation. It inspects the held authenticated lock, signed helper,
fresh process group and retained descendant history; it does not launch,
recover or repair missing state. Local native-history projection rejects known
uncertainty/release/escape/incomplete markers and malformed authority fields,
but absence of such a marker is not itself a fresh ownership proof. A local
containment denial closes the capability via `assignment_ended`; this diagnostic
does not create a business execution-end event. A denial after cloud commit
withholds the private reply without asserting that no effect committed.

Any failure returns a JSON-RPC error and creates no capability. The server
reads exactly the ten scoped `BFB_*` execution values: the nine named in the
architecture plus `BFB_RUNNER_ID` (`BFB_WORKSPACE_ID`, `BFB_PROJECT_ID`, `BFB_TASK_ID`,
`BFB_RUN_ID`, `BFB_RUN_EXECUTION_ID`, `BFB_ASSIGNMENT_GENERATION`,
`BFB_CHECKOUT_ID`, `BFB_CORRELATION_TOKEN`, `BFB_ARTIFACTS_DIR`, plus the
informational `BFB_RUNNER_ID`). `BFB_CORRELATION_TOKEN` is the only token it
reads. It refuses
to start when the environment carries a bearer-like value outside that set
(`BFB_RUNNER_TOKEN` or any other `BFB_*TOKEN`, `BFB_*SECRET`, `BFB_*BEARER`,
`BFB_*KEY` variable), and it never writes environment values to stdout,
stderr, or evidence.

## Capability states

A capability is in-memory only, bound to one stdio connection, one
assignment, one observed provider session, and one
workspace/project/task/run boundary. It is never reconstructed from
caller-supplied IDs.

- `provisional`: permits `initialize`, `tools/list`, `bfb_get_context`,
  `bfb_get_task`, and `bfb_get_attention`. Every mutation returns
  `session_not_bound`. This state exists so startup can load context before
  L06 commits the trusted observed-session binding.
- `activated`: permits the full tool set. Activation is atomic: the
  connection observes, through its `SessionBindingSource`, a trusted binding
  whose provider, observed session ID, execution ID, and assignment generation
  equal the pinned assignment, explicitly confirms it through the daemon and
  serialized Hub command, and transitions exactly once. A competing session ID can
  never activate the connection; after the first activation every other
  session ID returns `session_conflict`.
- `closed`: entered on revocation (authorization or grant epoch change),
  execution end, accepted/failed/cancelled run result, or stdio EOF. Every
  later call returns `capability_closed`. Closure is sticky; a capability
  never reopens.

Every call rechecks current revocation, execution, and result state, not
just the state observed at activation. This includes repeated request IDs:
the local capability, argument and boundary checks precede cached replies,
and a read-only run-authority hook uses fresh server time inside WorkspaceHub's
serialized transaction before returning an existing idempotent result. It runs
before staged writes, not after them. Connectivity failure does not mean
revocation, completion or successful cloud delivery. Cloud permission/policy
denials must never be downgraded to offline queue permission. An already
activated capability may reach daemon write admission after a transient cloud
poll failure, but only after rechecking its trusted local binding. This cannot
activate a new session offline or authorize capture by itself. Terminal receipt
reasons close a capability just like terminal errors.

## Tool map

All tools require `request_id` (8-128 ASCII characters matching
`^[A-Za-z0-9._:~-]{8,128}$`, the wire `IdempotencyKey` primitive). An authorized repeated
operation returns the stored outcome without re-executing, except
`bfb_wait_for_attention`, whose pending outcomes are never memoized so a
repeated wait always re-reads committed state. Reusing an operation identity
with a different tool or payload is rejected, not interpreted as the original
operation. This includes changed task/project/parent/attention arguments.
Bounds mirror C08 so local and remote behavior agree.

One stdio connection retains at most 256 accepted request identities with
their input fingerprints. Reads retain outcomes; production writes never cache
a private outcome or pending receipt and always recontact the daemon. Once full, every unseen identity returns
`request_rejected` before any tool effect; no outcome is executed without room
for its binding. Existing identical identities remain usable after current
authority validation. Error responses do not consume cache slots, but successful
delivery-receipt responses (including pending or rejected delivery) retain their
input binding. Pending attention waits remain uncached. A fresh stdio connection starts a new local
cache; the cloud keeps the scoped operation identity for committed reads.

For all four online writes, the stable cloud identity contains only tool, cloud
reference version, execution, generation and request ID. The confirmed session
and typed payload are bound independently by the input fingerprint, so changed
payload/session cannot become a new identity after a process restart. Session
binding has one assignment-scoped identity independent of caller request IDs;
its fingerprint binds the trusted observation. Current bound authority precedes
both local and cloud cached outcomes.

Cached proposal outcomes also reach their original cloud command: current
root-proposal policy is checked before the stored reply. An operation's committed
expected-version or child-count precondition is not re-applied to a retry.
Consequently a successful twentieth child remains replayable at a count of 20,
and an old update returns its original revision after later task changes.

New context/task command receipts in audit, semantic events and outbox records
contain bounded IDs, versions, hashes, delivery references, state and priority,
not private bodies, titles or punchlines. The full authorized response remains
in canonical idempotency storage. Binding/write receipts also retain bounded
derived run, execution, generation and canonical session IDs, never comment
bodies, progress summaries, task titles or punchlines. Progress receipts may
retain the explicitly reported percent/confidence. The authenticated runner remains a separate receipt actor. Infrastructure failures are sanitized,
retryable errors, not terminal authority or permission to queue. Fresh polling
currently creates bounded command receipts per request; durable poll growth
needs measurement and a bounded follow-up.

The stdio inspector fixture is owned by
`BFB_UPDATE_MCP_TRANSCRIPT=1 go test ./internal/localmcp -run TestGoldenInspectorTranscript`.

The original request ID is forwarded through IPC to the cloud, including for
context retrieval. Cloud idempotency keys are bounded deterministic identities
scoped to execution ID, assignment generation, tool name and request ID, not
raw unscoped request IDs. Retries after an uncertain response return the
original committed outcome and delivery IDs, without duplicating deliveries.

| Tool | Provisional | Input | Effect |
| --- | --- | --- | --- |
| `bfb_get_context` | allowed | `task_id?`, `request_id` | Returns `ContextResult {context, deliveries}` with one actual committed delivery row per returned immutable context item, bound to the run. |
| `bfb_get_task` | allowed | `task_id?`, `request_id` | Returns one task view: id, project, state, priority, title, punchline, resource version. Never human-only context. |
| `bfb_update_task` | `session_not_bound` | `task_id?`, `expected_version`, `title?`, `punchline?`, `request_id` | Requires title or punchline and updates only those bounded fields (1-512 chars) with an optimistic version check. Preserves original creator/workflow fields; state, priority, due, owner and promotion changes remain forbidden. |
| `bfb_add_comment` | `session_not_bound` | `task_id?`, `body` 1-2048 chars, `request_id` | Adds a discussion comment attributed to the agent run. |
| `bfb_report_progress` | `session_not_bound` | `task_id?`, `summary` 1-2048 chars, `percent` 0-100 optional, `confidence` 0-1 optional, `request_id` | Publishes an agent-reported progress comment with optional finite fractional metadata. Omitted values remain null; explicit zero is retained. Never infers activity or completion. |
| `bfb_propose_task` | `session_not_bound` | `project_id?`, `parent_task_id?`, `title` 1-512 chars, `priority` P0-P3 optional, `request_id` | Creates a root `proposed` task only when all three current policy tiers allow agent roots, else `forbidden`; creates a `ready` child under the exact bound parent, limited to 20 children excluding done/cancelled. Priority defaults to P2. Never promotes or launches. |
| `bfb_request_human` | `session_not_bound` | `kind` clarification/review/credential/capability/destructive_action/blocker, `question` 1-2048 chars, `reference_kind?`/`reference_id?` as a pair, `blocking`, `request_id` | Commits a typed attention request for the run. Fails visibly offline; attention questions are never journaled. |
| `bfb_get_attention` | allowed | `attention_id`, `request_id` | Returns the committed resolution metadata for one of the run's own requests; foreign records report `not_found`. Reads fail visibly offline. |
| `bfb_wait_for_attention` | allowed | `attention_id`, `request_id` | Polls committed state until answered/resolved, then returns the same metadata a later retrieval returns, or `pending` at the 30-second bound. Safe to repeat. |

`task_id`, `project_id`, and `parent_task_id` are optional conveniences.
When present they must equal the capability boundary exactly; any other
value returns `boundary_escape`. Omitted IDs are derived from the
capability. No tool accepts workspace, run, execution, session, or
assignment IDs from the caller.

Absent from the A01 core: result submission, artifact bytes, workspace
administration, self-approval, enumeration beyond the bound task, and any cloud
bearer credential in the provider environment. Attention tools are owned by
A02 above; the [A03 result contract](results.md) extends this same server.
A03 adds its separate v5 protected result family to this same daemon and journal;
it does not add a credential or endpoint. Its separate
[clean runtime certificate](../work-packages/evidence/WP-A03/runtime-manifest.json)
is at `9077a08`. V01 adds the separately negotiated v6 publication lane below;
its current acceptance is tracked independently in the active V01 package.

## Online artifact publication

`bfb_publish_artifact` accepts only `request_id`, relative `path`, `format`,
`role`, and optional `artifact_id`. The bound CLI exposes the same operation
through `bfb artifact publish --request-id --file <relative> --format --role`
and optional `--artifact-id`; mixing legacy scope or credential flags rejects.
Neither surface accepts endpoints, credentials, digest, version, storage key or
execution scope. The daemon derives current canonical session and assignment
authority before reading one bounded snapshot from the supervisor's pinned
artifact directory.

The separate `local-agent-artifact-rpc` schema version 6 negotiates exactly
`mcp.v6.publish_artifact` through the v1 daemon-status method list. Unsupported
peers fail without sending private data or downgrading to the historical
general publication RPC. Prepare/upload/finalize use fixed authenticated
cloud actions and return only the closed final `AgentArtifactResult`.

Publication is online-only and has no local journal, spool, pending-sync
permission or automatic replay. An unavailable response may follow a committed
phase; an explicit same-ID retry securely rereads the file and resolves the
canonical cloud operation. Changed bytes or metadata conflict only after
current authorization. Restart, ordinary token renewal and an equivalent safe
file path do not change business identity. Current authority is rechecked
before private delivery, including a cached available result. Active Submitted
runs remain eligible; accepted/failed/cancelled or otherwise ended authority
does not. See [the artifact contract](artifacts.md) and
[ADR 0010](../adr/0010-connected-artifact-publication.md) for limits, immutable
recovery identity, safe file access and the storage/audit boundaries.

## Per-item context result

`ContextResult` contains exactly `context` and `deliveries` arrays. Each context
item retains C08's `id`, `kind`, `body`, `version`, `audience`, `content_hash`
and `created_at` fields, with audience restricted to `agent` or `both`.
Each delivery has exactly:

```text
id, context_version, content_hash, delivered_at, run_id
```

The delivery ID is the actual `task_context_deliveries.id`. Its version/hash
identify the corresponding immutable item, not an aggregate task snapshot.
The arrays have equal length and matching order; an empty context returns
`{"context":[],"deliveries":[]}` and creates no item-delivery rows. Deliveries
are returned only after their WorkspaceHub/D1 command commits. No singular
`delivery` alias, invented aggregate hash/version, synthetic provider session
row, or human-only item is returned. The delegated remote context projection
is unchanged by this local revision.

The complete response, including its RPC envelope, must fit the existing
65,536-byte IPC limit. The domain command bounds the result before staging any
delivery writes. An oversized retrieval fails with `request_rejected` and no
delivery rows; neither array may be silently truncated. Pagination, if added,
requires an explicit versioned request/result contract and cannot pretend a
partial page is the complete context.

## Pending-operation journal

The production CLI never opens the journal. One daemon-owned service opens
`local-mcp-journal.sqlite`, using migration `014_result_journal` independently of
the daemon's migration chain and L06 hook state. A03 adds the result family while
preserving the signed bytes and delivery history from `013_work_journal`.
A retained private flock and
identity sentinel reject accidental database replacement/loss. Recognized
legacy 011/012 rows migrate atomically without rewriting their raw contents;
unsigned pending history is quarantined, never granted new capture authority.
This is not encryption, same-user deletion resistance or cryptographic rollback
protection.

Every new A01/A03 journaled write obtains a complete cloud confirmation of its canonical session,
assignment, native checkout fence, exact snapshot/policy versions, requesting
human and runner epochs, key identity and server deadlines. New capture lasts
at most 45 seconds from the original request send, bounded further by confirmed
lease/credential expiry. Suspend-inclusive elapsed time and the first verified
response anchor prevent sleep, delayed replies or wall-clock changes from
renewing permission. A daemon restart needs fresh live confirmation before new
capture; it cannot reconstruct a timing anchor from stored JSON.

Offline permission is explicitly empty/zero by default on all three immutable
policy tiers. An enabled setting selects only the four A01 writes and an age of
1–300 seconds. The snapshot repository hash must match the referenced approved
repository version. The signed mode is immutable: `online_only` admits empty/zero
with null expiry; `offline_admitted` retains exact configured permission and
`intent_expires_at = captured_at + policy age`. A failed request never upgrades
an online-only intent. Reads, attention and artifacts are not queued. Result
submission cannot use this A01 permission: A03 defines independent result-only
permission, confirmation and signature within the same bounded journal.

The enrolled P-256 key signs a closed `BFB-AGENT-WORK-CAPTURE-V1` transcript over
complete authority and the original typed request's hash. Original whitespace,
optional-field absence and operation schema remain part of the business
fingerprint. The key stays daemon-owned; there is no signing RPC. Both local
verification and Worker replay use the enrolled key, not a row-supplied JWK.

Before any business send, an atomic durable intent/claim/dispatch marker records
possible application, including online-only writes. A validated cloud result
must be durably acknowledged before success is returned. Marker failure sends
nothing; acknowledgement failure preserves uncertainty and stops recovery.
Receipts contain only operation identity, tool, mode, capture/expiry times,
delivery state, effect certainty and bounded reason, never private content or
credentials. `pending_sync` distinguishes `not_attempted` from
`possibly_applied`; a later denial cannot turn a possibly sent operation into
“no effect.” A known committed effect stays committed even when current
authorization blocks delivery of its private result.

Recovery claims only offline-admitted operations and is independent of MCP
lifetime. Exclusive token/incarnation/deadline claims last 30 seconds; a batch
is at most 16 and network requests hold no SQLite transaction. Admission limits
are 256 unresolved per run, 1024 per daemon, and 10,000 retained rows including
legacy history. Unknown outcomes are not deleted to make room. Local storage
failure stops draining and produces a bounded recovery diagnostic.

Replay preserves the original command, operation key, payload and expected
version. Current native ownership, trusted session, runner/requester authority,
exact policy and the original stored confirmation are checked before the cloud
business cache. Ordinary token/lease renewal is allowed; key/grant replacement
does not renew old permission. Optimistic version and child count are checked
only for a new effect, not its own cached success. Replay stops at intent expiry
even when a prior cloud effect may exist; permanent unknowns may consume quota.
No expired intent is rerouted through the ordinary online route.

## Session binding plug-in (L06)

A01 consumes the trusted observed-session binding through this narrow Go
interface, defined in `internal/localmcp/binding.go`:

```go
type SessionBindingSource interface {
  ObservedBinding(ctx context.Context, ref AssignmentRef) (SessionBinding, error)
}
```

`AssignmentRef` carries execution ID, assignment generation, and run ID.
`SessionBinding` carries the observed provider and session ID plus the same
three fields and the observation time. Production implements the source as
`JournalBindings` in `internal/localmcp/production.go` over
`journal.SessionReader` (the L06 hook journal, read through the same
read-only daemon database handle as the assignment lookup); `bfb mcp stdio`
wires it in `internal/cli/mcp.go`. The hook table keys rows by execution ID
plus assignment generation only, so the adapter echoes the run ID from the
startup-verified assignment boundary that key functionally determines. The
fake in `internal/localmcp/fake_test.go` (test double) stands in only inside
the test suite. L06 owns observation truth; its first trusted session-scoped
turn hook can precede SessionStart. Hooks do not create canonical business state.
A01's explicit internal bind command creates the immutable cloud association;
public MCP arguments cannot supply a session or observation. It uses the exact
provider from the pinned launch snapshot, not a mutable agent profile.

One canonical conversation retains its original provider-session ID and origin
execution across resumed executions. Each execution/generation has its own
immutable association; resume observations must match the launch's original
canonical/observed session references. A malformed present association never
falls back to a legacy session lookup. A new agent comment has null human and
delegation author fields plus an atomic constrained `agent_work_effects` row.
Ordinary browser reads and UI show Agent run, Delegated client, Human or Unknown
from this provenance; a legacy null author is never presented as Human. The
source task's original creator fields remain unchanged.

Bootstrap reads require no fabricated cloud provider-session row. Canonical
cloud session binding, if used for independent session fencing, needs its own
explicit checked command with assignment and trusted-observation provenance.
Event-ledger/session projections do not implicitly create that business record.

## Runtime acceptance and remaining integrations

A01's owning `pnpm test:a01` target passed from a clean checkout at the commit
recorded in the [runtime evidence manifest](../work-packages/evidence/WP-A01/runtime-manifest.json).
It exercises the compiled stdio host, production
daemon RPC, real possession-authenticated L08 connection, local Control Worker,
WorkspaceHub and D1. It proves agent/both bootstrap reads and real per-item
delivery, request deduplication, denied unbound mutation, malicious boundary and
process rejection, oversized retrieval and revocation/end/result/lease rejection even
for cached IDs. The synthetic native lifecycle assembles a real signed helper,
held authenticated lock and provider-shaped group, captures a real trusted L06
turn-before-SessionStart hook, then exercises canonical binding and all four
online writes, including lost-commit replies across both MCP and daemon restart.
The connected signed-native proof also covers permitted outage capture, MCP exit,
daemon restart, current-authority denial, remote commit/local acknowledgement
loss and durable dispatch-marker failure. Policy absence never grants permission
to journal, and online-only work is never autonomously replayed.

The runtime certificate records the exact target, full repository verification
and affected gates with their checkout scope. It is not full L05 launch,
Terminal, PTY or live-provider acceptance. A02/A03 must separately integrate and
certify their contracts on this endpoint; bootstrap reads and A01 writes do not
prove those integrations. Historical v1 evidence remains historical rather than
being relabelled as current runtime proof.

## Error codes

`peer_denied`, `assignment_unknown`, `assignment_ended`,
`correlation_rejected`, `session_not_bound`, `session_conflict`,
`boundary_escape`, `capability_closed`, `revoked`, `stale_version`,
`already_answered`,
`forbidden`, `policy_rejected`, `offline_pending`, `offline_rejected`,
`request_rejected`, `request_conflict`, `invalid_request`, `invalid_argument`, `child_limit`,
`capture_invalid`, `intent_expired`, `capacity_exceeded`, `storage_failed`,
`protocol_unsupported`, `method_not_found`. Failures carry a
bounded code and message only; they never echo tokens, environment values,
task bodies, or human-only context.
