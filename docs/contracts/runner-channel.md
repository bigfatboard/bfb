# Native enrollment and runner channel

L08 owns this transport contract. C06's [identity and possession contract](runner-enrollment.md)
remains the authentication authority. D1 is canonical; WorkspaceHub serializes
channel admission, privilege changes and command mutations. Connection heartbeat
is not process/session heartbeat, work activity, human attention or completion.

## Enrollment and local credentials

`bfb runner enroll --workspace <id> --origin <https-origin> --label <label>`
reserves one SQLite enrollment for that origin/workspace before creating its key.
It returns a public browser URL; `runner list`, `runner wake <id>` and
`runner forget <id>` expose status, retry and revoked-enrollment removal.
The same commands are available through the private Local RPC methods
`runner.enroll`, `runner.list`, `runner.wake` and `runner.forget`. L04 consumes them.
Forgetting requires a persisted terminal revocation and a stopped enrollment worker.

The handoff fragment is canonical base64url JSON matching `runner-enrollment-handoff`:
version, workspace/runner IDs, device label and public P-256 JWK only. The browser
shows the bound workspace and fingerprint, requires explicit project selection and
key recognition, then uses C03's action-bound user-verifying passkey assertion.
Reload after approval recognizes the same public identity without re-enrolling it.
No human credential is created by this flow. The fragment is not an approval token.

Each enrollment has a different software P-256 private key and runner token under
the Keychain service `com.tenira.bfb.runner`. The daemon uses Security.framework
directly; there is no signing subprocess, RPC signing oracle or plaintext fallback.
The signed daemon identifier is `com.tenira.bfb.daemon`. Its Apple-anchored code
signature and hardened runtime are checked, with debug, library-validation-bypass
and DYLD environment entitlements rejected. Credential ACLs trust only the creating
signed component, UI prompts are disabled, and exact-item reads precede update/delete.
Private keys are immutable; token generations replace only their enrollment item.
The app uses the daemon rather than reading those secrets.

Local migration `003_runner_enrollments.sql` stores public identity, connection
state, token epoch, inventory revision and durable command receipts. A crash between
Keychain creation and SQLite publication recovers the existing key. Ambiguous token
exchange or persistence always requires another fresh challenge, never replay.
Startup resets transient connection observations but preserves revoked state.

## RunnerConnection and the wire

`internal/runner.RunnerConnection` is the single local boundary for `Renew`,
authenticated `Request`, WebSocket `Open`, and non-secret credential epoch/expiry.
It serializes credential generations, rejects redirects and browser credentials,
and binds possession to exact HTTP method, path and body bytes. Detached handles
fail after disconnect; consumers must reacquire the current connection.
L06/E01 can add event actions here without creating another credential owner.

The native origin is canonical HTTPS, with no path/query/fragment/user information.
Production uses normal system TLS trust. Authentication uses the fresh C06 request
challenge and `X-BFB-Runner-Proof`: base64url of compact fixed-order JSON containing
`challenge_id`, `server_nonce`, `signature`, `token`. Secrets never enter URLs,
inventory, SQLite, logs or socket attachments. Responses are bounded to 64 KiB.

| Endpoint under `/runner/workspaces/:workspace/runners/:runner` | Contract |
| --- | --- |
| `GET /connect` | WebSocket upgrade, subprotocol `bfb.runner.v1`, empty body |
| `POST /commands/pull` | `{}` or `{after_command_id}`; at most 25 scoped references plus continuation |
| `POST /inventory` | Closed `runner-inventory` v1, at most 49,152 bytes |

`runner.channel.ready`/`alive` carry connection ID, current project grants, token
epoch, server time and authority expiry. The client sends a scoped heartbeat every
20 seconds. The server rejects malformed/binary/oversize frames and heartbeats less
than ten seconds apart. Every privileged message and committed workspace command
rechecks current D1 authority. Hibernation retains only public principal metadata,
connection identity and advisory nudge watermark. A persistent alarm closes expired
sockets even without messages. Alarm/storage failures close channels fail-closed.

