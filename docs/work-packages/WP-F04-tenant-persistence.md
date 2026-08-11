# WP-F04 — D1 tenant persistence and migrations

Status: `in_progress`

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

- Establish the ordered, checked-in D1 migration chain and migration test harness for an empty database and the previous released schema fixture.
- Create the minimal workspace registry needed before domain packages: opaque workspace ID, immutable deployment jurisdiction, creation metadata, and no membership or product behavior.
- Define composite `(workspace_id, id)` identity and foreign-key conventions for every tenant-owned table added later.
- Define repository primitives that require an immutable authorization context and automatically include the workspace predicate. A separate typed bootstrap context may create the first workspace registry row but cannot query or mutate an existing tenant.
- Prohibit unscoped tenant `getById` methods and bare foreign keys from tenant-owned rows to tenant-owned parents.
- Add D1 transaction/batch helpers, optimistic version predicates, UTC timestamp handling, and migration interruption recovery used by later packages.
- Add repository lint/structural tests and fixture tables that prove cross-workspace relationships fail at both repository and database layers.
- Keep Better Auth's later generated schema in this same migration chain without generating or applying it in F04.

## Non-goals

- Better Auth tables, memberships, projects, tasks, runner records, events, idempotency, audit/outbox records, hub commands, WebSockets, or artifact metadata.
- Tenant-per-database sharding, D1 read replicas, application-startup migrations, or generating persistence schemas from wire schemas.

## Contracts

### Consumes

- F02 wire primitives for opaque IDs and UTC timestamps.
- F03 Control Worker D1 binding and environment jurisdiction configuration.

### Produces

- Ordered D1 migrations under `migrations/d1/` with head `0005_workspace_invariants`.
- `@bfb/db` migration runner, authorization/bootstrap contexts, and workspace repository primitives.
- Stable test target `pnpm test:db` and evidence path `docs/work-packages/evidence/WP-F04/manifest.json`.

## Work plan

1. Implement the ordered migration runner and empty/previous-schema fixtures.
2. Add the workspace/jurisdiction registry and tenant identity/foreign-key conventions.
3. Add authorization-context repository primitives and unscoped-access linting.
4. Fault-inject migration interruption and cross-workspace repository/foreign-key attempts.

## Acceptance

- Empty-database and previous-schema migration paths produce the same reviewed final schema and migration head.
- Interrupting a migration at every supported boundary leaves a recoverable, diagnosable state and never runs migration logic at Worker startup.
- Repository and database tests reject cross-workspace reads, writes, and parent references.
- A tenant-owned repository cannot be instantiated or queried without an authorization context and exposes no unscoped `getById`.
- The bootstrap context can insert the first workspace registry row but cannot read or mutate any existing workspace row or tenant-owned child.
- The persisted workspace jurisdiction is immutable and a workspace cannot be registered with a jurisdiction different from the deployment's configured jurisdiction.
- Wire-schema generation and D1 schema evolution remain independent.

## Evidence and handoff

- Commit migration diagrams, schema snapshots, empty/previous migration results, interruption traces, and repository-boundary coverage.
- C01 consumes the migration/batch/repository primitives and workspace registry; later packages append migrations without replacing this foundation.

## Risks and decisions

- D1 has no row-level security. Composite keys, mandatory repository context, database constraints, and exhaustive negative tests are all required rather than alternative defenses.
