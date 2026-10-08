# ADR 0010 — Connected online artifact publication

Status: accepted for the approved local MVP

Date: 6 October 2026

## Context

V01's historical browser publication and client components do not provide a
production local-MCP path. The local Host rejects publication; the historical
general `artifact.publish` RPC accepts caller-selected origins and credentials
and cannot serve as a native-run capability. Its Go browser client also lacks
the production browser mutation boundary. Remote OAuth registration is not
local run authority. Historical evidence and frozen v1–v5 contracts remain
unchanged and are not relabelled as current runtime acceptance.

Review also reproduced missing restricted-project checks on regrant,
finalization and human abandonment, grant redemption after project revocation,
and two same-timestamp consumers passing the timestamp-only consume guard.
The upload handler ignores R2's conditional `put` null return. Cron abandonment
mutates business state outside WorkspaceHub, and artifact audit-outbox rows
have no production dispatcher. These belong to V01's existing authority,
storage, recovery and audit obligations.

## Decision

### Separate closed native contract

Add `local-agent-artifact-rpc` at schema version 6 with exactly
`mcp.v6.publish_artifact`. Negotiate that named method through the existing
v1 daemon-status method list before sending private data. Do not widen general
v1 RPC, prior local envelopes, A01's four capture actions, A03's result family,
or provider telemetry. Unsupported peers fail visibly, with no downgrade.

The local request carries correlation, the unchanged `AgentWorkRequest`, a
relative file path, optional existing artifact ID, format and role, and an
optional expected canonical session binding. Public MCP/CLI inputs cannot
select a workspace, project, task, run, execution, provider identity, cloud
origin, credential, grant, storage key or uploaded digest. Execution reference
and binding are derived by the trusted local transport, not public tool data.

The daemon derives the assignment, real L06 canonical session and native
ownership using the existing A01 boundary. Fresh or restarted MCP/CLI callers
need current online binding; an offline first activation is never allowed.
Use current active-run authority, allowing a still-active submitted run as
the existing human-loop contract does, but denying accepted/failed/cancelled
runs, ended execution/session, lost lease/lock and current grant/key failures.
Every phase and private response rechecks current authority. Cloud checks
occur inside the Hub FIFO before operation lookup, changed-input conflict or
cached private outcome; token renewal alone cannot change business identity.

### One bounded immutable snapshot per explicit call

Read relative to the supervisor's persisted and revalidated
`LaunchPreparation.Artifacts` device/inode identity. Environment variables,
caller paths and mutable assignment hints are not directory authority.
Descriptor-relative no-follow reads reject traversal, absolute/control paths,
symlink components, unsafe ownership/permissions, directory replacement,
nonregular files and bound violations. Reject unsafe hard-link aliases.
Revalidate native ownership and pinned directory before delivery.

Copy at most the role limit plus one byte into private memory. Size, digest
and uploaded content come from that one immutable copy; never reopen the file
between phases. Existing limits remain review 5 MiB and compressed log 1 MiB.
The cloud revalidates exact size, SHA-256, format and role. Local paths and
file contents never enter metadata, ordinary audit or telemetry.

No local artifact journal, durable spool, pending-sync permission, background
replay or watcher is added. After restart an explicit same-ID call securely
reads its file again. Changed bytes or metadata conflict with the original
cloud operation; a different safely scoped file containing identical bytes is
equivalent because path is an access selector, not business identity.

### Canonical cloud operation and fixed phases

Two fixed possession-authenticated runner actions, `work/artifact-prepare`
and `work/artifact-finalize`, accept the same closed `AgentArtifactRequest`:
unchanged reference, canonical binding, optional artifact ID, format, role,
`declared_size` and lowercase unprefixed SHA-256 `expected_digest`. No caller version ID or storage
key is accepted. All scope derives from current immutable assignment/binding.
Reuse the artifact state machine/domain functions; do not impersonate a human
actor or create parallel runner publication rules. Retain truthful agent-run
origin separately from any sponsoring human.

The stable operation key is `agentWorkKey("publish_artifact", reference)`.
A durable immutable operation-to-version record binds the exact canonical
metadata fingerprint, scope and origin. It outlives transient Hub reply caches
so a lost create reply cannot create another version. Credential tokens and
local path are not fingerprint fields. Resolve existing operation state from
canonical version/receipt rows under current authority, not a stale cached
prepare reply. Every phase and retry preserves the original optional
`artifact_id` selection, including absence; a client must not substitute the
returned artifact ID when the initial input omitted it.

Prepare returns one of three stages: `upload_required`, `finalize_required`
or `available`. Only the first carries an ephemeral upload grant and the
configured deployment artifact origin. Each issuance has an independent
server-minted attempt identity; only hashes enter D1, Hub outcomes or audit.
A lost grant reply is recovered by an explicit new prepare attempt against
the same operation/version, never by persisting a plaintext secret. Existing
abuse ceilings apply. A verified receipt lets prepare skip reupload; an
available version returns the original immutable result.

Finalize resolves only the operation's original version, reauthorizes, and
uses the same verified-receipt state transition as human publication. It
cannot create a fresh version, approve anything, submit a result, complete a
task or start work. Exact retries converge to one publication effect and
origin; changed input fails only after current authority has been checked.

