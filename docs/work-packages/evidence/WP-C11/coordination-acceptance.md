# C11 human coordination-history checkpoint

Tested source: `7a3440442fda0de3c3a7495b2d3964881dd0abeb`.
Protocol: unchanged `bfb-wire/1`. D1 head: `0045_private_task_authority`.

Human discussion and launch-status history now use current exact shared-parent
authority at final delivery. C11 remains `in_progress`; private creation,
sharing and author-private checkpoints remain unavailable. C12 stays planned.

## Covered boundaries

- Discussion detail checks viewer/retained epoch and exact parent before
  hydration and once after all asynchronous advisory reads. Privacy/viewer
  denial remains outside the readable shared sponsor-revocation advisory.
- Discussion lists select the shared parent/current viewer with rows before
  limits, counts and anchors. Empty pages still require current scope.
- Mounted reads retain the first captured workspace epoch, not a later rejoin.
  Private creator/grantee and missing/misbound history receive uniform denial.
- Launch status binds the exact launch, assignment generation, execution,
  work run, task/project and snapshot before selection. A replacement checkout
  occupant cannot enter earlier history. Terminal recorded work remains.
- Five fresh real-D1 checks prove bounded list/status selectors and unchanged
  stored history, not full discussion hydration or mounted authentication.
  The latter has independent focused transport cases.

## Clean verification

Exact `pnpm test:c11` passes 1,958 invocation cases in 70 files and 63 real-D1
checks across six harnesses. C10 separately passes 86 cases/nine D1 checks;
C08 passes 23 cases and its Worker race proof. Counts are not unique combined
cross-package totals.

Exact `pnpm test:d01` passes 114 cases in 11 files, protocol controls and
its real-D1 proof. Exact `pnpm test:w02` passes 121 cases in nine files,
protocol controls, the current C09 Worker/D1 proof and all 12 browser cases.
These synthetic regressions do not claim a live provider launch.

Full `pnpm verify` passes 4,300 TypeScript cases in 188 files, Go and all
16 Swift cases without skipping selected platform checks. G01 compilation
passes, not runtime acceptance. Frozen install, before/after worktree checks,
unchanged tested source and empty final status pass. See the
[manifest](coordination-manifest.json) and [command result](coordination-command-result.json).

The first clean attempt at `768e7cc` stopped at a historical W02 migration
assertion: the newer schema correctly adds manual permission defaults. The
repair asserts those defaults and compares every prior field unchanged. Fresh
certification passes; no certificate is claimed for the failed attempt.

## Regression provenance and limits

Meaningful old-source baselines fail 18 of 21 domain cases and 30 of 33 mounted
cases; the remaining cases are controls. The final mounted baseline uses
immutable prior certified exports. Exploratory import/dependency/column and
authority-fixture failures are not counted. Independent review passes 102 cases
across seven suites, including 48 existing controls; it did not rerun real D1.

Participant/runner/control delivery, cleanup, raw ordering metadata,
notification identities, GitHub key policy, destructive private retention and
natural in-flight expiry remain activation barriers. The public-position
contract included in this tested source is not implementation evidence.
No live private bytes, provider/pilot operation, deployment or external CI is
claimed. Other mandatory product features remain unbuilt. Earlier evidence is
preserved.
