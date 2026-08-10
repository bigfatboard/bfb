# ADR 0001 — Web and remote MCP first

Status: Accepted, 10 August 2026

## Context

The original package graph made X03 remote MCP depend on the full local runner, hooks, attention, results, and artifact path through A01/A02/A03/V01. That required 27 packages before a remote client could perform a basic task loop, even though the transport should reuse cloud domain commands.

The product needs an earlier checkpoint where a team can operate the board and use Claude, Codex, or Grok as delegated remote MCP clients. That checkpoint must not pretend an OAuth client is a verified local process or a run-scoped agent.

MCP `2026-07-28` also changes the transport shape: Cloudflare's current handler creates a server per request and routes stateless Streamable HTTP without the older initialize/session and GET-based HTTP+SSE lifecycle. Current request-scoped Streamable HTTP may still use SSE responses.

## Decision

- C07 owns the bounded authorized project read; C08 owns transport-neutral task/context/comment/proposal reads and mutations needed by web, local MCP, and remote MCP.
- X03A is the narrow remote core. It follows W01's control-plane prerequisites and can run alongside W01 once C08 freezes.
- X03A uses Cloudflare Agents SDK v2 `createMcpHandler(..., { legacy: "reject" })`, a new MCP server per request, and MCP `2026-07-28`. It does not use `McpAgent`, `createLegacyMcpHandler`, legacy GET-based HTTP+SSE, `initialize`, `Mcp-Session-Id`, sticky transport state, or an MCP Durable Object.
- X03A supplies explicit canonical `allowedHostnames`, exact handling for a present Origin, and non-credentialed CORS options; handler defaults are not the BFB trust policy.
- X03A exposes only delegated project/task reads, agent-visible context, bounded comments/progress, task proposals, and committed idempotent mutation outcomes.
- X03A supports only server-preregistered public OAuth clients. Client ID Metadata Documents are deferred because Better Auth `1.6.26` has no supported discovery extension; adopting a later stable auth stack requires another dependency/architecture decision, and BFB will not couple to provider internals.
- OAuth authority belongs to the human delegation. Audit keeps the human sponsor, authenticated client, and optional client-reported provider label distinct.
- Creating or widening a delegation consumes one fresh C03 proof bound to the complete client/resource/boundary/scope/expiry/epoch action.
- A remote MCP request proves recent authorized client activity. It does not prove that an agent process is working, measure agent time/tokens, submit a verified result, or create `agent_run` identity.
- X03 remains a later parity extension for attention, results, and artifacts after A01/A02/A03/V01.
- The first implementation tranche is F02, F03, F04, C01, C02, C03, C04, C07, C08, W01, then X03A. Packages remain sequential unless their contracts and path ownership are already frozen.

The transport follows the official [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/) and Cloudflare's current [MCP handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/). OAuth, tenant, revocation, credential-separation, abuse-control, and truthful-attribution boundaries remain unchanged.

## Consequences

- BFB gets a useful web/MCP checkpoint before local execution and realtime work.
- The checkpoint supports human-delegated client actions, not tracked autonomous-agent runs.
- Provider compatibility may be limited by preregistration support and is reported per exact client version rather than hidden behind a custom auth compatibility layer.
- The board must render unavailable states for hooks, realtime presence, attention resolution, result acceptance, human/agent time, and tokens until their owning packages exist.
- Local stdio MCP still supplies run-bound `agent_run` identity later; remote run-bound delegation would require another explicit security decision.
