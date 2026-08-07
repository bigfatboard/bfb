# WP-V01 — Artifact storage state machine

Status: `planned`

Risk: Very high

## Outcome

An authorized human or run-scoped agent can publish bounded immutable artifact bytes to private R2 through a recoverable grant/upload/finalize state machine.

## Dependencies

- **Requires:** A01, C01, C04, F03.
- **Unlocks:** V02, X02, X03, X05.
- **Can run with:** A02/A03 after shared migrations are sequenced.

## Scope

- Add artifact, immutable version, hashed upload grant, and audit/recovery tables.
- Support format and semantic role as separate fields.
- In one hub batch create an `uploading` version plus one-time grant bound to principal/grant, epoch, workspace, run, version, format, size, digest, and expiry.
- Before reading bytes, atomically recheck epoch/state, consume grant, and insert durable audit outbox.
- Stream/bound uploads to 5 MiB review artifacts and 1 MiB compressed log chunks.
- Validate declared format/detected MIME, compute SHA-256, and derive workspace-prefixed content-addressed R2 key.
- Use conditional create; verify existing-object size/checksum rather than overwrite.
- Finalize through the hub to `available`; only available versions can be consumed.
- Mark abandoned rows failed without physically deleting shared artifact hash objects in v0.1.
- Add MCP/CLI/daemon typed create → upload → finalize client; caller never selects an R2 key.
- Apply C01's durable abuse controls, bounded bodies, and uniform failures to upload-grant creation/redemption and upload attempts without storing raw grants, artifact bytes, or caller-supplied digests in rate keys/logs.

## Non-goals

- Viewer/renderers/reviews, multipart uploads, presigned large upload, dependency builds, or physical artifact-blob garbage collection.

## Work plan

1. Add metadata/grant migrations and hub creation/finalization commands.
2. Implement conditional grant consumption and bounded Artifact Worker upload.
3. Implement R2 conditional/deduplicated handling and recovery Cron state.
4. Fault-inject every D1/R2 boundary, replay, revocation, cross-isolate abuse, size/MIME/digest error, and same-hash race.

## Acceptance

- Replay/expiry/revocation/wrong principal/workspace/run/MIME/size/digest never yields an available version.
- Failure at every D1/R2 step leaves recoverable non-viewable state.
- Same-hash concurrent publication never overwrites bytes and may back distinct logical versions.
- Only available versions can be referenced downstream.
- R2 keys are derived server-side and remain workspace-prefixed.
- Raw upload secrets exist only once and are never logged/stored plaintext.
- Upload-grant budgets survive Worker-isolate changes; oversized/exhausted requests fail before artifact availability and expose no raw grant or bytes.

## Evidence and handoff

- Commit state-machine tests, fault matrix, R2 metadata fixtures, and publish-client trace.
- V02 receives version/hash metadata and bytes only through the Artifact Worker.

## Risks and decisions

- Content addressing is not object-store immutability. Conditional writes and no v0.1 delete path are deliberate.
