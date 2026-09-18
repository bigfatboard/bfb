# WP-A02 — Human attention workflow

Status: `done`

Risk: High

Test target: `pnpm test:a02`

Evidence manifest: `docs/work-packages/evidence/WP-A02/manifest.json`

> Settled 18 September: `done` — `pnpm test:a02` passed in a detached clean
> checkout at `9372c0f`; see Handoff.

## Outcome

An agent can request a typed human decision, a permitted human can answer it from the cross-project Attention view, and the agent can wait briefly or retrieve the durable answer later.

## Dependencies

- **Requires:** A01, E02, W01.
- **Unlocks:** A04, X01, X02, X03.
- **Can run with:** A03 after shared run-state mutations freeze.

## Scope

- Attention request kind, referenced immutable object, required permission, blocking flag, open/answered/resolved state, answer, and timestamps (D1 migration `0023_attention`).
- MCP `bfb_request_human`, `bfb_get_attention`, and 30-second bounded `bfb_wait_for_attention` on the same `bfb mcp stdio` server (no new credential, endpoint, or journal).
- Human answer/resolution API with permission recheck and optimistic version.
- Ranked cross-project Attention home with clarification, review, credential/capability, destructive-action, and blocker distinctions.
- In-app signaling and runner notification of committed answers by polling committed records; X01 owns external delivery.
- First-response and final-resolution timestamps plus uniquely identified raw observations; A04 owns latency derivation, aggregation, and display.
- Provider-native permission dialogs kept distinct; BFB never claims to answer them uniformly.

## Non-goals

- Remote native permission approval, infinite Worker waits, notification transport, or treating any human answer as privileged authorization.

## Contracts

### Consumes

- A01 `local-mcp/1` (`docs/contracts/local-mcp.md`): stdio transport, provisional/activated/closed capability states, `bfb_` naming, pending-operation journal (attention tools fail visibly offline and are never journaled), and the `SessionBindingSource`, `AssignmentSource`, `AuthoritySource`, `WorkTransport` interfaces the attention tools build against.
- C08 work records, execution assignments, and run result states (`packages/domain/src/work-records.ts`); run/execution identity for request binding and terminal-result fences.
- C04 workspace roles, project grants, and authorization epochs for answer permission rechecks; reviewers stay project-scoped.
- E01 event ledger v1 (`docs/contracts/event-ledger.md`): committed observations as the durability reference; attention truth lives in its own tables, not the ledger.
- W01 app shell, Work surface, and component/style conventions in `apps/web` and `packages/ui`; E02 is concurrent, so signaling polls committed records and never touches its socket.

### Produces

- Attention workflow v1, frozen in `docs/contracts/attention.md`: `0023_attention` records, `attention.request`/`attention.answer`/`attention.resolve` commands, ranked reads, the three local MCP tools with the 30-second bound, the no-transport signaling model, and the raw-observation boundary for A04.
- Stable test target `pnpm test:a02` and evidence manifest `docs/work-packages/evidence/WP-A02/manifest.json`.
- `packages/domain/src/attention.ts`: commands, ranked `listAttention` with explainable `rank_reason`, and immutable observation reads consumed by routes, UI, and the harness.
- `apps/control-worker/src/api/attention.ts`: ranked list, scoped read with observations, answer (409 carries the committed record on duplicates), and resolve routes.
- `apps/web/src/attention/home.tsx`: ranked Attention home with answer/resolve actions and the native-permission notice.
- `internal/localmcp/attention.go`: the three tool implementations plus the bounded wait over `WorkTransport.GetAttention`.
- `tools/attention/run.ts`: the real-Worker/D1 fault harness writing `recording.jsonl` and `raw-timing-observations.json`.

## Work plan

1. Attention migration, domain commands, ranked reads, and permission tests.
2. Worker answer/resolution APIs and route tests.
3. Ranked Attention UI, run integration, and browser tests.
4. Local MCP request/get/wait tools with Go tests and transcript twin.
5. Real-Worker/D1 harness for timeout, reconnect, revocation, and guards; contract freeze; evidence.

