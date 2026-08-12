# WP-F04 — D1 tenant persistence and migrations

Status: `done`

Risk: Very high

Test target: `pnpm test:db`

Evidence manifest: `docs/work-packages/evidence/WP-F04/manifest.json`

## Outcome

Every later cloud package builds on one reviewed D1 migration chain and tenant-safe repository foundation that makes an unscoped workspace lookup difficult to express.

## Dependencies

- **Requires:** F02, F03.
- **Unlocks:** C01, G02.
- **Can run with:** L01 after F02; it owns only cloud D1 persistence primitives.

## Scope

- Establish the ordered, checked-in D1 migration chain and migration test harness for an empty database and the previous package checkpoint fixture.
- Create the minimal workspace registry needed before domain packages: opaque workspace ID, immutable deployment jurisdiction, creation metadata, and no membership or product behavior.
- Define composite `(workspace_id, id)` identity and foreign-key conventions for every tenant-owned table added later.
- Define F04-owned repository primitives that require an immutable authorization context and automatically include the workspace predicate. A separate typed bootstrap context may create the first workspace registry row but cannot query or mutate an existing tenant.
- Prohibit unscoped tenant `getById` methods and bare foreign keys from tenant-owned rows to tenant-owned parents.
- Add D1 phased-batch helpers, optimistic version predicates, UTC timestamp handling, and migration interruption recovery used by later packages. Result-dependent writes require an immediate authoritative D1 result and fail closed inside a deferred batch.
- Add repository lint/structural tests and fixture tables that prove cross-workspace relationships fail at both repository and database layers.
- Keep later authentication and product schema in this same migration chain without making F04 its domain owner. F04 may add relationship constraints needed to preserve the tenant foundation across the integrated chain.

## Non-goals

- Designing Better Auth tables, memberships, projects, tasks, runner records, events, idempotency, audit/outbox records, hub commands, WebSockets, or artifact metadata.
- Tenant-per-database sharding, D1 read replicas, application-startup migrations, or generating persistence schemas from wire schemas.

## Contracts

### Consumes

- F02 wire primitives for opaque IDs and UTC timestamps.
- F03 Control Worker D1 binding and environment jurisdiction configuration.

### Produces

- Ordered D1 migrations under `migrations/d1/`, currently reviewed through `0007_tenant_relationships`; Wrangler is the only deployment migration authority.
- `@bfb/db` verification/fault-injection runner, Drizzle schema model, authorization/bootstrap contexts, D1 adapter, and workspace repository primitives.
- Stable test target `pnpm test:db` and evidence path `docs/work-packages/evidence/WP-F04/manifest.json`.

## Work plan

1. Implement the ordered migration verifier and empty/previous-checkpoint fixtures.
2. Add the workspace/jurisdiction registry and tenant identity/foreign-key conventions.
3. Add authorization-context repository primitives and unscoped-access linting.
4. Fault-inject migration interruption and cross-workspace repository/foreign-key attempts.

## Acceptance

- Empty-database and populated previous-checkpoint migration paths produce the same reviewed final schema and migration head through real local Wrangler/D1.
- Malformed identifiers and invalid legacy tenant relationships abort their migration atomically; after correcting the source row, retry converges on the reviewed schema.
- Interrupting a migration at every verifier boundary and within real Wrangler/D1 leaves a recoverable, diagnosable state and never runs migration logic at Worker startup.
- Repository and database tests reject cross-workspace reads, writes, and parent references.
- A tenant-owned repository cannot be instantiated or queried without an authorization context and exposes no unscoped `getById`.
- The bootstrap context can insert the first workspace registry row but cannot read or mutate any existing workspace row or tenant-owned child.
- Persisted workspace identity and jurisdiction are immutable. Delete, insert-replace, and update-replace conflict paths cannot remove or replace another registry row, and bootstrap jurisdiction must match the deployment.
- D1 batched writes never invent pre-commit change counts or expose read-your-writes. Commands perform reads before queued writes; repository operations that require a conditional-write result run outside a deferred batch.
- Wire-schema generation and D1 schema evolution remain independent.

## Evidence and handoff

- Commit migration diagrams, schema snapshots, empty/previous migration results, interruption traces, and repository-boundary coverage.
- C01 consumes the migration/batch/repository primitives and workspace registry; later packages append migrations without replacing this foundation.
- F04 evidence covers the F04-owned repository surface only. C01, C02, C04, C07, C08, and X03A remain blocked from completion until their production tenant queries consume the authorization boundary instead of raw workspace identifiers.

## Risks and decisions

- D1 has no row-level security. Composite keys, mandatory repository context, database constraints, and exhaustive negative tests are all required rather than alternative defenses.
