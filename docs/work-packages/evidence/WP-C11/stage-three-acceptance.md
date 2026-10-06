# C11 partial metadata checkpoint

Tested source: `1e6b710a0b7dbe040632a1a00b71398ecd39b1c3`.
Protocol: unchanged `bfb-wire/1`. D1 head: `0045_private_task_authority`.

This checkpoint adds exact result-reference authority and partial notification,
GitHub and operations content fences to the historical child-delivery proof.
It is **not complete C11 acceptance**. C11 stays `in_progress`; private creation,
creator sharing and author-private checkpoints remain unavailable. C12 stays
planned. Tests use synthetic policy rows, not a privacy activation switch.

## Covered boundaries

| Boundary | Proof |
| --- | --- |
| Exact result evidence | Recognized `artifact_version` references bind one immutable version to its artifact; absent, hidden, foreign, dangling and wrong-binding sources have the same resource denial |
| Credential and source ceilings | Direct humans retain authorized shared cross-task and run-free references; delegated sources retain current scope and exact boundary; local agents stay within their originating run |
| Cached result delivery | Current authenticated input reauthorizes the actual retained references after cache hydration; inaccessible references do not return from stored outcomes |
| Atomic result submission | Independent source privatization after preflight, before real-D1 batch execution, rolls back submission, task/run state, semantic receipt, audit, outbox and idempotency writes |
| Immutable result history | Invalid or inaccessible recognized references are omitted without rewriting stored rows; scalar, non-array, duplicate-key and unsupported shapes cannot bypass the projection |
| Notifications | Private subjects remain unavailable even to creators and grantees; fanout, retry, signed push contact, native pull/ack and history check current parent and recipient authority |
| Notification preference | Final contact checks use the effective current project/workspace preference, not a retained preflight choice |
| GitHub evidence | Requested and retained task association are checked before write/cache and commit; private history is omitted before pagination and all verification references are selected together |
| Operations activity and stuck work | Shared-only exact-parent selection filters activity before pagination and rechecks hydrated upload/launch references together after other awaited reads |

Same-batch stale-authority guards use the existing `command_failed` transaction
outcome. They do not introduce a new semantic reference-error contract or modify
historical receipts. D1 expression-depth failures were reproduced and repaired
with separate authority guards and MATERIALIZED history boundaries, without
weakening authority or changing database limits.

## Clean verification

Exact `pnpm test:c11` passes 1,079 focused/regression cases in 54 files and
20 production-Hub/real-D1 checks. Separate retained C10 and C08 invocations pass
86 cases with nine D1 checks and 23 cases with their Hub race proof. These counts
overlap and are not a unique combined total.

Affected exact gates also pass: X01 notification runtime and Go regressions,
X04's 13 Worker scenarios, X05's 11 Worker drill scenarios and four browser
cases, and X03's 11 Worker/D1/R2 checks and two OAuth browser cases. These runs
do not settle the held dependency status of X01, X04 or X05. Historical evidence
remains intact; the current notification harness reports its migration-head
regression separately.

Full `pnpm verify` passes 3,420 TypeScript cases in 172 files, Go checks and
all 16 Swift cases. No platform check is skipped. Frozen install and clean
worktree checks pass before and after the sequence; the tested committed source
is unchanged. Aggregate command counts and scope are recorded in
[the command result](stage-three-command-result.json) and
[the manifest](stage-three-manifest.json).

## Remaining activation barriers

Natural credential or lease expiry while a D1 batch is already in flight is
**not certified**. A short real-wall-time reproduction still succeeds after
natural expiry when the batch itself is delayed. Changed expiry rows and
revocation are fenced, but they do not prove execution-clock freshness. The
shared prepared-time semantics require a coordinated temporal-boundary repair
and proof before activation.

Opaque recipient positions, cursor-derived notification identities, GitHub's
unbound evidence-key collision policy, operations aggregate counts, security
audit, diagnostics, retention/recovery and coordination consumers remain open.
The full matrix and creation/sharing/internal-progress controls must pass
together before private work is available. No route is disabled merely because
a private fixture exists, since that would itself expose presence.

## Evidence limits

Real-D1 proofs cover synthetic production domain/Hub queries and atomic writes.
Authenticated mounted transports and browser regressions are separate proofs;
they do not establish a deployed private workflow. R2 authority races use
bounded doubles, not live private byte delivery. Notification/GitHub doubles do
not contact real external recipients. No provider launch, remote start, agent
discussion, pilot operation, deployment or external CI is claimed. This slice
adds no UI or remaining knowledge, skills, vault, reminder or contribution
feature. Only bounded counts, source identity and proof labels are committed.
