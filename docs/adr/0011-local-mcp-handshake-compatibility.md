# ADR 0011 — Local MCP handshake compatibility

Status: accepted for the approved local MVP

Date: 6 October 2026

## Context

L07's isolated real-Claude `2.1.291` probe sends `initialize` with protocol
`2025-11-25`, then `notifications/initialized`, `tools/list` and `tools/call`.
The local server implements that handshake but incorrectly advertises
`2026-07-28`. The latter removes initialization in favor of request metadata
and optional client discovery. A version label cannot substitute for those
different wire behaviors. Existing synthetic native clients sent empty
initialization parameters and did not establish actual provider compatibility.

## Decision

The local stdio transport supports the `2025-11-25` handshake revision only.
Validate the required version, client identity and capabilities shapes during
initialization, and advertise the supported revision even when the client asks
for another one. The client decides whether it can accept that offer. Require
the completed initialization exchange before listing or calling tools. Accept
transport `ping` without treating it as task authority or provider activity.
Unsupported modern discovery receives `method_not_found`, allowing a client
that explicitly supports legacy fallback to negotiate normally.

This changes neither the remote OAuth MCP protocol nor BFB's local RPC versions.
`local-mcp/2` continues to identify the BFB tool/trust contract; MCP's dated
transport revision is a separate concern. No cloud credential, scope override,
business state, telemetry or completion inference is introduced. Every existing
native ownership, session binding and current-authority check remains in force.
The handshake does not itself bind a provider session or activate write access.

## Verification

Test valid and malformed initialization, an unsupported-version counteroffer,
notification ordering, duplicate initialization, pre-handshake tool rejection,
ping, modern discovery rejection and unchanged startup authority failures.
Update synthetic stdio clients and the deterministic inspector transcript to
send a real initialization exchange. Run local-MCP/CLI checks, the connected
native regression and the exact L07/repository gates. The isolated Claude probe
proves an external wire shape, not BFB launch, MCP authority or L07 completion.

## Sources

- [MCP 2025 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP 2025 ping](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping)
- [MCP 2026 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
