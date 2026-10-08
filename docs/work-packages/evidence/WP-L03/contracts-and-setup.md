# L03 contract and setup assertions

Tested from clean commit `367ede9a2948dca89f3e7bbda47b3c254649abc4` with
`pnpm test:l03` and `pnpm verify`. This evidence describes assertions, not raw
provider output or personal configuration.

## Invocation and version policy

- Provider-local descriptors generate the same sorted aggregation. Version
  parsers accept the observed Claude/Codex/Grok forms and reject ambiguous output.
  Only the synthetic manifest currently grants launch/tracking capabilities.
- Unknown version, unhealthy integration, absent provider, missing capability,
  policy-ceiling mismatch and forged/expired probes fail closed.
- Replacing a binary inode, symlink target, observed version, config contents,
  config presence, integration hash or registry/manifest identity invalidates
  immediate pre-exec revalidation.
- Malicious model/session/policy values cannot choose options, shell commands or
  executables. A checkout containing quotes and shell metacharacters stays only
  in the working-directory slot. Returned argv/stdin are defensive copies.
- Discussion content reaches only the bounded fixed-instruction stdin envelope.
  Missing/wrong provider/session/run/execution/generation bindings, fork without
  a source, writable filesystem policy, interactive mode, inherited context and
  permission widening are rejected.

## Lifecycle and semantic normalization

- Synthetic native processes exercise normal/headless and interactive waiting,
  exact resume, fork, wrong-session failure, tool failure, nonzero exit, context
  without a turn, hang, interrupt, ignored-interrupt termination, inherited
  process-group child and new-session escape fixtures.
- Tests inspect real child process groups and verify cleanup of every owned
  synthetic child. Production containment/PTY behavior remains L05-owned.
- Duplicate JSON keys, oversized structures, invalid identities and token
  quantities cannot become semantic candidates. Unknown private fields are
  discarded. Context, tool failure, terminal/process outcomes and turn completion
  never produce result submission or attention creation.

## Approved setup and recovery

- Proposals do not write; approval must match both proposal ID and expected hash.
  Caller-mutated diffs, duplicate-key JSON and edits to unowned semantics fail.
  Unrelated nested configuration, large integers and original rollback formatting
  are preserved.
- A stale proposal or competing writer fails under the shared inode lock.
  Edits made during either a passing or failing doctor stay intact and leave a
  private recovery copy.
- Atomic exchange retains an unexpected file saved in the final publication
  window. Exclusive creation preserves a new file raced into an absent target.
  Rollback to original absence also retains a raced file rather than unlinking
  it. Unexpected displaced bytes remain private and require explicit conflict
  resolution; automatic recovery refuses to discard them.
- Failed doctor restores exact original bytes/mode or original absence. The
  large-config fixture exercises recovery beyond the base64 journal's 2 MiB
  threshold. Configuration symlinks, directory replacement and cancellation
  before publication fail safely.
- Actual subprocess exit after publication leaves a durable journal; a later
  recovery restores existing or absent configuration. Deterministic fault states
  additionally exercise journal-only, before/after exchange, rollback exchange,
  unexpected displacement and partial-journal boundaries.

The live experiment is recorded separately in `capability-matrix.json`.
Its optional/unverified capabilities do not enter production manifests.
