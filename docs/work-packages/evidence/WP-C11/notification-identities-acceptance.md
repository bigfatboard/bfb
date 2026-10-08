# C11 notification identity checkpoint

Recipient notifications now use stored random identities instead of internal
source-derived keys. Browser history and push payloads omit raw event positions;
native pull keeps its v1 envelope and acknowledges only public identities.
Existing internal keys, dispatch ordering, inbox references and delivery history
remain intact. C11 stays `in_progress`; private creation, sharing and
author-private checkpoints remain disabled, and C12 remains planned.

Tested source: `4f156f5b5520671b9876d12e73d19c01c9556df1`.
Protocol: unchanged `bfb-wire/1`. D1 head: `0046_notification_public_identities`.

## Identity and legacy repair

Each public identity encodes 128 cryptographically random bits without a
timestamp, cursor, recipient or epoch input. D1 enforces global uniqueness and
immutable workspace, internal key, source, channel and recipient bindings.
It remains an object identity, not a bearer capability. A logical fan-out
conflict retains its winning row; an alias collision fails explicitly.

The additive migration leaves legacy identities NULL without rewriting state,
attempts, errors, timestamps or inbox acknowledgements. A registered system-only
Hub command assigns them in bounded batches with sorted retry fingerprints and
count-only receipts. Cron resumes every historical state; authorized history
and native pages repair missing identities, then repeat the original retained
authority selection. They neither omit old rows nor fall back to derived IDs.
Push contact retains its post-signing authority, alias and endpoint checks.

The maintenance cases cover 500 rows, bounded parameters and 101-row Cron
resume. Real Worker/D1 proof preserves five historical states and an acknowledged
inbox, serializes independent Worker requests through one production Hub,
retains the winning aliases on retry, rejects unauthorized cache access and
resumes remaining NULL rows. Assigned identities cannot be changed.

Old derived native IDs acknowledge zero, like unknown or foreign IDs, and the
same unacknowledged inbox can be repulled with its new alias. The native decoder
now accepts the complete production workspace/runner tuple and rejects malformed
or duplicate batches before any offer. Fixed bridge copy and transient retry
semantics remain unchanged.

## Clean verification

Exact `pnpm test:c11` passes 2,044 invocation cases in 76 files. Its seven earlier
D1 harnesses retain 67 checks, and the notification Worker/D1/Queue/DLQ drill
passes separately. That drill emits 41 record labels, including repeated
dispatch/redaction and setup, not 41 independent acceptance cases. C10 separately
passes 86 cases and nine D1 checks; C08 passes 23 cases and its Worker race proof.

Exact X01 passes 37 unit cases, native bridge/runner race checks and the full
notification drill. Exact X05 passes 60 unit cases, 11 runtime checks and all
five browser cases, retaining supported operator history and counts.
Full `pnpm verify` passes 4,380 TypeScript cases in 194 files, Go and all 16
Swift cases without skipping selected platform checks. G01 caller compilation
passes; its runtime acceptance is not certified here. Frozen install,
before/after worktree checks, unchanged source and empty final status pass.
See the [manifest](notification-identities-manifest.json) and
[command result](notification-identities-command-result.json).

The old-source baseline has three meaningful domain failures and one control;
both selected mounted cases fail. Five native leaf failures expose envelope,
batch and trailing-JSON defects. Old tuple denials alone were not independent
proof because the old decoder rejected the new fields. Final fixtures use the
production envelope. Exploratory fixture failures are not security evidence.

The first clean attempt caught a stale final-migration assumption in C10.
The second passed all product/platform gates but caught a stale G01 push-builder
caller. Both fixtures were repaired without removing their substantive controls;
every selected gate passes at the final committed source.

## Activation and cutover limits

Deployment must retire old producers and prove complete NULL backfill before
claiming cutover. Old displayed native notices may duplicate once under a new
identity, and already sent push payloads cannot be recalled. This checkpoint
does not operate the installed app, provider or pilot, enable private delivery,
or certify live private artifact bytes.

Security-audit opaque anchors are next. GitHub key collisions, execution-owned
delivery and cleanup, destructive private retention and natural in-flight
credential/lease expiry remain barriers. Private creation/sharing/checkpoints,
publication and the other mandatory product features are still unfinished.
