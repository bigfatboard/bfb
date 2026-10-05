# ADR 0005 — Canonical session binding and truthful local agent-work writes

Status: Accepted for implementation under the already approved local-MVP scope
in [mvp.plan.md](../../mvp.plan.md), 5 October 2026. This status records
implementation authority, not new personal approval of this text or completed
A01 acceptance. It does not change package status.

## Context

[ADR 0004](0004-local-mcp-runtime-authority.md) connects the `local-mcp/2`
bootstrap reads through compiled stdio, typed daemon RPC, the possession-
authenticated Worker, WorkspaceHub and D1. The four A01 mutations remain
unconnected. [A01](../work-packages/WP-A01-local-mcp-context.md) is
`in_progress`; its historical journal tests do not prove production offline
permission or daemon-owned replay.

The current C08 work commands authorize a human or human-sponsored OAuth
delegation. Tasks and comments have nullable human/delegation author fields,
but no run author. Passing the launch requester as the acting human would
impersonate them. Progress comments currently retain only their body, although
the local tool advertises optional percent and confidence. The comments API
and editor also assume that every nondelegated comment is human-authored.
These are online-write closure requirements, not optional presentation work.

L06 durably binds the first trusted session-scoped hook to an execution and
generation. A turn hook may win before `SessionStart`; requiring that event
exclusively would reject an existing valid L06 observation. This local fact is
telemetry, not a canonical cloud provider-session command. Bootstrap reads
must not fabricate session records to enable writes.

C08's canonical `provider_sessions.execution_id` identifies one originating
execution. C09 resume creates another execution/generation and refers to the
existing canonical session. Its current source-session lookup uses the source
execution directly, so a second resume needs an explicit association rather
than another invented vendor conversation or a reassigned origin execution.

## Decision

### Negotiated local agent envelope

The general local RPC v1 envelope is closed. Installed app, CLI and daemon
binaries are not guaranteed to match: signature/team checks do not prove a
build version, and an existing daemon may keep running during a CLI upgrade.
Do not append the new payload fields to that envelope or claim lockstep
deployment. Freeze the committed v1 envelope, including the preceding read
slice, without rewriting its historical proof.

Introduce a separate closed `local-agent-rpc` document with `schema_version: 2`
on the same bounded Unix socket. Its version-qualified methods use the
`mcp.v2.` prefix for authority, context, task, session binding, bound authority
and the four specified writes. Declare all four write shapes in this version;
advertise only handlers actually installed. The new host uses this lane for
bootstrap reads too; the daemon may continue serving the existing v1 read
methods without giving them write authority. The public MCP tool names and
their `local-mcp/2` contract are unchanged.

Before sending a correlation token, binding or task content, the host calls
the existing v1 `daemon.status` method and requires the relevant version-
qualified methods in its response. Populate the already-declared optional
`methods` field with the registered methods; do not add a v1 field. A genuine
old daemon omits that advertisement and the host reports unsupported protocol
without attempting or downgrading the operation. This is capability
negotiation, not business authority.

The daemon validates the selected closed document and restricts v2 to its
fixed method set before dispatch. Every response, including errors, echoes
the request version, method and request ID. The client checks all three and
the existing native server/peer boundary. A daemon replacement cannot be
rescued by stale cached negotiation or a silent v1 fallback. Keep frame bounds,
duplicate-key/Unicode rejection and schema errors intact. Permit version 2
only for this named document; all existing documents keep their current
version checks. Swift app RPC stays v1. Catalog/generator metadata and mixed-
version negative fixtures must describe this document-specific transition;
the rest of `bfb-wire/1` is not implicitly upgraded.

Local-envelope version 2 is independent of the nested cloud operation
reference's `schema_version: 1`. Preserve read idempotency hashes exactly.
Offline permission and replay envelopes are not part of this version and
cannot later be appended as optional v2 fields without an explicit transition.

### Explicit canonical binding

Add a fixed internal `mcp.v2.bind_session` RPC mapped to the possession-
authenticated `work/session-bind` action. It is not an exposed MCP tool.
The host requests confirmation for its already-verified execution reference;
the daemon independently verifies the kernel caller and reads L06's trusted
`SessionReader`. Public tool arguments cannot supply a provider, observed
session, canonical session, run, execution, generation or actor identity.

