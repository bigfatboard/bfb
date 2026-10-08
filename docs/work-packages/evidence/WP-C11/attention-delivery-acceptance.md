# C11 delegated attention read checkpoint

Delegated attention reads now return a current canonical record after every
advisory await. The final SELECT retains the original task, project, run,
execution and assignment generation while repeating current read authority
and the original OAuth restrictions. It does not create business state.

Tested source: `3a2b0a6e01451938b4a735bc78bc547d2a6cc110`.
Protocol: unchanged `bfb-wire/1`.
D1 head: `0047_security_audit_positions`; no migration added.

C11 remains `in_progress`. Private creation, creator sharing and author-private
checkpoints stay disabled; C12 remains planned.

## Regression and historical access

Seventeen domain and seventeen authenticated mounted MCP cases pass.
Read-only Owner, Member and Reviewer controls preserve open, answered and
resolved requests, including older ended executions and cancelled runs.
Reading history does not require a live lease, latest execution, requester
equality or permission to answer.

Production delegation revocation after preliminary selection withholds the
body. Current read scope, client, original nullable boundaries, private read
grant, epoch and project access remain restrictions. Private grant, epoch and
project loss after the last successful advisory read are separately witnessed
races. A real answer committed during the read returns the new canonical
answer rather than the preliminary state.

Eighteen actual-D1 groups mount the compiled OAuth MCP handler in the test
process over native bound statements. An unchanged credential live when final
SQL is prepared naturally expires before execution; a delayed live control
remains readable. Missing and denied records share the same bounded error.
Business history and cursor snapshots stay unchanged by reads; independently
committed permission and answer changes remain.

The final selector matches retained business lineage and joins the exact
historical immutable assignment. Attention rows themselves are mutable.
Misbound canonical rows and synthetic parent changes are robustness controls,
not claims that such changes are reachable through business commands.

The final mounted suite was replayed against committed unfixed production
runtime. Thirteen of seventeen cases failed, with four healthy controls:
nine unauthorized-body responses, one stale answer and three already-denied
advisory responses with the wrong wire. The last three are not exposure
proof. This is a regression probe, not old-source package acceptance.

## Clean verification

Exact `pnpm test:c11` passes 2,427 stage cases in 91 file
invocations, plus C10 and C08 dependency gates. Twelve stage D1 harnesses pass
140 checks. The separate notification drill passes; its 41 record labels
include setup and repeated dispatch rather than 41 independent cases.
Exact X03 passes 71 unit cases, 11 Worker/D1/R2 checks and both
OAuth browser cases.

Full `pnpm verify` passes 4,551 TypeScript cases in 207 files,
Go and all 16 Swift cases without skipping selected platform checks.
Frozen installation, before/after worktree checks, unchanged source identity
and empty final status pass. The previous interrupted run's handle and
temporary logs were unavailable; only the fresh complete run is certified.

The additive `pnpm test:c11:attention-delivery` is composed once by C11.
Its native-D1 witness records 24 bindings and 4,902 SQL bytes.

See the [manifest](attention-delivery-manifest.json) and
[command result](attention-delivery-command-result.json).

## Remaining gates

This proves the final attention read statement, not authority after that
statement, other OAuth tools or private activation. Genuine OAuth admission
and compiled MCP are mounted in the test process; a real HTTP Worker OAuth
ingress race is not claimed. No cached command or rollback of an independent
answer or permission change is implied.

The next slice is final `bfb_get_task` delivery, followed by delegated task
and project list selection. GitHub collision policy, execution-owned consumers
and destructive private retention remain open. Publication, project knowledge,
skills, vault, reminders and contribution views remain unfinished. No fresh
UI certificate, installed-app operation, live pilot, deployment or external
CI is included.
