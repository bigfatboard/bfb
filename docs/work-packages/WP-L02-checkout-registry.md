# WP-L02 — Exact checkout registry

Status: `in_progress`

Risk: High

Test target: `pnpm test:l02`

Evidence manifest: `docs/work-packages/evidence/WP-L02/manifest.json`

## Outcome

BFB links and revalidates an exact local project working directory without changing Git state or uploading its absolute path.

## Dependencies

- **Requires:** F02, L01.
- **Unlocks:** L05, L08, X02, X05.
- **Can run with:** L03 and control-plane work using fake project/runner APIs.

## Scope

- Implement `checkout link/list/verify/unlink` and local RPC equivalents.
- Record absolute project working directory, Git root/common directory, workspace-relative subpath, filesystem identity, physical-worktree identity, normalized remote fingerprint, branch, HEAD, dirty state, and validation time.
- Prefer immutable GitHub repository ID when later available; normalize SSH/HTTPS identity otherwise.
- Reject duplicate physical worktrees through path aliases/project records.
- Parse, canonicalize, validate, and hash `.bfb/config.yaml` as tightening-only non-secret policy.
- Synchronize only sanitized checkout ID/label/repository fingerprint/physical hash/Git summary/availability.
- Provide read-only preflight and final revalidation with typed block reasons.
- Define the local occupancy/lock key independent of cloud lease state.

## Non-goals

- Clone, fetch, pull, reset, checkout, branch, rebase, worktree creation, automatic repair, or project guessing.

## Contracts

### Consumes

- F02 `bfb-wire/1` canonical local RPC and checkout-summary contracts; L01 private same-user socket, owned SQLite connection and leaf registration boundary.
- L01 local migration head `001_kernel.sql`. Prerequisite certification: `pnpm test:l01`, uncached native race tests, `pnpm verify` and IC-1 passed from clean commit `f19d188`; evidence committed before L02 began.
- Existing C07 repository-policy fields and canonical SHA-256 JSON semantics are tested through shared synthetic fixtures, not a new policy dialect.

### Produces

- `checkout link/list/verify/unlink` leaf commands and local RPC methods, with an explicit workspace/runner/project/repository/subpath binding. Local paths are accepted only by local link requests; responses and future synchronization use a separate canonical sanitized summary.
- Local migration `002_checkouts.sql`, immutable linked filesystem/Git identity, runner-wide physical-worktree uniqueness, explicit default selection and tombstoned unlinks. Registration is local metadata, not enrollment or cloud authorization.
- A path-free physical-worktree hash derived from filesystem identity, independent of cloud lease state. L05 owns acquiring and retaining the actual execution lock; no provider runs in L02.
- Read-only `Revalidate(checkout_id)` observations plus final configuration-hash/parent-policy validation. A prior claimed config hash remains invalid after a change even when ordinary verification refreshes the displayed snapshot; L05 must obtain replacement specification/final authorization.
- The policy file is `.bfb/config.yaml` at the detected Git root. It applies to a registered monorepo subdirectory too. Missing or comment-only files canonicalize to `{}`; unknown fields, secret/path fields, duplicate keys, aliases, non-boolean flags and unsafe filesystem objects fail closed.
- Real APFS fixtures cover root/subdirectory/worktree/common-directory identity, aliases/case handling, replacement/removal, dirty/unborn/detached Git states, config changes, sanitized output and byte-for-byte Git metadata preservation.

No network request, Git repair, provider launch or automatic worktree creation is performed by checkout observation. Immutable GitHub repository-ID resolution remains with the later verified integration path; L02 never upgrades a local claim into a verified hosted ID.

## Work plan

1. Build Git/filesystem identity fixtures and normalization.
2. Implement registry/migrations/CLI with sanitized sync DTOs.
3. Implement config parsing/hash and read-only revalidation.
4. Test aliases, linked worktrees, nested projects, replacement, removal, and config changes on real APFS.

## Acceptance

- Git root, project subdirectory, linked worktree, common-dir, symlink alias, case variation, dirty tree, missing path, and replaced directory behave as specified.
- Linking an aliased physical worktree twice is rejected.
- Verification never mutates Git state.
- No synchronized/logged field contains the absolute path.
- A config hash change cannot widen policy and forces replacement/final authorization later.
- No failure falls back to another checkout or the home directory.

## Evidence and handoff

- Commit filesystem fixture matrix, zero-mutation Git proof, sanitized snapshots, and typed failures.
- L05 receives `Revalidate(checkout_id)` and one canonical lock identity.

## Risks and decisions

- APFS case behavior, removable volumes, inode reuse, and Git worktree semantics require real filesystem tests, not mocks alone.
