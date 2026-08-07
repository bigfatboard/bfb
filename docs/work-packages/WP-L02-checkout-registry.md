# WP-L02 — Exact checkout registry

Status: `planned`

Risk: High

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
