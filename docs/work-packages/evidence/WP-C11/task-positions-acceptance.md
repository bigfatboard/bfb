# C11 browser task child positions

Comments, dependencies, links and work-run browser pages now use canonical random
32-byte opaque positions, not record IDs. Raw continuation is retired without
fallback under ADR 0016; terminal pages return `next_cursor: null`. Context stays
unpaged. Current authority and original transport project ceilings remain
necessary; a position grants no access.

Tested production source: `70c8500525a2b0748a336f3b0b4e5360eed0207e`.
D1 head: `0048_task_collection_positions`. `bfb-wire/1` is unchanged; the four
browser continuation wires intentionally change.

## Finite proof

The additive `pnpm test:c11:task-positions` target, composed once by C11, passes
106 cases in six files: twenty new authenticated mounted cases, eight new local
SQLite migration cases and 78 retained route controls. Six independently
collecting native-D1 groups pass. Nested family loops, delay waves and assertions
are not extra acceptance cases.

Read-only Reviewers get useful rows in every family. Reuse and terminal reads
preserve state; malformed, raw, unknown and foreign handles share the bounded
cursor rejection. Parent denial precedes cursor validation. Mounted successes
and denials are private/no-store. The wrong-human fixture has equal canonical
project audiences. Task/family rejection is not claimed as single-column fault
isolation: current anchor membership also supplies a backstop.

Hash-only immutable metadata binds workspace/human/epoch, exact canonical
audience, task/project/family/limit/version and current anchor identity/rowid.
Database-clock capture ceilings and ten-minute expiry are inherited by
descendants. Same-epoch audience changes invalidate positions. Dependency access
is applied before visible-only lookahead; a production shared-task association
inserted after capture is excluded until a fresh root.

The real native batch guard reselects the complete bounded selection, including
a nonanchor delivered row and the actual lookahead. Changes roll back position
and ordinary Hub bookkeeping. Four post-Hub waves witness actual registered
success before independently revoking access: final denial preserves committed
position/history. No task/comment/progress/interaction action is created; Hub
interfaces and trusted dispatch branches are unchanged.

Instrumented reader/local native Hub statements use at most 24 bindings and
10,659 SQL bytes. Setup, snapshots and independent Worker-internal statements
are not included in those bounds. Migration preservation, immutable/hash grammar,
guard rollback and clean foreign keys pass. Canonical persisted state and captured
Hub inputs contain no plaintext position.

## Clean verification

The unchanged clean-checkout pipeline exits zero with
`C11_TASK_COLLECTION_POSITIONS_CLEAN_CERTIFICATE_OK`. Frozen installation,
before/after worktree checks and final empty status pass at the exact source SHA.

Exact C11 passes 3,307 stage-case invocations in 138 file invocations across
twenty-two Vitest blocks, not unique test/file totals. Six retained panel
Chromium cases and 230 native check labels across twenty-one harnesses are
separate. C10 has 86 cases/eight files/nine D1 checks; C08 has 23 cases/five files
and its D1 marker. The notification drill passes its identity/X01 markers and
Go race checks; its 41 setup/repeated labels are not independent cases.

Full `pnpm verify` passes 4,848 TypeScript cases in 223 files, Go and all sixteen
Swift cases without skipping selected platform checks. This does not claim new
standalone W03/V02/X03/A02/A04 acceptance.

See the [manifest](task-positions-manifest.json) and
[command result](task-positions-command-result.json).

## Boundaries and remaining work

Mounted tests use genuine synthetic sessions over local SQLite and production
routing; native D1 separately proves actual Hub/batch selection. Neither is
deployed ingress or compiled-browser presentation. Dormant privacy/read grants,
recorded work-run history and the FK-clean parent move are explicit fixtures,
not private activation, reachable task movement or provider execution.

Expired positions are already-expired typed historical fixtures, not natural
in-flight expiry. The native foreign-human/task rejection changes both inputs;
mounted cases separate them. Canonical snapshots retain all business/authority/
history tables, excluding engine metadata, migrations and separate abuse buckets.
No OLD security failure is claimed for this approved compatibility feature.
Exploratory missing-header, historical-clock and private-business-setup failures
were repaired before the committed clean certificate; their partial passes are
not acceptance evidence.

GitHub collision policy/history fencing, human artifact and operations natural
expiry, execution-owned delivery and destructive private retention remain open.
Private creation/sharing/inherited children/checkpoints stay disabled. C11 is
`in_progress`, C12 planned; other mandatory product features remain unfinished.
There is no installed-app, live-pilot, provider, remote-start/agent-to-agent,
deployment or external-CI claim.
