# WP-C05 — Human device and CLI credentials

Status: `review`

Risk: High

Test target: `pnpm test:c05`

Evidence manifest: `docs/work-packages/evidence/WP-C05/manifest.json`

## Outcome

A signed-in human can authorize the BFB CLI through a browser device flow and receive a workspace-bound, scoped, expiring credential that never becomes a web session.

## Dependencies

- **Requires:** C01, C02, C04, C07.
- **Unlocks:** X02.
- **Can run with:** C06 if migrations and auth routes are coordinated sequentially.

## Scope

- Configure Better Auth Device Authorization for browser-assisted CLI bootstrap.
- Create BFB-owned `api_key_binding` records before issuing active API keys.
- Bind a credential to human/integration principal, workspace, optional projects, fixed scopes, expiry, and authorization epoch.
- Store only the key hash server-side and prohibit API-key session elevation.
- Expose one BFB exchange endpoint; hide direct Better Auth API-key create/update routes.
- Consume C01's durable abuse-control service for device-code issuance, approval, polling, and exchange using hashed IP plus subject/code/client dimensions, bounded bodies, polling/attempt caps, and uniform failure responses.
- Implement revocation and prefix-safe logging.
- Define Keychain storage contract consumed by the local client.
- Keep approved CI integration principals separate from humans without implementing CI workflows yet.

## Non-goals

- Runner credentials, remote OAuth MCP, browser sessions, provider credentials, or persistent unscoped personal tokens.

## Contracts

### Consumes

- C01 WorkspaceHub atomic command lane, FIFO serialization, and durable abuse budgets (`abuseBucketKey`, `consumeAbuseBudget`).
- C02 Better Auth 1.6.26 human identity, browser sessions, CSRF, and the pinned plugin/route configuration.
- C04 current workspace membership, roles, and authorization epochs (`loadPrincipal`, `assertRole`, `assertEpoch`).
- C07 project access (`AuthzPrincipal.projectIds` narrowing).
- Better Auth 1.6.26 `device-authorization` plugin protocol rows and endpoint semantics for the exact pinned version (no `api-key` plugin exists in 1.6.26; key issuance is BFB-owned).

### Produces

- `docs/contracts/cli-credentials.md`: device bootstrap, browser approval, single exchange, per-request authority, credential separation, and the Keychain storage contract.
- `cli.authorize_device`, `cli.exchange_credential`, and `cli.revoke_binding` v1 hub commands with `api_key_bindings`/`cli_mutation_guards` D1 records.
- Exact target `pnpm test:c05`; evidence manifest `docs/work-packages/evidence/WP-C05/manifest.json`.

## Work plan

1. Add binding migrations and device-flow configuration.
2. Implement staged binding → key activation → bootstrap revocation.
3. Add per-request binding/membership/epoch checks and revocation.
4. Test cross-isolate polling abuse, expiry, oversized bodies, partial issuance failure, and credential-type confusion.

## Acceptance

- Device approval produces one scoped CLI credential and invalidates the bootstrap credential.
- Every request joins an active BFB binding and current membership/epoch.
- Revoking the binding disables authority before Better Auth row cleanup.
- Direct API-key management routes and session elevation are unavailable.
- Browser, runner, MCP, and webhook routes reject the CLI credential unless explicitly designated.
- Raw keys never enter D1, logs, URLs, or process arguments.
- Device polling/attempt caps remain effective across Worker isolates; rate keys and diagnostics contain no raw user code, device code, IP, or credential.

## Evidence

- `docs/work-packages/evidence/WP-C05/command-result.json`: exact `pnpm test:c05`, `pnpm verify`, and `pnpm worktree:check` outcomes for the tested commit.
- `docs/work-packages/evidence/WP-C05/security-matrix.md`: boundary-by-boundary positive and negative proof with owners.
- Committed suites: `packages/domain/test/cli-credentials.test.ts`, `apps/control-worker/test/cli-credentials.test.ts`, `apps/control-worker/test/auth-configuration.test.ts`, `tools/cli-credentials/run.ts`.
- Evidence path is stable, repository-relative, conforms to the [evidence manifest schema](evidence/manifest.schema.json), and references commit, protocol/schema heads, environment, commands, outcome, and redaction status.

## Risks and decisions

- The BFB binding is authoritative; cleanup failures in Better Auth must not preserve access.
- Pinned Better Auth 1.6.26 ships device authorization but no API-key plugin, so key issuance is BFB-owned (prefixed random credential, SHA-256 hash stored, raw value returned once). `POST /auth/device/token` is disabled at the auth layer and never routed, so an approved device code can never become a web session.
- D1 batches cannot read after a queued write, so the single-exchange claim is a `cli_mutation_guards` predicate row evaluated at commit time; a racing exchange aborts the whole batch.
- Membership removal disables CLI authority through the epoch fence; the binding row itself is revoked only through the explicit revoke command.

## Handoff

- X02 consumes `POST /api/v1/cli/exchange`, `GET /api/v1/cli/session`, the binding lifecycle in `docs/contracts/cli-credentials.md`, and the Keychain storage contract. X02 never inspects Better Auth records and adds its own designated CLI routes behind `resolveCliPrincipal`.
- Migration head after this package: `0018_cli_credentials`.
- Known limitations: no browser management UI for bindings (revocation is API-only until W02/X02); integration-principal issuance has schema support but no route; device codes live in the Better Auth protocol table by plugin design while all BFB authorization state stays hashed.
