# WP-A03 — Result submission and acceptance

Status: `in_progress`

Risk: High

Test target: `pnpm test:a03`

Evidence manifest: `docs/work-packages/evidence/WP-A03/manifest.json`

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

- [Run-scoped local MCP runtime](../contracts/local-mcp.md), clean-certified
  at `adbf740`: canonical binding, independent native/runner authority and
  daemon-owned protected four-tool capture/replay. Result permission is not
  inherited from those four tools. [ADR 0008](../adr/0008-protected-agent-result-submission.md)
  defines separate result policy/proof/v5 transport and shared journal recovery.
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
4. Add local MCP `bfb_submit_result` and local CLI `run submit` through the
   daemon-owned protected v5 result family under ADR 0008; verify with
   `go test -race ./internal/localmcp/... ./internal/cli/...`.
5. Add task-sheet result/review state; verify with
   `vitest run apps/web/test/result.test.ts` plus the browser spec on
   `BFB_E2E_PORT=4183`.
6. Prove hub races over real Workers and D1 with `tools/results/run.ts`
   and the real binary with `tools/results/cli.ts`.
7. Commit bounded redacted evidence at the manifest path and one
   `mvp.progress.md` checkpoint line; regenerate the index with
   `pnpm roadmap:write`.
8. Connect the production MCP and CLI result paths under ADR 0008: default-denied
   independent offline permission, current authority before cache, private-body
   redaction, protected capture/shared-quota recovery and actual signed native
   outage/restart proof. Re-certify the complete exact target from a clean checkout.

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
- Risk: the new protected journal upgrade (v13→v14) could corrupt A01 evidence
  or admit unsigned legacy results. ADR 0008 requires transactional preservation
  of original signed bytes, dispatch/claim history and shared quotas, with
  legacy unsigned rows retained/quarantined and never promoted. Historical
  v11→v12 fixtures remain historical evidence, not protected runtime proof.
- Risk: sibling packages (A02 attention, V01 artifacts) extend the same MCP
  server and evidence contract. Decision: A03 additions are additive and
  separately named (`bfb_submit_result`, `run submit`, generic refs with an
  explicit V01/V03 extension hook). Shared authority and journal changes retain
  the original A01/A02 wire families and require their regression gates.

## Handoff

- Runtime integration resumed 6 October after A01 and A02 clean runtime
  certificates were committed. ADR 0008 records the independent result-policy,
  v5 transport, current authority, CLI priming and protected-recovery contract
  before implementation. A03 stays incomplete until both online and protected
  offline MCP/CLI paths pass its expanded exact gate from a clean checkout.
- Dependency hold, 5 October: A01 is reopened for its missing production online/replay path. This implementation and historical isolated acceptance are retained; their tests have not been declared failed. Re-certification and settlement wait for A01 runtime acceptance and affected integration checks. The dated status below is historical, not the current package state.
- Settled 18 September: `done`. A01 and E01 are `done`, and `pnpm test:a03`
  passed in a detached clean checkout at `1d0046b` (install, build, exact
  target with the real-Worker/D1 harness, real-binary CLI harness, and
  browser submit/change/supersede/accept cycle). The evidence manifest is
  re-based on that rerun; the implementation evidence stays listed as
  manifest artifacts.
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
  separate names and frozen v4 wire bytes. A known attention authority denial
  also invalidates pending result-confirmation availability.
- L08: replay journaled `bfb_submit_result` rows through the runner channel
  as the run-bound agent authority with the same capability, epoch, and
  version rechecks as A01 writes.
- X02/X03: build human CLI and remote MCP parity on the frozen contract;
  local `run submit` stays the agent-local journaling surface.
- Current limitations: no automatic submission caller exists in v0.1 (even
  headless runs submit explicitly); the connected production MCP/CLI result
  draft is under verification and is not yet clean-certified. The historical unsigned CLI journal
  is not enabled or reinterpreted as capture authority; UI renders no artifact
  content yet.
