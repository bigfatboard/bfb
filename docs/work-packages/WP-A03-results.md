# WP-A03 — Result submission and acceptance

Status: `planned`

Risk: High

Test target: `pnpm test:a03`

Evidence manifest: `docs/work-packages/evidence/WP-A03/manifest.json`

> Status note: implementation, gate, and evidence are complete on this branch,
> but `Status` stays `planned` because `pnpm roadmap:check` rejects any status
> beyond `planned` while dependencies A01 and E01 are not `done`. See Handoff.

## Outcome

A run-scoped agent submits an immutable result with evidence for human review,
a reviewer or owner requests changes or accepts it, and acceptance revokes
the agent's write capability while the checkout lock survives until verified
process end. Only documented unambiguous headless success may submit without
an explicit call; every interactive ending never submits or accepts.

## Dependencies

- **Requires:** A01, C08, E01, W01.
- **Unlocks:** A04, P01, P02, V03, X01, X02, X03, X04.
- **Can run with:** E02, L06, L07, P01, W02.

## Scope

- Model immutable result submissions binding summary, bounded typed evidence
  references, limitations, Git facts, config snapshot/hash, timestamp.
- Add MCP/CLI/API submission through `bfb_submit_result`/`run submit` with
  idempotency.
- Implement run result transitions: open, submitted, changes requested,
  accepted, failed, cancelled.
- Move task active→review on submission, review→active on changes,
  review→done only on permitted human acceptance.
- Mark a submission outdated when bound Git/config facts or generic
  evidence-reference version changes; never rewrite history.
- Revoke run-scoped agent write capability on acceptance while retaining
  checkout lock until verified process end.
- Permit only documented unambiguous headless-success submission; interactive
  Stop/exit never qualifies.
- Build result/review state on task/run UI without artifact rendering yet.

## Non-goals

- No artifact rendering (V01/V03 extend the generic evidence-reference
  contract only).
- No automatic merge or deploy.
- No self-acceptance, no approval inheritance, no terminal-prose success
  scraping.
- No remote MCP result tools (X03 parity later).
- No L05 lock UI, no A02 attention tools, no E02/W02/P01/L06/L07 behavior.

## Contracts

### Consumes

- [Run-scoped local MCP server v1](../contracts/local-mcp.md) (capability
  states, tool registration, pending-operation journal, revocation on
  accepted result).
- [Runner event ledger v1](../contracts/event-ledger.md) (ingest never
  infers result state).
- [Launch orchestration v1](../contracts/execution-supervisor.md) (checkout
  lock retention across acceptance).
- C08 work records, task and run transitions, work APIs
  (`packages/domain/src/work-records.ts`).

### Produces

- [Result submission and acceptance v1](../contracts/results.md), freezing
  the submission record, the generic evidence-reference shape V01 and V03
  extend, the transition matrix, the authority matrix, the headless-success
  rule, outdated detection, and revocation/lease semantics.
- Stable test target `pnpm test:a03` and evidence-manifest path
  `docs/work-packages/evidence/WP-A03/manifest.json`.

## Work plan

1. Freeze `docs/contracts/results.md` with D1 heads and the generic
   evidence-reference shape; verify with `pnpm docs:check`.
2. Add D1 migration `0024_result_submissions` plus domain commands
   (`result.submit`, `result.request_changes`, `result.accept`,
   `result.fail`, `result.cancel`); verify with
   `vitest run packages/domain/test/results.test.ts`.
3. Serve REST submission/review endpoints; verify with
   `vitest run apps/control-worker/test/result-routes.test.ts`.
4. Add local MCP `bfb_submit_result` (activated only, journaled offline,
   replayed by L08 rules) and local CLI `run submit`; verify with
   `go test -race ./internal/localmcp/... ./internal/cli/...`.
5. Add task-sheet result/review state; verify with
   `vitest run apps/web/test/result.test.ts` plus the browser spec on
   `BFB_E2E_PORT=4183`.
6. Prove hub races over real Workers and D1 with `tools/results/run.ts`
   and the real binary with `tools/results/cli.ts`.
7. Commit bounded redacted evidence at the manifest path and one
   `mvp.progress.md` checkpoint line; regenerate the index with
   `pnpm roadmap:write`.

## Acceptance

