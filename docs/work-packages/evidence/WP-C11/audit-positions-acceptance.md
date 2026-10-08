# C11 security audit position checkpoint

Security-audit pagination now uses random positions instead of raw audit IDs.
Each position binds the current human, epoch, exact project audience, page size
and canonical cut. Hub issuance stores only its hash, checks the complete page
at commit, and repeats selection before returning the handle. Existing business
audit IDs, timestamps, insertion order and history remain unchanged.

C11 remains `in_progress`. Private creation, sharing and author-private
checkpoints stay disabled; C12 remains planned.

Tested source: `23c89306d5d7bff9691142413a380249c4e3f8da`.
Protocol: unchanged `bfb-wire/1`; security audit positions v1.
D1 head: `0047_security_audit_positions`.

## Position and delivery rules

Positions encode 32 cryptographically random bytes as canonical base64url.
Raw IDs, malformed, expired, foreign and unknown positions share one bounded
denial after current direct-human Owner admission. Current admission takes
priority even when the page is empty or its history is run-free. Projection
version and effective page limit cannot change within a chain.

The root captures the workspace audit-row insertion ceiling and a ten-minute
database-clock expiry. Every descendant inherits both exactly; reuse cannot
slide expiry or include a later backdated insertion. Exact current sorted
project audiences are bounded to 32 KiB. Same-epoch expansion or contraction
invalidates a genuine position. Canonical anchor ID, normalized chronological
key and rowid must still match.

The registered Owner command derives its cut server-side, rejects cached
issuance replay and returns only a safe boolean receipt. Plaintext handles do
not enter Hub requests, results, fingerprints, audit or idempotency storage.
Write-only D1 guards repeat the full bounded selection, including lookahead,
before immutable insertion. A final selection under the issued capture must
retain the actually delivered cut. Fresh expiry is checked synchronously after
the final await for replayed or issued positions. Terminal pages return a NULL
continuation; an issuer is required only for a page with more results.

The additive migration preserves historical audit rowids and payloads.
Workspace-composite keys retain tenant identity and global hash uniqueness.
Position metadata is immutable, without membership, epoch or source-anchor
foreign keys. Cleanup has a separate owner and cannot delete audit history.
Rebuilding audit rowids while positions are live is unsupported and fails closed.

## Clean verification

Exact `pnpm test:c11` passes 2,298 stage invocation cases in 80 file invocations.
The seven prior D1 harnesses retain 67 checks; the new audit-position harness
passes 12 actual-D1 checks. The notification Worker/D1/Queue/DLQ drill passes
separately. Its 41 structured labels include setup and repeated dispatch and
redaction, not 41 independent cases. C10 separately passes 86 cases and nine
D1 checks; C08 passes 23 cases and its Worker race proof.

The position target passes 18 domain, five database and 212 mounted audit
cases. Two independent request Workers issue positions through the registered
production Hub. Real-D1 cases prove fixed capture, inherited expiry, reusable
positions, uniform retained-expired/foreign denial, cross-isolate cached-retry
rejection and whole-selection rollback. Privatizing a non-anchor and lookahead
aborts even when the delivered cut is unchanged; a post-Hub changed cut returns
no handle. Maximum observed statements use 18 bindings and 33,807 SQL bytes.

Exact X01 passes 37 unit cases, Go race checks and the notification drill.
Exact X05 passes 60 unit cases, 11 runtime checks and five browser cases.
Full `pnpm verify` passes 4,422 TypeScript cases in 196 files, Go and all 16
Swift cases without skipping selected platform checks. G01 caller compilation
passes, not its runtime acceptance. Frozen install, before/after worktree
checks, unchanged source and empty final status pass. See the
[manifest](audit-positions-manifest.json) and
[command result](audit-positions-command-result.json).

Four meaningful old-source failures demonstrate raw-ID acceptance and missing
continuation positions through domain and mounted routes. Exploratory failures
from impossible append-only fixture edits are not security evidence. Those
fixtures were corrected, and the local structural gate led to tenant-composite
keys without relaxing global hash uniqueness. Every selected clean gate passes
at the committed source.

## Remaining activation gates

This checkpoint closes security-audit position v1, not broader event/realtime
availability or natural credential/lease expiry during an in-flight batch.
Current board UI workspace-selection races need a separate correction. GitHub
key existence policy, execution-owned consumers and destructive private
retention remain open. Private creation, sharing, checkpoints, publication,
project knowledge, skills, vault, reminders and contribution views remain
unfinished. No live pilot, provider, installed app or deployment was operated.
