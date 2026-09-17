# Human attention workflow v1

Owner: [A02](../work-packages/WP-A02-attention.md). Gate: `pnpm test:a02`.

This contract freezes attention records, the agent wait/read tools, the
human answer/resolution APIs, the ranked Attention home, and the raw
observation boundary consumed by A04. E02 consumes committed rows by polling
these reads; X01 consumes committed semantic events for external delivery.

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
  membership, or policy state.

`attention_observations` keeps one immutable raw row per transition
(`requested`, `answered`, `resolved`) with actor provenance
(`agent_run`, `runner`, or `human`) and unique observation identity.
Update/delete triggers abort. A04 owns every derived latency, aggregate,
and display value; this contract commits only raw timestamps and identities.

## Domain commands

- `attention.request` (runner actor): validates the execution assignment
  against the authenticated runner exactly like event ingest, derives
  workspace/project/task/run server-side, and commits the open request plus
  its `requested` observation. Hub idempotency replays the identical record.
- `attention.answer` (direct human only, never a delegation): rechecks
  membership, authorization epoch, project access, and the kind's required
  role on every call, then commits the answer with an optimistic version
  check. A second answer under any key fails as `already_answered` and the
  committed response is returned, never overwritten.
- `attention.resolve` (same human authority): moves `answered` to `resolved`
  with its own version check and observation.
- An answer records a human decision. It grants no authority: roles,
  grants, policies, and run results are untouched.

Reads go directly to D1: `getAttention` (one in-scope request),
`listAttention` (ranked across the reader's projects), and
`listAttentionObservations` (immutable history, oldest first).

## Local MCP tools (same `bfb mcp stdio` server, `local-mcp/1`)

- `bfb_request_human` (`kind`, `question`, `reference_kind?`,
  `reference_id?`, `blocking`, `request_id`): requires the activated
  capability. Commits through the L08 transport when online.
- `bfb_get_attention` (`attention_id`, `request_id`): a read, available
  before session binding. Records outside the run boundary report
  `not_found`.
- `bfb_wait_for_attention` (`attention_id`, `request_id`): polls committed
  state until the request is `answered`/`resolved` and returns the same
  resolution metadata a later retrieval returns, or `pending` when the
  30-second bound (`ATTENTION_WAIT_TIMEOUT_MS`) expires. Pending outcomes
  are never memoized, so repeating a wait is side-effect free and always
  re-reads committed state.
- All three tools fail visibly as `offline_rejected` when the cloud channel
  is unreachable. Attention questions are not journaled: a question is only
  useful inside a live waiter loop, and redelivering a stale question after
  reconnect would mislead the human about run liveness. The A01
  pending-operation journal keeps exactly its four task-mutation tools.

## Browser and runner signaling

There is no attention push transport in v0.1. Both surfaces poll committed
records: the Attention home refetches the ranked list on a bounded interval,
and agent waiters poll `get_attention` inside the 30-second bound. A higher
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
`assignment_ended`, `session_not_bound`, `boundary_escape`. Failures carry a
bounded code and message only; they never echo tokens, environment values,
or human-only context beyond the request's own committed fields.