The new finite wire documents are `agent-artifact-local-request`,
`agent-artifact-request`, `agent-artifact-prepare-result`,
`agent-artifact-result`, and `local-agent-artifact-rpc`. Prepare/result carry
`schema_version: 1`, `operation_key`, `artifact_id`, `version_id`, `format`,
`role`, `content_hash`, `size` and existing `AgentEffectOrigin` as `origin`.
Prepare has `stage`, nullable `upload` and nullable `available_at`, with
mutually consistent branches. The upload object is exactly
`{origin, grant_id, secret, expires_at}`; its nested `origin` is the deployment
URL, not the agent-effect origin. The final result has `state: available` and
a required `available_at` timestamp. Local `expected_binding` and optional
`artifact_id` are absent when omitted, not explicit null.
Public success exposes only that final projection, never upload credentials,
endpoints, local path or R2 key. Local envelope is bounded to 16 KiB, metadata
requests/prepare replies to 4 KiB, and final replies to 2 KiB. Bytes use only
the existing separate upload route.

Bound CLI mode uses `bfb artifact publish --request-id` with relative `--file`,
`--format`, `--role` and optional `--artifact-id`. It rejects every mixed
legacy origin/workspace/run/credential flag, uses the same v6 native boundary
and emits only the closed final result or typed error. The historical human
mode/wire is not upgraded into agent authority; human credential parity stays
owned by X02.

The daemon validates the authenticated prepare origin as an exact HTTPS
origin without userinfo, path, query or fragment; only explicit local-test
loopback HTTP is allowed. Construct the fixed `PUT /upload/<grant-id>` route,
disable redirects and cookie jars, and send only the ephemeral upload secret.
Never forward runner/browser credentials to the Artifact Worker.

An attempted network operation can have committed despite a missing reply.
Use bounded typed errors that describe unavailable/possibly-applied state and
direct explicit same-ID recovery; no new receipt family or `never_sent`,
`pending_sync`, durable local capture or autonomous recovery claim is made.
Authorization denial hides any original private result even if its applied
fact remains in canonical storage.

### Storage and audit boundaries

Preserve the architecture's explicit direct-D1 exception for ephemeral
upload-grant consumption. Consumption, exact attempt identity and outbox row
commit atomically; a unique per-grant sidecar prevents equal timestamps from
making two requests winners. Historical consumed rows need no invented
backfill. All current principal/role/epoch, project/run and agent-origin
predicates belong in commit-time guards, not only preflight reads. Rejected
consumption reads no request body and performs no R2 effect.

Classify verified object registry and receipt inserts as a narrow extension
of upload bookkeeping, not a business-availability transition. The Artifact
Worker must bind them to the exact successful consumption and immutable
version-derived role/run/key/digest/size, with atomic conflict guards. Only
physically verified bytes can create a receipt. Missing or conflicting R2
conditional results require actual checksum/size verification (bounded byte
rehash if stored checksum is unavailable), never trust in custom metadata
alone. D1 failure after R2 write leaves recoverable non-viewable bytes;
publication still requires current-authority Hub finalization. No delete or
overwriting path is added.

Cron only selects bounded abandonment candidates. The system
`artifact.mark_failed` command rechecks grace/expiry and uploading state
inside WorkspaceHub before changing business state. A concurrent regrant or
finalization must survive a stale candidate scan.

Drain bounded artifact-audit outbox records through a system Hub command.
Original outbox identity binds one audit/event projection and its dispatched
stamp in the same D1 batch. Duplicates, a lost response, process restart and
expired transient reply caches cannot create a second projection. Preserve
source occurrence time separately from dispatch time. No raw bytes, secret,
local path or private task content enters the projection. This does not
certify V02/V03/X05 behavior or change their held package status.

## Verification and limits

Keep failing-first project/role/epoch and same-clock staged-D1 regressions,
then prove genuine two-Worker concurrency and R2 conditional failures. Cover
faults at consume, put, receipt and finalize boundaries; current authority
before cached delivery/conflict; submitted versus accepted state; immutable
operation recovery; metadata confusion; origin/redirect refusal; safe file
reads and changing/replaced directories; bounded audit dispatch and stale Cron
candidates. Empty/populated migration tests preserve historical state.

The exact V01 gate must include a compiled MCP and fresh bound CLI through a
development-signed daemon, Keychain enrollment, real L06 observation, native
ownership/held lock, real local Control Worker/Hub/D1 and Artifact Worker/R2.
Prove lost create/upload/finalize replies across MCP/daemon restart using
explicit same-ID retry, offline visibility without queued sends, single
version/effect and intentional bounded byte storage. No Terminal automation,
live provider turn, real-workspace offline enablement, deployment or broader
MVP completion is implied. Run affected connected-runtime regressions and
full repository verification from the final clean candidate before certifying.

## References

- [Artifact contract](../contracts/artifacts.md)
- [A01 current native authority](0005-agent-work-session-and-attribution.md)
- [Protected result boundary](0008-protected-agent-result-submission.md)
- [R2 conditional writes and checksums](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [D1 atomic batch behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/)
