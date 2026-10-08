# Remote MCP runtime proof

Owner: [WP-X03](../../docs/work-packages/WP-X03-remote-mcp.md).
Command: `pnpm test:x03` (standalone after build:
`pnpm exec tsc -b tools/remote-mcp && pnpm exec tsx tools/remote-mcp/run.ts`).

Two independent production Control handlers share one production WorkspaceHub,
disposable D1 and an Artifact Worker/R2 bucket. The proof checks exact retries,
human attribution, current access, metadata-only receipts and actual delegated
upload/finalization. No provider, persistent pilot or remote launch is involved.
Output is a bounded check-name/count record ending `X03_D1_OK`; raw private
responses and credentials are not exported as evidence.

`grant.ts` creates visibly synthetic session/passkey-proof/token fixtures using
production delegation activation/binding functions. It is not OAuth token
protocol issuance; the retained Chromium gate owns consent and code exchange.
`control.ts` exposes a fixture-only direct Hub dispatch path for bypass-of-outer-
auth attacks. It also restores the preserved request URL's Host after Wrangler's
Node bridge replaces that header with its loopback address. Deployed code has
neither adaptation; the unchanged handler gate owns Host/Origin negatives.
The deterministic static fixture supplies the required assets binding, not UI.
