# ADR 0004 — Local MCP runtime authority and per-item context delivery

Status: Accepted for implementation under the local-MVP autopilot scope in
[mvp.plan.md](../../mvp.plan.md), 5 October 2026. This status records implementation
authority, not personal approval of this text or completed acceptance proof.

## Context

A01's stdio server, local process checks, trusted L06 session-binding adapter,
and pending-operation journal exist, but production still installs
`OfflineTransport`. L08's daemon-owned authenticated connection is not wired to
local work tools, and the Control Worker exposes no runner-scoped work route.
The existing A01 tests do not prove a compiled stdio client reaching
WorkspaceHub and D1. Previous package evidence remains historical evidence;
this decision does not make runtime closure complete.

C08 persists one `task_context_deliveries` row per immutable context item. The
local `GetContext` interface instead returns one delivery. Combining several
items into an invented aggregate version/hash would misrepresent the existing
records and their foreign-key contract.

Runner possession proves the enrolled daemon's transport identity, not a human
actor. Local run authority must additionally derive from an immutable execution
assignment and verified process containment. Cached responses and replay must
not preserve authority after an execution ends or a grant is revoked.

## Decision

- Define `local-mcp/2` as the proposed local tool contract. It keeps the same
  stdio endpoint and MCP protocol version. `bfb_get_context` returns
  `ContextResult { context, deliveries }`, with one actual committed delivery
  row per returned item, in the same order, and empty arrays when there is no
  visible context. A delivery includes its row ID, item version/hash, delivery
  time and run ID. There is no singular `delivery` compatibility alias and no
  fabricated aggregate version or hash. The delegated remote context response
  is unchanged.
- Keep runner tokens, signing keys and `RunnerConnection` exclusively inside
  the daemon. The provider and stdio MCP host receive neither runner credentials
  nor a generic authenticated HTTP proxy. The MCP host uses bounded, typed Unix
  RPC; the daemon maps it to fixed possession-authenticated runner work actions.
- Independently validate the kernel-authenticated IPC caller UID/PID, live
  process start identity and containment, immutable assignment/generation, and
  constant-time correlation equality. Inspect current kernel facts rather than
  accepting a caller-supplied provider PID, process group or identity. Stdio's
  own startup check is not a substitute for the daemon's check.
- Keep the authenticated Hub transport actor as `runner`. Domain commands
  derive the originating `agent_run` from the matching D1 execution assignment;
  tools cannot select it. Recheck current runner credentials/epochs, requester
  membership/project and runner launch grants/epochs, assignment ownership,
  checkout lease, execution and result fences. Do not impersonate the requesting
  human, an OAuth delegation, or a system actor named after a run. Business
  attribution preserves the derived run separately from the executing runner
  and requesting human.
- Serialize context delivery and run-bound replay authorization through the
  existing WorkspaceHub command lane. Reuse C08's audience filtering and
  delivery persistence; do not introduce transport-owned business logic. A
  read-only authorization hook uses fresh server time inside the same serialized
  transaction before either a new effect or an idempotently cached reply, and
  performs no reads after staged writes. The local MCP host also validates
  boundary, tool/arguments and current capability before a cached outcome.
- Forward the original tool `request_id`, including context reads. Derive a
  bounded cloud idempotency key from execution ID, assignment generation, tool
  name and request ID. Bind the outcome to the validated operation, not merely
  an unscoped request string. Retries return the same delivery rows rather than
  inserting duplicates; changed tool/arguments under an existing local request
  identity or changed input under a cloud operation identity are rejected.
  Cached success never bypasses current authorization.
- Bound the complete context result before committing its delivery records so
  it fits the existing fixed IPC envelope limit. Reject an oversized retrieval
  atomically; never silently truncate items or deliveries. Any later pagination
  must be explicit and versioned, not an implicit lossy transport workaround.
- Allow safe bootstrap context/task reads before a trusted provider session is
  bound. Reject every mutation while unbound. The daemon obtains observed
  session identity only through L06's trusted reader. Bootstrap reads never
  invent a session or populate `provider_sessions` merely to satisfy a check.
- Keep permission, policy, validation and stale-authority failures distinct from
  connectivity failure. Neither CLI nor daemon may convert a cloud denial into
  offline queue permission.

## Staged proof and remaining obligations

The first runtime slice proves the compiled `bfb mcp stdio` binary through
production typed daemon RPC, the real L08 possession connection, a local Control
Worker, WorkspaceHub and D1. It covers agent/both-only context, truthful per-item
delivery, duplicate delivery, denied unbound mutation, boundary/process attacks,
oversized retrieval and revocation/end/result rejection even for cached request
IDs. It uses synthetic execution fixtures, not live provider turns or Terminal
UI automation. Injected `WorkTransport` tests remain useful unit tests but
cannot substitute for this vertical proof.

The reads slice is not full A01 acceptance. These closure obligations remain:

1. Connect permitted task/comment/progress/proposal mutations using the shared
   domain rules, optimistic versions and truthful durable run attribution.
   Existing A02/A03 extensions stay on this endpoint and retain their own
   authority and result rules; bootstrap work must not claim their runtime
   integration is already proven.
2. Define and persist explicit versioned offline-operation policy, including its
   authorized mutation path and effective ceilings. Missing or unavailable
   permission must not become unconditional `AllowPending: true`.
3. Own pending-operation replay in a daemon service that survives MCP exit and
   daemon restart. Preserve and verify the captured principal, grant/epochs,
   assignment, trusted session, request identity, payload proof, expiry, policy
   and expected resource version. Distinguish retryable connectivity failures
   from terminal stale-authority rejection; prove remote-commit/local-ack crash
   deduplication and durable applied/rejected acknowledgements.
4. Specify the explicit checked command that binds an observed provider session
   into canonical cloud session records, if needed for independent cloud session
   fencing. A telemetry projection is not that command and bootstrap reads are
   not permission to synthesize a binding. This lifecycle remains distinct from
   local trusted session activation and run/result transitions.
5. Pass full `pnpm test:a01`, affected earlier gates and `pnpm verify` from a clean
   checkout, and commit bounded evidence before claiming complete A01 runtime
   acceptance. Coordinate package accounting without rewriting historical
   completion evidence or weakening the dependency checker.

## Consequences

The proposed context response is an intentional local contract revision.
Implementations advertise `local-mcp/1` until the v2 runtime slice and its tests
land; this ADR and contract draft alone do not change the running server.
Generated request/response schemas and deterministic fixtures are required
before the new wire methods ship. No dependency, provider capability, release,
deployment, or arbitrary-shell boundary changes are authorized by this ADR.

D1 remains canonical, workspace mutations stay serialized through WorkspaceHub,
and hooks remain telemetry. Offline replay, explicit business commands and
truthful actor/session identity remain required, not relaxed MVP exclusions.