The command runs through WorkspaceHub. Before any effect or cached outcome,
it checks the same current runner/requester grants and epochs, assignment,
final launch authority, execution/result and lease fences as ADR 0004. It
also validates the trusted observation against that assignment. The provider
must equal `execution_config.provider` from the immutable launch snapshot,
not the current mutable agent profile. Observed IDs retain L06's bounded
opaque-ID validation. Local observation time is reported provenance; the
server supplies confirmation time. Neither proves human verification, agent
activity, usage or completion.

Add an immutable `execution_session_bindings` table with one row per
`(workspace_id, execution_id, assignment_generation)`. It records the derived
run/runner, canonical provider-session ID, exact provider/observed-session
identity and bounded observation/confirmation provenance. Composite foreign
keys bind it to the immutable execution assignment and a provider session in
the same workspace/run. Add only the parent uniqueness indexes needed by
these foreign keys. Updates or deletion cannot silently rebind an execution.

The association is many executions to one canonical session. Do not make
`provider_session_id` unique across associations, require every associated
execution to equal `provider_sessions.execution_id`, or impose global
observed-session uniqueness. Preserve the canonical session's originating
execution; an observed provider ID is not a globally unique BFB identity.

For a first execution, the checked command creates the canonical observed
session only when no eligible row exists. One active, requested-only C08 row
for that execution/provider may instead acquire its observed ID exactly once;
its requested ID remains a separate value. One already-observed matching row
may be associated. Multiple eligible rows, a conflicting observed identity,
wrong provider or ended session fail closed; no heuristic merge or historical
backfill is allowed. Canonical creation requires the existing attached or
detached execution precondition. Binding does not itself attach an execution,
change the launch state, end a session or advance a run/result.

For resume, the command associates the new execution with the exact canonical
`launch.resume_session_id`. Provider, run, active session state and observed
identity must also match `launch.resume_observed_session_id` and the trusted
new-execution observation. It never creates a replacement conversation.
Narrowly change C09's source-session lookup to follow the immutable binding
when present, retaining the unambiguous legacy originating-execution lookup
for existing sessions without an association. An association that exists but
is invalid must not fall back. Test initial execution, first resume and second
resume with distinct generations and one unchanged canonical session.
Provider-specific conversation-tree/continuation identity is not guessed or
expanded by this decision; exact continuation still consumes C09's pinned
resume fields and the provider adapter's certified contract.

Local capability activation requires both the matching trusted L06
observation and committed cloud-binding confirmation. Lost confirmation can
be retried with the same deterministic binding operation identity. Identical
confirmation returns the same canonical ID; changed binding input is rejected.
A binding request or bootstrap read cannot invent a trusted local observation.

### Current bound authority and cached outcomes

Add a fixed read-only `mcp.v2.bound_authority` / `work/bound-authority` operation
for an activated connection's captured session reference. Every bound call,
including a locally cached write outcome, rechecks the current association,
canonical session state and exact provider/observed identity as well as the
existing run-authority fences. Bootstrap authority remains read-only and does
not create a binding. Binding confirmation is an explicit command, never a
write hidden inside an authorization hook.

Cloud write commands use a read-only authorization hook with fresh server
time inside the existing serialized Hub transaction before cached replies.
It validates current authority, binding and applicable policy. It does not
rerun a committed effect's original expected-version comparison or child-
count admission check: the operation's own success may have changed those
values. Those preconditions run only for a new effect after the idempotency
lookup. All necessary reads/preflight finish before staged D1 writes; no
nested command transaction or read after staged writes is introduced.

Terminal authority/session closure stays sticky. Explicit unbound/conflicting
session failures remain distinct. D1, Hub, connection and local storage faults
are sanitized retryable failures, not revocation or offline permission. Do
not convert every binding-source error into `session_not_bound`. Extend the
fixed route/daemon error mappings to preserve `stale_version`, session conflict,
policy, validation and child-limit denials as terminal operation outcomes,
not generic 503/offline errors. A denied operation is not itself proof that
the whole capability was revoked.

### Four online writes through shared C08 rules

Extend only the existing A01 tools: `bfb_update_task`, `bfb_add_comment`,
`bfb_report_progress` and `bfb_propose_task`. Each gets a fixed typed daemon
method and runner action. The daemon independently verifies its caller before
and after the network operation, derives the assignment boundary, compares
the trusted observation and forwards the confirmed binding. Runner credentials
and signing keys stay exclusively in the daemon; the MCP host receives no
authenticated generic proxy.

