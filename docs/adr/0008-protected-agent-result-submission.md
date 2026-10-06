# ADR 0008 — Protected agent result submission and recovery

Status: Accepted for implementation under the approved local-MVP scope in
[mvp.plan.md](../../mvp.plan.md), 6 October 2026, following independent runtime
and protocol review. This is not completed A03 acceptance, permission to enable
offline submission in a real workspace, or Terminal/live-provider certification.

## Context

A01 and A02 now have connected runtime certificates. A03's retained domain,
human review and UI implementation does not connect its production MCP/CLI
submission paths: the tool is unsupported and `run submit` returns
`not_implemented`. Historical unsigned result journal rows cannot become
protected intents. ADR 0006 admits exactly four task writes, not results.

Submission changes a run from open/changes-requested to submitted and its task
from active to review. An acknowledgement may be lost after this transition.
Using launch-start eligibility for reconciliation would reject the original
request immediately after its own successful effect. Conversely, current
nonterminal read authority alone cannot authorize a second new submission.

## Decision

### Separate default-denied result policy

Add closed `offline_agent_results` to the existing workspace, project and
repository policy model:

```json
{
  "allow_submit_result": false,
  "max_pending_age_seconds": 0
}
```

False requires zero; true requires an integer age from 1 through 300 seconds.
Project/repository settings can only deny or shorten their parent. Both
`offline_agent_work` and `offline_agent_results` remain independently complete
settings; no task tool permission or omission grants result permission.

Add D1 migration `0040_offline_result_policy` with explicit false/zero values
for existing current and historical policy rows. Do not rewrite historical
repository canonical JSON/content hashes or launch-snapshot v1 bytes/hashes.
Resolve omitted repository result policy as deny, not inherited permission.
The existing launch projection stays unchanged. Read permission from the exact
immutable policy versions referenced by the snapshot and require the approved
repository hash to match its snapshot hash before offline admission.

Move sensitive policy/repository update targets to version 3, binding action,
scope, expected version, all normalized existing settings and both independent
offline families. Old target proofs cannot authorize the new shape. Require
the complete settings on policy updates. Repository reports explicitly naming
either family require the new action-bound proof, including explicit deny;
omitting both preserves the existing authorized reporting path with denied
offline permission. Current authority precedes cached outcomes. Validate and
consume new proofs inside the serialized Hub batch with guarded policy heads,
immutable versions and idempotent outcome, as in ADR 0006.

### Closed result-only transport

Add `local-agent-result-rpc` version 5 with exactly `mcp.v5.submit_result` on
the existing checked socket. Negotiate it on that socket before private input;
no fallback or widening of v1/v2/v3/v4. Its local request contains:

```text
{correlation,
 request:{reference, summary, limitations?, evidence_refs?,
          git_branch?, git_commit?, git_dirty?},
 expected_binding?}
```

`reference` is the existing execution/generation/request identity. An activated
MCP host supplies `expected_binding` as an assertion, not authority. A fresh
one-shot CLI omits it. The daemon independently checks the kernel caller's
process/parent/group/start identity, correlation, immutable assignment, actual
native ownership and trusted L06 observation. It derives the canonical binding
and adds required `binding` to the closed original cloud business request.
No client supplies policy, capture time, session observation, key or signature.

Introduce separately named `agent-result-request`, `agent-result-local-request`,
`agent-result-result`, `agent-result-confirmation-request`,
`agent-result-confirmation-result`, `agent-result-capture`,
`agent-result-replay-request` and `agent-result-receipt` documents. Fixed
possession-authenticated cloud actions are `work/result-submit`,
`work/result-confirmation` and `work/result-replay`. Confirmation/replay/signing
are daemon-only, never new provider-facing tools or an arbitrary proxy.

The operation key follows ADR 0005's algorithm with action `submit_result`,
original operation schema version, execution, assignment generation and original
request ID. The business command remains `result.submit`. Fingerprint exact
canonical original typed input including binding, omissions, whitespace and
evidence order, before the existing business text normalization. Online send,
explicit uncertain retry and protected replay use the same key/fingerprint.
Never allocate a new identity or submission version merely to recover a reply.

Return a bounded committed projection: submission ID/version, submitted/review
states, current effect versions and exact agent origin. No private summary,
limitations, reference body or review comment belongs in the journal outcome,
audit, semantic-event or outbox projection. Normal authorized result reads and
the necessary Hub idempotent result retain the business record.

