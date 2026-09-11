# Runner identity and possession contract

C06 owns this server contract. L08 owns keys, browser handoff, native credentials,
authenticated sockets and recovery. C09/E01 consume a verified runner principal
but must reauthorize every command/event; a returned principal is not a reusable
credential. W02 owns the runner management UI.

## Identity and approval

The daemon generates a fresh P-256 key **for each workspace** and a fresh ULID
runner ID. Its browser handoff carries only that public JWK, runner ID and bounded
display label; the human selects the workspace/projects. No pending secret,
provider configuration or local path is uploaded. W02/L08 must show the selected
identity and never silently replace the key after step-up.

The public JWK has exactly `crv`, `kty`, `x`, `y`, with `P-256`, `EC` and canonical
unpadded base64url 32-byte coordinates. Web Crypto must import the curve point.
Private `d`, `key_ops`, extra fields and another curve are rejected. The key
thumbprint is `sha256:` plus lowercase hexadecimal SHA-256 of the UTF-8 JSON
`{"crv":"P-256","kty":"EC","x":"…","y":"…"}` in that order. One public key
cannot be reused for any other enrollment, including another workspace.

Browser endpoints require the existing Better Auth session, same-origin CSRF
protection, active member/owner role and a fresh C03 user-verifying passkey proof:

| Endpoint | JSON fields | Result |
| --- | --- | --- |
| `POST /api/v1/workspaces/:workspace/runners` | `runner_id`, `device_label`, `public_key`, `project_ids`, `step_up_proof_id` | `201 {runner: RunnerIdentity}` |
| `POST …/runners/:runner/grants` | `expected_grant_epoch`, `project_ids`, `launcher_human_ids`, `step_up_proof_id` | `{runner: RunnerIdentity, signals: RunnerChannelClose[]}` |
| `POST …/runners/:runner/revoke` | `step_up_proof_id` | `{signal: RunnerChannelClose}` |
| `GET /api/v1/workspaces/:workspace/runners` | none | `{runners: RunnerIdentity[]}`, at most 100 |

Enrollment creates only the owner's launch grant. Project and launcher sets have
at most 64 distinct ULIDs. Enrollment/project changes cannot exceed the owner's
current project access. Only the enrolling human can change sharing or revoke;
another workspace owner does not inherit that right. Launchers must be active
members/owners, not reviewers. The owner remains a launcher until revocation.
Workspace membership removal cascades its named-human launch grant. Rejoining
and regaining project access cannot resurrect that old grant; the runner owner
must approve sharing again. C04's membership-removal event also remains the
authority-revocation signal for commands attributed to that human.
List results show only owned or explicitly granted runners; non-owners receive
only their visible project IDs and their own launcher grant. Labels are at most
80 characters, using letters, numbers, spaces and limited display punctuation;
slashes, control characters and paths are rejected.

Proof actions are `runner.enroll`, `runner.grants.replace`, and `runner.revoke`.
All bind the exact workspace, human, current human authorization epoch, empty
scopes, no OAuth client/resource/project/task boundary, and the issued expiry.
Enrollment's target is the SHA-256 of the fixed-order JSON array
`["runner.enroll", runnerId, deviceLabel, keyThumbprint, sortedProjectIds]`.
Sharing's target is the SHA-256 of
`["runner.grants.replace", runnerId, expectedGrantEpoch, sortedProjectIds, sortedLauncherIds]`.
Both targets use the `sha256:` hexadecimal prefix. Revocation's target is the
runner ID. `runnerEnrollmentTarget` and `runnerGrantsTarget` own this encoding.
A prior enrollment proof cannot authorize sharing; removal also needs a new
exact proof. Replay is rejected even with the original hub idempotency key.

## Native challenge and token exchange

