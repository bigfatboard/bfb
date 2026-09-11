# L08 native channel evidence

Tested implementation: `18b7e206657151cb76e63b4d97b5e88b50aa99d4`.
The exact L08 target passed from a detached clean checkout. This is a bounded
assertion report, not a retained terminal transcript or production certification.
The aggregate command outcomes are recorded separately in the manifest.

## Trust and credential boundary

| Boundary | Observed result | Owning test |
| --- | --- | --- |
| Two enrollments on one Mac | Different public keys, runner IDs and live connection IDs; isolated credential subjects and local records | `TestNativeWorkerChannel`, C06 Worker isolation |
| Signed daemon without an app | Real temporary launchd service has launchd parentage; creates keys, signs, renews and reconnects without starting the app | `TestNativeWorkerChannel` |
| Completely unsigned executable | Apple Silicon rejects execution before a credential request | `TestNativeCredentialACL` |
| Ad-hoc signed executable with BFB identifier | Direct Security.framework key and token reads rejected | `TestNativeCredentialACL` |
| Unrelated Apple-signed component | Direct key and token reads rejected despite using the same development certificate | `TestNativeCredentialACL` |
| Approved code | Private signing, public-key recovery, token replacement and exact-item cleanup succeed; private-key replacement rejected | `TestNativeCredentialACL` |
| Altered scope/audience/origin/body | Challenge or actual-request proof rejected; no cross-workspace authentication | possession fixtures, TLS and C06 Worker suites |
| Consumed proof | Replay rejected; a later exchange uses a new challenge | C06 Worker races, `TestAmbiguousRenewalUsesNewChallenge` |
| Concurrent renewal | Twelve concurrent callers produce one successful local credential generation | `TestTLSRotationSerializesAndBindsActualRequest` |
| Ambiguous persistence/redirect | No usable ambiguous in-memory credential; fresh challenge required; redirected endpoint never called | `TestPersistenceFailureAndRedirectFailClosed` |

## Connectivity and durable delivery

The signed native fixture uses production runner code, actual HTTPS and WebSocket
routes, local Workerd/D1 and the real hibernating WorkspaceHub. The synthetic owner
consumer writes and syncs a durable effect before returning; it is not a launch
implementation and does not stand in for C09/L05 final authorization.

| Fault or transition | Observed result |
| --- | --- |
| Lost command nudges | Periodic pull receives 27 allowed references across two pages; an ungranted-project reference is excluded |
| Already-expired references | Delivered to the owning consumer, not silently discarded by the transport |
| Receipt versus canonical state | All 28 initial canonical references remain pending in D1 after local acceptance; no cursor-driven deletion |
| Hibernating DO eviction | Existing connection ID survives; subsequent real heartbeat advances its observation |
| Workspace A wake | Fresh challenge and greater token epoch, new A connection; B's connection unchanged |
| Server clock jump | Near-expiry B token closes through the real persistent DO alarm, then renews on a different connection |
| Daemon kill after business commit | Launchd restarts the daemon; same enrollment and command identity reconcile the missing local receipt; exactly 28 allowed durable effects remain |
| Grant tightening | Existing socket closes; fresh authorization reconnects with the tightened grant set |
| Terminal live revocation | Matching advancing fence persists `revoked` and blocks renewal; other workspace remains connected |
| HTTP denial races the socket | Pending request cancellation and delayed-notice-after-403 cases both retain the verified terminal fence |
| Stale/wrong-workspace notice | Rejected; no terminal state is fabricated |
| Bare denial or parent cancellation | No inferred revocation; channel reader joins promptly |
| Missing consumer / acceptance crash | Reference remains pending or redelivers idempotently; no acceptance is inferred |
| Database or alarm failure | Unauthorized/live-expiring sockets close; a nudge failure cannot change an already-committed business outcome |

## Public synchronization and approval

- Native RPC links a real temporary Git checkout; the inventory contains its public
  summary but not the local directory. Only currently granted projects synchronize.
- Closed inventory fixtures reject provider configuration and private fields.
  Revision, size, duplicate-identity, project scope, provider freshness and unhealthy
  capability restrictions are exercised by domain tests.
- Browser pairing verifies explicit project selection, exact public-key identity,
  owner-only initial launch permission, real user-verifying passkey assertions,
  rejection with UV cleared, reviewer rejection, malformed links and reload recovery.
- Desktop and 390-pixel mobile pairing layouts were visually inspected during local
  development. Screenshots are not retained as certification artifacts.
- `runner:fixtures` and `protocol:generate` own deterministic public fixtures and
  generated contracts. Go and TypeScript decode the same protocol corpus;
  159 TypeScript protocol tests pass.

## Limits of this evidence

Signing uses an available Apple Development identity, not a notarized release
artifact. G02 repeats signed access through release installation and upgrades.
Wake is injected through the production daemon operation on a real signed process;
the test does not suspend the entire developer Mac. Cloudflare jurisdiction-specific
deployment, real-device sleep/network environments and cross-device reachability
are not claimed. The existing ADR 0003 fresh-macOS-account deferral remains in force.

The test-only TLS adapter pins the native-facing synthetic certificate; its separate
loopback proxy accepts Wrangler's disposable development certificate. There is no
production setting for that adapter or trust exception. Synthetic proof minting in
the native fixture is supplemented by the separate real-browser UV gate.

No real provider capabilities, process activity, launch claim/final authorization,
event acknowledgement, human credential, discussion execution or completed local
MVP is claimed by this transport package. No production deployment occurred.
