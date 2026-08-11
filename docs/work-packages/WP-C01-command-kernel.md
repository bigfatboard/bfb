# WP-C01 — WorkspaceHub command and event kernel

Status: `planned`

Risk: Very high

Test target: `pnpm test:c01`

Evidence manifest: `docs/work-packages/evidence/WP-C01/manifest.json`

## Outcome

Every BFB workspace mutation can execute through one deterministic command lane that commits relational state, event, cursor, idempotency, and audit/outbox effects atomically, with one shared durable abuse-control service for public capability endpoints.

## Dependencies

- **Requires:** F02, F03, F04.
- **Unlocks:** C02, C03, C04, C05, C06, C07, C08, C09, E01, V01, V02, X03A, X04, X05.
- **Can run with:** L01 after F02.

## Scope

- Append only command-kernel storage to F04's migration chain: idempotency records, semantic events, workspace cursors, audit events, durable outbox records, and shared rate-limit buckets.
- Resolve each workspace through F04's persisted deployment jurisdiction and exactly one `WorkspaceHub`.
- Implement typed hub RPC and an explicit per-instance FIFO promise queue around the full D1 mutation path.
- Commit guarded relational changes, absolute projections, semantic events, cursors, and outbox records in one D1 batch.
- Return stored idempotent results before constructing another mutation.
- Expose replay/high-water reads without making the Durable Object durable history.
- Build a D1-backed abuse-control service keyed by hashed IP plus the relevant subject/code/client dimensions, with bounded policy inputs, atomic counters/windows, attempt and polling caps, and uniform failure decisions.
- Support Cloudflare edge limits as an outer layer and a typed escalation result for packages that require Turnstile after repeated abuse; isolate-local memory is never authoritative.

## Non-goals

- Migration/repository primitives already owned by F04, Better Auth tables, memberships, tasks, launch leases, public WebSockets, provider events, or artifact bytes.
- Choosing package-specific abuse thresholds or accepting a one-time capability; each owning package binds the shared decision to its own atomic capability operation.
- Pure event sourcing, tenant-per-database sharding, or Durable Object storage as canonical data.


## Contracts

### Consumes

- F02, F03, F04 kernel dependencies and D1 primitives.

### Produces

- WorkspaceHub FIFO command lane, idempotency, semantic events, cursors, abuse-control service.
- Stable test target `pnpm test:c01` and evidence path `docs/work-packages/evidence/WP-C01/manifest.json`.

## Work plan

1. Append kernel tables through F04 and implement a synthetic typed workspace command plus atomic event/outbox batch.
2. Add FIFO serialization, idempotency, version guards, and replay/high-water reads.
3. Implement the shared durable abuse-control service and bounded policy interface.
4. Fault-inject delayed D1 operations, duplicate commands, concurrent abuse attempts, Worker-isolate changes, and rate-window boundaries.

## Acceptance

- Delayed concurrent commands commit in FIFO cursor/state order.
- A repeated idempotency key returns the first result with one database effect.
- Stale versions and invalid transitions fail atomically; F04's repository/database tenant-isolation suite remains green.
- Workspace cursors are monotonic within one workspace and never serve as runner acknowledgements.
- The resolver cannot address the same workspace once globally and once through another jurisdiction.
- Concurrent requests across fresh Worker isolates observe the same D1-backed abuse budget; raw IPs, codes, client secrets, and capability values are not stored in rate-limit keys or logs.
- Abuse decisions enforce bounded bodies, attempt/poll caps, expiry, and uniform public failures without making isolate memory the source of truth.

## Evidence and handoff

- Commit kernel migration diagrams, contention/fault-injection results, abuse-control fixtures, and command/replay contracts.
- Later packages add domain tables and typed commands through F04's migration/repository foundation, consume the abuse-control service for their public capability endpoints, and never mutate repositories directly from public handlers.

## Risks and decisions

- Durable Object requests can interleave across D1 awaits; the explicit FIFO is mandatory.
- D1 constraints remain authoritative even with a serialized hub.
- Rate limiting is a shared security primitive, but capability consumption still belongs in the owning package's conditional D1 batch.
