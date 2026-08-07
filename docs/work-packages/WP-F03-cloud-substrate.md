# WP-F03 — Cloudflare application substrate

Status: `planned`

Risk: High

## Outcome

BFB’s web, control, and artifact applications build and run against an explicit local/staging Cloudflare topology with validated bindings and origin separation.

## Dependencies

- **Requires:** F01.
- **Unlocks:** C01, C02, F04, G02, V01, W01, X04.
- **Can run with:** F02.

## Scope

- Scaffold React/Vite web assets served through Workers Static Assets and a Hono Control Worker.
- Reserve Worker-first routes for API, auth, MCP, realtime, runner, webhook, and OAuth metadata paths; use asset-first routing elsewhere.
- Scaffold a separate inert Artifact Worker origin with no session cookie or trusted-origin feature.
- Declare typed bindings for D1, `WorkspaceHub`, private R2, Queue, DLQ, and Cron.
- Define isolated local, staging, and production configuration names without shared-secret assumptions.
- Use current declarative Durable Object SQLite `exports`; do not add a legacy migration tag.
- Add configuration validation for bindings, trusted origins, app/artifact/launch hostnames, and jurisdiction.
- Run a disposable compile/deploy compatibility spike proving that the architecture's pinned Better Auth version, D1 binding, and Durable Object declaration can coexist in the Worker runtime. The spike enables no auth route, creates no auth table, and checks in no Better Auth product configuration; C02 remains the sole owner of Better Auth behavior and schema.

## Non-goals

- Domain tables, Better Auth behavior/schema/configuration, hub commands, Queue consumers, R2 uploads, or production resource creation.
- Pages, KV, Workflows, Analytics Engine, Workers AI, or another service excluded by the architecture.

## Work plan

1. Build the three application shells and route ownership table.
2. Add typed environment bindings and validation.
3. Configure local/staging resources and the disposable compatibility proof.
4. Verify asset routing, origin/cookie boundaries, and missing-binding failures.

## Acceptance

- A clean checkout builds all applications and starts the local topology.
- SPA fallback cannot shadow protected Worker-first paths.
- Missing D1, R2, Queue, DLQ, Durable Object, origin, or jurisdiction configuration fails before deployment.
- The artifact origin never receives/sets the app cookie and has no credentialed CORS path.
- The disposable stack deploys without a manually created Durable Object namespace.
- The compatibility spike leaves no enabled Better Auth route, migration, session behavior, or product configuration behind.
- No production or shared-state deployment occurs in this package.

## Evidence and handoff

- Commit local smoke output, route matrix, binding matrix, and disposable deployment result.
- F04 receives one typed Worker environment and one supported D1 deployment shape; C02 receives only the disposable compatibility result, not auth implementation.

## Risks and decisions

- Static asset routing and cookie domains are security boundaries, not deployment polish.
- Cloudflare configuration syntax must be verified against current official docs during implementation.
