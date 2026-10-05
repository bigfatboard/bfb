# Local run-scoped MCP v2

Owner: [A01](../work-packages/WP-A01-local-mcp-context.md). Gate: `pnpm test:a01`.

Status: Current bootstrap implementation `local-mcp/2` under
[ADR 0004](../adr/0004-local-mcp-runtime-authority.md). Context/task reads and current
authority use typed daemon RPC and the possession-authenticated Worker/Hub/D1
path. Online mutations, explicit offline policy and daemon-owned pending replay
remain closure obligations; this reads slice is not complete A01 acceptance.

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
- Supported methods: `initialize`, `notifications/initialized` (no-op),
  `tools/list`, `tools/call`. Every other method returns `method_not_found`.
  There are no prompts, resources, or subscriptions in v2.
- Protocol version reported by `initialize` is `2026-07-28`; the server name
  is `bfb-local-mcp`. The bootstrap implementation reports `local-mcp/2`.

## Daemon and cloud bridge

The MCP host has no runner token, signing key, `RunnerConnection`, or human
credential. It calls fixed typed Unix RPC methods on the private daemon socket.
The daemon alone obtains the current L08 connection for the runner derived from
the verified local assignment. Neither RPC nor the cloud work API accepts an
arbitrary URL, HTTP action, shell command, executable, or claimed principal.

The bootstrap bridge has these fixed operations:

| Local RPC method | Runner action | Result |
| --- | --- | --- |
| `mcp.authority` | `work/authority` | Current assignment/run authority disposition |
| `mcp.get_context` | `work/context` | `ContextResult` with committed per-item delivery rows |
| `mcp.get_task` | `work/task` | Agent-visible bound task view |

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
`pnpm protocol:check`. The local envelope remains schema version 1; the local
tool-contract revision is independently `local-mcp/2`.

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
  whose observed session ID, execution ID, and assignment generation equal
  the assignment, and transitions exactly once. A competing session ID can
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
denials must never be downgraded to offline queue permission.

## Tool map

All tools require `request_id` (8-128 ASCII characters matching
`^[A-Za-z0-9._:~-]{8,128}$`, the wire `IdempotencyKey` primitive). An authorized repeated
operation returns the stored outcome without re-executing, except
`bfb_wait_for_attention`, whose pending outcomes are never memoized so a
repeated wait always re-reads committed state. Reusing an operation identity
with a different tool or payload is rejected, not interpreted as the original
operation. This includes changed task/project/parent/attention arguments.
Bounds mirror C08 so local and remote behavior agree.

One stdio connection retains at most 256 completed request identities with
their input fingerprints and outcomes. Once full, every unseen identity returns
`request_rejected` before any tool effect; no outcome is executed without room
for its binding. Existing identical identities remain usable after current
authority validation. Failed operations do not consume cache slots, and pending
attention waits remain uncached. A fresh stdio connection starts a new local
cache; the cloud keeps the scoped operation identity for committed reads.

New context/task command receipts in audit, semantic events and outbox records
contain bounded IDs, versions, hashes, delivery references, state and priority,
not private bodies, titles or punchlines. The full authorized response remains
in canonical idempotency storage. Infrastructure failures are sanitized,
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
| `bfb_update_task` | `session_not_bound` | `task_id?`, `expected_version`, `title?`, `punchline?`, `request_id` | Updates permitted fields only (title 1-512 chars, punchline 1-512 chars) with an optimistic version check. State, priority, due, owner, and promotion are rejected with `forbidden`, exactly as for delegated agents. |
| `bfb_add_comment` | `session_not_bound` | `task_id?`, `body` 1-2048 chars, `request_id` | Adds a discussion comment attributed to the agent run. |
| `bfb_report_progress` | `session_not_bound` | `task_id?`, `summary` 1-2048 chars, `percent` 0-100 optional, `confidence` 0-1 optional, `request_id` | Publishes a bounded progress checkpoint attributed to the agent run. |
| `bfb_propose_task` | `session_not_bound` | `project_id?`, `parent_task_id?`, `title` 1-512 chars, `priority` P0-P3 optional, `request_id` | Creates a root `proposed` task only when effective policy allows agent root proposals, else `forbidden`; creates a policy-bounded child task (at most 20 active children per parent). Never promotes, never launches a run. |
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
A03/V01 must not add a credential, endpoint, or journal. Their existing tool
rules do not establish an implemented online bridge during the bootstrap slice.

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