Extract only the C08 preparation/persistence helpers needed to share these
effects. Domain authority distinguishes human, delegated human and derived
`agent_run`; runner possession is the transport principal, not the business
author. Keep existing human/delegated command names, result shapes, rules and
idempotency behavior unchanged. Never call those commands by substituting the
requester as actor, a delegation or a system actor named after the run.

The permitted local effects remain bounded by the existing contract:

- Task update changes only title/punchline, with the existing optimistic
  version guard and 1–512-character bounds. Workflow, priority, due/owner,
  routing and promotion changes remain forbidden.
- Discussion comments keep the 1–2048-character C08 bound.
- Progress checkpoints keep that summary bound and retain optional explicit
  percent (0–100) and confidence (0–1). Absence is null, not zero. They are
  agent-reported values, never inferred activity, usage or result transitions.
- Root proposals remain `proposed` and require the effective workspace,
  project and repository policy to permit them. A child is under the exact
  bound parent and obeys C08's existing policy, state and 20-active-child
  ceiling. Priority is P0–P3; a proposal neither promotes nor launches work.

Caller convenience IDs must still equal the derived boundary. The proposed
task is a new target; the source task remains the run's bound task. Do not
pretend that a new proposal is already `runs.task_id`.

### Minimal durable run attribution

Add one immutable, fixed-purpose `agent_work_effects` sidecar table for exactly
`task.update`, `comment.add`, `progress.report` and `task.propose`. Each effect
records its stable operation key, derived run/execution/generation, confirmed
canonical session, project, source task, affected task, actual comment ID or
resulting task version as applicable, input hash and server creation time.
Only a progress effect has nullable percent/confidence with range checks.
Private body/title/punchline remain in the existing canonical business rows,
not duplicated in this provenance table.

Composite foreign keys enforce workspace/run/assignment/session association,
source and affected project/task identity, and comment-to-affected-task
identity. Fixed-kind checks require the appropriate target fields. Operation
identity is unique; a comment or proposal has one agent origin, and a task
revision cannot acquire contradictory agent attribution. A historical resulting
task version is constrained metadata with unique revision attribution, not a
foreign key to the task's mutable current `resource_version`. Business changes,
effect provenance, canonical idempotency outcome and Hub receipts commit in
the same batch or not at all. There is no unauthored intermediate commit.

For a newly created agent comment or proposal, human/delegation author or
creator fields remain null. Updating a human- or delegation-created task
preserves its original `created_by_human_id` and `created_by_delegation_id`;
the new revision's sidecar attributes the update to the agent without erasing
creator provenance. A sidecar is the authoritative run attribution, not an
excuse to label null as human. Extend ordinary comment reads with an explicit
author kind and bounded run/execution/session provenance; join the exact
committed effect.
Render human, delegated client and agent-run authors truthfully. A legacy row
with neither human, delegation nor agent provenance is unknown, not human.
Expose progress metadata through the same read path. Task proposal/revision
receipts expose their effect provenance without inventing a human creator.

These two additive sidecars avoid rebuilding tasks/comments and their many
tenant composite-FK consumers solely to add another actor variant. Adding
author columns alone would still not retain run-attributed task revisions or
progress metadata. This is not a generic polymorphic actor/event framework,
an independent business ledger or inferred legacy authorship. Existing C08
records stay canonical; the sidecar makes these exact A01 effects attributable.
The next ordered D1 migration must preserve all existing rows and verify both
empty-database and previous-head upgrade paths.

### Stable identity, bounded wire and private receipts

Cloud operation identity remains the existing `agent:` SHA-256 key with the
same canonicalization and exactly `tool`, `schema_version`, execution ID,
assignment generation and original request ID as hash inputs. Preserve today's
read hashes byte-for-byte so an upgrade cannot duplicate context deliveries.
Write payload and confirmed session reference belong in the separately checked
input fingerprint, not the operation key. Changed payload/session under the
same scoped identity is rejected even after MCP/daemon restart. Credential
renewal does not create another operation; current credential authority is
checked independently. The binding command also has one stable assignment-
scoped identity with independently fingerprinted observation input.

Retain the 8–128 ASCII request-ID primitive, closed generated method-specific
schemas, JSON-RPC/stdout purity and existing 256 completed-request admission
bound. No new action accepts an arbitrary URL, HTTP verb, command, executable,
principal or unvalidated extension object. Bound complete encoded write
requests to 16,384 bytes and complete local IPC envelopes to the existing
65,536 bytes, including JSON escaping and wrappers. Character limits alone
are insufficient. Validate and reject oversized input/result before effects;
never silently trim body, metadata or receipts. Deterministic positive and
negative fixtures are owned by `pnpm protocol:generate` / `pnpm protocol:check`.

