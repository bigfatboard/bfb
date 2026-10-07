# C11 browser board selection checkpoint

The browser board, agent profiles and displayed role now belong to one current
human and workspace selection. Old responses cannot replace a newer board or
restore its controls after navigation. Failed current reads remove stale content
and expose one retry. Server authorization and the W03 action budget are unchanged.

C11 remains `in_progress`. Private creation, sharing and author-private checkpoints
stay disabled; C12 remains planned.

Tested source: `320b23a2f71af5fa687e533ff1f31532beb3c931`.
Protocol: unchanged `bfb-wire/1`.
D1 head: unchanged `0047_security_audit_positions`.

## Current selection and delivery

Each read captures the committed selection incarnation and latest request.
Checks cover entry, HTTP and body awaits, success, errors and final loading
updates. Returning through A to B to A cannot revive the first A read. Board,
profiles and role are installed together only when the response identifies the
captured human. Mismatched snapshots are suppressed before a new response arrives.

Workspace or human changes clear task selection and the composer. An old
creation callback cannot start an old-scope read or select its task in another
workspace; a current callback still refreshes and opens committed work. Browser
history navigation has the same reset, and unmounted shells remain inert.

Current HTTP, network and body failures clear board content, profiles and
role-dependent controls. The account menu says the role is unavailable rather
than substituting cached membership. Impeccable distill guidance keeps the error
state to one retry and preserves existing light/dark themes, on-demand details
and at most two default task actions.

## Clean verification

Exact `pnpm test:w03` passes 205 unit cases in 29 files and all 85 shared browser
cases. Nineteen new mounted cases cover deferred bodies, out-of-order reads,
old errors/finalizers, navigation, human mismatch and creation callbacks, with
healthy/current-creation controls. Re-authentication induced by changing the
public fetch prop is a test trigger, not a production refresh action.

The two new browser cases prove rendered suppression, current Reviewer role,
absence of stale Owner controls, selector focus and keyboard retry. The secondary
workspace is explicitly intercepted synthetic presentation data, not a second
canonical server authorization proof. Standard option selection avoids headless
native-popup limitations; native popup-key navigation is not certified.
The [light](browser-board/current-board-light.png) and
[dark](browser-board/current-board-dark.png) viewport captures show rendered
current content. Separate DOM assertions prove the two-action task budget.

Exact `pnpm test:c11` passes 2,317 stage invocation cases in 81 file invocations,
79 actual-D1 checks across eight harnesses and the separate notification
Worker/D1/Queue/DLQ drill. Its 41 structured labels are not independent acceptance
cases. C10 separately passes 86 cases and nine D1 checks; C08 passes 23 cases and
its Worker race proof. Full `pnpm verify` passes 4,441 TypeScript cases in 197
files, Go and all 16 Swift cases, without skipping selected platform checks.
Frozen install, before/after worktree checks, unchanged source and empty final
status pass. See the [manifest](browser-board-manifest.json) and
[command result](browser-board-command-result.json).

Before the correction, 15 of 18 mounted cases failed and three positive controls
passed. Two failures concerned unavailable-role copy rather than independent
security races. A subsequent healthy response identifying another human failed
against the initial correction and passes at the final source. Three initial
browser runs failed to choose a native option before reaching race assertions;
those driver failures are not production defect evidence. The final selected
clean gates pass at the committed source.

## Remaining activation gates

This checkpoint closes browser board selection coherence, not complete browser
session lifetime, profile-transport identity or private delivery. GitHub key
policy, execution-owned consumers, destructive private retention and natural
in-flight credential/lease expiry remain open. Private creation, sharing,
checkpoints, publication, project knowledge, skills, vault, reminders and
contribution views remain unfinished. No live pilot, provider, installed app
operation or deployment changed.
