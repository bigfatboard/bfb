# Provider MCP client compatibility (X03A)

**Historical only — not IC-1 acceptance proof.** IC-1 re-certification reopened X03A; this document and redacted attempt summaries remain for context until a new evidence package is generated at the re-certified commit.

Real installed-client attempts against a local BFB control app serving MCP `2026-07-28` at `/mcp` with OAuth authorization_code + PKCE S256 and server-preregistered public client `bfb-mcp-synthetic-client` (redirect `http://127.0.0.1:9999/callback`).

Harness: `node tools/provider-compat/run-attempts.mjs` (Node 24.19.0). Endpoint: `http://127.0.0.1:18765/mcp`. Cookie auth on `/mcp` rejected by harness probe (HTTP 401).

| Provider client | Exact version | Result | Limitations |
| --- | --- | --- | --- |
| Claude | 2.1.224 (Claude Code) | failed to connect — client probe omitted/mismatched MCP-Protocol-Version 2026-07-28 (HTTP 400) | BFB requires preregistered public client + PKCE S256; authorize needs browser session + workspace_id + step_up_proof_id; Claude health probe omitted required protocol version; no cookie auth on `/mcp` |
| Codex | @openai/codex 0.114.0 (native ENOENT) | failed — native binary missing; MCP not exercised | npm wrapper cannot spawn vendor binary; no acceptance weakening |
| Grok | grok 1.0.0 (3cd0d0cbcebe) | doctor unhealthy — initialize without MCP-Protocol-Version 2026-07-28 (HTTP 400) | Grok doctor uses initialize handshake; BFB rejects it under strict 2026-07-28; no DCR/CIMD |

## Harness notes

- Local server uses `createControlApp` + migrated in-memory SQLite fixtures.
- Host header port normalization is harness-only for loopback allowlisting.
- Unsupported outcomes do not change frozen X03A transport or OAuth policy.

## Evidence artifacts (redacted summaries)

- `docs/work-packages/evidence/WP-X03A/attempts/attempt-summary.json`
- `docs/work-packages/evidence/WP-X03A/attempts/claude.log`
- `docs/work-packages/evidence/WP-X03A/attempts/codex.log`
- `docs/work-packages/evidence/WP-X03A/attempts/grok.log`

Raw provider attempt stdout/stderr, machine-local paths, and unrelated MCP inventory were removed from the branch tip. Remote history is not rewritten without confirmation.

Started: 2026-08-11T11:39:34.260Z  
Ended: 2026-08-11T11:39:44.393Z