- Headless/interactive stop, tool failure, terminal close, session end,
  process exit cannot qualify for submission or acceptance. Agent cannot
  accept its result; Reviewer/Member/Owner behavior matches policy.
- Proved by: domain headless-rule matrix and no-inference ingest test,
  worker role-matrix tests, Go provisional/closed capability tests, browser
  reviewer-403 check (`pnpm test:a03`).
- Changes requested reopens same run and later submission creates new
  immutable version; submitted data is immutable.
- Proved by: domain cycle test, worker outdated-history check, browser
  superseded screenshot (`pnpm test:a03`).
- Later repo/config or generic evidence-ref change marks prior submission
  outdated (no mutation).
- Proved by: domain config-change and evidence-map tests, worker history
  assertion (`pnpm test:a03`).
- Acceptance revokes agent writes but does not release live checkout lock.
- Proved by: Go terminal-close tests, worker accept/changes race with
  byte-identical lease assertion, domain lease-retention test
  (`pnpm test:a03`).
- Idempotent retries create one submission.
- Proved by: domain idempotency test, worker cross-worker retry, Go
  request-id dedupe, CLI repeat check (`pnpm test:a03`).
- Result state rendered in task UI; evidence bounded/redacted with UI
  snapshots.
- Proved by: web unit tests, browser review/accepted screenshots, manifest
  conformance (`pnpm test:a03`).

## Evidence

- Evidence manifest: `docs/work-packages/evidence/WP-A03/manifest.json`
  (conforms to `docs/work-packages/evidence/manifest.schema.json`).
- Contents: transition matrix (`transition-matrix.md`), role matrix
  (`acceptance-matrix.md`), command result (`command-result.json`),
  revocation race trace (`revocation-trace.md`), duplicate/stale fixtures
  (`fixtures/`), browser review snapshots (`browser/`).
- Evidence is bounded and redacted: synthetic identities only, no secrets,
  no local absolute paths, no raw terminal output.

## Risks and decisions

- Risk: acceptance authority mistakes could let an agent self-accept or a
  reviewer close a task. Decision: agents hold no review command at all,
  reviewers hold only request-changes, and the domain, route, worker, and
  browser layers each pin the matrix.
- Risk: journal schema widening (v11→v12) could strand A01 offline rows.
  Decision: rebuild preserves rows, covered by a dedicated migration test;
  A01's pinned transcript was regenerated by its owning test with only the
  two intended line changes.
- Risk: sibling packages (A02 attention, V01 artifacts) extend the same MCP
  server and evidence contract. Decision: A03 additions are additive and
  separately named (`bfb_submit_result`, `run submit`, generic refs with an
  explicit V01/V03 extension hook); no shared file was refactored.

## Handoff

- State: implementation, `pnpm test:a03` gate, and evidence are complete on
  this branch at the committed hash recorded in the evidence manifest.
  `Status` is intentionally left at `planned`: `pnpm roadmap:check`
  rejects anything beyond `planned` while A01 and E01 are not `done`.
- Consume: `docs/contracts/results.md` (v1), domain commands
  `result.submit`, `result.request_changes`, `result.accept`,
  `result.fail`, `result.cancel` in `packages/domain/src/results.ts`,
  REST routes under `/runs/:runId/{results,review,failure,cancellation}`,
  local MCP `bfb_submit_result`, local CLI `bfb run submit`,
  `ResultPanel`/`ResultView` in `apps/web/src/work/result.tsx`.
- V01: validate `artifact_version` refs and supply artifact versions to
  `listResultSubmissions` via the generic version map; extend the generic
  evidence-reference shape without changing stored rows.
- V03: consume reviewed submission versions; never mutate submissions.
- L05: acceptance and review commands never read or write
  `checkout_leases`; the live lock survives until verified process end.
- A02: MCP and domain additions are additive; A02 attention tools keep
  separate names.
- L08: replay journaled `bfb_submit_result` rows through the runner channel
  as the run-bound agent authority with the same capability, epoch, and
  version rechecks as A01 writes.
- X02/X03: build human CLI and remote MCP parity on the frozen contract;
  local `run submit` stays the agent-local journaling surface.
- Limitations: no automatic submission caller exists in v0.1 (even headless
  runs submit explicitly); the CLI journals `pending_sync` rows that replay
  through L08; UI renders no artifact content yet.
