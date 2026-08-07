# WP-C05 — Human device and CLI credentials

Status: `planned`

Risk: High

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

## Evidence and handoff

- Commit device-flow transcript, credential route matrix, partial-failure tests, and Keychain interface.
- X02 consumes the exchange API and Keychain contract and never inspects Better Auth records.

## Risks and decisions

- The BFB binding is authoritative; cleanup failures in Better Auth must not preserve access.
