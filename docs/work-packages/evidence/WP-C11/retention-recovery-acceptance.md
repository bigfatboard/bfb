# C11 retention and upload recovery checkpoint

Tested source: `de4f5fe83e725dbeaee70f5f43795d122eabe1df`.
Protocol: unchanged `bfb-wire/1`. D1 head: `0045_private_task_authority`.

This bounded checkpoint extends the partial metadata certificate with authorized
human retention reads and atomic stuck-upload recovery. It is not complete C11
acceptance. C11 stays `in_progress`; private creation, creator sharing and
author-private checkpoints stay unavailable. C12 remains planned. Synthetic
private policy fixtures do not activate a feature.

## Covered boundaries

- Human retention requires explicit current Owner/member authority and retained
  epoch. Only exact shared version→artifact→run→task/project candidates count.
  Keys bind the exact workspace, run and version; run-free or dangling log
  parents and misbound keys are omitted before examined/eligible counts.
- Health remasks retention and stuck references together after other awaited
  reads. Current-scope sentinels deny access loss even with no references,
  before returning hydrated policy or workspace metadata.
- Configured system selection is separately named and cannot inherit human
  Owner authority. The synthetic Queue/R2 drill preserves misbound and run-free
  objects. This selector proof does not certify destructive private retention.
- Upload recovery uses the exact 15-minute TTL plus five-minute grace, with no
  grant expiring inside that grace, including consumed grants. A current Owner
  needs shared-parent contribution authority, or genuine run-free workspace
  authority, plus a fresh action-bound step-up proof.
- The Hub batch repeats exact authority, target/state, proof and ledger
  witnesses before proof consumption, abandonment effects, ledger and safe
  receipts commit. A consumed future grant inserted independently before real
  D1 batch execution rolls back all effects, including idempotency and audit.
- Target-ledger retries require a fresh proof and matching closed history.
  Private, absent and non-stuck targets have one resource denial. Duplicate,
  malformed and mixed targets reject without partial effects. Browser delivery
  rechecks authority after the awaited Hub response; the old unguarded path
  rejects before cache lookup.

## Clean verification

Exact `pnpm test:c11` passes 1,179 cases in 56 files and 24 production-Hub/real-D1
checks. Its retained C10 invocation passes 86 cases and nine D1 checks; C08
passes 23 cases and its independent-worker race proof. Counts overlap rather
than forming a unique combined total.

Exact `pnpm test:x05` passes 58 cases, 11 Worker drill scenarios and four browser
cases. Its current-head runtime proof preserves dated package evidence; the
historical X05 dependency hold is unchanged.

Full `pnpm verify` passes 3,520 TypeScript cases in 174 files, Go checks and all
16 Swift cases. No platform gate is skipped. Frozen install and clean-worktree
checks pass before and after; the tested commit is unchanged and the proof
checkout remains clean. See the [command result](retention-recovery-command-result.json)
and [manifest](retention-recovery-manifest.json).

## Remaining limits

Natural credential or lease expiry while a D1 batch is in flight remains
uncertified; observed-time guards are not execution-clock proof. Opaque
recipient positions, GitHub unbound-key collision policy, operations aggregates,
security audit, frozen diagnostics, other recovery kinds, destructive private
retention and coordination consumers remain open. All delivery stages and
creation/sharing/internal-progress controls must pass together before activation.

The proof uses disposable production Hub/D1, separate mounted authenticated
routes and synthetic Queue/R2 objects. It does not establish deployed private
workflows, live private bytes, provider execution or external recipients.
Remote start, agent discussion, pilot operation, provider configuration and
deployment are unchanged. This slice adds no UI, knowledge, skill catalog,
vault, reminder or contribution feature. Only bounded evidence is committed.