This section specifies required closure behavior, not a connected production
replay service. The bootstrap CLI installs deny-by-default offline policy and
does not queue unsupported mutations; its current daemon bridge exposes only
authority, context and task reads. The existing journal and injected replay
tests alone do not establish daemon-owned replay or durable online writes.

When the cloud channel is unreachable, policy-permitted mutations
(`bfb_update_task`, `bfb_add_comment`, `bfb_report_progress`,
`bfb_propose_task`) either persist a durable `pending_sync` operation or
fail visibly as offline, exactly by project policy. Reads and attention
tools fail visibly offline; they are never journaled.

Each record carries the originating agent-run principal and grant, the
immutable assignment and session binding, `request_id` plus idempotency
key, expected resource version, bounded payload hash, local capture proof,
capture and expiry times (expiry is capture plus 24 hours), and the policy
decision. The journal is local SQLite migration `011_pending_operations`
in the A01-owned journal file; it shares no table with L06 hook state.

Replay goes through the L08 channel transport and rechecks, in order, the
current runner credential, authorization/grant epoch, run capability
(revocation, execution end, terminal result), current policy, and resource
version. A stale operation becomes a visible terminal rejection; it is
never applied under stale authority. Replay uses the original scoped operation
identity: an already-applied operation reports its stored outcome, after current
authority validation.

The daemon owns the replay service independently of provider/MCP lifetime. A
restart reopens the A01 journal and preserves the originating principal,
assignment, observed session, grant/epoch and policy decision; it cannot upgrade
an old capture to a newly authorized identity or session. Remote commit followed
by lost acknowledgement must replay to the same outcome. Local applied/rejected
dispositions must be durably acknowledged before they are reported as durable.
An unavailable connection remains retryable; explicit stale authority, expiry,
policy or optimistic-version failure becomes a bounded visible rejection.

## Session binding plug-in (L06)

A01 consumes the trusted observed-session binding through this narrow Go
interface, defined in `internal/localmcp/binding.go`:

```go
type SessionBindingSource interface {
  ObservedBinding(ctx context.Context, ref AssignmentRef) (SessionBinding, error)
}
```

`AssignmentRef` carries execution ID, assignment generation, and run ID.
`SessionBinding` carries the observed provider session ID plus the same
three fields and the observation time. Production implements the source as
`JournalBindings` in `internal/localmcp/production.go` over
`journal.SessionReader` (the L06 hook journal, read through the same
read-only daemon database handle as the assignment lookup); `bfb mcp stdio`
wires it in `internal/cli/mcp.go`. The hook table keys rows by execution ID
plus assignment generation only, so the adapter echoes the run ID from the
startup-verified assignment boundary that key functionally determines. The
fake in `internal/localmcp/fake_test.go` (test double) stands in only inside
the test suite. L06 owns the binding truth; A01 only compares equality and
never invents a session ID.

Bootstrap reads require no fabricated cloud provider-session row. Canonical
cloud session binding, if used for independent session fencing, needs its own
explicit checked command with assignment and trusted-observation provenance.
Event-ledger/session projections do not implicitly create that business record.

## Outstanding runtime closure

The current v2 reads slice does not make A01 complete. Its owning `pnpm test:a01`
target exercises the compiled stdio host, production
daemon RPC, real possession-authenticated L08 connection, local Control Worker,
WorkspaceHub and D1. It proves agent/both bootstrap reads and real per-item
delivery, request deduplication, denied unbound mutation, malicious boundary and
process rejection, oversized retrieval and revocation/end/result/lease rejection even
for cached IDs. An injected transport or stdout-only fixture is not a substitute.

Remaining A01 closure includes the permitted online task/comment/progress/
proposal writes with truthful durable run attribution; explicit versioned,
deny-by-default offline policy and its authorized mutation path; daemon-owned
restart/crash-safe replay; and the explicit session-binding lifecycle decision.
Policy absence cannot imply permission to journal. Existing A02/A03 integration
must retain their contracts on this endpoint, without being claimed as proven
by bootstrap reads. Full exact-target, affected-gate and clean-checkout evidence
are required before complete A01 runtime acceptance is claimed. Historical v1
evidence is not relabelled as v2 proof.

## Error codes

`peer_denied`, `assignment_unknown`, `assignment_ended`,
`correlation_rejected`, `session_not_bound`, `session_conflict`,
`boundary_escape`, `capability_closed`, `revoked`, `stale_version`,
`already_answered`,
`forbidden`, `policy_rejected`, `offline_pending`, `offline_rejected`,
`request_rejected`, `invalid_request`, `method_not_found`. Failures carry a
bounded code and message only; they never echo tokens, environment values,
task bodies, or human-only context.
