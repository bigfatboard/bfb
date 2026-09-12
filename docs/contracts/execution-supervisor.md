# Local execution supervision v1

Owner: [L05](../work-packages/WP-L05-terminal-supervisor.md). Gate: `pnpm test:l05`.
Implementation and acceptance are in progress; this contract is not completion evidence.

## Boundaries and sequence

The existing runner command inbox feeds the local execution service. It durably
records each received command before acknowledging consumer acceptance; repeated
delivery continues the same local record. C09 remains the only owner of cloud
Start, claim, final authorization, lease and control state.

An interactive launch first claims its C09 assignment and cloud fence, checks the
immutable snapshot, exact L02 checkout and L03 provider identity, and persists a
fresh daemon-local UUID. Only that UUID is passed to the signed app's fixed
`bfb __launch <uuid>` command. A cloud wake ULID is never a Terminal intent. Wake
redemption tries only existing enrollment connections and merely triggers a pull.

The helper authenticates to the user-only daemon socket. The daemon derives its
UID/PID, executable and start identity from the operating system before consuming
the local intent or returning private execution data. A duplicate helper cannot
take over a consumed intent. A lost reply may be reconciled only with the same
registered process; a crash never authorizes a fresh automatic execution.

`execution.register` accepts only the local intent UUID. Its response-only
`local-execution-assignment` document contains the claimed binding, bounded
correlation value and verified supervisor identity, never local paths. A supplied
PID or extra field cannot choose the peer. Both ends verify the same hardened
Apple-signed helper build and signing team, including its code identity and current
executable fingerprint. The helper checks the daemon before transmitting its UUID,
then checks that the returned supervisor is itself. A different helper build, even
with the same signing identifier/team, must restart into a matching installation.
The native verifier uses Apple's [dynamic code validation](https://developer.apple.com/documentation/security/seccodecheckvalidity(_:_:_:))
before reading signing information; an unvalidated filesystem path is not process identity.

Local migration `004_execution_supervision.sql` separates the durable command
inbox, immutable assignment/intent identity, process observations and control-effect
dispositions. The command's original claim key survives redelivery. Issuing an
intent or offering it to Terminal is single-use under concurrent transactions;
unknown delivery cannot mint or offer another one. Native registration is committed
before returning the assignment. Database triggers prevent rebinding the execution
or clearing an already registered supervisor.

If the claim response is lost, the original persisted request can retrieve C09's
cleanup-only reconciliation binding even after lease/launch expiry. This cannot
create a local intent or replace final authorization. The daemon must consult its
durable intent/registration and native lock/process evidence before reporting an
unstarted release; absence of an HTTP reply alone is not proof that nothing started.

