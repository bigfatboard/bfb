# C05 security and isolation evidence

Tested commit: `<tested-commit>`.

The exact `pnpm test:c05` target passed in a clean detached checkout. The matrix below summarizes retained synthetic assertions, not production observations.

| Boundary | Positive and negative proof | Owner |
| --- | --- | --- |
| Device bootstrap | The fixed `bfb-cli` client obtains short-lived codes; foreign clients, caller-supplied `user_id`, widened scopes, and oversized bodies fail without creating rows. | Mounted route suite |
| Approval before key | Browser approval creates the binding first with fixed scopes, epoch, and project subset; unknown, expired, decided, foreign-client, foreign-user, reviewer, and duplicate approvals fail. | Domain and mounted suites |
| Single exchange | One approved bootstrap credential yields one `bfb_cli_` credential; the device row is deleted atomically and replays fail uniformly. Two isolates racing one code produce one winner. | Domain, mounted, and real D1 suites |
| Current authority | Binding, membership, role, project access, and authorization epoch are rechecked on every request; epoch bumps, revocation, expiry, and project loss disable the credential. | Domain and mounted suites |
| Revocation | The binding disables first and device cleanup follows in the same command; existing credentials cannot authenticate afterward. Failed browser approval revokes the pending binding. | Domain, mounted, and real D1 suites |
| No session elevation | `POST /auth/device/token` answers 404 and no session row is created; no endpoint exchanges a CLI credential for a session and no direct key route exists. | Mounted and real D1 suites |
| Transport separation | CLI credentials fail on browser, runner, MCP, and webhook routes; those routes' cookies and bearers fail on CLI routes. Bodies and identifiers are bounded; public failures are uniform and non-cacheable. | Mounted route suite |
| Abuse | Durable HMAC-hashed IP and hashed code/subject dimensions survive isolate changes for issuance, approval, polling, and exchange. Exhaustion blocks even valid proofs until the window passes; valid proofs on other codes are unaffected. | Mounted and real D1 suites |
| D1 atomicity | The exchange claim is a commit-time guard predicate, not a read-after-write; losers abort the whole batch including audit and idempotency writes. Guard rows never persist. | Domain and real D1 suites |
| Redaction | Bindings, device, audit, event, idempotency, and bucket persistence are scanned for synthetic raw credentials, codes, IPs, and paths. Only key hashes, public prefixes, safe claims, and hex bucket keys survive. | Domain, mounted, and real D1 suites |

## Reproduction and contract ownership

- `pnpm test:c05` composes the build, protocol parity, focused domain and mounted route suites, the web build, and the two-isolate workerd run with exchange races, revocation, abuse exhaustion, and secret scans.
- `pnpm verify` additionally passed the full TypeScript, Go, and native Swift/Xcode checks.
- Migration `0018_cli_credentials` owns the reviewed device table plus binding/guard schema; the drift test fails on unreviewed change. No fixture contains a usable credential.
- Local workerd does not implement EU Durable Object jurisdiction. Test fixtures use global routing with the production jurisdiction contract unchanged.
- [CLI credentials contract](../../../contracts/cli-credentials.md) freezes the exchange API, binding lifecycle, and Keychain storage contract for X02. Browser binding management UI and CI issuance routes are not C05 evidence.
