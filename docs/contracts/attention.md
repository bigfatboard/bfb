# Human attention workflow v1

Owner: [A02](../work-packages/WP-A02-attention.md). Gate: `pnpm test:a02`.

This contract freezes attention records, the agent wait/read tools, the
human answer/resolution APIs, the ranked Attention home, and the raw
observation boundary consumed by A04. E02 consumes committed rows by polling
these reads; X01 consumes committed semantic events for external delivery.

The production integration is clean-certified at `891fbcc` under
[ADR 0007](../adr/0007-online-agent-attention-runtime.md), with the
[connected runtime evidence](../work-packages/evidence/WP-A02/runtime-manifest.json)
kept separate from historical isolated evidence. The records and human-visible
tool shapes below remain the business contract; the closed transport carries
their authority and provenance. Synthetic native proof does not certify
Terminal interaction or live provider behavior.

## Records (D1 migration `0023_attention`)

`attention_requests` carries kind, referenced immutable object, required
permission, blocking flag, state, answer, and timestamps:

- `kind`: `clarification`, `review`, `credential`, `capability`,
  `destructive_action`, or `blocker`.
- `required_role`: the minimum workspace role that may answer, derived from
  the kind and stored explicitly: `clarification`/`review` need `reviewer`,
  `blocker` needs `member`, `credential`/`capability`/`destructive_action`
  need `owner`. Owner outranks member outranks reviewer.
- `reference_kind`/`reference_id`: an optional pair naming one immutable
  object (for example an artifact version). Both or neither; never a body.
- `question` (1-2,048 chars) and `blocking` flag from the requesting agent.
- `state`: `open` → `answered` → `resolved`, guarded by `resource_version`.
  `answer` (1-2,048 chars), `answered_by_human_id`, `requested_at`,
  `first_response_at`, `answered_at`, and `resolved_at` advance with it.
- One row binds one run, execution, and assignment generation. A request is
  refused once its run result is terminal, and requesting never changes run,
  membership, or policy state. A submitted result remains nonterminal: a live,
  currently authorized agent may still ask a review question or read an answer.
  Accepted, failed and cancelled results close this access.

`attention_observations` keeps one immutable raw row per transition
(`requested`, `answered`, `resolved`) with actor provenance
(`agent_run`, `runner`, or `human`) and unique observation identity.
Update/delete triggers abort. A04 owns every derived latency, aggregate,
and display value; this contract commits only raw timestamps and identities.

## Domain commands

- `attention.request` (runner actor): validates the execution assignment
  against the authenticated runner, current requester grants, launch, lease,
  run and exact session authority, derives workspace/project/task/run
  server-side, and commits the open request plus its `requested` observation.
  Current authority is checked before Hub idempotency. Exact retries replay the
  identical record; changed business input under the same identity conflicts.
- `attention.answer` (direct human only, never a delegation): rechecks
  membership, authorization epoch, project access, and the kind's required
  role on every call, then commits the answer with an optimistic version
  check. A second answer under any key fails as `already_answered` and the
  committed response is returned, never overwritten.
- `attention.resolve` (same human authority): moves `answered` to `resolved`
  with its own version check and observation.
- An answer records a human decision. It grants no authority: roles,
  grants, policies, and run results are untouched.

Human commands recheck authority before cached replies and fingerprint their
business input. Audit/semantic/outbox projections contain bounded identifiers,
kinds, states, versions and counts, never the question or answer body.

Reads go directly to D1: `getAttention` (one in-scope request),
`listAttention` (ranked across the reader's projects), and
`listAttentionObservations` (immutable history, oldest first).

## Local MCP tools (same `bfb mcp stdio` server)

The production bridge uses separate closed `local-agent-attention-rpc` version 4
with only `mcp.v4.request_human` and `mcp.v4.get_attention`. Each call negotiates
the advertised method on the same checked socket before sending private input;
there is no older-protocol fallback. A01's v2/v3 schemas and four-tool protected
journal are unchanged. The only cloud actions are possession-authenticated
`work/attention-request` and `work/attention-get`; there is no cloud wait endpoint.

- `bfb_request_human` (`kind`, `question`, `reference_kind?`,
  `reference_id?`, `blocking`, `request_id`): requires the activated
  capability. Commits through the L08 transport when online.
- `bfb_get_attention` (`attention_id`, `request_id`): a read, available
  before session binding. Records outside the run boundary report
  `not_found`, just like missing records. Every call reads current committed
  state; reusing a request ID does not return an old cached answer. A record from
  an older execution of the same run retains its original provenance.
- `bfb_wait_for_attention` (`attention_id`, `request_id`): polls committed
  state until the request is `answered`/`resolved` and returns the same
  resolution metadata a later retrieval returns, or `pending` when the
  30-second bound expires. The bound includes authorization and network I/O;
  a late answer is not returned after expiry. Pending outcomes
  are never memoized, so repeating a wait is side-effect free and always
  re-reads committed state.
- All three tools fail visibly as `offline_rejected` when the cloud channel
  is unreachable. Attention questions are not journaled: a question is only
  useful inside a live waiter loop, and redelivering a stale question after
  reconnect would mislead the human about run liveness. The A01
  pending-operation journal keeps exactly its four task-mutation tools.

Request creation carries the exact confirmed session. Read requests may omit
that reference while provisional, but omission never bypasses an existing
canonical session fence. A result's `origin` names the attention record's
original run/execution/generation; `authority_binding` names the current
calling assignment's canonical session or null only when none exists. The
Worker independently checks any existing association, and the daemon compares
it with trusted L06 observation before private delivery, including postflight
checks. An activated host additionally requires its exact confirmed reference.
A read never creates a canonical binding.

Attention does not create local journal work or autonomous retries. An offline
or lost-response error after dispatch is not proof of no cloud effect. Explicit
retry must preserve the exact original request ID and input, and still requires
current authority. Restarting MCP or the daemon does not resend a question.

## Browser and runner signaling

There is no attention push transport in v0.1. Both surfaces poll committed
records: the Attention home refetches the ranked list on a bounded interval,
and agent waiters poll `get_attention` at one-second intervals inside the
30-second bound. This replaces the historical 100 ms cadence to fit existing
possession budgets. Attention reads use the existing authenticated channel
limits; question creation retains the mutation limit, with no increase to
global challenge or IP ceilings. A higher
committed version is an invalidation to re-read. Hub semantic events for
every transition exist for X01/E02; X01 owns external delivery.

## Ranked Attention home

`listAttention` order is deterministic and every item carries its
`rank_reason`: blocking requests first, then kind severity (`blocker`,
`destructive_action`, `credential`, `capability`, `review`,
`clarification`), then oldest request, then ID. The home shows kind,
blocking, required-role, state, question, committed answer, task/project/run
context, and raw timestamps, plus the standing notice that provider-native
permission dialogs (Claude Code, Codex, Grok prompts inside the terminal)
stay separate: an attention answer never approves a native provider
permission.

## Error vocabulary

`request_rejected` (unknown/foreign execution, uniform), `not_found`
(hidden or missing record), `forbidden` (role below the kind's required
role), `stale_version`, `already_answered`, `invalid_transition`,
`invalid_argument`, `offline_rejected`, `revoked`, `capability_closed`,
`assignment_ended`, `session_not_bound`, `session_conflict`, `boundary_escape`,
`policy_rejected`, `storage_failed`, `protocol_unsupported`. Failures carry a
bounded code and message only; they never echo tokens, environment values,
or human-only context beyond the request's own committed fields.
