# Provider MCP client compatibility (X03A)

Real installed-client attempts against a local BFB control app serving MCP `2026-07-28` at `/mcp` with OAuth authorization_code + PKCE S256 and server-preregistered public client `bfb-mcp-synthetic-client` (redirect `http://127.0.0.1:9999/callback`).

Harness: `node tools/provider-compat/run-attempts.mjs` (Node 24.19.0). Endpoint: `http://127.0.0.1:18765/mcp`. Cookie auth on `/mcp` rejected by harness probe (HTTP 401).

| Provider client | Exact version | Command(s) run | Result | Limitations |
| --- | --- | --- | --- | --- |
| Claude | 2.1.224 (Claude Code) | `claude mcp remove -s local bfb-x03a-provider-compat`<br>`claude mcp add --transport http --scope local --client-id bfb-mcp-synthetic-client --callback-port 9999 bfb-x03a-provider-compat http://127.0.0.1:18765/mcp`<br>`claude mcp get bfb-x03a-provider-compat`<br>`claude mcp login --no-browser bfb-x03a-provider-compat`<br>`claude mcp list`<br>`claude mcp remove -s local bfb-x03a-provider-compat` | failed to connect — client probe omitted/mismatched MCP-Protocol-Version 2026-07-28 (HTTP 400) | BFB requires server-preregistered public client, PKCE S256, exact redirect http://127.0.0.1:9999/callback; BFB authorize requires browser session cookie plus workspace_id and step_up_proof_id (C03); Claude Code Streamable HTTP health probe did not send MCP-Protocol-Version 2026-07-28; BFB rejects legacy initialize/Mcp-Session-Id; protocol is MCP 2026-07-28 stateless Streamable HTTP; Cookie sessions cannot authenticate /mcp |
| Codex | @openai/codex 0.114.0 (native --version ENOENT) | `codex --version`<br>`codex --help`<br>`codex mcp add bfb-x03a http://127.0.0.1:18765/mcp` | failed — native binary missing (ENOENT on darwin vendor codex); MCP not exercised | npm @openai/codex wrapper cannot spawn vendor/aarch64-apple-darwin/codex/codex (ENOENT); BFB accepts only preregistered public client bfb-mcp-synthetic-client; No X03A acceptance weakening for broken local Codex installs |
| Grok | grok 1.0.0 (3cd0d0cbcebe) | `grok mcp remove --scope user bfb-x03a-provider-compat`<br>`grok mcp add --transport http --scope user bfb-x03a-provider-compat http://127.0.0.1:18765/mcp`<br>`grok mcp list --json`<br>`grok mcp doctor --json bfb-x03a-provider-compat`<br>`grok mcp remove --scope user bfb-x03a-provider-compat` | doctor unhealthy — handshake sent initialize without MCP-Protocol-Version 2026-07-28 (HTTP 400) | Grok MCP HTTP doctor performs an initialize handshake; BFB rejects initialize and requires MCP-Protocol-Version 2026-07-28; OAuth against BFB preregistered client + C03 step-up is not a full delegated board-client loop from grok mcp alone; BFB protected-resource metadata advertises resource https://bfb.example.test/mcp (fixture constant) even when served on loopback; BFB does not open DCR/CIMD; unregistered clients fail closed |

## Harness notes

- Local server uses `createControlApp` + migrated in-memory SQLite fixtures (`seedSyntheticWorkspace`).
- Host header port is normalized in the harness only so loopback non-default ports match F03 hostname allowlisting; production uses canonical hosts.
- Protected-resource metadata still advertises fixture resource `https://bfb.example.test/mcp`.
- These rows are **not** fixture-profile-only claims; each client binary was invoked on this machine.
- Unsupported or incomplete outcomes do not change the frozen X03A transport or OAuth policy.

## Evidence artifacts

- `docs/work-packages/evidence/WP-X03A/attempts/attempt-summary.json`
- `docs/work-packages/evidence/WP-X03A/attempts/claude.log`
- `docs/work-packages/evidence/WP-X03A/attempts/codex.log`
- `docs/work-packages/evidence/WP-X03A/attempts/grok.log`

Started: 2026-08-11T11:39:34.260Z  
Ended: 2026-08-11T11:39:44.393Z
