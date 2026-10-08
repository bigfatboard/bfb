# Exact checkout registry

The daemon owns registration metadata in local migration `002_checkouts.sql`.
Linking requires explicit workspace, runner, project, repository identity and
project-subpath bindings; it does not enroll a runner or confer cloud authority.

`bfb checkout link --workspace <id> --runner <id> --project <id> --repository github.com/owner/repo --label Work --subpath packages/api <directory>`
links that exact existing directory. Flags precede the directory.
`checkout list` supports explicit workspace/runner/project filters and bounded
`--limit`/`--after` pagination. `checkout verify <id>` refreshes the displayed
snapshot; `checkout unlink <id>` tombstones metadata without touching Git.
Only one active default is allowed per workspace/runner/project. Unlinking frees
the default and physical identity but relinking creates a new checkout ID.

## Identity and read-only observation

Paths are local database fields, excluded from JSON serialization. RPC accepts a
path only in a `checkout.link` request; all responses use the canonical sanitized
checkout-summary schema. Labels cannot be paths. Remote credentials are stripped,
GitHub names normalize case, and other hosted repository paths retain case.
HTTPS/SSH/scp-style remotes at standard ports are supported; local transports,
nonstandard ports, query/fragment suffixes and ambiguous paths fail closed.
Immutable GitHub repository-ID verification belongs to the later hosted integration.

Directory identity includes filesystem device/inode and creation time, plus inode
generation on macOS. APFS canonical spelling comes from the opened directory
descriptor. The physical lock key is SHA-256 over a versioned root identity, not
over the local path. Different linked worktrees have different keys even when
their common Git directory matches; aliases and subdirectories of the same
worktree cannot create additional registrations, including under different IDs.
Registration retains the resolved project/root/Git/common-directory identities
and the entered absolute path so a retargeted alias cannot redirect execution.

Observation invokes fixed `/usr/bin/git` commands with bounded output, an eight
second context, no ambient Git configuration environment, and no optional index
writes, filesystem monitors, hooks, automatic maintenance or lazy fetches.
Topology and remote identity are checked again before returning. No network
operation, repository repair or provider launch occurs here. This follows Git's
[read-only status guidance](https://git-scm.com/docs/git-status#_background_refresh)
and [absolute topology options](https://git-scm.com/docs/git-rev-parse).
Local replacement or removal blocks; no alternate checkout or home-directory
fallback is attempted.

## Repository policy and execution handoff

The detected Git root's `.bfb/config.yaml` governs root and monorepo-subdirectory
registrations. The only fields are `allowed_providers`,
`allow_agent_root_propose`, `allow_pass_to_agent`, `allow_run_overrides` and
the optional closed `offline_agent_work` object.
Absent files and comment-only documents mean `{}`. The parser rejects symlinked
policy files/directories, non-regular files, content above 8 KiB, unknown fields,
duplicate keys, aliases, anchors and ambiguous/non-boolean flags.

`offline_agent_work` requires `allowed_tools` and `max_pending_age_seconds`.
Its four possible tools are `bfb_add_comment`, `bfb_propose_task`,
`bfb_report_progress` and `bfb_update_task`; the parser sorts and deduplicates
them. An empty set requires age zero, and a nonempty set requires an integer
age from 1 through 300 seconds. Omission stays absent in canonical JSON and
means denied capture in cloud policy; it never inherits enabled permission.
Existing `{}` bytes and hashes stay unchanged. The separate four-field launch
`Policy` projection and closed launch-tightening wire contract are unchanged.
Parsing this field does not grant capture or replay authority; A01 must verify
the exact approved immutable policy versions under
[ADR 0006](../../docs/adr/0006-daemon-owned-pending-agent-work.md).

Canonical JSON sorts object keys and normalizes provider lists. The owning
conformance command is `pnpm test:l02`: Go parses the synthetic YAML cases in
`protocol/fixtures/checkout-policy.json`, while TypeScript sends their documents
through the existing WorkspaceHub repository-policy command. Both must produce
the recorded hash and inherited restrictions or the same widening failure.
Fixtures are hand-maintained synthetic contract inputs, not runtime output.
The additional hand-maintained `internal/checkout/testdata/offline-agent-work.json`
cases pin native/cloud canonical bytes and hashes. Their owning checks are
`go test ./internal/checkout/...` and
`pnpm exec vitest run packages/domain/test/checkout-contract.test.ts`; both are
included in the expanded A01 target.
Protocol sources under `protocol/schema/v1` own generated types/validators;
`pnpm protocol:generate` is their deterministic generator.

`Revalidate(id)` makes a fresh read-only observation against the registration.
`RevalidateForExecution(id, claimedHash, authoritativeParent)` additionally checks
the immutable claimed hash and the parent's policy ceiling. A verification
refresh may store a new hash but cannot authorize an old specification. Syntax
validity alone is not authorization; a config may still widen its current parent
and therefore must be rejected at the execution boundary.

L05 owns acquisition/retention of the physical lock, occupied-unlink protection,
final authorization and the exact-directory provider spawn. This package only
supplies the identity and revalidation boundary. Observation cannot prevent an
unmanaged human process from editing files, nor prove a volume's permanent
identity if its operating system no longer provides it.
