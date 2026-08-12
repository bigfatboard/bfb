# Provider MCP client compatibility (X03A)

Real installed-client attempts against a local BFB control app serving MCP `2026-07-28` at `/mcp` with OAuth authorization_code + PKCE S256 and server-preregistered public client `bfb-claude-code` (redirect `http://localhost:9999/callback`).

Harness: `node tools/provider-compat/run-attempts.mjs` (Node 24.19.0). Endpoint: `http://localhost:18765/mcp`. Cookie auth on `/mcp` rejected by harness probe (HTTP 401).

| Provider client | Exact version | Command(s) run | Result | Limitations |
| --- | --- | --- | --- | --- |
| Claude | 2.1.224 (Claude Code) | `claude mcp remove -s local bfb-x03a-provider-compat`<br>`claude mcp add --transport http --scope local --client-id bfb-claude-code --callback-port 9999 bfb-x03a-provider-compat http://localhost:18765/mcp`<br>`claude mcp get bfb-x03a-provider-compat`<br>`claude mcp login --no-browser bfb-x03a-provider-compat`<br>`claude mcp list`<br>`claude mcp remove -s local bfb-x03a-provider-compat` | registered HTTP server; OAuth login incomplete (non-interactive / policy constraints) | BFB requires server-preregistered public client, PKCE S256, and exact redirect http://localhost:9999/callback; BFB browser checkpoint supplies the workspace/project boundary and C03 passkey proof before consent; The non-interactive CLI attempt emitted the expected authorization URL but could not complete a browser ceremony; BFB rejects legacy initialize/Mcp-Session-Id; protocol is MCP 2026-07-28 stateless Streamable HTTP; Cookie sessions cannot authenticate /mcp |
| Codex | @openai/codex 0.146.0 | `codex mcp remove bfb-x03a-provider-compat`<br>`codex mcp add bfb-x03a-provider-compat --url http://localhost:18765/mcp --oauth-client-id bfb-claude-code`<br>`codex mcp get bfb-x03a-provider-compat`<br>`codex mcp list`<br>`codex mcp remove bfb-x03a-provider-compat` | registered — OAuth browser ceremony incomplete | Codex configuration supports an explicit OAuth client ID and resource; Codex generates a random callback port/path, which cannot match BFB's exact preregistered redirect; BFB rejects DCR/CIMD and accepts only preregistered public clients |
| Grok | grok 1.0.0 (3cd0d0cbcebe) | `grok mcp remove --scope user bfb-x03a-provider-compat`<br>`grok mcp add --transport http --scope user bfb-x03a-provider-compat http://localhost:18765/mcp`<br>`grok mcp list --json`<br>`grok mcp doctor --json bfb-x03a-provider-compat`<br>`grok mcp remove --scope user bfb-x03a-provider-compat` | doctor unhealthy — connectivity/handshake failed (see log) | Grok MCP HTTP doctor performs an initialize handshake; BFB rejects initialize and requires MCP-Protocol-Version 2026-07-28; Grok 1.0.0 exposes HTTP/static-header configuration but no OAuth client-id or login command for this flow; BFB protected-resource metadata advertises the exact loopback resource http://localhost:18765/mcp; BFB does not open DCR/CIMD; unregistered clients fail closed |

## Harness notes

- Local server uses the production fetch handler with migrated in-memory SQLite fixtures (`seedSyntheticWorkspace`).
- Protected-resource metadata advertises the exact served resource `http://localhost:18765/mcp`.
- These rows are **not** fixture-profile-only claims; each client binary was invoked on this machine.
- Unsupported or incomplete outcomes do not change the frozen X03A transport or OAuth policy.

## Evidence artifacts

- `attempts/attempt-summary.json`
- `attempts/claude.log`
- `attempts/codex.log`
- `attempts/grok.log`

Started: 2026-08-12T03:33:48.680Z
Ended: 2026-08-12T03:34:29.637Z
