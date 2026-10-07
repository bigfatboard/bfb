# C11 delegated attention commit authority checkpoint

Delegated attention creation now repeats current authority, permitted run state
and the exact historical waiter tuple inside its committing D1 batch. A separate
database-clock guard requires the retained credential to remain unexpired.
Write-only requests, Owner/Member/Reviewer access, prepared observations and
exact retries are preserved. Artifact publication retains its narrower role
ceiling and existing target checks.

Tested source: `0e987c9afd204328eff938904a6d37210d50f89a`.
Protocol: unchanged `bfb-wire/1`.
D1 head: `0047_security_audit_positions`; no migration added.

C11 remains `in_progress`. Private creation, creator sharing and author-private
checkpoints stay disabled; C12 remains planned.

## Regression and rollback proof

Eleven domain and seven authenticated mounted MCP cases pass. Delayed healthy
requests retain their observations and commit once; exact retries return the
original record, while changed inputs reject. Independent production revocation,
epoch/project/scope/boundary changes and private contribution loss deny before
effects without erasing the independent change. Failed keys succeed after a
valid new contribution grant restores authority.

Fourteen actual-D1 checks use native bound statements. An unchanged credential
is live on batch arrival and naturally expires before the guard executes; the
request, observation, semantic/audit/outbox/idempotency and cursor roll back.
Submitted review questions and legally ended execution context remain valid.
An immutable assignment is context, not a requirement for an active/latest
execution, matching requester or live lease. The temporal claim is limited to
the guard statement, consistent with [SQLite clock behavior](https://www.sqlite.org/lang_datefunc.html)
and [D1 batch rollback](https://developers.cloudflare.com/d1/worker-api/d1-database/).

Unchanged production source with the new reproducers produces 11 expected
failures and seven healthy passes in the focused suites; corrected D1 probes
produce eight expected failures and six healthy passes. These are local
regression observations, not old-source package certificates. The initial D1
submitted-run setup used an insufficiently scoped result credential and is
excluded; a human result command now prepares that attention control. Initial
clean C11 also caught a historical September expiry in a healthy parity fixture.
Only that expiry now uses the existing database-relative window, preserving the
historical work clocks. Fresh final certification passes.

## Clean verification

Exact `pnpm test:c11` passes 2,362 stage cases in 87 file invocations, plus C10/C08
dependency gates. Ten stage D1 harnesses pass 110 checks. The notification drill
passes separately; its 41 record labels include setup and repeated dispatch,
not 41 independent cases. The new additive `pnpm test:c11:delegated-attention`
is composed once. Its D1 statements remain bounded at 25 bindings, 6,497 SQL
bytes and 11 batch statements.

Exact X03 passes 71 unit cases, 11 Worker/D1/R2 checks and both OAuth browser
cases. Full `pnpm verify` passes 4,486 TypeScript cases in 203 files, Go checks
and all 16 Swift cases without skipping selected platform checks. Frozen
install, before/after worktree checks, unchanged source identity and empty final
status pass. See the [manifest](delegated-attention-manifest.json) and
[command result](delegated-attention-command-result.json).

## Scope and remaining gates

This checkpoint certifies command-local creation guards, not every later
statement, cached/read response delivery or private activation. OAuth races are
authenticated mounted requests using staged SQLite; actual D1 is separately
proven through domain/Hub. Provider, runner and lease behavior is unchanged.

Delegated context delivery is the next product slice to reproduce. GitHub key
policy, execution-owned consumers, destructive private retention and other
delivery/expiry boundaries remain open. Publication, project knowledge, skills,
vault, reminders and contribution views remain unfinished. The approved
Impeccable UI direction carries forward without fresh UI certification here.
No live pilot, installed app, deployment or external CI was operated.
