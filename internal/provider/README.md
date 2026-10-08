# Provider adapter kit

`pnpm test:l03` owns the kit's acceptance target. It checks deterministic
registration, probe-report classification, the L01 gate and race-tested native
provider contracts. `pnpm verify` also checks registration drift and the Go suite.
The synthetic executable is built by `go build ./cmd/bfb-fake-provider`.

## Ownership

- Each `internal/providers/<name>` directory owns its `registration.json`,
  `Descriptor()` and eventual adapter, manifest, hook parser and config editor.
  `pnpm provider:generate` deterministically owns
  `internal/providers/catalog.generated.go`; never edit that file by hand.
- Real descriptors currently provide discovery only. Empty tested-version and
  capability lists deliberately withhold tracked launch and discussion behavior.
  L07, P01 and P02 own their real integrations and exact-version certification.
- `Installation` is local state, not a cloud payload. It contains the resolved
  executable, an explicit environment, integration hash and every config source
  the adapter says can affect its behavior. An omitted environment is empty, not
  inherited. Real adapters must enumerate inherited/managed configuration and
  tighten their environment before receiving tracked capabilities.
- L05 owns checkout/PTY/process identity, immediate pre-exec revalidation,
  signaling/escalation and physical worktree occupancy. The adapter returns
  semantic interrupt/terminate requests; it cannot choose another process.
- L06 owns correlation, event envelopes, sequencing, persistence and upload.
  Hook parsers return only bounded semantic candidates. They cannot emit task
  completion, attention creation or result submission.
- L05 owns interactive resume's stopped-source proof and new execution guard;
  D02 owns discussion session fencing and delivery records. A `SessionBinding`
  must come from authenticated assignment state, not a peer message or a guessed
  most-recent session. The kit validates its shape, not native process absence
  or cloud authorization; the execution owner must establish those separately.

## Probe and invocation contract

The registry intersects packaged, runtime and policy capabilities. It validates
each selected mode, approval/filesystem policy, context/initial-turn transport,
model and required capability before invoking a compiled argv builder.
No cloud executable, argv, environment, shell command or task text is accepted.

A probe lasts 30 seconds. Its immutable internal identity includes the canonical
executable and requested symlink target, device/inode, mode, size, modification
time, byte hash, observed version, configuration identities/hashes (including
absence), integration hash and manifest identity. Editing the public report does
not grant capabilities. `Revalidate` reprobes those facts immediately before
execution; a changed/unknown/unhealthy/expired installation fails closed. Local
policy cannot make an unknown version inherit another version's certification.

`InstallationSource` derives defensive installation copies and a source hash from
the sealed original probe. `ProbeBound` checks executable and configuration
fingerprints against that hash before invoking even `--version` or a health probe.
Plan `Revalidate` uses the same guard, so a replaced binary cannot run first and
only then be rejected. L05 freezes this evidence locally for a separately started
helper, which also compares the resulting full identity, version and manifest.

`VerifyInstallationSource` returns the unchanged executable fingerprint from that
authenticated source without executing a probe. L05 uses it to inspect an existing
process after launch-probe expiry. It provides no capabilities, plan or new launch
authority; the ordinary fresh-probe requirements still apply before execution.

Launch plans return defensive copies of argv, environment and stdin. A safe
initial turn uses the fixed `InitialInstruction`; context injection alone stays
`waiting_initial_turn` or `waiting_user_submit`, never `working`.

`PlanResume` and the adapter's `Resume` entry point continue an exact interactive
`SessionBinding`. They require valid owned run/execution/generation identities,
no requested new session ID, and the intersection of `session.resume` and
`session.resume.interactive`, in addition to the ordinary launch/policy checks.
Headless-only continuation evidence cannot enable interactive resume. There is
no optional session, implicit most-recent target, or fork on this path. Resume
plans retain the same installation revalidation, immutable invocation and fixed
initial-turn transport as fresh launches; a plan is not a session observation
or evidence that a provider started a turn. Unknown exact targets must fail
without falling back to a fresh session. Real adapters own that runtime proof.

Discussion plans require headless, read-only, no permission prompts or inherited
context, a bounded turn ID, and verified structured/read-only capabilities.
The compiled turn argv builder never receives peer content. The kit encodes that
content as attributed external data on stdin with its fixed discussion
instruction. Exact continuation/fork additionally requires an observed owned
session binding and the corresponding tested capability.

JSON normalization rejects duplicate keys, invalid UTF-8, deep structures,
oversized input, invalid identities and invalid token counts. Parsers discard
unknown private fields rather than forwarding raw provider payloads. A completed
turn is telemetry, not a completed task or submitted result.

## Setup transaction

`ProposeSetup` is read-only. A compiled provider editor produces an explicit
BFB-owned diff and verifies unchanged unowned semantics; it must reject ambiguous
or invalid provider syntax. `ApplySetup` requires human approval of that exact
proposal ID and expected hash, plus a post-write doctor.

Application pins the owned parent directory, rejects unsafe/symlinked config
targets, acquires a private per-target inode lock and rechecks the config hash.
It fsyncs a private recovery journal before publishing. For existing files,
macOS/Linux atomic exchange retains the displaced file until its expected hash
is verified. For absent files, exclusive hard-link publication cannot replace a
raced new file. Recovery of original absence also retains the displaced file
until validation. Filesystems lacking the required atomic operation fail closed.

A failed doctor restores exact prior bytes/mode or absence if the published
configuration is still the one BFB wrote. Process-crash recovery uses the same
journal and staged-file checks. A non-cooperating editor's unexpected bytes are
never discarded: setup returns `provider_setup_conflict`, retains the private
journal/displaced copy and refuses automatic recovery over that edit. Depending
on the race, the newer edit is either still at the config path or retained as the
adjacent private `.recovery.staged` file. Explicit local inspection/reproposal is
required; do not delete a pending journal to force setup through.

Locks remain as empty private files, preserving their inode across calls.
Successful setup/rollback removes its recovery data. This protects bounded
configuration transactions, not arbitrary same-user processes holding stale
writable file descriptors. Real provider-specific setup/doctor commands are
owned by their integration packages.

## Synthetic provider

The fake supports fixed launch argv, exact synthetic resume/fork identities,
context-only starts, structured hooks, controlled failure, tool failure, hanging,
interrupt, terminate and ignored-interrupt escalation scenarios. Child fixtures
either inherit the process group or explicitly create a new session to exercise
containment detection. The test owns and cleans up every such process.
`BFB_FAKE_*` variables are local test controls, never fields of a launch
specification or production provider configuration.

Native fake-process tests do not certify Terminal.app PTY handoff (L05), real
provider sandboxing (L07/P01), enrollment (L08) or business delivery (D02).