Native endpoints are under `/runner/workspaces/:workspace/runners/:runner` on the
configured application origin. They reject browser cookies, Origin and
Authorization headers. JSON bodies are streamed with an 8,192-byte bound and
closed field sets. Public invalid, stale, missing and exhausted requests return
the same `403 {error: "request_rejected", message: "request rejected"}`. Successful
and rejected responses are `no-store`. The daemon gets no human session or key.

1. `POST /challenge` with `{"purpose":"token"}` returns `{challenge: RunnerChallenge}`.
   Before browser approval this fails uniformly; bounded retries are allowed.
2. The daemon checks workspace, runner, origin, audience and enrolled thumbprint,
   then signs the canonical transcript with its workspace key.
3. `POST /token` with `challenge_id`, `server_nonce`, `signature` returns `token`,
   `token_type: "bfb-runner-pop"`, and `expires_at`.

Every challenge contains a server-generated 256-bit nonce and lasts 60 seconds.
Only its SHA-256 verifier is stored. Every issuance/renewal needs a new challenge;
old tokens are not renewal authority. The server clock controls expiry, with no
positive grace window. Clients use the challenge timestamps and server expiry,
not a locally signed timestamp. Before its stored issue time or at its expiry,
a proof fails closed.

Signatures are ECDSA P-256/SHA-256, 64-byte IEEE P1363 `r || s`, encoded as
canonical unpadded base64url, not ASN.1 DER. The signed bytes are exactly:

```text
BFB-RUNNER-POSSESSION-V1\n
JSON.stringify([challenge_id, server_nonce, workspace_id, runner_id, audience,
  origin, public_key_thumbprint, purpose, authorization_epoch,
  owner_authorization_epoch, grant_epoch, token_epoch, token_id,
  request === null ? null : [request.method, request.path, request.body_sha256],
  issued_at, expires_at]) + "\n"
```

The two lines above describe one UTF-8 prefix line and one compact JSON line;
there is no indentation or extra whitespace in the signed bytes. The canonical
vector is `protocol/fixtures/runner-possession.json`. A changed field, reordered
transcript or altered workspace/audience cannot authenticate.

The token is **stateful, not a JWT and not OAuth/DPoP**:
`bfb_runner_<base64url(UTF-8 claims JSON)>.<256-bit base64url secret>`.
D1 stores the exact public claims JSON and only SHA-256 of the random secret.
Claims are untrusted until the full credential has been joined to the current
runner and matching stored claims. It expires after five minutes and contains:
`v`, `sub`, `workspace_id`, `aud: "bfb-runner"`, `iss` (application origin), `jti`,
integer `iat`/`exp`, runner `authorization_epoch`, `owner_authorization_epoch`,
`grant_epoch`, `token_epoch`, and `cnf: {jkt: <BFB key thumbprint>}`.
The `jkt` value uses BFB's hexadecimal-prefixed thumbprint, not JWT conventions.
Neither token claims alone nor the random secret alone is a credential.

Token exchange increments `token_epoch` atomically. Only one exchange from the
previous generation can succeed, even with distinct outstanding challenges.
The client must serialize exchanges and store only the successful generation;
after an ambiguous response, obtain a new challenge and rotate again, never
reuse a consumed proof. Old generations fail authentication immediately.

## Request possession and the L08 boundary

A token is not accepted as an ordinary bearer credential. Before a channel
handshake or native HTTPS action:

1. `POST /challenge` with `purpose: "request"`, `token`, and
   `request: {method, path, body_sha256}`. `path` is a closed, query-free route
   under that workspace/runner; `body_sha256` is lowercase hexadecimal SHA-256
   of the exact business-body bytes, excluding authentication material.
2. Sign the returned fresh challenge. It binds the token ID and request fields.
3. L08/E01's handler calls `authenticateRunnerRequest` with the actual observed
   method/path/body digest and the proof. The supplied binding is never trusted
   as the actual request. Consumption is single-use, so replay cannot authenticate
   again. Business idempotency is separately owned by C09/E01/L06.

