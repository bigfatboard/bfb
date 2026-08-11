# WP-X03A — Remote OAuth MCP core

Status: `done`

Risk: Very high

Test target: `pnpm test:x03a`

Evidence manifest: `docs/work-packages/evidence/WP-X03A/manifest.json`

## Outcome

An approved remote MCP client can use a small delegated BFB task loop through stateless Streamable HTTP without gaining broader workspace authority or being misrepresented as a verified running agent.

## Dependencies

- **Requires:** C01, C02, C03, C04, C07, C08, F03.
- **Unlocks:** X03.
- **Can run with:** W01 after C08's command and authorization contracts freeze.

## Scope

- Serve current MCP `2026-07-28` at `/mcp` with Cloudflare Agents SDK v2 `createMcpHandler(..., { legacy: "reject" })` and a fresh server instance for every request.
- Set `allowedHostnames` from F03's validated canonical host configuration. Requests without `Origin` are permitted for native clients; a present `Origin` must equal the configured app origin. Set explicit non-credentialed `corsOptions`; reject arbitrary Host, opaque/null Origin, and every other origin.
- Use stateless Streamable HTTP routing with `MCP-Protocol-Version` and `Mcp-Method`. Require `Mcp-Name` for `tools/call`, `resources/read`, and `prompts/get`; allow it to be absent for methods such as `server/discover` and `tools/list`. Reject missing required, unsupported, or body-mismatched routing metadata.
- Configure Better Auth OAuth Provider for authorization code + PKCE S256, exact redirect URIs, rotating refresh tokens, opaque hashed token storage, and protected-resource/authorization-server metadata.
- Require a fresh C03 proof bound to client, resource, workspace/project/task boundary, scopes, expiry, and authorization epoch before creating or widening a BFB-owned `oauth_delegation`; create it before a token becomes active.
- Re-evaluate delegation, membership, project access, scope, resource, boundary, and epoch on every call. Caller identifiers may narrow authority but never widen it.
- Support only server-preregistered public clients.
- Expose only `bfb_list_projects` through C07's bounded authorized project read plus `bfb_list_tasks`, `bfb_get_task`, `bfb_get_context`, `bfb_add_comment`, `bfb_report_progress`, and `bfb_propose_task` through C08 reads/commands. Every mutation returns its committed idempotent outcome directly.
- Apply shared D1-backed abuse controls, bounded collections and bodies, attempt/poll caps, and uniform failures without isolate-local authority.
- Attribute mutations to the authorizing human and authenticated MCP client. Preserve an optional client-reported provider label separately.

## Non-goals

- Persistent MCP sessions, `initialize`/`initialized`, `Mcp-Session-Id`, the legacy GET-based HTTP+SSE transport, `McpAgent`, `createLegacyMcpHandler`, or an MCP-specific Durable Object. Request-scoped SSE responses permitted by current Streamable HTTP are not legacy transport.
- Run-bound `agent_run` identity, local process presence, runner launch/control, attention resolution, result submission/acceptance, measurements, token accounting, artifacts, GitHub, or workspace administration.
- Open Dynamic Client Registration, Client ID Metadata Documents, end-user client administration, `client_credentials`, bearer JWT access tokens, service accounts, or credentials shared with browser/CLI/runner routes.

## Contracts

### Consumes

- C02 human authentication; C03 action-bound WebAuthn step-up proof; C04 workspace/project authorization and revocation epochs. X03A owns OAuth consent and delegation creation.
- C07 bounded authorized project reads and project-policy boundaries.
- C08 transport-neutral reads and commands with actor envelope, idempotency, optimistic version, pagination, context audience, proposal, and semantic-event contracts.
- F03 same-origin Worker routing; C01 durable D1-backed abuse-control primitives.

### Produces

- MCP `2026-07-28` stateless HTTP routing and OAuth metadata at stable same-origin paths.
- BFB-owned OAuth delegation, client policy, credential separation, attribution, and revocation contracts.
- A bounded tool map whose behavior is identical to the corresponding C07/C08 read or command behavior.

## Work plan

1. Freeze the SDK versions, MCP routing fixture, tool map, OAuth/delegation schema, and abuse-control cases.
2. Add delegation migrations plus strict Better Auth OAuth provider and preregistered-client policy.
3. Bind a per-request MCP server to delegation-derived C07/C08 handlers.
4. Attack redirect/resource/scope/step-up/replay/revocation/credential-confusion/Host/Origin/CORS/routing/body/attempt boundaries from a clean Worker fixture.

## Acceptance

- The current protocol fixture succeeds without persistent transport state. Legacy session, initialize, GET/SSE transport, and mismatched routing cases fail closed; valid request-scoped SSE remains available to current Streamable HTTP.
- Routing fixtures cover required and omitted `Mcp-Name` by method plus every header/body mismatch.
- Exact redirect, PKCE, state, resource, scope, active delegation, current membership, and current authorization epoch are mandatory.
- Unregistered clients, Client ID Metadata Documents, open DCR, authenticated client CRUD, and `client_credentials` fail closed.
- Delegation creation/widening rejects a stolen cookie, stale or replayed proof, cross-client/resource/boundary proof, and scope or expiry widening beyond the action-bound C03 proof.
- Revocation blocks the next call before asynchronous token cleanup, and refresh-token replay fails.
- A real C02 browser cookie cannot authenticate `/mcp`. Synthetic reserved-format fixtures prove rejection for CLI, runner, integration, and local-agent credential classes not yet implemented; SG-01/G01 later runs the real cross-credential matrix.
- Caller identifiers cannot escape delegated workspace/project/task boundaries; context audience and proposal rules match C08 negatives.
- Every collection is bounded/paginated and every mutation is idempotent with an optimistic version check.
- No log or evidence contains authorization codes, tokens, request bodies, or private context.
- UI/audit copy may say “Provider client via the current human's grant · MCP activity 18s ago”; it cannot claim the provider is working, agent time, token use, completion, review, or verified agent identity from MCP traffic.

## Evidence and handoff

- Commit protocol/routing fixtures, OAuth metadata and client-policy matrices, Host/Origin/CORS and abuse tests, step-up/token rotation/revocation traces, credential-confusion tests, and tool parity results at the declared manifest.
- X03 receives the stable transport/delegation boundary and adds later tools without changing the core authority model.

## Risks and decisions

- This public auth surface is intentionally early but narrow. X03A proves a delegated board-client loop, not autonomous agent execution or live process tracking.
