# Local execution supervision v1

Owner: [L05](../work-packages/WP-L05-terminal-supervisor.md). Gate: `pnpm test:l05`.
Certified 18 September; bounded evidence is committed under `../work-packages/evidence/WP-L05/`.

## Native acceptance harness

`node tools/supervisor/native-execution.mjs` builds an isolated development-signed
Debug app with a compiled test helper. That helper calls the same `RunHelper`,
`RunExecChild`, service, signed socket, process inspection, event sink, lease and
control implementations as production. Only provider installation and the strict
synthetic C09 transport are replaced; native helper/app identities are never
overridden. No synthetic installation is exposed by the production CLI.

The separately compiled fake provider records actual kernel, cwd, Git, argv and
scoped-environment facts in its private artifact directory outside the checkout.
Its child/escape faults are bounded and driven only by its local test controller.
The tests retain a surviving child's lock and heartbeat after parent death and
exercise signed local recovery only after helper, descendant and lock absence.
An internally consistent stale PID/start record also checks that fresh kernel
inspection refuses a signal to a live process with another identity; it does not
force the operating system to recycle a PID.

`--pty-diagnostic` runs the signed chain through a native PTY without opening the
app or controlling Terminal. It explicitly cannot satisfy Terminal acceptance.
The real Terminal mode requires an available GUI session. Its native
open/focus/control delivery passed the complete clean-checkout `test:l05`
gate: real `focus_existing`, human-like Ctrl-C with exactly one SIGINT, and
provider-only window close with verified whole-group release. Honest limits:
a same-group survivor cannot outlive a real close (retention stays covered
by the child and escape scenarios); the synthetic `--require-focus` routing
section is not invoked by any gate; a cold start beyond the scripting-readiness
poll fails safe; one shutdown-observation race in five full gates captured
same-instant uncertainty and wedged its release past the release wait,
failing closed with the lock retained. Private synthetic execution files
and complete command logs stay local; committed evidence must contain bounded
redacted assertions, not environment values, correlation capabilities or paths.

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
The production entry point wires the launch and run-control consumers to the same
execution service, the service to the runner manager's bound connections, and
Terminal delivery to the signed-app bridge. The hidden `__launch` and `__exec`
commands share the daemon's compiled provider registry and accept one local UUID,
never an invocation or descriptor-number arguments.

Wake redemption permits one in-flight batch of at most sixteen existing,
credentialed enrollment connections under a five-second deadline. It rejects
replay, malformed or ambiguous receipts, wrong runner binding and observed
revocation uniformly. A single bound success only reconnects that runner to pull
its durable queue; it does not accept the returned launch ID as a command, create
an assignment, open Terminal, or persist the raw wake hint. Offline delivery still
relies on L08's ordinary reconnect/pull lifecycle.

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

Local migration `005_launch_cleanup.sql` adds a distinct immutable cleanup ID,
initially absent for existing and newly accepted commands. Beginning unstarted
cleanup atomically pins that ID and blocks any unregistered intent. The same
transaction excludes a racing registration, and a database trigger prevents
later intent issuance. The ID labels cleanup-only absence evidence; it does not
create a physical lock or replace a registered supervisor's actual lock identity.
Confirmed completion cannot reopen through redelivery or a queue retry.

The launch consumer acknowledges only durable acceptance. Four bounded workers
process the recovered queue independently of the runner channel, with per-command
backoff from five seconds to one minute. They reuse the original claim request and
never claim or offer a previously offered/registered intent again. Shutdown cancels
and joins those workers before closing private assignment files. Registered
executions remain owned by native lifecycle observation, not by the unstarted
cleanup path. Missing provider adapters/installations fail closed; the fake provider
is available only through a compiled synthetic-harness installation boundary.

After that transaction, registration atomically publishes the strict assignment in
the user-private `execution-records` directory, authenticated over both its bytes
and local-intent filename. Publication is immutable and serialized by a stable
per-record lock with a bounded wait. The same registered process can finish a
missing publication after a failed write; it cannot overwrite conflicting or
corrupt evidence. The helper independently verifies that the authenticated file
equals the socket reply. Read-only access never initializes directories, keys or
lock files and never opens the daemon database. Retained assignments are historical
correlation evidence: reading one after the launch deadline grants no new execution
authority, and registration still rejects that deadline.

