# Independent IC-1 security/acceptance audit

**Branch:** goal/grok-web-mcp  
**Certification commit:** 696e3ccf33ba590a4a50a3f53dc448ca9cd4f639  
**Mode:** read-only review + clean-clone command evidence

## Findings

### P0

None.

### P1

None open.

Prior residual P1s closed at this cert:

1. **C01 WorkspaceHub DO command path** — work API and MCP mutations call `executeWorkspaceCommand`, which RPCs the jurisdiction-scoped Durable Object when `WORKSPACE_HUB` is bound. Process-local FIFO is test-only when the namespace is unavailable; DO RPC failure does not degrade to local FIFO.
2. **C02 session-bound CSRF** — cookie mutations require `X-BFB-CSRF` derived from session id + auth secret (HMAC-SHA256). Token is issued on sign-in and `/auth/session`; SPA sends it on work mutations. Origin + Sec-Fetch-Site remain in force.
3. **D1 one-time capability races** — step-up and OAuth authorization-code consume use conditional `UPDATE … WHERE consumed_at IS NULL` plus unique post-commit stamp ownership so only one concurrent winner succeeds.

### P2

- Synthetic local auth-secret fallback remains for unit tests when `BETTER_AUTH_SECRET` is unset.
- PR #3 open; not merged by design.
- Provider-compat logs remain historical only (honest unsupported Claude/Codex/Grok).

## Gates

- Package statuses F02–X03A: done with evidence manifests
- `pnpm test:c01` includes hub-client DO-shaped FIFO coverage
- `pnpm test:c02` includes session-bound CSRF token tests
- `pnpm test:c03` includes concurrent consume single-winner
- CI: `pnpm test:ic1` mandatory (domain + W01 unit/browser + X03A)
- Clean-clone at cert SHA: package chain + `pnpm verify` → CLEAN_CLONE_OK
- PR #3 unmerged

## Verdict

**IC-1 residual re-certification complete for the web + remote MCP checkpoint.** No open P0/P1.
