# V02 current viewer acceptance

Source: `4e4fb7071c1c9e7d84dfa73249ecd888afd121dd`, clean checkout,
6 October 2026. Owner command: `pnpm test:v02`. Full `pnpm verify` and the
clean-worktree check pass on the same source. Historical evidence is retained
under `manifest.json`; this certificate does not rewrite it.

| Boundary | Current proof |
| --- | --- |
| One-use grants at equal timestamps | Failing-first staged regression; eight real-D1 same-clock requests have one winner, one audit and no credential plaintext |
| 4096-byte redemption limit | Declared-length and streamed-body negatives reject before consumption or R2 reads |
| Compiled active preview | Production React component waits for a click, loads actual R2 bytes, stops and reloads with a new grant |
| Compiled passive preview | Production component loads actual published Markdown and handles authentication loss visibly |
| Browser authentication | Production browser-session/CSRF routes reject missing CSRF and revoked membership |
| Revocation | Epoch rotation denies a preissued grant before consumption; fresh issuance denies revoked membership |
| View audit delivery | Production Hub command across two control isolates; duplicate, lost-reply and transient-cache-loss retries produce one bounded projection |
| Containment | Eleven retained hostile iframe/top-level browser cases pass; exact sandbox/CSP policy, strict renderers, cookie separation and abuse budgets remain enforced |
| Repository | 2,905 TypeScript tests, Go checks and 16 Swift tests; no platform skips |

The compiled browser fixture serves its generated entry and JavaScript through
a synthetic HTTP bridge. Business requests reach real production Control and
Artifact Worker handlers, WorkspaceHub, D1 and R2. This closes the component/auth
integration gap, not a new certificate for Worker static-asset routing or the
whole board. No persistent pilot state or deployed feature flag was changed.

## Limits

Strict Mermaid remains a bounded flowchart subset. Compressed logs retain the
static fallback. The directly opened top-level hostile document can issue a
credential-free self-navigation GET; intended iframe top navigation is blocked.
Immutable review and mandatory product additions retain their separate owners
and are not certified by these viewer tests.
