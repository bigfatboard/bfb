# C11 historical attention measurement lineage

Attention-derived run, task and aggregate measurements now require the exact
retained workspace/project/task/run/execution/assignment-generation relationship.
Malformed stored requests contribute neither source metadata nor observation
counts, latencies, blocking waits or aggregate counts. Their historical rows are
not repaired, rewritten or deleted.

Production source: `6ebe0dc78ba088597ceec6c1bfe4743edd04296f`.
Tested clean source and historical-fixture repair:
`c4747a903a371ad485eeffee203e0f24bd58f377`.
Protocol: unchanged `bfb-wire/1`.
D1 head: `0047_security_audit_positions`; no migration added by this slice.

C11 remains `in_progress`. Private creation, creator sharing, inherited private
children and author-private checkpoints stay disabled; C12 remains planned.

## Exact retained lineage

One complete predicate governs run attention rows and their observation count,
task attention/intervention rows and aggregate attention counts. A declared
readable task or run cannot substitute for its retained private execution and
immutable assignment. Foreign-key validity alone does not prove that relationship.

Canonical resolved history on ended executions remains measurable. No active
runner, latest assignment, live lease or open attention/result is required.
Current parent ACLs and final authority checks, interval/token arithmetic,
observation clocks and held public `sources:null` remain unchanged.

The focused target passes 99 cases in five files, including five new domain
cases and existing measurement/route controls. Four independently collecting
native-D1 groups pass with `C11_MEASUREMENT_ATTENTION_D1_OK`: canonical ended
history, two task/run mismatches, and a coherent declared shared tuple retaining
a private execution/assignment. The fixtures use the same project so task privacy
is not accidentally proved by project restrictions.

Complete run/task/aggregate projections, observation counts, waits and kind counts
remain equal after each malformed source is inserted. Native read statements use
at most six bindings and 4,116 SQL bytes, below the 100-binding/100,000-byte limits.
These bounds cover instrumented measurement reads, not every setup/snapshot query.
Production Hub task/run setup, clean foreign-key checks and full canonical-table
snapshots prove read-only filtering without changing stored source rows. Ended
execution/assignment and dormant privacy fixtures are synthetic; no provider,
runner, lease or live ingestion operation occurs.

## Committed OLD and historical-fixture repair

The final same-project five-case probe was replayed against committed unfixed
source `6fb6623991c5540c27e6f2a5f71488cd844cca5f`: four meaningful failures and
one healthy control. Failures expose changed run/task metadata, kind counts,
aggregate cells and waits from misbound private history, not a claim of question
prose delivery. The eleven soft-assertion failure blocks are four failed tests.
Neither the full 99-case target nor the four native groups were replayed on OLD.
Earlier different-project draft probes are excluded.

The earlier `IOvaFa` clean attempt at `6ebe` passed C11 but failed A04 because its
pre-0027 migration fixture invoked modern task creation without privacy tables.
It is not acceptance. The successor `c4747a9` narrowly repairs A04 and A02
historical setup with explicit full old-schema task rows, exact before/after
retention and foreign-key checks. Modern post-upgrade commands are unchanged;
there is no production fallback, policy relaxation, schema or clock change.
Routine capture preserves dated evidence and uses ignored output unless opted in.

The initial focused driver's invalid `RunRecord.created_at` assumption was
repaired by reading the actual stored run row. A preliminary repaired A04 drill
also ended on an unsupported eslint driver command. Both failed drivers are
excluded; the completed exact combined pipeline is the acceptance record.

## Completed shared clean pipeline

The unchanged clean checkout records
`C11_ATTENTION_HISTORY_CLEAN_CERTIFICATE_OK` and terminal exit zero. Frozen
installation, exact C11/A04/A02/X03, full verification, before/after worktree checks
and empty final status pass at `c4747a9`.

C11 passes 3,004 stage-case invocations in 121 file invocations across nineteen
Vitest blocks, plus six retained panel Chromium cases. C10 passes 86 cases and
nine D1 checks; C08 passes 23 cases and its native proof separately. Eighteen
stage D1 harnesses pass 214 checks, including this slice's four groups. The
notification drill's 41 setup/dispatch/redaction labels are separate, not 41
independent acceptance cases. Repeated suites are not unique-test totals.

A04 passes 1,154 protocol cases, 138 focused cases, five Node evidence tests,
three Chromium cases and its native capture/daemon/possession/Worker/Hub/D1 proof.
A02 passes the same 1,154-case protocol dependency, 95 focused cases, seven Node
evidence tests, three Chromium cases and its native proof. X03 passes 71 cases,
eleven Worker/D1/R2 checks and two browser cases. Full verification passes 4,788
TypeScript cases in 220 files, Go and all sixteen Swift cases without skipping
selected platform checks.

The shared pipeline also contains separately owned human-attention-history
source and proof; those are not additional measurement capability claims. It
does not contain later `a150` browser task-collection work or a fresh W03 target.
Previous UI and historical evidence remain unchanged.

See the [manifest](measurement-attention-manifest.json) and
[command result](measurement-attention-command-result.json).

## Remaining boundaries

Human attention-detail delivery, other measurement-source lineages, ingestion
and mutation authority, execution consumers and broader temporal/lease boundaries
remain outside this corrective proof. Native domain reads are not mounted human
authentication, live-provider/private-byte operation, deployment or persistent
pilot acceptance. GitHub key policy, execution-owned delivery, destructive
private retention and complete C11 activation remain open.