A registered helper reads the existing checkout registry through SQLite
[read-only mode](https://www.sqlite.org/uri.html), with schema checksum validation.
It does not run daemon startup migrations or reset process observations. WAL change
detection remains enabled. Its independent L03 probe must reproduce the claimed
installation-identity digest, covering executable/configuration fingerprints,
version, integration and manifest/capabilities. Fresh probe timestamps and the
helper's normal local environment are not durable identity or cloud credentials.

The helper acquires the Mac-wide physical-worktree lock and durable recovery
marker. With that fence held it repeats checkout, repository policy and provider
probe checks, obtains a new online C09 final authorization, and revalidates local
identity immediately before spawning explicit locally compiled argv. Local changes
cannot be grandfathered by an earlier cloud or provider check. A narrower repository
policy uses C09's replacement snapshot and a new final check; widening blocks.

## Process and terminal ownership

The foreground helper remains a BFB-owned supervisor. The provider runs in its own
process group in the exact registered root or project subdirectory. Interactive
stdio belongs to the Terminal PTY, never a transcript parser or simulated input.
The foreground handoff uses Go's Darwin process-spawn support, which keeps signals
blocked during the child group/TTY setup. Restoration checks the current foreground
group and blocks `SIGTTOU` around `tcsetpgrp`; it must not steal a terminal now owned
by a different group. See the [Go Darwin spawn implementation](https://go.dev/src/syscall/exec_libc2.go)
and [Apple's terminal foreground contract](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/tcsetpgrp.3.html).

Process identity includes kernel PID/start time, user and group identity; executable
identity is verified separately for the trusted helper/provider. The supervisor
remembers observed descendants and checks their identity and group membership.
Remote signals and escalation require a fresh matching owned group; terminal Ctrl-C
is a separate kernel job-control path. An ambiguous PID is never signalled.
The supervisor retains its direct child unreaped until the owned group is gone;
even a zombie leader reserves its PID against reuse. Signals and final reaping are
serialized by the owning supervisor, not raced from an unrelated daemon process.

Parent exit does not end ownership while any owned child remains. Every 15 seconds
of verified group presence creates a local process-heartbeat observation, not an
agent-working interval. The local event sink preserves typed provenance for L06;
C09 lease renewal uses only freshly verified supervisor, group and lock evidence.
Closing the app or losing the daemon/cloud connection cannot release the local lock.

## Persistence and recovery

The local execution assignment and its random correlation capability are private,
authenticated and bound to workspace/project/task/run/execution/generation. The
provider receives only scoped `BFB_*` correlation and artifact-location values plus
its validated normal local environment. No task text, runner credential or MCP
mutation capability is added. The run artifact directory is outside the checkout.

The physical-worktree lock has a stable inode. Its durable recovery marker survives
supervisor or daemon crash. An escaped observed descendant, unverifiable identity,
incomplete inspection or unknown delivery becomes persistent `containment_unknown`.
TTL, a cloud release hint, result state and a new enrollment cannot override it.

All enrollments use the same private lock directory under this user's daemon state.
The filename is derived from the L02 physical-worktree digest, not checkout spelling,
runner identity or the cloud fence. A no-follow descriptor owns the stable `flock`
inode; a separately atomically replaced HMAC record binds the local lock ID,
execution, assignment/fencing generations, supervisor identity and bounded observed
process history. Writes sync the file and directory. Missing, corrupt, public,
hard-linked, symlinked or semantically invalid evidence cannot become a free lock.
Closing a descriptor without a verified release leaves the marker intact. An
incomplete process history cannot prove absence by forgetting the missing identities.

The provider-start path must gate execution until the new group leader is durably
recorded. A fixed BFB child can wait on a private inherited pipe before its provider
`exec`; EOF or an expired grant forbids that exec. A crash between process creation
and registration therefore cannot leave an unrecorded executing provider. This gate
is still an integration requirement; the lock primitive alone does not certify it.

Only an explicit local recovery operation may inspect and clear unknown containment.
It must prove the owned/observed processes are gone and no live lock holder remains;
missing or ambiguous evidence blocks. Recovery does not kill unknown processes.
Verified ordinary group end releases the local lock, closes event creation after a
bounded final-hook grace period and queues the corresponding C09 release proof.
Captured events and historical assignments remain available for later replay.

## Controls and failures

Cloud controls are pulled, read and claimed using their strict C09 bindings. Before
any delayed local effect, the service reauthorizes online and verifies the original
execution/generation and current native identity. Local deduplication preserves one
effective focus/signal/cancel disposition. If a crash makes an effect ambiguous,
report/reconcile that ambiguity instead of blindly repeating it. Focus must target
the existing owned Terminal; resume uses C09's exact observed session and new
independently claimed execution rather than starting another writer in a live one.

Expired/cancelled/revoked launches, unavailable sessions, consent denial, stale
snapshots, changed providers and occupied/moved checkouts fail with bounded typed
diagnostics. They do not submit or accept a run result. Unknown Terminal delivery
retains the local intent for inspection and never repeats a speculative open.

## Acceptance ownership

The synthetic suite must prove real PTY foreground handoff/restoration, Ctrl-C,
Terminal close, owned-child survival, escape, PID-reuse negatives, lock contention,
durable recovery, 15-second heartbeat provenance and pre-exec identity/config swaps.
Protocol fixtures must reject cloud shell/path/argv fields, confused wake/local IDs,
wrong process/generation and malformed local assignment data.

`pnpm supervisor:fixtures` owns the `*.l05-*.json` fixture subset and its matrix
entries; `pnpm protocol:generate` owns generated codecs. Test-only installation,
clock and transport boundaries are compiled harness dependencies, not remotely
selectable configuration. Real Claude/Codex adapters, hook ingestion, MCP business
authority and browser Start UI remain with their owning packages.

`node tools/supervisor/helper-peer.mjs` exercises actual signed Unix-socket peers:
mutual exact-build verification, registration-before-reply, same-process reply
reconciliation, rejection of a second helper and alternate build/identifier/
entitlement/ad-hoc signatures. It is a registration proof, not Terminal execution
or provider-start acceptance. Its synthetic controls are absent from the production CLI.