The client rotates 30 seconds before its monotonic deadline, mapping server lifetime
from the challenge rather than trusting wall-clock agreement. It reconnects with
bounded exponential jitter, renews separately per workspace, and forces fresh
authentication on wake/retry. No response for 45 seconds causes recovery.
Grant changes rotate; a matching, advancing typed `runner.channel.close` with reason
`revoked` persists the terminal fence before token cleanup. The socket reader handles
that notice independently of in-flight HTTP requests. A bare 403, close code or
network failure means authorization required/offline, never inferred revocation.

## Durable recovery and sanitized inventory

Connect, command nudges and periodic heartbeat independently trigger pending pull.
The server filters current project grants before pagination. Reference expiry is
informational here: the owning C09/D02 handler must decide claim/final authorization
or terminal rejection. L08 never silently drops an expired reference.

Local receipts have `(runner_id, command_id)` identity. Consumers must durably commit
their own idempotent acceptance before returning; only then is the local receipt
accepted. Restart between those commits redelivers to the same consumer identity.
Absent consumers leave references pending. Cursors, nudges and receipts never delete
canonical commands or acknowledge event persistence. Bounds are 256 pending local
references, 4,096 retained receipts, and 16 pull pages per recovery. Hitting a bound
is visible `sync_blocked`; business owners resolve/retain work under their contracts.

Inventory has a monotonic revision, at most 25 granted L02 checkout summaries and
four L03 provider reports. It contains no absolute paths, executable arguments,
provider configuration or credentials. Provider observations expire within 30
seconds; unhealthy or unverified providers advertise no capabilities. Probe clocks
are translated to the authenticated server clock. Excess checkouts fail visibly,
not as a truncated inventory. Real provider capability certification remains L07/P01.

Cloud migration head is `0015_runner_channel.sql`. `runner_connections` and
`runner_inventories` are observations; `runner_command_references` is a durable,
project-scoped delivery index created/resolved only by internal domain commands.

## Acceptance and reproduction

`pnpm test:l08` requires macOS with an available Apple Development signing identity.
It runs generated-fixture drift, Go/TypeScript wire parity, domain/route/security
tests, race-tested native credential/daemon/runner tests, actual local Workerd/D1
and hibernating WorkspaceHub interoperability, and browser passkey pairing.
`pnpm runner:fixtures` owns the synthetic channel and handoff vectors;
`pnpm protocol:generate` owns generated codecs/types. Their `--check`/drift gates
must leave the checkout unchanged.

The native fixture installs a uniquely named temporary per-user launchd service,
checks launchd parentage, connects two workspaces with no app process, links a real
temporary checkout, loses nudges, hibernates the real DO, invokes wake recovery,
forces a clock jump/expiry alarm, kills the owned daemon after a business commit,
and changes/revokes grants through the production browser routes. Cleanup targets
only that service, its synthetic Keychain items and temporary state. A separate
direct Security.framework probe rejects unsigned/ad-hoc and unrelated signed access.
On Apple Silicon a completely unsigned executable is rejected by the OS before it
runs; the executable ad-hoc probe still directly tests the Keychain boundary.

The fixture's loopback TLS adapter trusts a pinned test certificate on the native
client leg and Wrangler's disposable development certificate on the proxy leg.
It has no production configuration path. Real production TLS verification is not
disabled. Fixture step-up minting isolates transport tests; Chromium separately
exercises real virtual-authenticator assertions including non-UV rejection.

Wake recovery is injected through the same production wake operation on a signed
daemon; this does not suspend the developer's whole Mac. Real device sleep/network
environment coverage, notarized release signing/upgrades and the genuinely fresh
macOS account gate remain G02 release checks. Local development-signing evidence
is not notarized-release or cross-device certification.