If the claim response is lost, the original persisted request can retrieve C09's
cleanup-only reconciliation binding even after lease/launch expiry. This cannot
create a local intent or replace final authorization. The daemon must consult its
durable intent/registration and native lock/process evidence before reporting an
unstarted release; absence of an HTTP reply alone is not proof that nothing started.

A terminal `never_acquired` receipt settles a locally unissued command without a
lease write. An unstarted reserved launch requires the durable local cleanup barrier,
a bound reconciliation receipt, rejection of the unstarted cloud launch and a fresh
never-started lease observation. Completion then requires another bound receipt;
neither an HTTP success nor a lost release acknowledgement suffices. Live or unknown
containment, conflicting bindings, or any registered local supervisor block this
path. A lost release reply is reconciled with the same cleanup ID after restart.

A registered helper reads the existing checkout registry through SQLite
[read-only mode](https://www.sqlite.org/uri.html), with schema checksum validation.
It does not run daemon startup migrations or reset process observations. WAL change
detection remains enabled. Its independent L03 probe must reproduce the claimed
installation-identity digest, covering executable/configuration fingerprints,
version, integration and manifest/capabilities. Fresh probe timestamps and the
helper's normal local environment are not durable identity or cloud credentials.

The daemon freezes local executable/configuration locations and the sealed probe's
source fingerprint in an authenticated preparation record before offering the
intent. The independent helper checks that fingerprint before executing even a
version/health probe, then compares full installation identity, observed version
and manifest with the claim. Preparation serializes no argv or environment. It
removes inherited `BFB_*` values and later adds only the nine scoped execution,
correlation and artifact-location variables listed in the architecture.

Artifacts live in private `run-artifacts/<execution-id>` directories below daemon
state. Native ancestor identity checks reject state inside the registered Git
root, including case aliases and symlinks, before creating output directories.
Preparation pins the artifact device/inode; missing, replaced, symlinked or public
directories block and are not recreated by a retry. The helper repeats this
inspection before execution. Artifact output contains no assignment authentication
key and is not a metadata storage or invocation-authority surface.

An issued but unoffered intent may continue after restart only if its authenticated
preparation still exists and its original sources pass a non-executing fingerprint
check before probing. A missing preparation is blocked, not reconstructed from a
new installation. Execution preflight returns freshly observed Git branch, HEAD,
dirty state and observation time without rewriting checkout registration.

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

Provider startup additionally requires the prepared native executable to be the
owned child's running image. Darwin dynamic code validity is checked before
reading its executable URL, with process identity and authenticated source
fingerprints checked around repeated native queries. A waiting signed BFB wrapper,
pipe EOF or provider output cannot establish this fact. This provider check does
not relax the separate exact-build Apple-signature requirement for BFB helpers.
Interpreted launchers do not pass merely because their script exists; their
provider-specific identity contract belongs to L07/P01 certification.

Historical source verification reads only existing files and never reprobes a
running installation or extends the 30-second launch probe. Apple documents that
[signing-information queries](https://developer.apple.com/documentation/security/seccodecopysigninginformation(_:_:_:))
alone do not validate code; dynamic validity must first match the running code to
its on-disk signing information. Native regression tests keep an old image running
while replacing its pathname and require rejection of the replacement identity.

Parent exit does not end ownership while any owned child remains. Every 15 seconds
of verified group presence creates a local process-heartbeat observation, not an
agent-working interval. The local event sink preserves typed provenance for L06;
C09 lease renewal uses only freshly verified supervisor, group and lock evidence.
Closing the app or losing the daemon/cloud connection cannot release the local lock.

Local migration `006_execution_observations.sql` adds immutable first-provider-image
and whole-group-absence observation times, independent of pending event retention.
The local sink atomically assigns an event ID and execution-local sequence, captures
the strict `local-execution-observation` document and advances its checkpoint. The
sequence is not L06's enrollment upload-stream sequence. Only the daemon's local
inspection path can supply these facts; no RPC accepts them. Capture and checkpoint
roll back together on failure. The sink holds at most 8,192 observations and refuses
new rows when full without deleting accepted records or affecting the native fence.

An observed BFB wrapper does not attach an agent or create a process heartbeat.
First native provider-image observation creates `execution_attached`; subsequent
verified group presence creates at most one heartbeat per 15 seconds, using the
actual observation time. Restart or delayed inspection does not backfill a missing
interval. `provider_start: unobserved` describes missing startup evidence, not proof
that the provider never executed. No process event reports working time or a result.
Unknown containment creates a bounded `execution_detached` fact and stays sticky;
subsequent absence can close event creation but cannot clear the occupancy marker.

Verified group absence creates one `execution_ended` observation and fixes a
15-second final-hook grace deadline. Repeated capture cannot extend that deadline,
and no new process heartbeat follows absence. Grace expiry transitions an ordinary
local `ending` record to `ended` without another event or a run-result mutation.
The window boundary alone is not hook or upload authorization. A hook may arrive
before the daemon observes the provider image; L06 must still validate its immutable
assignment and correlation. A never-started launch requires the durable cleanup
barrier and has no provider hook window. Reading pending observations does not
acknowledge import, delete rows or supply fresh C09 lease evidence. L06 owns durable
import, upload-stream sequencing and explicit delivery dispositions.

The daemon's one-second native inspection loop is independent of launch retry
workers and network I/O. It reads existing authenticated lock state without
creating or repairing it, checks the registered signed helper and kernel process
table, and repeats those checks after provider-image inspection. A helper still
preparing its child is waiting; its bounded preflight probes are not provider
descendants. A historical startup checkpoint permits later whole-group heartbeats
without executing another probe or requiring the original provider parent to live.

Local migration `007_native_inspection.sql` retains up to 256 observed process
identities per execution in a separate bounded daemon history. Inspection merges
that history with the helper's authenticated marker before and after native reads.
It commits newly observed descendants and sticky uncertainty before attempting an
event insert, so event capacity or a restart cannot discard a known escaped child.
Overflow retains incomplete history and blocks recovery; conflicting PID identities
never replace previously observed ownership. Final authorization rejects uncertain
history even when no detached event could be captured. The daemon never races the
helper by writing its live lock marker, signalling its group or reaping its child.

Explicit local recovery serializes with daemon inspection, merges both process
histories, and requires a free native lock and actual process absence. An already
released helper marker cannot bypass a daemon-observed descendant. The recovered
authenticated marker retains the merged history and explicit-local flag; neither
event import nor ordinary observation clears uncertainty. A pinned execution also
receives a fresh release-history fingerprint during this operation, including when
its observer and lease workers have already settled. Missing or changed proof
still fails closed; recovery does not fabricate process events or clear historical
uncertainty.

The local `bfb execution recover <intent-uuid>` command calls `execution.recover`
through the private socket. Both ends require the same signed helper build before
transmitting or acting on the target. The caller is a new matching helper, not the
ended execution owner. The strict request contains only the local intent UUID and
the response contains no execution data. It cannot accept a cloud ID, supplied PID,
group, path, signal, force option or replacement assignment. A failed absence check
leaves occupancy intact. No runner command invokes this recovery operation.

Four independent lease workers inspect registered executions on a
15-second cadence, separately from launch workers and the local event sink. Each
attempt reconciles the original winning claim before fresh native inspection and
commits a lease sequence greater than both its local counter and C09's receipt
before sending. Lease request bodies are not persisted or replayed. A lost reply
requires another reconciliation and a newly timed observation. Slow inspection,
clock reversal or facts older than five seconds cannot become a lease request.
This cadence is not a guarantee of connectivity; delayed/failed requests never
extend authority locally or turn expired cloud TTL into release permission.

A waiting wrapper cannot renew or attach provider work. The first renewal also
requires durable native startup capture, including when lease inspection is the
only check that sees the provider image before its parent exits. An existing
startup checkpoint permits fresh verified child-only renewals after restart.
Normal group end while
the helper restores foreground and exits is retried without poisoning containment.
Native uncertainty retains the original supervisor/lock/group identity and cannot
be cleared by a later good heartbeat. A recovered marker may release cloud
containment only when it covers every daemon-retained descendant and fresh native
inspection proves the helper, whole group and lock are gone.

Before a release request, bounded native history retains the first verified local
release time. This historical checkpoint never supplies fresh lease authority.
Fresh native release also fingerprints the complete retained group history.
Newly recorded descendants or containment uncertainty do not inherit that proof;
exact-session resume requires a matching fingerprint plus fresh kernel absence.
An older record without the fingerprint cannot authorize resume. Only a fresh
verified release/recovery inspection can certify the enlarged history, without
erasing its historical uncertainty.
It permits local settlement after a strict bound `released` or `superseded` cloud
receipt plus fresh absence of all original native identities, even if a new
execution has replaced the physical marker after a lost release reply. Settlement
neither reads nor changes the successor's marker, lease or processes. HTTP success
alone cannot complete delivery; process-end capture must also commit before the
original local command is complete. Event-capacity failure cannot prevent fresh
cloud release but leaves local delivery pending until its end fact can be retained.
Registered pre-spawn failure can end without inventing provider startup. Incomplete
spawn history still blocks recovery.

A registered helper that never pinned its local lock has a distinct cleanup path.
The daemon commits `PinOwnership` before sending any final online authorization;
the helper cannot spawn a provider child before that authorization. After bound
reconciliation and native helper absence, cleanup atomically blocks future pinning
and preserves the supervisor identity. Native absence is checked again after the
transaction. A separate preflight-stop checkpoint records this closed-gate proof,
not physical-marker release. Started/live or cloud-unknown receipts contradict
this phase and cannot become automatic release authority.

The fresh cleanup observation reports the original supervisor gone, no provider
group ever started, and that supervisor's lock descriptor gone. It uses the durable
cleanup-only ID without pinning it as physical ownership. No physical marker is
read, initialized, cleared or replaced: a helper may have acquired and abandoned a
reserved marker before pinning, and another enrollment may hold the physical lock.
The original helper's absence and closed spawn gate prove its descriptor is gone;
they do not declare another owner's lock free. Canonical cloud settlement and
native process-end capture still precede local command completion, and retries
must use fresh native evidence even when the preflight checkpoint already exists.

An abandoned preflight marker continues blocking native acquisition after cloud
release. Only explicit local recovery may open the existing authenticated marker
and fence, verify the original binding and supervisor, require no recorded or
pending spawn, and prove native owner absence plus a free flock before marking it
recovered. Recovery never adopts the marker's ID into the blocked assignment or
reopens its final-authorization gate. Missing, conflicting, corrupted or held
physical evidence cannot be repaired into release by this operation.

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

The provider-start gate uses a fixed BFB child and two private inherited pipes, not
an invocation supplied by the cloud or pipe writer. The child checks its signed,
registered kernel parent, independently loads the assignment and local preparation,
and compiles its provider plan. The parent records the wrapper's native identity in
the durable lock even while preparation is pending. Provider containment observations
start after bounded version/health probes have ended, so these separately grouped
inspection processes do not masquerade as escaped provider descendants.

Before creating that child, the parent repeats its own signed build/fingerprint
check and durably marks spawning as pending. Successful native PID/start/group
recording clears this marker; only a proven `Start` failure can cancel it without
a child identity. A crash between spawn and registration therefore cannot turn an
incomplete reservation into a never-started recovery. Unrecorded process history
continues to block recovery, even after the known parent exits.

The helper lifetime loop observes without reading provider input or waiting on
cloud connectivity. Local helper shutdown uses verified `SIGTERM`, followed by
verified `SIGKILL` after five seconds if the owned group remains alive. It never
signals ambiguous containment. An observed escape retains the live fence while
the helper remains active; shutdown may abandon the descriptor but leaves its
durable marker intact. Proven whole-group absence permits final reaping and
non-stealing foreground restoration, not automatic clearance of an unknown marker.
Foreground restoration precedes reaping while the original PID is still reserved.
A disappeared terminal cannot skip lock disposition or final reaping.

The fixed child receives only its local UUID and the standard local `--data-dir`
option generated from the parent's private daemon configuration. This direct
local argv is not a Terminal shell string and never contains a cloud-selected path,
provider invocation or checkout. The Terminal command remains the fixed helper
path and `__launch <uuid>`.

Before opening the gate, the parent requires durable daemon group registration,
fresh local checks and another online final authorization using the original
supervisor/lock identity. The strict single-frame pipe permit binds the child's
native identity, intent, random readiness nonce and lock ID. It expires within five
seconds and never beyond the launch deadline. EOF, cancellation, malformed or
duplicate fields and a dead/different parent forbid execution. Inherited pipes use
nonblocking descriptors so their [Go read/write deadlines](https://pkg.go.dev/os#NewFile)
remain effective; the preparation wait is bounded to 30 seconds.

The fixed helper callbacks use `execution.authorize` with only the local intent
and lock ID, and `execution.group` with those IDs plus the native group ID. The
daemon derives the C09 final request from the stored assignment; no supplied
supervisor, snapshot, provider plan or invocation can replace it. Every request
authenticates the registered signed peer and reads the existing authenticated
worktree marker with a live native lock holder. Group registration also verifies
the exact signed direct child and durably commits its PID/start/group identity
before replying. Duplicate registration preserves the original group.

Before its first online request, the daemon pins the lock ID locally so that a
lost response retains C09's possible cleanup binding. Every authorization attempt
uses the current enrollment connection and a new bounded request, never a cached
grant. Both daemon and helper require a strict successful C09 response for the
exact launch/execution/generation within a five-second round trip, with at most
five seconds of timestamp disagreement. Larger clock disagreement blocks rather
than extending authority. The daemon rechecks native ownership and the unchanged
final-request binding after network I/O. It does not send signals or reap children.

The child verifies the authenticated lock record and live native lock holder,
rechecks checkout/artifacts, pins the exact registered directory for `fchdir`, and
revalidates executable/configuration sources without starting a new probe process.
It closes private descriptors and replaces itself with explicit locally compiled
argv. Interactive stdin remains the PTY; the fake adapter supplies only the fixed
initial instruction through its native prompt argument. A resume specification
uses the separately certified L03 resume planner and cannot fall through to a
fresh session.

Native PTY tests exercise this gate, including supervisor loss before permission
with a retained ownership record and absent exec canary. CLI/daemon lifecycle and
real Terminal acceptance remain in progress; these tests do not certify L05 alone.

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

Local migration `008_run_control_delivery.sql` pins the control's original claim,
execution/generation, action and expiry, with a write-once resumed-launch ID and
effect-start timestamp. Recording metadata leaves it `prepared`; a cloud read or
claim cannot label a local action applied. Delivery commits `applying` before the
effect owner receives it. Concurrent deliveries have one winner. Applied, rejected
and uncertain effects cannot reopen, and terminal cloud receipts close the inbox
without overwriting local effect evidence or changing native containment.

A launch cancelled before local assignment creation can still have a queued
control reference. A terminal bound cloud receipt closes that inbox record
transactionally without creating an assignment, effect or observation. It cannot
hide an existing effect by changing the target to an absent assignment. An expired
non-resume control may use its original claim only to obtain a terminal receipt;
a nonterminal response is not completion or permission for any native action.
Missing resume sources never use that cleanup path, because clock skew must not
turn expiry reconciliation into child-launch creation.

The control inbox has four workers independent of launch preparation, with a
one-second retry backoff so a prepared control cannot delay a later result for a
minute. It reads bound metadata and acknowledges recorded local outcomes, never
signals directly. The signed helper claims signal delivery; the focus worker
performs a fresh claim before sending its guarded app action. Resume dispatch claims its single child only after native
source-absence checks, as described below.
An acknowledgement does not reclaim the effect: after termination, a new claim
could reject the already-ended target before its valid acknowledgement arrives.
Lost cloud acknowledgements are reconciled against a fresh bound read, retaining
the original claim and local outcome. Restart marks in-flight native effects
`delivery_unknown`; the queue also does so after ten seconds without a helper
result. A late reply cannot erase that uncertainty. This timeout does not extend
the five-second freshness limit for an actual effect.

`execution.control` accepts only the local intent UUID and authenticates the
original signed helper before reading its assignment. Native inspection must
verify the original supervisor, live owned group, held local lock and complete
contained descendant history. A pending signal control obtains a fresh bounded
C09 claim through its original enrollment and repeats native checks after the
network response. The original launch deadline is not runtime-control authority;
the new control's own expiry applies. An ended parent with live owned children
remains controllable without mistaking the provider for the old BFB exec wrapper.

Delivery returns only the response-only `local-execution-control` document:
local intent, control/execution IDs, generation, interrupt/terminate/cancel action,
authorization time and expiry. No PID, group, signal number or invocation crosses
this boundary. The helper checks exact binding and a five-second round trip,
then submits the request to its single native lifetime loop. Freshness is checked
again after native inspection, immediately before `killpg`. Interrupt sends one
verified `SIGINT`. Terminate/cancel begin the same fixed TERM/five-second-KILL
shutdown as local helper cancellation; subsequent escalation rechecks native
identity and does not depend on extending the original control TTL.

The lifetime loop alone observes, signals, restores foreground and reaps. A
separate cancellable poller cannot block native lifetime on cloud connectivity.
Per-helper bounded deduplication backs the durable daemon barrier. A pending
control receives a local rejection if native containment, binding or freshness
fails before its signal; an error after signal dispatch is `delivery_unknown`,
including a failed marker write after a successful syscall. Such uncertainty
retains occupancy and never retries or escalates that effect.

`execution.control_result` accepts only the original local intent, control ID and
applied/local-rejected/unknown disposition. It authenticates the original helper,
including after the group has ended, and cannot rebind a control or rewrite its
terminal local outcome. Fast provider exit still gives the helper one bounded
result-delivery attempt before it exits. Applied means the signal request was
accepted, not that a provider turn completed or the run result changed.

### Exact existing Terminal focus

`focus_existing` requires the original signed live helper, owned live group,
held physical lock and complete contained history. The daemon maps the helper's
Darwin kernel controlling-device number to a local character-device node and
repeats PID/start/device checks around that lookup. A fresh C09 claim and a second
native inspection precede the durable `applying` barrier. The original launch's
expired deadline is not reused as runtime authority.

The response-only `local-execution-focus` document carries the local intent,
control/execution/generation, native TTY and bounded authorization timestamps.
It contains no PID, window selector, shell command or remote path. The bridge
retains a private callback bound to the original command/assignment. The signed
app sends only its pending delivery ID to `app.focus_check`; each check repeats
native ownership, held-lock/history, exact device, command state and expiry.
Closing the command, stopping the group, losing the lock, changing the app peer
or timing out invalidates this route before the next effect.

The app matches its opaque tab tag plus that device, using fixed Terminal
Apple-event properties. Tabs are filtered by one device comparison, because
Terminal leaves compound filtered references unanswered while a single
comparison answers promptly; the tag then matches when the foreground command
line still names `__launch <intent>` or the owned helper still runs in the tab,
and an exited session matches neither and fails closed. Windows are addressed
by unique ID with the selected tab rechecked locally before each mutation. It
selects only the unique matching tab and raises only the window whose selected
tab still matches; raising also activates Terminal, since ordering a window
frontmost does not. All mutations recheck the GUI session and fresh daemon
authorization. Success requires native selection/frontmost verification. Partial UI effects or lost replies remain
unknown and are not repeated after restart; no fallback opens another Terminal,
resumes a provider or selects an unrelated frontmost window.

### Exact-session resume

The resume consumer first requires the original registered execution, a captured
provider start and whole-group end, completed original launch delivery, and a
release fingerprint matching all retained native history. Fresh kernel inspection
must find the original helper, provider group and every recorded descendant gone.
A live reused PID remains ambiguous. Stored release or cloud TTL alone is not
absence proof; this path cannot clear a native recovery marker.

A fresh bounded C09 control claim creates or returns one immutable child launch.
After the reply, the local transaction repeats source/expiry checks and commits
`applying` before accepting that exact child into the normal launch inbox. Lost
claim replies reuse the original control claim. A crash between effect binding
and inbox acceptance retries only acceptance of the same child ID. A child pulled
before this binding waits without opening Terminal or irreversibly cleaning up
its valid reservation.

The child must preserve workspace, project, task, run, runner, checkout and
configuration snapshot; it must use distinct launch/execution IDs and newer
assignment and fencing generations. Its observed session comes from C09's
immutable authorized specification, never terminal output or an implicit latest
session. Both daemon preparation and the independently authenticated helper use
`PlanResume`, which additionally requires `session.resume.interactive` in the
manifest/runtime/policy intersection. Missing session/binding, closed control,
changed snapshot, ambiguous source or missing release history blocks preparation.

The ordinary single-use Terminal intent, new physical-worktree lock and online
final-authorization gate still apply. Source binding and fresh native absence
are rechecked before offering Terminal, when the helper reconstructs its plan,
and during pre-exec revalidation. Replacing the physical marker with the new
owned lock does not erase the old source's retained process history. No resume
consumer signals the old group, clears occupancy, writes terminal input or skips
checkout/provider revalidation.

Applied resume requires both a locally observed child provider image and strict
original-claim reconciliation showing that C09 recorded that child as started.
Opening Terminal, claiming a child or receiving only one of those observations
is insufficient. This acknowledges the exact planned launch, not a provider turn,
successful provider-session attachment or business result. A settled rejected
child produces local rejection. Lost acknowledgement and restart cannot offer
another Terminal intent or create another execution.

Native signal, resume and focus delivery have socket/process/PTY tests with
explicit synthetic cloud, signing and UI boundaries. Swift tests cover exact
predicate construction and per-effect authorization, expiry and ambiguity.
Production entry-point wiring and real signed Terminal focus/supervision
acceptance remain unfinished. These tests are not complete L05 certification.

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
