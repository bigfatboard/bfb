# C06 security and isolation evidence

Tested commit: `02475746c36c0673bb389c43241536b256d2f9bc`.

The exact `pnpm test:c06` target passed in a clean detached checkout. The matrix below summarizes retained synthetic assertions, not production observations.

| Boundary | Positive and negative proof | Owner |
| --- | --- | --- |
| Human approval | Real browser assertion with user verification enrolls; session-only, missing, wrong-action, replayed and non-UV assertions fail. Sharing, removal and revocation each require their own fresh assertion. | Browser C06 scenario and domain/API suites |
| Current authority | Human and owner membership, authorization epoch, current project access, owner-only grant edits and explicit named-human launch grants are rechecked. Removed membership cascades launch grants; rejoining does not restore them. | Runner domain suite |
| Public key | Only exact public P-256 JWK coordinates are accepted; malformed/off-curve keys, private members and globally reused keys fail. A key collision rolls back the already-queued step-up consumption. | Domain and real D1 suites |
| Workspace isolation | Two enrollments have different keys, runner IDs, tokens and grants. Cross-workspace challenge/proof/token use fails. Revoking A does not revoke B. | Domain and real D1 suites |
| Possession | Domain-separated transcript binds audience, origin, workspace, runner, key, nonce, purpose, all epochs, time and optional actual request method/path/body hash. Alterations, expired/future challenges, signature mismatch and replay fail. | Domain and protocol fixtures |
| Token renewal | A fresh challenge is mandatory. Hashed random token secret and exact public claims are both checked. Two old-generation challenges cannot both update the token epoch. Token presence alone cannot authenticate an application request. | Domain and real D1 suites |
| Atomicity | Two independent API Worker scripts address one WorkspaceHub and shared D1. Competing enrollment, token, authenticated request and grant operations each produce one winner. SQL guards roll back losing writes and proof consumption. | Real three-Worker suite |
| Revocation | Authorization and epoch changes plus typed close signals commit before later credential cleanup. Existing tokens cannot renew or authenticate after revocation. This proves the signal contract, not a live socket. | Domain and real D1 suites |
| Abuse | Durable HMAC-hashed IP and workspace/runner dimensions survive API isolate changes. Approval, challenge, bad-proof and renewal attempts consume bounded budgets. Exhaustion does not consume a subsequently submitted valid proof. | Real three-Worker suite |
| Transport separation | Native routes reject cookies, browser Origin and Authorization headers. Browser routes retain real session/CSRF checks. Bodies and identifiers are bounded; public failures are uniform and non-cacheable. | Mounted API and browser suites |
| Redaction | Audit, event, idempotency, challenge and token persistence are scanned for synthetic raw credentials. Only nonce/token hashes, public keys, safe claims and bounded domain identifiers survive. | Domain and real D1 suites |

## Reproduction and contract ownership

- `pnpm test:c06` composes `pnpm test:protocol`, `node tools/runners/fixtures.mjs --check`, focused tests, three real workerd processes and the Chromium passkey scenario.
- `pnpm verify` additionally passed 411 TypeScript tests, Go checks and native Swift/Xcode checks. `pnpm test:w01:browser` passed all 15 browser scenarios.
- `pnpm runner:fixtures` owns the synthetic transcript, token-claims and new wire examples; `pnpm protocol:generate` owns language bindings and validators. No fixture contains a private signing key or usable credential.
- Local workerd does not implement EU Durable Object jurisdiction. Test fixtures use global routing with the production jurisdiction contract unchanged.
- [Runner enrollment contract](../../../contracts/runner-enrollment.md) freezes the exact stateful token and possession format for L08. WSS delivery, native key storage, launch semantics and automatic cleanup are not C06 evidence.
