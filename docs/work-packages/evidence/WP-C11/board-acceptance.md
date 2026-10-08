# C11 canonical board and attention-deck checkpoint

Tested source: `014f73b147f1c48e528c96eb0901b7bd96c113be`.
Protocol: unchanged `bfb-wire/1`. D1 head: `0045_private_task_authority`.

One final current-authority selection replaces multi-await board hydration.
C11 remains `in_progress`; private creation/sharing/checkpoints stay disabled
and C12 stays planned.

## Covered boundaries

- Browser board delivery selects lanes and Needs Now together. Current
  Owner/Member/Reviewer and retained epoch are required even for empty scopes.
  Captured project IDs only narrow current authority; revoked grants do not
  survive later name/run/policy hydration. Only synchronous projection follows.
- Task access precedes the first 50 global candidates. Policy-backed lane
  mapping follows that limit; missing policy rows still consume the legacy
  candidate budget. Accessible empty lanes remain slug-ordered. The independent
  deck ranks all readable urgent assigned tasks and returns at most three.
- Role, task bodies, routing/policy flags and current same-workspace owner
  names share the selector. Exact typed work-run lineage excludes discussion,
  misbound and malformed sources without discarding terminal recorded history.
  Valid UTC ordering preserves precise instants and deterministic ties.
- Heuristic recent events are uniformly held, without semantic reads or history
  rewrite. The response declares unavailability; stale injected metadata cannot
  render. Impeccable hardening keeps the explanation inside the existing native
  Details disclosure, with no additional default action. Keyboard and both
  themes pass; representative light/dark card captures were visually inspected.
- Meaningful domain, mounted, UI and actual-D1 regressions fail before repair.
  Six fresh actual-D1 checks cover the final selection, revocation, typed history,
  large fixed-bind project sets, independent limits and empty-scope authority.
  The existing vacuous discussion card lookup now asserts a real `taskId` match.

## Clean verification

Exact `pnpm test:c11` passes 1,877 invocation cases in 66 files: 1,828 retained
and 49 board cases. Its four real-D1 harnesses pass 55 checks. Separate C10
passes 86 cases and nine D1 checks; C08 passes 23 cases and its independent
worker race proof. These counts are not a unique cross-package total.

Exact `pnpm test:w03` passes 179 unit cases in 27 files and 87 shared browser
cases, including 16 W03 scenarios. Full `pnpm verify` passes 4,219 TypeScript
cases in 184 files, Go and all 16 Swift cases; no platform gate is skipped.
G01 caller compilation passes, not G01 runtime acceptance. Frozen install and
worktree checks pass before/after; tested source is unchanged and final status
is empty. See the [command result](board-command-result.json) and
[manifest](board-manifest.json).

The first certificate attempt at `71f4ebd` passed test gates but failed final
clean status: an existing G01 browser regression overwrote tracked historical
request-count evidence. Routine captures now use ignored test output; explicit
historical capture remains available. A fresh checkout passes all gates without
rewriting dated evidence. No clean certificate is claimed for the first attempt.

## Remaining limits

This is not complete privacy activation, a recipient-safe event stream or a
browser-session/commit-time expiry certificate. Opaque positions, notification
identities, GitHub key policy, unsupported audit/recovery, destructive private
retention and remaining coordination delivery are still open. The unsupported
audit/recovery contract included in this source is not implementation evidence.
No provider/pilot operation, private R2 byte delivery, deployment or external CI
is claimed. Project knowledge, skills, vault values, reminders and contribution
views remain unbuilt. Earlier certificates stay historical.
