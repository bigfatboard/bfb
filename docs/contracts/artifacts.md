# Artifact storage (V01)

| Version | Date | Change |
| --- | --- | --- |
| 1 | 2026-09-17 | Freeze V01 state machine, client, and MCP seam. |
| 2 | 2026-09-18 | Retention purge records `retained` versions (finding 24). |
| 3 | 2026-10-06 | ADR 0010 connected online agent publication, exact consume identity, Hub recovery and audit. |

Consumers: V02 (views), V03 (review), X02 (CLI parity), A01 (run-scoped MCP tool).

Version 3 is the accepted contract for V01's active runtime integration, not
a certification claim. Historical v1 RPC fixtures and evidence stay intact;
the new native capability is a separate closed v6 protocol. See
[ADR 0010](../adr/0010-connected-artifact-publication.md) for the full authority
and retry contract.

## State machine

`uploading` → `available` | `uploading` → `failed` | `available` →
`retained`. No other transition exists; the D1 trigger
`artifact_versions_state_guarded` aborts anything else, and `available`
additionally requires a verified content hash and R2 key. Only `available`
versions may be viewed or reviewed. `uploading` rows hold no trusted bytes.
`failed` rows are terminal. `retained` rows are terminal purge records
written only by the X05 retention sweep after it deletes a per-run raw log
R2 object: the content hash, R2 key, and metadata stay intact while the
bytes are gone, so grants for a `retained` version reject like unknown
versions instead of reaching byte reads. Distinct logical versions may share
one content hash; v0.1 has no blob delete path by design. Identical bytes
published for another workspace, or for another log version, are stored as
separate objects under their own server-derived keys and finalize
independently — a repeat publication never conflicts and reveals nothing
about bytes held by another tenant. Only same-workspace review re-uploads of
identical bytes converge on one stored object.

## Roles, formats, limits

- `role: review` — human/AI review payloads, at most 5 MiB.
- `role: log` — compressed run log chunks, at most 1 MiB, zstd bytes only.
- `format` is separate from `role`: `markdown | mermaid | diff | svg | png |
  jpeg | html | log | json`. Declared format must match sniffed bytes
  (magic numbers, never extensions): `markdown/mermaid/diff` accept text;
  `log` accepts text/zstd/gzip; every other format accepts exactly its kind.

## Control routes (browser session + CSRF)

- `POST /api/v1/workspaces/:ws/artifacts`
  `{artifact_id?, run_id?, format, role, declared_size, expected_digest}` →
  `201 {artifact_id, version_id, state: uploading, format, role,
  declared_size, expected_digest, upload_grant: {grant_id, version_id,
  secret, expires_at}}`. In one hub batch this creates the artifact (unless
  `artifact_id` names an existing one with identical format/role/run), an
  `uploading` version, a one-time grant, and an audit row. Creation requires
  an owner/member at the current epoch; when `run_id` names a run, the author
  must hold project access to that run's project, otherwise the uniform
  rejection applies. Run-free artifacts need membership only.
- `POST .../artifacts/:version/grants` → `201 {grant_id, version_id,
  secret, expires_at}`. Recovery path for a consumed or expired grant on an
  `uploading` version; terminal versions are rejected. Current membership,
  role, epoch and project access are required again, not inherited from creation.
- `POST .../artifacts/:version/finalize` `{content_hash, size}` → `200
  {version_id, artifact_id, state: available, content_hash, r2_key,
  available_at}`. Requires a verified upload receipt with matching hash and
  size plus the shared object row and current author/project authority.

Every failure is a uniform `403 {error: request_rejected}` (oversized JSON
bodies included). The plaintext grant secret is returned exactly once, in the
creation/issuance response; D1, events, idempotency records, and rate keys
keep hashes only. CLI credentials are rejected on these routes
(`credential_confusion`); CLI parity is X02.

## Upload route (Artifact Worker, cookie-less)

