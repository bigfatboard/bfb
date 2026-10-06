# WP-A02 — Human attention workflow

Status: `done`

Risk: High

Test target: `pnpm test:a02`

Evidence manifest: `docs/work-packages/evidence/WP-A02/runtime-manifest.json`

## Outcome

An agent can request a typed human decision, a permitted human can answer it from the cross-project Attention view, and the agent can wait briefly or retrieve the durable answer later.

## Dependencies

- **Requires:** A01, E02, W01.
- **Unlocks:** A04, C11, X01, X02, X03.
- **Can run with:** A03 after shared run-state mutations freeze.

## Scope

- Attention request kind, referenced immutable object, required permission, blocking flag, open/answered/resolved state, answer, and timestamps (D1 migration `0023_attention`).
- MCP `bfb_request_human`, `bfb_get_attention`, and 30-second bounded `bfb_wait_for_attention` on the same `bfb mcp stdio` server, using two fixed authenticated runner actions without a new credential, cloud wait endpoint, or journal.
- Human answer/resolution API with permission recheck and optimistic version.
- Ranked cross-project Attention home with clarification, review, credential/capability, destructive-action, and blocker distinctions.
- In-app signaling and runner notification of committed answers by polling committed records; X01 owns external delivery.
- First-response and final-resolution timestamps plus uniquely identified raw observations; A04 owns latency derivation, aggregation, and display.
- Provider-native permission dialogs kept distinct; BFB never claims to answer them uniformly.

## Non-goals

- Remote native permission approval, infinite Worker waits, notification transport, or treating any human answer as privileged authorization.

## Contracts

### Consumes

- A01's clean-certified runtime at `adbf740` (`docs/contracts/local-mcp.md`): stdio transport, provisional/activated/closed capability states, `bfb_` naming, typed daemon authority and the `SessionBindingSource`, `AssignmentSource`, `AuthoritySource`, `WorkTransport` interfaces. Reads/session authority use closed v2; the protected four-tool journal uses closed v3. A02 adds its separate closed v4 lane under [ADR 0007](../adr/0007-online-agent-attention-runtime.md); attention fails visibly offline and is never journaled.
- C08 work records, execution assignments, and run result states (`packages/domain/src/work-records.ts`); run/execution identity for request binding and terminal-result fences.
- C04 workspace roles, project grants, and authorization epochs for answer permission rechecks; reviewers stay project-scoped.
- E01 event ledger v1 (`docs/contracts/event-ledger.md`): committed observations as the durability reference; attention truth lives in its own tables, not the ledger.
- W01 app shell, Work surface, and component/style conventions in `apps/web` and `packages/ui`; signaling polls committed records rather than depending on E02 socket delivery.

### Produces

- Attention workflow v1, frozen in `docs/contracts/attention.md`: `0023_attention` records, `attention.request`/`attention.answer`/`attention.resolve` commands, ranked reads, the three local MCP tools with the 30-second bound, the no-transport signaling model, and the raw-observation boundary for A04.
- Stable test target `pnpm test:a02` and evidence manifest `docs/work-packages/evidence/WP-A02/runtime-manifest.json`.
- `packages/domain/src/attention.ts`: commands, ranked `listAttention` with explainable `rank_reason`, and immutable observation reads consumed by routes, UI, and the harness.
- `apps/control-worker/src/api/attention.ts`: ranked list, scoped read with observations, answer (409 carries the committed record on duplicates), and resolve routes.
- `apps/web/src/attention/home.tsx`: ranked Attention home with answer/resolve actions and the native-permission notice.
- `internal/localmcp/attention.go`: the three tool implementations plus the bounded wait over `WorkTransport.GetAttention`.
- `tools/attention/run.ts`: the real-Worker/D1 fault harness writing deterministic `runtime-recording.jsonl` and `runtime-waiter-cadence.json` (step outcomes only, so reruns are byte-identical); historical evidence remains unchanged.
- `internal/agentwork/native_attention_darwin_test.go` and `tools/local-mcp/native.ts a02`: compiled stdio through the development-signed daemon and authenticated local Worker/D1, with a synthetic provider-shaped child and no Terminal automation or live provider turn.

## Work plan

1. Attention migration, domain commands, ranked reads, and permission tests.
2. Worker answer/resolution APIs and route tests.
3. Ranked Attention UI, run integration, and browser tests.
4. Local MCP request/get/wait tools with Go tests and transcript twin.
5. Real-Worker/D1 harness for timeout, reconnect, revocation, and guards; contract freeze; evidence.
6. Connect the production typed attention lane through fresh native/runner authority, preserve read-before-binding and online-only behavior, fix stale read caching and the complete wait deadline, and re-certify exact A02 from a clean checkout.

## Acceptance

- Agent requests attention, permitted human answers, current waiter returns, and later retrieval returns identical resolution metadata.
- Wait returns pending within 30 seconds and can be repeated safely.
- Reviewer can answer a clarification/review request but cannot satisfy an owner-only policy/credential approval.
- Duplicate answer attempts do not overwrite the committed response silently.
- An answer survives disconnect and is not dependent on WebSocket delivery.
- Native provider permission remains visibly separate.

## Evidence