### Authority and transition eligibility are distinct

Every agent request, replay and cached-result delivery checks the current
runner/key/token, runner-owner/requester membership and grant epochs, latest
assignment generation, actual live execution, final launch scope, exact current
policy versions, current unreleased lease/fence and canonical session. Reuse
`reauthorizeActiveRun` for nonterminal authority; do not broaden the original
launch/task-capture eligibility helper. Local checks run before admission and
again after network/signing waits before delivery or durable capture.

The result confirmation carries separately derived `can_submit`: true only
when the run is open/changes_requested and its task active. It may return false
for a currently authorized submitted run so an existing original intent can
reconcile. New intent admission requires true. A protected capture contains
the original true value and canonical confirmation; current authority equality
may ignore this derived mutable eligibility value, but not scope, binding,
policy, key or authorization identity. Cloud new-effect transition checks
remain authoritative and run only after the idempotency lookup. A new request
in submitted state cannot create another version; the identical original
request can recover one stored submission. Terminal results deny agent access.

All five result commands gain current-authorization-before-cache and business
input fingerprints. Keep direct-human submission/review semantics: reviewers
may request changes, never submit/accept/fail/cancel; members/owners with project
access may do those actions. No agent review command exists. Human cache
authorization rechecks role/project/epoch, not the already completed business
transition. No provider/transport ending infers submission or acceptance.

Agent authorization reads checkout authority but never mutates/releases it.
Agent submissions bind configuration to their exact authorized launch snapshot;
direct-human submission retains its existing latest-run-snapshot semantics.
Submission or human acceptance cannot release a live local flock/cloud lease;
verified process-end/recovery remains the owner's responsibility.

### Genuine confirmation without fresh-client offline deadlock

Use a result-specific complete confirmation, not A01's four-tool permission.
It carries the derived scope/session, snapshot/policy references, actual and
approved repository hashes, requester/runner identities and epochs, key,
lease/credential expiries, confirmed time, configured result policy and
`can_submit`. Its canonical Hub outcome is retained for at least 345 seconds.
Replay compares that original outcome and independently derives current facts.

Use ADR 0006's suspend-inclusive capture timing: the earliest of original lease
expiry, credential expiry or 45 seconds from the original request send anchor.
Repeated clients cannot renew that anchor. Capture time derives from confirmed
server time plus elapsed time after receipt. Clock faults, sleep-boundary
failure, delayed signing or missing anchors reject new capture. A daemon
restart discards new-capture permission but preserves previously signed intents.

A fresh CLI cannot pass A01 Host activation while offline, so it uses the
read-only startup/environment checks plus v5 daemon admission directly, not
`Capability.allowWrite`. A matching live result confirmation supplies the
canonical binding only after fresh kernel/assignment/native/L06 checks. Missing
confirmation, an A01-only confirmation or a mismatched expected binding rejects
offline submission without any intent. Online first-time binding uses the
existing fixed trusted-observation binding command, never caller-invented
session state. Existing original intents supply their signed binding for retry;
reconciliation does not require a new launch-eligible binding operation.

Prime result confirmations as optional daemon work after a successful canonical
bind has passed peer/native/L06 postflight and response validation, and after a
genuinely online verified task-work confirmation. Do not use a pending fallback.
Use one daemon-lifetime worker, a queue of at most 16, per-assignment singleflight
and a cache of at most 1024 entries. Prime only missing/expired proof; repeated
calls do not slide a valid window. Queue overflow, timeout or failed optional
priming cannot change a successful bind/write response. Do not hold the A01
work mutex over this network work. Each actual prime gets a fresh daemon ID and
its own timing/pre/postflight checks. Immediate outage before proof arrives
still rejects: binding alone is not an offline availability guarantee.
Known authority/session/policy denials invalidate matching cached proof and
any in-flight publication generation; a late prime response cannot resurrect
it. Shutdown cancels and joins this worker before closing journal/SQLite state.

Existing identical signed intents may be retried by a newly verified CLI/MCP
client after client or daemon restart. Verify original signature, identity,
fingerprint and binding against current local facts; preserve original mode,
capture expiry, dispatch and effect history. Offline retries may return a safe
unavailable/uncertain receipt, never private cached success or renewed capture
permission. New intents after daemon restart require fresh live confirmation.

### Protected capture, shared quota and truthful recovery

