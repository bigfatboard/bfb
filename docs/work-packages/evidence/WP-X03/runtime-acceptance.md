# X03 current delegated MCP acceptance

Source: `edac71ee4b8a7c04004fe94a68d79f99615cbc91`, clean checkout,
6 October 2026. Frozen install, exact `pnpm test:x03`, full `pnpm verify`
and clean-worktree checks pass. Historical `manifest.json` stays intact.

| Boundary | Current proof |
| --- | --- |
| Extension parity and fixed tools | 71 cases in the seven owning/core suites; twelve-tool map unchanged |
| Exact retry input | Failing-first regression plus two-isolate attention/result duplicates commit once; changed input rejects |
| Current authority before cache | Six revocation/scope/boundary/time fences for each private reply; project removal blocks real MCP replay; revoked delegation blocks both outer handler and direct Hub retry |
| Private receipts | Canonical records and authorized replies retain bodies; semantic/audit/outbox receipts exclude question/result/evidence canaries |
| Current A02 state | Explicit review question succeeds after result submission; terminal runs still reject |
| Real publication | MCP creates a one-use grant, missing receipt rejects, Artifact Worker verifies actual bytes into R2 and MCP finalizes the exact digest |
| Attribution and scope | Human sponsor plus delegation, never `agent_run`; cross-delegation key reuse and read-only writes deny; acceptance/approval/launch tools remain absent |
| Auth protocol | Retained Chromium consent/passkey/code-exchange and bad-redirect scenarios pass; core routing, credential-confusion and revocation tests remain green |
| Repository | 2,923 TypeScript cases, Go checks and 16 Swift cases, without platform skips |

The runtime harness applies all 39 registered migrations through current head
`0044_agent_profile_permissions`. It seeds explicitly synthetic approved
session/proof/token fixtures using production delegation functions, not an OAuth
token endpoint. The separate browser gate owns the protocol exchange.

Wrangler's loopback Host is reconstructed from the preserved request URL only
in the test bridge; the unmodified handler gate owns Host/Origin attacks. The
fixture-only direct Hub route verifies that skipping outer token resolution
does not skip current command authority. Neither adaptation is deployed.

Historical cache entries lacking input fingerprints fail closed. Canonical
history remains available under current access; old persistent audit rows were
not purged. No provider or enrolled Mac was operated, no pilot flag was changed
and no scope, remote agent identity or autonomous launch capability was added.
Creator-private tasks and the remaining mandatory product features need their
own privacy, publication and design contracts.
