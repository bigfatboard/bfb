# L02 filesystem and Git evidence

The exact `pnpm test:l02` target passed at clean commit
`0c436be74dd7744ed8c956a66acd1fc1f136072c` on macOS/APFS.
Checkout tests run with `-race -count=1` and create synthetic repositories only.

| Case | Observed assertion |
| --- | --- |
| Root and monorepo project | Exact cwd/root/subpath retained; incorrect expected subpath rejected |
| Symlink and actual APFS case alias | Canonical spelling and filesystem identity agree; duplicate links rejected |
| Duplicate project/runner identity claims | Same physical worktree remains unique across different claimed IDs |
| Linked worktree | Shared common Git directory, distinct Git directory and physical-worktree hash |
| Common-directory retarget | Final revalidation reports `checkout_identity_changed` |
| Root/subdirectory/Git-directory replacement | Registered filesystem identity no longer matches; no fallback |
| Removal and alias retarget | Typed missing/identity-changed block is persisted and returned |
| Clean, dirty, unborn, detached | Branch/HEAD/dirty are observations; no task state inferred |
| Bare repository | Not a working tree; rejected |
| Four concurrent links | Exactly one succeeds; other attempts report already-linked |
| Default, paging, unlink, restart | One default; bounded cursor/filter results; tombstones survive; relink has a new ID |
| Cancellation/output bounds | Read-only inspection fails closed |

## Zero-mutation proof

`TestExactRootAliasesAndReadOnlyGit` snapshots every Git metadata entry's bytes,
mode and modification time before linking, alias rejection, clean verification,
dirty verification and unlinking. The entire snapshot remains equal afterward.
Linked-worktree inspection independently preserves the common-directory snapshot.

The test configures an executable filesystem-monitor/SSH canary and poisons
ambient Git directory, working-tree, index and configuration variables.
Observation still selects the intended repository and creates no canary marker.
No production or personal Git repository is mutated by these fixtures.

The root resource identity includes macOS device/inode/generation/birth time.
The APFS test asserts the actual filesystem type; it observed case-insensitive
aliases on the acceptance host. Missing/remapped directories are exercised on
disk, not represented only by mocked filesystem return values. Removable-volume
unplug and a fresh macOS account are not claimed here.

The previous-head migration test opens the L01 schema, inserts a synthetic kernel
record, interrupts migration 002 before commit, reopens the old schema with no
partial checkout table, then upgrades successfully while preserving the record.