`PUT /upload/:grantId` with `Authorization: Bearer <secret>`. Before reading
bytes the worker consumes the grant in one conditional D1 batch that rechecks
expiry, `uploading` state, current principal/role/epoch, project and run scope,
and any agent-origin authority. The successful request has a unique consumption
attempt identity; equal clock timestamps cannot select two winners. A racing or
replayed redemption aborts before body reads or R2 effects. Then it enforces exact size,
SHA-256, format/MIME, and role/kind, and writes R2 with a conditional create
(`onlyIf: etagDoesNotMatch: *`, verified `sha256`) against the version's own
server-derived key: an existing object under that same key is verified by
size and stored checksum, never overwritten. Both a conditional `null` return
and an existing-object error require verification. If a checksum is absent,
bounded rehash must match the same object version; custom metadata is not proof.
Review versions within one workspace can share a key; other workspaces and
per-version log objects cannot. The verified receipt is tied to the exact
successful consumption and canonical version-derived role/run/key/hash/size,
with conflict guards in the same D1 batch. It is recorded before the
`200 {version_id, artifact_id, content_hash,
size, r2_key, deduplicated}` response.

Content errors after redemption are `422 {error: upload_rejected, message:
size_mismatch | digest_mismatch | mime_mismatch | role_mismatch}`; the
version stays `uploading` and the client reissues a grant to retry. Bodies
past the global bound are `413 body_too_large`.

## R2 keys (server-derived; callers never select a key)

- Review: `workspaces/<workspace>/artifacts/sha256/<content-hash>`
- Log chunk: `workspaces/<workspace>/runs/<run>/logs/<version>.jsonl.zst`

The D1 object registry (`artifact_objects`) is keyed by `(workspace_id,
r2_key)`, not by content hash: the stored object identity is the
server-derived key inside its workspace. Finalization binds each version to
its own expected key, so a version can never finalize against another
version's or another workspace's bytes.

## Recovery

`artifact.mark_failed` (human member, or the system actor for Cron) moves an
`uploading` version to `failed` with an audit row. The control Cron (every 5
minutes) scans at most 50 candidates without mutation, then dispatches each
through the jurisdiction-scoped WorkspaceHub. Only the designated artifact
recovery system actor can perform automatic abandonment. The command uses
fresh Hub time: creation must be at least 20 minutes old (15-minute grant TTL
plus 5-minute grace), and every grant, including a consumed in-flight grant,
must have expired past that grace.
A regrant or finalization after the scan is rechecked before mutation.
Human explicit abandonment still requires current membership/project access.
Stored bytes are never deleted. Human retries use regrant or a new version;
bound-agent same-ID retries resolve the original logical operation below.

## Audit dispatch

Grant issuance/reissuance/consumption, verified uploads, finalization and
abandonment append metadata-only artifact-audit outbox rows. Cron selects at
most 100 owned rows and sends `artifact.dispatch_audit` through WorkspaceHub
with the designated recovery system actor. The original outbox ID identifies
one semantic event and audit projection; their insertion and the dispatched
stamp commit atomically. Duplicate dispatch, a lost reply or lost transient
idempotency cache cannot duplicate that projection.

The projection is exactly `schema_version, outbox_id, version_id, grant_id,
source_action, occurred_at`. Dispatch time is separate from source occurrence
time. Raw outbox payloads, file bytes, local paths and plaintext secrets are
not copied. View/review/retention audit actions remain owned by V02/V03/X05.

## Abuse budgets

Durable per-IP and per-subject budgets (20 attempts / 60 polls per 60 s
window) guard grant creation, issuance, upload attempts, and finalization,
and survive Worker-isolate changes through shared D1 counters. Subjects are
hashes of principals, versions, or grants. Uploads fail closed while
`UPLOAD_ABUSE_SECRET` (Artifact Worker) or `AUTH_ABUSE_SECRET` (control) is
missing or short; staging/production set the former with `wrangler secret
put UPLOAD_ABUSE_SECRET`, and local `wrangler dev` reads it from the
gitignored `apps/artifact-worker/.dev.vars`. No committed `wrangler.toml`
may inline a secret value.

## Historical human client (`internal/artifact`)

The following general v1 client/wire remains a historical human integration
surface, not native-run authority. It does not establish browser CSRF support
or the held X02 CLI-credential parity; never route bound agents through it.

