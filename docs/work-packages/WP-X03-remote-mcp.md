# WP-X03 — Remote OAuth MCP

Status: `planned`

Risk: Very high

## Outcome

An approved remote MCP client can invoke an explicitly scoped subset of BFB tools through Streamable HTTP without receiving broader workspace authority.

## Dependencies

- **Requires:** A01, A02, A03, C01, C02, C03, C04, V01.
- **Unlocks:** G01.
- **Can run with:** X02/X04 after auth migrations are sequenced.

## Scope

- Expose Streamable HTTP MCP at `/mcp` with authorization-server/protected-resource metadata.
- Configure Better Auth OAuth Provider for authorization code + PKCE S256, exact redirect URIs, rotating refresh tokens, and opaque hashed token storage.
- Create BFB-owned `oauth_delegation` before a grant/token becomes active; bind human, resource, workspace, optional project/task/run, scopes, expiry, and epoch.
- Validate delegation/membership/resource/scope/boundaries every call; derive IDs from the grant.
- Support preregistered public clients plus SSRF-safe HTTPS Client ID Metadata Documents under explicit allow policy.
- Disable open DCR, authenticated end-user client CRUD, `client_credentials`, JWT access tokens, and tokens without human+active delegation.
- Return protected-resource metadata in unauthorized challenges.
- Expose only the documented agent tools and reuse their authorization/idempotency tests.
- Apply shared D1-backed abuse controls, bounded bodies, attempt/poll caps, and uniform failure responses to authorization, token, client-metadata, and MCP request surfaces; isolate-local memory is not the authority.

## Non-goals

- Service-account automation, broad workspace admin tools, bearer JWTs, open client registration, or using OAuth records as workspace authorization.

## Work plan

1. Add delegation migrations and strict OAuth provider configuration.
2. Implement metadata, consent, PKCE/token rotation, and client policy.
3. Bind MCP tools to delegation-derived context and revocation.
4. Attack redirect/resource/scope/SSRF/token replay/client CRUD/credential-type boundaries plus distributed rate-limit bypass, oversized bodies, and attempt exhaustion.

## Acceptance

- Exact redirect, PKCE, state, resource, scope, and active delegation are mandatory.
- `client_credentials`, open DCR, user client CRUD, JWT tokens, and unsafe metadata targets fail closed.
- Revoking delegation/membership/epoch blocks the next call before token cleanup.
- Caller IDs cannot escape delegated workspace/project/task/run.
- Refresh tokens rotate; replay fails.
- Cookie/CLI/runner credentials cannot authenticate `/mcp`.
- Abuse limits survive requests routed through different Worker isolates, reject oversized/exhausted flows uniformly, and never log authorization codes, tokens, metadata secrets, or request bodies.

## Evidence and handoff

- Commit OAuth/MCP inspector trace, client-policy matrix, SSRF/abuse-control suite, token-rotation/revocation results, and tool boundary tests including A03 result submission.
- G01 treats this public auth surface as a separate adversarial target.

## Risks and decisions

- This is the cleanest optional private-alpha cut because it adds a large public authorization surface; local stdio MCP remains the core path.