Full authorized outcomes remain in canonical idempotency storage. New binding
and write audit/semantic/outbox receipts use explicit safe input/result
projections: bounded IDs, kind, hashes, versions, state and progress metadata,
not private comment/progress bodies, task titles, punchlines, raw hook payloads,
local paths or credentials. Preserve the authenticated runner and derived run
as separate identities. Do not broaden this into unrelated C08 receipt rewrites.

## Implementation boundary and proof

The first vertical change connects canonical binding and a discussion comment,
including migration, truthful comment reads/display and the real compiled
stdio → daemon → possession-authenticated Worker → Hub/D1 proof. Then connect
the remaining three writes and progress metadata through the same shared
helpers, schema and attribution model. Both steps belong to A01; no provider,
attention, result, release or deployment package is started by this decision.

Required regressions include:

- New host plus old daemon fails before private input; old app/CLI and existing
  v1 reads still work with the new daemon. Reject mismatched document/version,
  wrong-version replies, unadvertised methods, duplicate/ambiguous framing and
  downgrade attempts without business effects. Generated v1 fixtures remain
  unchanged; generated v2 fixtures cover every declared fixed action.
- No binding/business mutation from bootstrap reads, absent observation,
  competing observation, wrong provider, owned wrong correlation/generation,
  foreign process, cross-run/project/workspace input or caller session claims.
  A trusted turn-before-SessionStart observation remains bindable.
- Actual L06 validation/capture plus explicit binding, not direct test insertion
  of `hook_observed_sessions` as the production proof; all four compiled tools
  persist one correct business effect/provenance row. New agent comments and
  proposals have null human/delegation authors or creators; agent updates
  preserve the task's original creator fields. Normal API/UI labels remain
  truthful and progress metadata round-trips. Later task updates leave retained
  historical revision attribution valid without a mutable-version foreign key.
- Repeat resume retains one canonical conversation across distinct executions;
  wrong resumed observed ID or canonical target fails closed. An ambiguous
  legacy session set is not guessed or silently backfilled.
- Remote binding/write commit followed by response loss, MCP exit or daemon
  restart returns the original outcome on unchanged-ID retry with one effect.
  Changed typed payload or captured session is rejected after cache loss.
  Existing read delivery IDs and cache saturation/fingerprint checks stay green.
- Concurrent identical requests deduplicate; changed fingerprints conflict;
  distinct updates to the same expected version produce one success and one
  stale-version rejection. Child admission serializes, and a cached successful
  twentieth child remains replayable without rerunning its original count gate.
- Current requester/runner grant and epoch changes, canonical session closure,
  execution end, terminal result and lease expiry deny even cached local/cloud
  outcomes. Transient database/Hub faults stay retryable and never authorize
  queuing or permanently revoke a valid capability.
- Migration/foreign-key/immutability checks preserve legacy rows and reject
  mismatched provenance. Failed preparation or oversized escaped envelopes
  leave business/effect/idempotency rows unchanged. Audit/outbox receipts and
  subprocess environments contain no prohibited payload or credentials.

Run the expanded exact A01 target, affected C01/C08/C09/L06/L08 and UI checks,
repository verification and clean-checkout proof with retained complete logs
and bounded synthetic evidence before claiming this online slice shipped.
Synthetic provider-shaped processes are sufficient for this runtime boundary;
they are not live-provider or exact vendor-continuation certification.

## Remaining A01 obligations

This first implementation slice is online-only. Production offline policy
remains deny-by-default: unreachable cloud/daemon returns a visible offline
failure, not `pending_sync`. Neither a successful online write nor an outage
grants queue permission. This decision does not widen offline policy or claim
that injected replay tests prove daemon-owned recovery.

A01 remains `in_progress` after these writes until explicit versioned offline
policy and its authorized update path, complete daemon-owned capture proof,
scoped durable journal identity/migration, bounded exclusive draining and
crash-safe terminal acknowledgements are implemented and independently proven.
Replay must preserve the original confirmed session/assignment/principal and
recheck current authority/policy; old incomplete captures cannot acquire new
permission. Online uncertain-response deduplication is required here, but is
not acceptance of the pending-operation replayer. Historical package evidence
and blocked-descendant accounting remain unchanged until complete acceptance.
