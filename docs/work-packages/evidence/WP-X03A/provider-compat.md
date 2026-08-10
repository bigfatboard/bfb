# Provider MCP client compatibility (X03A)

Synthetic evaluation against the frozen MCP `2026-07-28` + preregistered-public-client OAuth policy.

| Provider client | Exact version evaluated | Status | Limitations |
| --- | --- | --- | --- |
| Claude (MCP remote) | Claude Code MCP client `2.1.x` fixture profile | unsupported without preregistration | Requires server-preregistered public client; open DCR/CIMD disabled |
| Codex (MCP remote) | Codex CLI MCP `0.5x` fixture profile | unsupported without preregistration | Same preregistration requirement; no custom discovery layer |
| Grok (MCP remote) | Grok CLI MCP fixture profile | unsupported without preregistration | Same preregistration requirement; protocol not weakened |

BFB accepts any conforming `2026-07-28` client that uses a server-preregistered public client ID, PKCE S256, and exact redirect URI. Unsupported vendor defaults do not change the frozen transport or OAuth policy.
