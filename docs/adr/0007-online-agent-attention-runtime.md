# ADR 0007 — Online agent attention through the authenticated runtime

Status: Accepted for implementation under the approved local-MVP scope in
[mvp.plan.md](../../mvp.plan.md), 6 October 2026. This records the A02 integration
decision, not completed acceptance, a production rollout or live-provider proof.

## Context

A01's runtime is certified, but production attention tools remain explicitly
unsupported. Historical A02 tests prove isolated records, human APIs and UI,
not the compiled stdio/daemon/runner connection. Its host also memoizes attention
reads and checks its wait deadline only after a network read. Neither behavior
proves a fresh, bounded human-answer loop.

Attention requests deliberately stay online-only. ADR 0006's protected journal
admits exactly four task-mutation tools; an attention question cannot acquire
offline permission or be delivered autonomously after its caller exits.

## Decision

### Closed transport, existing business state

Add a separate closed `local-agent-attention-rpc` envelope with version 4 on the
same checked socket. Its only methods are `mcp.v4.request_human` and
`mcp.v4.get_attention`. Negotiate each call against that daemon's advertised
methods before private input is sent, with no fallback to an older envelope.
Keep v1/v2/v3 documents and their method sets unchanged. Generation and fixtures
remain owned by `pnpm protocol:generate` and `pnpm protocol:check`.

The daemon exposes only fixed possession-authenticated `work/attention-request`
and `work/attention-get` actions, not an arbitrary route or signing proxy.
Requests carry the existing execution/generation/request identity, a confirmed
session for creation, and the bounded attention fields. Reads carry an attention
ID and, when activated, the confirmed session. Scope and provenance are derived
from current authority, never caller-supplied workspace/project/run identities.
Closed results carry `attention` (the existing local metadata projection, with
nullable answer/timestamps), `origin` (original `run_id`, `run_execution_id` and
`assignment_generation`) and `authority_binding` (the current calling assignment's
`AgentSessionReference` or null). Original record provenance and current read
authority are distinct. No credential, private capture or journal enumeration
is exposed.

Creation reuses `attention.request` and its existing table/observation effect.
Bind its stable idempotency key to execution, assignment generation, action,
schema and original request ID; fingerprint the complete original typed business
request, independently of renewable credentials. Identical explicit retries can
recover the original committed outcome; changed input under the same identity
conflicts. No replacement identity is invented after a lost response.

Reads inspect fresh committed D1 state, without creating an idempotency outcome
or memoizing open, answered or resolved records. A request ID may retain local
input binding, but cannot retain a private answer as the authoritative read.
The agent can read only its current run's attention records, including an older
execution of that same run. Missing and foreign IDs have the same `not_found`
response. Return original record provenance rather than relabelling old work as
the current execution.

### Current authority before private delivery

Every operation checks the kernel caller, immutable assignment, fresh native
ownership and current runner connection. Cloud checks include current runner and
requester grants/epochs, final launch authority, checkout lease, run state and
the relevant session/launch fences. Creation also requires the exact trusted
L06 observation and confirmed canonical session. Recheck local caller, native
ownership and trusted observation after network waits before private delivery.

An explicitly submitted result is still nonterminal: its live agent may request
a review question or retrieve a committed answer. Attention retains all current
launch-scope and policy checks without borrowing the narrower eligibility for
starting a new launch. Accepted, failed and cancelled results remain closed.
This does not widen launch, task-write capture or replay eligibility.

Provisional reads remain allowed without creating a session binding. Omitting a
binding cannot bypass an existing canonical association: an ended, malformed or
conflicting current association fails closed, including after an MCP restart.
An existing canonical association must agree with the daemon's trusted observed
session before the read result is delivered; an activated host additionally
requires its exact confirmed canonical reference. `authority_binding` is null
only when no canonical association exists and no input binding was supplied.
Creation requires a nonnull exact binding. Reads do not manufacture session
state or activate an unobserved session.

Human answer and resolution commands recheck current membership, project access,
required role and authorization epoch inside the serialized Hub unit before
cached outcomes, and bind the original input to the idempotency identity. They
retain optimistic version checks and the no-overwrite rule. An answer records a
decision, never permission for a provider-native or privileged operation.

Audit, semantic events and outbox use bounded identifiers, kinds, states,
versions and counts rather than question/answer bodies. Private bodies remain
only in the authorized business record/response and necessary idempotent result.

### Online-only uncertainty and bounded waiting

No attention operation opens, writes or drains the A01 journal. Channel loss
fails visibly; failure after dispatch does not prove the question was not
committed. Recovery is an explicit retry with the exact original identity and
input under current authority, never autonomous resend. MCP exit or daemon
restart creates no attention delivery work.

`bfb_wait_for_attention` stays in the local client and repeatedly uses the fixed
read operation; no Worker request waits for a human. Establish a child context
covering the entire call with a maximum of 30 seconds, including authorization
and network I/O. Do not return a late answer after that deadline. Repetition
reads current state, and pending is not a durable or memoized outcome. Authority
denials and channel failures remain visible rather than being converted to an
ordinary unanswered question.

Use a one-second polling interval instead of the historical 100 ms cadence,
which exceeds the possession-challenge budget. Classify attention reads as
authenticated channel traffic under the existing channel limits; creation
retains the existing mutation limit. Do not increase global challenge, IP or
mutation ceilings to make a test pass. Multiple concurrent waiters may encounter
bounded capacity failure; no unlimited polling guarantee is made.

## Required acceptance

- Compiled stdio, signed daemon, real authenticated runner and local Worker/D1
  prove request, authorized human answer, current wait and later identical
  resolution retrieval; new MCP hosts retain that behavior.
- Offline calls and daemon restarts create no attention journal work; a lost
  committed reply followed by an explicit exact retry creates one request and
  one requested observation.
- Same-identity changed input, foreign/missing IDs, provisional/activated session
  boundaries, closed session, revoked grants, ended execution, terminal result,
  expired/replaced lease and postflight containment changes fail safely.
- A slow network read and repeated unanswered waits obey the full call deadline;
  no stale cached read hides an answer or revocation. Real budgets remain enabled.
- Human role/project/epoch and duplicate-answer rules hold before cached replies;
  private question/answer canaries do not enter audit, semantic or outbox payloads.
- Exact A02, affected A01/runner/protocol gates, repository verification and clean
  checkout evidence pass before A02 is marked done. Historical A02 evidence is
  retained as historical; no Terminal or live-provider claim is inferred.
