# Artifact storage (V01)

| Version | Date | Change |
| --- | --- | --- |
| 1 | 2026-09-17 | Freeze V01 state machine, client, and MCP seam. |

Consumers: V02 (views), V03 (review), X02 (CLI parity), A01 (run-scoped MCP tool).

## State machine

`uploading` → `available` | `uploading` → `failed`. No other transition exists;
the D1 trigger `artifact_versions_state_guarded` aborts anything else, and
`available` additionally requires a verified content hash and R2 key. Only
`available` versions may be viewed or reviewed. `uploading` rows hold no
trusted bytes. `failed` rows are terminal. Distinct logical versions may share
one content hash; v0.1 has no blob delete path by design.

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
  `uploading` version, a one-time grant, and an audit row.
- `POST .../artifacts/:version/grants` → `201 {grant_id, version_id,
  secret, expires_at}`. Recovery path for a consumed or expired grant on an
  `uploading` version; terminal versions are rejected.
- `POST .../artifacts/:version/finalize` `{content_hash, size}` → `200
  {version_id, artifact_id, state: available, content_hash, r2_key,
  available_at}`. Requires a verified upload receipt with matching hash and
  size plus the shared object row.

Every failure is a uniform `403 {error: request_rejected}` (oversized JSON
bodies included). The plaintext grant secret is returned exactly once, in the
creation/issuance response; D1, events, idempotency records, and rate keys
keep hashes only. CLI credentials are rejected on these routes
(`credential_confusion`); CLI parity is X02.

## Upload route (Artifact Worker, cookie-less)

`PUT /upload/:grantId` with `Authorization: Bearer <secret>`. Before reading
bytes the worker consumes the grant in one conditional D1 batch that rechecks
expiry, `uploading` state, and the current authorization epoch; a racing or
replayed redemption aborts with no effect. Then it enforces exact size,
SHA-256, format/MIME, and role/kind, and writes R2 with a conditional create
(`onlyIf: etagDoesNotMatch: *`, verified `sha256`): an existing object is
verified by size and stored checksum, never overwritten. The verified receipt
is recorded before the `200 {version_id, artifact_id, content_hash, size,
r2_key, deduplicated}` response.

Content errors after redemption are `422 {error: upload_rejected, message:
size_mismatch | digest_mismatch | mime_mismatch | role_mismatch}`; the
version stays `uploading` and the client reissues a grant to retry. Bodies
past the global bound are `413 body_too_large`.

## R2 keys (server-derived; callers never select a key)

- Review: `workspaces/<workspace>/artifacts/sha256/<content-hash>`
- Log chunk: `workspaces/<workspace>/runs/<run>/logs/<version>.jsonl.zst`

## Recovery

`artifact.mark_failed` (human member, or the system actor for Cron) moves an
`uploading` version to `failed` with an audit row. The control Cron (every 5
minutes) runs the same sweep the harness calls `runArtifactSweep` for:
versions whose every grant expired past a 5-minute grace become `failed`.
Shared content-addressed bytes are never deleted. Retry always converges
through re-grant or a new version, never through overwriting.

## Abuse budgets

Durable per-IP and per-subject budgets (20 attempts / 60 polls per 60 s
window) guard grant creation, issuance, upload attempts, and finalization,
and survive Worker-isolate changes through shared D1 counters. Subjects are
hashes of principals, versions, or grants. Uploads fail closed while
`UPLOAD_ABUSE_SECRET` (Artifact Worker) or `AUTH_ABUSE_SECRET` (control) is
missing or short; staging/production set the former with `wrangler secret
put UPLOAD_ABUSE_SECRET`.

## Go publish client (`internal/artifact`)

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

## MCP seam for A01

`ToolName = "bfb_publish_artifact"`; `ToolDefinition()` returns the closed
input schema (`workspace_id, format, role, path` required; `artifact_id,
run_id` optional; no other fields); `Client.InvokePublish` runs the full
state machine and returns `{artifact_id, version_id, content_hash, size,
r2_key}`. A01 registers this tool on its run-scoped server and must scope
`path` to the calling run before delegating; the tool result never carries
the grant secret.

## Non-goals

View grants and byte serving (V02), review surfacing (V03), blob deletion or
retention (later package), CLI-credential auth on publication routes (X02),
run-scoped agent authority (A01 registers it against these same commands).