Reuse the daemon-only enrolled P-256 signer with a distinct
`BFB-AGENT-RESULT-CAPTURE-V1` transcript domain. The closed signed metadata binds
the full original request digest, operation identity, result tool/schema,
complete result confirmation, admitted policy/mode and capture/expiry times.
No arbitrary signing/key-selection RPC is exposed. A task capture/confirmation
cannot substitute for a result proof, even with the same run and valid key.

As in ADR 0006, record an immutable signed `online_only` or `offline_admitted`
intent before any send, and durably record dispatch before network I/O. Online
only admits false/zero and null expiry; failure cannot upgrade it to offline
permission. Pending result capture creates no cloud submission/version/task
transition. Only `result.submit` inside WorkspaceHub creates business state.

Use one daemon journal with explicit capture family/schema, upgraded atomically
from 13 to 14. Preserve all A01 intent/capture bytes, operation keys, outcomes,
dispatch markers, claims and legacy history. Rebuild affected bounded tables
transactionally with foreign keys, indexes, immutable-history triggers and
schema/layout identity verification intact; do not edit published migration
013. Unsigned legacy result rows stay terminal history or quarantined unknowns,
never signed/promoted. Failed/interrupted migration leaves the old journal
usable or explicitly rejected, never partially adopted.

Share existing admission limits across both families: 256 unresolved per run,
1024 unresolved per daemon and 10,000 retained rows including retained legacy
history. Existing identities still receive authority/fingerprint checks at
capacity; unknown outcomes are never erased. One exclusive replay scheduler
claims bounded batches with original identities and checked acknowledgements.
Do not create independent result quotas or competing uncoordinated drainers.

Result encoded UTF-8 limits: confirmation request 2048 bytes, confirmation
result 4096, original bound request 32768, replay request 49152, signature
transcript/capture 8192, receipt 2048 and local envelope 65536. Existing A01
bounds stay unchanged. Check encoded bytes before signing/storage/send as well
as the business character/reference limits. Reject oversized input; never
truncate it or sign one representation and send another.

Marker failure sends nothing. A lost/unstored acknowledgement retains unknown
effect, including after expiry, revocation or terminal closure. Durable success
is an internal fact, not permission to disclose it after revocation. Replay
uses fresh current authorization and ordinary same-owner lease renewal; it
cannot recreate a lease, extend a generation or replay old liveness. Expired
offline intent never falls back to a new online operation. Missing/corrupt
history fails closed; signed capture is not tamper-proof delivery history or
protection against deletion/rollback.

## Required acceptance

- Protocol TS/Go agreement, closed v5 negotiation and cross-family substitution
  negatives; old wire documents/fixtures stay deterministic and unchanged.
- Default denial, complete V3 step-up targets, tightening, exact policy/hash
  binding, empty/populated migrations and unchanged historical snapshot bytes.
- Actual MCP and one-shot CLI through signed daemon/Keychain, genuine L06
  observation and real local Worker/Hub/D1: one submission, exact retries,
  immutable changes-requested/resubmission cycle and human acceptance.
- Actual fresh CLI during permitted outage, no prior/A01-only/expired proof
  denials, client restart preserving anchors, daemon restart denying new capture
  while retaining admitted work, and authorized replay after ordinary renewal.
- Lost committed response/restart, changed input, same request ID in other runs,
  actual submitted-state retries, terminal/revoked/session/native-lock denials,
  marker/acknowledgement failures, delayed signing and privacy canaries.
- Shared quotas, concurrent claims, no permission upgrades, original v13 signed
  task-row byte preservation, empty/legacy/interrupted v14 migration cases.
- No process/session/hook-based result inference; acceptance closes agent writes
  while the real held lock survives. No Terminal automation or live provider
  turn is required or implied by synthetic native acceptance.
- Exact expanded `pnpm test:a03`, affected A01/A02/policy/runner gates, full
  `pnpm verify`, Linux build and committed clean-checkout evidence before done.

## Platform references

The existing Hub stages guarded mutations into D1's atomic batch; this decision
does not replace it with a second canonical store or hold an interactive SQL
transaction across network I/O. See [D1 database batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/).
New D1 migrations preserve foreign-key validity; local daemon journal rebuilds
use native SQLite transactions, not assumed D1 PRAGMA behavior. See
[D1 foreign-key constraints](https://developers.cloudflare.com/d1/sql-api/foreign-keys/).