## Acceptance

- Agent requests attention, permitted human answers, current waiter returns, and later retrieval returns identical resolution metadata.
- Wait returns pending within 30 seconds and can be repeated safely.
- Reviewer can answer a clarification/review request but cannot satisfy an owner-only policy/credential approval.
- Duplicate answer attempts do not overwrite the committed response silently.
- An answer survives disconnect and is not dependent on WebSocket delivery.
- Native provider permission remains visibly separate.

## Evidence

- `docs/work-packages/evidence/WP-A02/manifest.json` indexes the tested commit, migration head, toolchains, commands, and redaction status per the evidence manifest schema.
- `recording.jsonl` traces one end-to-end run across two Workers and real D1 (migration, claim, request, idempotent replay, pending polls, answer, duplicate rejection, permission matrix, timeout/retry, guards, revocation, reconnect re-read, observations) with IDs, states, versions, and timings only.
- `raw-timing-observations.json` carries the measured request/answer latencies and waiter poll cadence consumed by A04.
- `permission-matrix.md` tabulates the role/kind answer matrix; `timeout-reconnect-trace.md` narrates the bounded wait, retry, and eviction traces; `acceptance-matrix.md` maps each Acceptance bullet to its proving test; `command-result.json` records the `pnpm test:a02`, `pnpm verify`, `pnpm worktree:check`, Linux cross-build, and clean-checkout gate outcomes.
- Evidence contains synthetic identities only: no bearer/grant secret, task body, local absolute path, environment value, or raw terminal output.

## Risks and decisions

- Ranking must remain explainable and deterministic in v0.1; the rank is blocking flag, frozen kind severity, request time, then ID, and every item carries its `rank_reason`. No opaque priority model.
- E02 builds its socket concurrently: both UI and runner signaling poll committed records, so no E02 surface is consumed before it freezes.
- The 30-second wait never holds a Worker open; pending outcomes are never memoized, so repetition is side-effect free.
- Attention questions are not journaled offline: a question is only useful inside a live waiter loop, and stale redelivery would mislead the human about run liveness. The A01 journal keeps exactly its four task-mutation tools (migration `011` untouched).
- A03 also extends the local MCP server and run/task transitions; A02's MCP and domain additions are additive and separately named (`bfb_request_human`, `bfb_get_attention`, `bfb_wait_for_attention`, `attention.*`).

## Handoff

- Settled 18 September: `done`. A01 and E02 are `done`, and `pnpm test:a02` passed in a detached clean checkout at `9372c0f` (install, build, exact target with the real-Worker/D1 fault harness, real-binary stdio purity, and browser spec).
- Commands: `pnpm test:a02`; `pnpm verify`; `pnpm worktree:check`. The Worker/D1 fault flow is `tools/attention/run.ts`; the attention stdio cases are `internal/localmcp/attention_test.go` plus the golden transcript.
- A04 consumes `attention_observations` (unique identity, actor provenance) and the raw `requested_at`/`first_response_at`/`resolved_at` timestamps plus `raw-timing-observations.json`; derivation and display belong to A04.
- X01 consumes committed `attention.request`/`attention.answer`/`attention.resolve` semantic events; it does not own attention truth and owns all external delivery.
- L08 merge step: implement `WorkTransport.RequestAttention`/`GetAttention` over the runner channel client (rechecking runner credential, epoch, run capability, and run-boundary ownership; foreign records report `not_found`), exactly like the other `WorkTransport` methods. No CLI wiring change needed beyond the transport swap.
- Known limitations: waits poll on a 100 ms cadence rather than waking on commit (E02 may add wake-ups later without changing the bound); browser signaling polls every 15 seconds until E02 sockets land; offline agents cannot request attention until the channel returns.