`Client{ControlURL, ArtifactsURL, HTTP, Auth{Cookie, Bearer}}` with
`Create`, `Upload`, `Finalize`, `Publish`, `PublishFile`. `Prepare` bounds
reads and computes the digest the server re-verifies. Request bodies never
contain an R2 key. Typed `*Error` codes: `invalid_request`, `unauthorized`,
`request_rejected`, `too_large`, `upload_rejected` (server reason preserved),
`upload_conflict`, `unavailable`. CLI `bfb artifact publish` (file-based
credentials only) and daemon `artifact.publish` drive the same client; the
local-RPC payload keys are `control_url, artifacts_url, workspace_id,
artifact_id?, run_id?, artifact_format, artifact_role, artifact_path,
artifact_cookie?, artifact_bearer?` and the response is `{artifact_id,
version_id, content_hash, artifact_size, r2_key}` (see
`protocol/schema/v1/local-rpc.json` and its `v01-publish` fixtures).

## Connected local MCP and bound CLI

The current public `bfb_publish_artifact` input is closed: `request_id`,
relative `path`, `format`, `role`, and optional `artifact_id`. Scope, session,
run, endpoint, credentials, grant, hash and storage key are not caller inputs.
The trusted MCP transport or bound CLI constructs the unchanged
`AgentWorkRequest` and invokes the separately negotiated
`mcp.v6.publish_artifact` in `local-agent-artifact-rpc` schema version 6.
CLI uses `bfb artifact publish --request-id --file <relative> --format --role`
with optional `--artifact-id`; mixed legacy scope/credential/origin flags reject.

The daemon revalidates native ownership, L06 canonical provider session,
execution and lease against A01 before using an artifact directory pinned by
the persisted supervisor preparation's device/inode. Descriptor-relative
no-follow reads reject traversal, unsafe permissions/ownership, symlinks,
hard links, directory replacement, nonregular files and oversize bytes. One
bounded immutable in-memory snapshot supplies size, digest and upload bytes.
No file path or body enters metadata, audit or telemetry.

Fixed runner-authenticated actions `work/artifact-prepare` and
`work/artifact-finalize` accept the same `AgentArtifactRequest`. The canonical
operation key is `agentWorkKey("publish_artifact", reference)`, durably bound
to one version, exact metadata and immutable agent-run origin. Optional
`artifact_id` absence is preserved across all phases. Tokens and file paths
are not business identity; changed metadata/bytes conflict only after current
authority is checked. Submitted but still active runs are allowed; accepted,
failed, cancelled or ended scopes and revoked grants/keys are denied.

Prepare reads canonical state and returns `upload_required`,
`finalize_required` or `available`. Only upload-required carries an ephemeral
fresh grant and configured origin. Secrets never enter durable Hub outcomes.
Upload uses a fixed route on an exact HTTPS origin (explicit local-test
loopback HTTP only), with no redirects, cookies or forwarded runner credential.
Finalize requires verified bytes and current authority, and returns only the
closed `AgentArtifactResult`: schema version, operation/artifact/version IDs,
format, role, content hash, size, agent origin, available state/time.

No offline journal, spool, pending-sync permission, watcher or automatic replay
is added. An unavailable response may follow a committed network effect;
explicit retry with the same request ID recovers the original operation,
including after MCP/daemon restart. A new invocation securely reads its file
again. Current authority is rechecked before any private result is delivered.

The five closed documents are generated from `protocol/schema/v1/agent-artifact-*`
and `local-agent-artifact-rpc.json`; `pnpm protocol:generate` owns their bindings
and deterministic `protocol/fixtures/v6/local-agent-artifact-rpc.json` fixtures.
Local envelopes cap at 16 KiB, cloud metadata requests/prepare replies at 4 KiB,
final replies at 2 KiB. Artifact bytes use only the separate bounded upload route.

## Non-goals

View grants and byte serving (V02), review surfacing (V03), blob deletion or
retention (X05), CLI-credential auth on publication routes (X02), offline artifact
replay, provider/Terminal acceptance, and wider MVP certification.
