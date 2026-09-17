# Local run-scoped MCP v1

Owner: [A01](../work-packages/WP-A01-local-mcp-context.md). Gate: `pnpm test:a01`.

This contract is the frozen tool and trust boundary for `bfb mcp stdio`.
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
  There are no prompts, resources, or subscriptions in v1.
- Protocol version reported by `initialize` is `2026-07-28`; the server name
  is `bfb-local-mcp` and the contract version below is `local-mcp/1`.

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
  and `bfb_get_task`. Every mutation returns `session_not_bound`. This state
  exists so startup can load context before L06 commits the trusted
  observed-session binding.
- `activated`: permits the full v1 tool set. Activation is atomic: the
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
just the state observed at activation.

## Tool map

All six tools require `request_id` (8-128 characters). A repeated
`request_id` on one connection returns the stored outcome without
re-executing. Bounds mirror C08 so local and remote behavior agree.

| Tool | Provisional | Input | Effect |
| --- | --- | --- | --- |
| `bfb_get_context` | allowed | `task_id?`, `request_id` | Returns the scoped agent context items plus a delivery record `{context_version, content_hash, delivered_at, run_id}`. Records the delivery bound to the run. |
| `bfb_get_task` | allowed | `task_id?`, `request_id` | Returns one task view: id, project, state, priority, title, punchline, routing, resource version. Never human-only context. |
| `bfb_update_task` | `session_not_bound` | `task_id?`, `expected_version`, `title?`, `punchline?`, `request_id` | Updates permitted fields only (title 1-512 chars, punchline 1-512 chars) with an optimistic version check. State, priority, due, owner, and promotion are rejected with `forbidden`, exactly as for delegated agents. |
| `bfb_add_comment` | `session_not_bound` | `task_id?`, `body` 1-2048 chars, `request_id` | Adds a discussion comment attributed to the agent run. |
| `bfb_report_progress` | `session_not_bound` | `task_id?`, `summary` 1-2048 chars, `percent` 0-100 optional, `confidence` 0-1 optional, `request_id` | Publishes a bounded progress checkpoint attributed to the agent run. |
| `bfb_propose_task` | `session_not_bound` | `project_id?`, `parent_task_id?`, `title` 1-512 chars, `priority` P0-P3 optional, `request_id` | Creates a root `proposed` task only when effective policy allows agent root proposals, else `forbidden`; creates a policy-bounded child task (at most 20 active children per parent). Never promotes, never launches a run. |

`task_id`, `project_id`, and `parent_task_id` are optional conveniences.
When present they must equal the capability boundary exactly; any other
value returns `boundary_escape`. Omitted IDs are derived from the
capability. No tool accepts workspace, run, execution, session, or
assignment IDs from the caller.

Explicitly absent in v1: attention tools, result submission, artifact
bytes, workspace administration, self-approval, enumeration beyond the
bound task, and any cloud bearer credential in the provider environment.

## Pending-operation journal

When the cloud channel is unreachable, policy-permitted mutations
(`bfb_update_task`, `bfb_add_comment`, `bfb_report_progress`,
`bfb_propose_task`) either persist a durable `pending_sync` operation or
fail visibly as offline, exactly by project policy. Reads fail visibly
offline; they are never journaled.

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
never applied under stale authority. Replay is idempotent on
`request_id`: an already-applied operation reports its stored outcome.

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
three fields and the observation time. The fake in
`internal/localmcp/fake_test.go` (test double) stands in until L06 exposes
its hook-journal reader; the Handoff in WP-A01 names the exact merge step.
L06 owns the binding truth; A01 only compares equality and never invents a
session ID.

## Error codes

`peer_denied`, `assignment_unknown`, `assignment_ended`,
`correlation_rejected`, `session_not_bound`, `session_conflict`,
`boundary_escape`, `capability_closed`, `revoked`, `stale_version`,
`forbidden`, `policy_rejected`, `offline_pending`, `offline_rejected`,
`request_rejected`, `invalid_request`, `method_not_found`. Failures carry a
bounded code and message only; they never echo tokens, environment values,
task bodies, or human-only context.