- `docs/work-packages/evidence/WP-A02/runtime-manifest.json` indexes the clean-tested `891fbcc` source, migration head, toolchains, commands, and redaction status per the evidence manifest schema.
- `runtime-recording.jsonl` traces the connected flow across two Workers and real D1 (migration, final launch authority, lease observation, canonical binding, request, exact/changed-input retry, pending polls, answer, permission matrix, guards, revocation, reconnect and observations). It contains step outcomes, kinds, states, versions and counts, not run IDs or private bodies; reruns are byte-identical.
- `runtime-waiter-cadence.json` carries deterministic pending-poll and repeated-read states as a structural cross-check. A04 derives latencies from committed attention timestamps, never from harness wall-clock. The native proof separately measures the actual 30-second production wait and its 26 reads.
- `runtime-acceptance.md` maps the connected authority, durability, privacy and wait contracts to tests; `runtime-command-result.json` records exact A02, A01, L08, repository verification, Linux build and clean-worktree outcomes, plus the separately scoped implementation-checkout C09 regression.
- Historical `manifest.json`, `recording.jsonl`, `waiter-cadence.json`, `permission-matrix.md`, `timeout-reconnect-trace.md`, `acceptance-matrix.md` and `command-result.json` remain unchanged. They document the earlier isolated implementation, not the connected runtime certificate.
- Evidence contains synthetic identities only: no bearer/grant secret, task body, local absolute path, environment value, or raw terminal output.

## Risks and decisions

- Ranking must remain explainable and deterministic in v0.1; the rank is blocking flag, frozen kind severity, request time, then ID, and every item carries its `rank_reason`. No opaque priority model.
- Both UI and runner signaling poll committed records; socket presence or notification delivery is not evidence of an answer.
- The 30-second wait never holds a Worker open; pending outcomes are never memoized, so repetition is side-effect free.
- Attention questions are not journaled offline: autonomous stale redelivery could mislead a human about current run authority. Committed questions and answers remain durable and readable by a currently authorized agent after a waiter ends. A01's daemon-owned `013_work_journal` keeps exactly its four task-mutation tools; A02 does not open, extend or drain it.
- A03 also extends the local MCP server and run/task transitions; A02's MCP and domain additions are additive and separately named (`bfb_request_human`, `bfb_get_attention`, `bfb_wait_for_attention`, `attention.*`).

## Handoff

- Re-certified 6 October at clean source `891fbcc`: frozen install, forced build, exact A02 (866 protocol cases, 85 focused cases, Go race suites, real D1, seven evidence checks, compiled stdio, signed native proof and three browser cases), full verification (2,245 TypeScript cases, Go and 16 Swift cases), exact A01/L08, Linux build and clean-worktree check pass. C09 also passes at that source in the implementation checkout. [ADR 0007](../adr/0007-online-agent-attention-runtime.md) and the runtime evidence above define the connected contract. This uses synthetic provider-shaped processes, not Terminal automation or live provider turns, and does not certify A03 or the full MVP.
- The native acceptance found and reproduced a runner inventory scheduling gap; `63f02ec` restores each existing heartbeat refresh without widening freshness or rate limits. `891fbcc` keeps attention available on submitted nonterminal runs while preserving launch/task-capture eligibility and terminal closure.
- Dependency hold, 5 October: A01 is reopened for its missing production online/replay path. This implementation and historical isolated acceptance are retained; their tests have not been declared failed. Re-certification and settlement wait for A01 runtime acceptance and affected integration checks. The dated status below is historical, not the current package state.
- Settled 18 September: `done`. A01 and E02 are `done`, and `pnpm test:a02` passed in a detached clean checkout at `9372c0f` (install, build, exact target with the real-Worker/D1 fault harness, real-binary stdio purity, and browser spec). Re-proven in-worktree at `b3b1391` after the evidence-determinism fix (build, exact target with the deterministic-evidence harness plus its regression test, real-binary stdio purity, and browser spec).
- Commands: `pnpm test:a02`; `pnpm verify`; `pnpm worktree:check`. The Worker/D1 fault flow is `tools/attention/run.ts`; the attention stdio cases are `internal/localmcp/attention_test.go` plus the golden transcript.
- A04 consumes `attention_observations` (unique identity, actor provenance) and the raw `requested_at`/`first_response_at`/`resolved_at` timestamps plus the `runtime-waiter-cadence.json` poll/retry counts as a structural cross-check; derivation and display belong to A04.
- X01 consumes committed `attention.request`/`attention.answer`/`attention.resolve` semantic events; it does not own attention truth and owns all external delivery.
- The historical L08 merge step is now connected: `WorkTransport.RequestAttention`/`GetAttention` use the separate v4 daemon lane and fixed runner actions, with current native ownership, credential/epoch, run/session/launch/lease checks and uniform `not_found` for foreign records. The clean acceptance above proves this connection.
- Historical wait fixtures use a 100 ms cadence. The production integration moves to one second to fit existing possession budgets without widening them; it does not add commit-driven wake-ups. Browser signaling polls every 15 seconds; offline agents cannot request attention until the channel returns. A transport failure after dispatch may hide an already committed request; explicit same-identity retry is the only recovery path.
