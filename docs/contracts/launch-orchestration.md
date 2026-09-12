# Launch orchestration v1

Owner: [C09](../work-packages/WP-C09-launch-orchestration.md). Gate: `pnpm test:c09`.

## Authority and replay

Every mutation runs in the existing WorkspaceHub FIFO and commits its state, audit,
event, outbox and idempotency result in one D1 batch. Reads precede staged writes;
SQL constraints and guarded predicates reject conflicting batches. D1 is canonical,
not socket attachments or an in-memory lease. Cloudflare documents [atomic D1
batches](https://developers.cloudflare.com/d1/worker-api/d1-database/) and the
[eviction lifetime of Durable Object memory](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/).

C09 commands reject the hub's cached-result path. Transport attempts use fresh hub
envelopes; durable domain rows separately bind caller idempotency keys to canonical
request hashes and the actual principal. Retrying one request rechecks live authority
and returns the same current domain object, never a cached authorization. A changed
input under the same domain key fails. Claim has one winning runner/key; retries of
that exact claim do not acquire another lease. Final authorization is always online
and freshly evaluated. The local single-use intent and supervisor remain necessary
to prevent duplicate execution after a retried response.

The authenticated `launch/reconcile` endpoint accepts the original claim request
and returns cleanup-only assignment/fence metadata for that runner, signing key and
winning claim key. It remains usable after lease freshness/launch expiry or human
launch-grant revocation, but never after runner authentication is revoked. It does
not return a snapshot or execution configuration, update launch/lease state, renew
a deadline, reacquire occupancy or authorize execution. A fresh Hub envelope avoids
cached results. A released reservation reports its current observation sequence;
after another execution replaces it, the old request receives `superseded` without
the replacement's fence or other execution identity. An unclaimed request has no
reconciliation binding. The Mac must still supply verified local absence through
the existing lease-observation path; knowing a fence is not absence proof.

Browser commands require a direct authorized human session with CSRF protection.
Native commands require C06 request-bound device possession and a current runner
principal. Neither substitutes for the other. Claim and final authorization recheck
the requesting human's original epoch, current project access and policy, profile
version, runner owner/grants/key, checkout identity/configuration and deadline.
The audit distinguishes the requesting human from the acting runner.

## Start, immutable history and expiry

Start names a ready task/version, profile/version, current workspace/project/repository
configuration versions, runner and registered checkout. It atomically creates the
run, initial immutable snapshot, execution, immutable assignment, pending launch and
durable runner reference. The assignment generation increases for every execution
of a run; its workspace/project/task/run/runner/checkout binding never changes.

Both interactive and headless pending launches expire after 120 seconds in this
contract. Final authorization must precede that deadline; expiry is not extended by
claim, reconnect, a wake link, configuration replacement or a retry. Expired/rejected
unstarted launches end the execution with `launch_expired`/`launch_blocked`, keep the
run result open and return the task to ready when no other execution owns its work.
Before any provider session attaches, another explicit Start may reuse that run with
a new execution/assignment. Once provider work begins, an independent attempt is a
new run; resumption requires the explicit unfinished-session control below.

Snapshots preserve all adapter inputs and their configuration versions. An execution
selects an immutable snapshot; a per-run snapshot lineage permits append-only
replacement without updating/deleting history. A runner may report a bounded local
repository restriction under its still-valid claim. It must tighten both current
cloud ceilings and the previous effective restrictions. A changed hash creates a
new snapshot/specification, invalidates the old final-check binding and requires
another final check. It does not mutate shared project configuration or extend time.
Changes to cloud policy/profile/runner authority invalidate rather than silently
refresh an existing launch.

The wire specification contains IDs, generation, expiry, hashes and typed execution
configuration only. Model values must be safe identifiers selected by the profile;
the local provider manifest still enforces its exact model allowlist. No shell,
executable, argv, cwd, local path, task text, repository URL, branch or credential is
accepted as a launch/control field. The complete immutable snapshot is delivered as
typed policy/configuration data so the runner can recompute its hash. Display-only
checkout branch/path-like metadata is not copied into launch authority.

The checkout's repository fingerprint is the hosted identity independently verified
by L02 against local Git metadata during explicit registration. C09 pins that
fingerprint and checks the registered project, host and subpath. It does not resolve
a GitHub opaque repository ID over the network; X04 owns that hosted-service binding.

Synthetic IC-3 profiles use the honest provider name `fake` and model `synthetic`.
An owner must explicitly add it to provider ceilings; default policies are unchanged.
Real-provider adapters must remain unavailable until their owning gates certify them.

## Checkout fencing and containment

Claim atomically reserves `(runner_id, physical_worktree_hash)` and increments a
fencing generation. Checkout aliases cannot obtain parallel reservations. All
launch modes reserve the same physical worktree, including read-only discussion.
Cross-workspace enrollments have distinct runner keys; the Mac-wide canonical local
lock is the final cross-enrollment fence. Cloud TTL is a freshness indicator only:
an unreleased reservation blocks indefinitely, including after lease expiry.

Every lease observation binds workspace, runner, execution, assignment generation,
fencing generation, monotonic observation sequence and observation time. Verified
renewal also binds supervisor PID/start identity, the owned process group and its
local lock identity. PID numbers alone, connection heartbeat and provider/session
exit are insufficient. Binding changes, escaped descendants, missing verification,
ambiguous identities or incomplete recovery durably set `containment_unknown`.

Normal release requires authenticated local verification that the entire owned
group, all observed descendants and the owned lock are gone. Once containment is
unknown, only an explicit local recovery observation carrying equivalent complete
proof can release it. A browser cancellation or a server timer cannot supply this
proof. Stale observations cannot renew or clear a newer fence/unknown marker. The
cloud validates typed provenance and bindings, not remote macOS processes; L05 owns
the real local inspection and must fail closed when proof is unavailable.

## Durable controls and wake hints

Controls name `focus_existing`, `resume`, `interrupt`, `terminate` or `cancel`, an
immutable execution/assignment generation, runner and caller idempotency key. They
expire after 120 seconds and retain an explicit claimed/applied/rejected/expired
disposition. Claim/final local application recheck current human and runner authority,
the exact assignment, action and deadline. Acknowledgement is bound to that claimed
control, and duplicate delivery has one effective disposition. Focus and signals
require a verified live owned execution; resume requires the unfinished exact
observed session and cannot retarget a live process. L05 owns local effect dedupe.
After pull returns an opaque control reference, authenticated `controls/read` returns
its bound target/action without changing state. The runner must separately claim
(and re-claim immediately before any delayed application); a read never authorizes
focus, session creation or a signal. Unauthorized readers cannot inspect the target.
Resume never resurrects an ended execution. Claiming a resume control requires one
unambiguous unfinished observed session, complete release of the old physical fence,
no other active execution of that run and fresh launch policy. It creates exactly one
new execution/assignment and pending launch under the same run, with the control's
unchanged expiry and the exact session binding. That new launch must independently
win claim and final authorization; its typed specification carries only the bounded
session identifiers, never a prompt or arbitrary input. Duplicate resume delivery
returns the same new launch. A later session-identity/state change invalidates it.
Cancellation prevents further launch authorization immediately but retains any
claimed reservation until verified local absence. Result state remains independent.

A wake intent binds an existing unexpired command, requesting human/epoch, workspace,
runner/key and expiry. The link is only a uniformly random canonical ULID (128 random
bits, not a timestamp-bearing identifier). Raw values exist only in the bounded
creation response and redemption request; D1, hub/audit inputs, events, rate keys and
application logs receive only a verifier or safe public binding. Losing the creation
response does not recover a secret from D1; a new explicit request can mint another
short-lived hint without creating another command.

Redemption requires the bound runner's request possession, consumes the verifier
once and only prompts retrieval of the existing durable command. It never Starts or
claims an execution. The Mac can try its bounded set of existing enrollments; failure
does not disclose another workspace's binding. The managed Universal Link and
self-host custom scheme share these semantics. Public link GETs have no side effect.

Wake and control endpoints enforce C01 durable per-address and per-principal abuse
budgets before body processing, strict bounded bodies and uniform failures. Fresh
Worker isolates cannot reset those counters. Pulls and opportunistic nudges deliver
only existing command references; dropping every nudge cannot lose a valid command,
and an expired reference can never authorize execution.

## Verification ownership

The C09 gate covers concurrent claims and alias contention, input/idempotency changes,
revocation before claim/final check, local tightening/widening, immutable history,
clock/expiry/cancel races, dropped nudges, wake replay and wrong bindings, durable
abuse counters, control dispositions, release proof matrices and unknown-containment
recovery. It runs real D1 batches through two Workers and the owning Hub, including
failure rollback and restart. Fixtures are visibly synthetic and retained evidence
contains no capability, private content, terminal transcript or absolute local path.

`pnpm launch:fixtures` owns the `*.c09-*.json` protocol fixtures and their matrix
entries. `pnpm protocol:generate` owns the TypeScript, Go and Swift schema output;
both check modes run in the package/repository gates. The D1 gate upgrades populated
0015 data, retaining immutable profile/run/snapshot/session history and foreign keys.

L05 supplies actual Terminal/PTY/lock/process proof. L07/P01 supply real provider
behavior. W02 supplies the human launch/control UI. These are not C09 completion
claims, and no link delivery is evidence that a local process started.

C09 clean-checkout certification is recorded in the
[committed evidence manifest](../work-packages/evidence/WP-C09/manifest.json), with
the complete negative, concurrency and lease-release matrix. The exported D1
migration head is checked against the ordered SQL manifest in the repository gate.