`POST /authenticate` is a possession diagnostic using a request binding of
`POST`, that exact endpoint path, and SHA-256 of the empty business body. It takes
`challenge_id`, `server_nonce`, `signature`, `token` and returns a non-secret
`RunnerPrincipal`. That response has no authentication power at another endpoint.

The principal carries separate runner and owner identities, current epochs,
token ID, thumbprint, expiry and currently intersected project grants. L08 must
store only these non-secret attachment fields, not raw tokens, cookies or proofs.
Connection liveness never means process activity or task completion. L08's
[native channel contract](runner-channel.md) specifies sockets, expiry alarms,
privileged message rechecks and durable pull; E01 retains event disposition authority.

## Transaction, revocation and abuse guarantees

All runner mutations use WorkspaceHub. Its security commands opt into a narrow
audit-input projection and reject cached-success replay. No result contains raw
tokens, nonce, signature or proof input. Transport-only material traverses the
trusted internal hub RPC only while being verified. D1 batches consume proofs
and commit identity/grants, events, audit, outbox and idempotency together.
Transient `runner_mutation_guards` CHECK assertions abort the complete batch
on a lost conditional-consumption race; the table is empty after success.

Grant changes increment the grant epoch. Revocation first records `revoked_at`
and increments both runner and grant epochs. In that same transaction,
`runner.channel.close` is committed in `runner_channel_signals` and the command's
ordered semantic event/outbox. Signals include all current runner/grant/token
epochs. Token rotation also signals older token generations. C06 emits the typed
signal; L08/E01 own actual live-socket delivery and closure. Any later cleanup
must follow this committed fence, not confer authority based on rows being
absent. Invalid token verifier rows may remain; revocation already blocks
issuance and authentication before their deletion.

Grant-removal signals include the removed human ID. C09 must cancel that human's
pending commands and independently call `assertRunnerLaunchAuthority` at creation,
claim and final authorization. The signal is not a substitute for those checks.
Owner membership/role and current project access are reloaded; membership epoch
changes also invalidate outstanding challenges and previous tokens. A fresh
challenge can renew only while the owner still has an eligible active role.

C01's durable rate-limit service gates browser approval, challenge issuance,
proof exchange and authentication. There are separate keyed IP and subject
buckets per surface, with 20 bootstrap mutations or 60 reads per minute. Recurring
L08 request-challenge, channel, pull and inventory surfaces have separate bounds:
120 attempts per enrollment and 1,024 per IP per minute. An outer challenge-envelope
budget also bounds malformed input; token challenges retain the 20-attempt bootstrap
budget after parsing. Both changing
runner IDs from one IP and changing IPs for one runner retain an authoritative
limit. No raw IP enters bucket keys, D1 rows or application logs. Incoming
oversize/malformed bodies are rejected without buffering past the byte bound.
Challenges are attributed to a named system issuer, not claimed runner activity;
runner audit attribution is used only after successful possession verification.

## Reproduction and fixtures

`pnpm test:c06` runs fixture drift, build, TypeScript/Go wire parity, domain and
mounted-route tests, three real Workerd scripts sharing D1/WorkspaceHub, and
Chromium with real virtual-authenticator assertions including a cleared UV flag.
Workerd uses the `global` jurisdiction because its emulator does not implement
jurisdiction selection; existing hub-client tests cover persisted EU/US routing.
These are local tests, not a deployed Cloudflare or real-Keychain certification.

`pnpm runner:fixtures` owns the synthetic C06 fixtures and transcript vector;
`node tools/runners/fixtures.mjs --check` checks them without mutation.
`pnpm protocol:generate` owns generated Go/TypeScript codecs/types/catalogs;
`pnpm protocol:check` checks drift. C06 adds `runner-identity`, `runner-challenge`
and `runner-channel-close` documents. It does not widen the existing closed v1
`runner-enrollment` connection-summary document.

Implementation references: [Cloudflare D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/),
and [Chromium WebAuthn test controls](https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/).
