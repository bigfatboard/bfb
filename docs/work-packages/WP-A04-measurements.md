# WP-A04 — Measurements and provenance

Status: `planned`

Risk: High

Test target: `pnpm test:a04`

Evidence manifest: `docs/work-packages/evidence/WP-A04/manifest.json`

> Status note: implementation, gate, and evidence are complete on this branch,
> but `Status` stays `planned` because `pnpm roadmap:check` rejects any status
> beyond `planned` while dependencies A02, A03, and E01 are not `done`. See Handoff.

## Outcome

BFB shows human attention, process elapsed time, active agent work, waiting, and token usage as separate provenance-labelled measurements rather than one misleading total.

## Dependencies

- **Requires:** A02, A03, E01, W01.
- **Unlocks:** G01, V03.
- **Can run with:** V01/V02 if UI ownership is coordinated.

## Scope

- Uniquely identified typed observations with derived totals; replays never blindly increment (D1 migration `0027_measurements`).
- Launch latency, process elapsed, process-alive union, active interval union, attention wait, external wait/idle, and run age derived at read time.
- Normalized input/output/cache/reasoning token fields with `provider_reported`, `stream_derived`, `estimated`, or `unavailable` quality.
- Optional versioned price-catalog calculations keeping token facts independent.
- Explicit review-timer contract and observations, attention response/resolution time, intervention counts, and capped observed browser-activity estimates.
- Task/run displays showing human minutes, active/elapsed/wait time, token total/quality, and provenance separately.
- Project/provider/task-type aggregation for later autonomy analysis; no autonomy rules.

## Non-goals

- Treating browser-open time as labor, estimated tokens as exact, process elapsed as active work, or absence of intervention as approval.
- No autonomy rules, no artifact review UI.

## Contracts

### Consumes

- [Event ledger v1](../contracts/event-ledger.md) (uniquely identified raw observations, heartbeats, replay-safe derivation source; E01 computes no intervals).
- [Human attention workflow v1](../contracts/attention.md) (raw `attention_observations` plus `requested_at`/`first_response_at`/`answered_at`/`resolved_at`; A02 timing evidence in `evidence/WP-A02/raw-timing-observations.json`).
- [Result submission and acceptance v1](../contracts/results.md) (submission/review timestamps for run age, review counts for interventions).
- Provider usage fields in `internal/providers/codex` (`exec`/`turn.completed` usage) and `internal/providers/claude` (hook usage) as normalization sources.
- W01 task and run surfaces in `apps/web` and `packages/ui` (task-sheet slot, component conventions; E02 sockets not consumed).

### Produces

- [Measurements and provenance v1](../contracts/measurements.md), freezing the observation, interval-union, token-quality, price-catalog, and review-timer contracts; D1 head `0027_measurements`. V03 consumes the review-timer service and creates no second timer.
- Stable test target `pnpm test:a04` and evidence-manifest path `docs/work-packages/evidence/WP-A04/manifest.json`.
- `packages/domain/src/measurements.ts`: `token.report`/`interval.report` (runner actor, assignment-validated, idempotent with confusion rejection), `review_timer.start`/`stop` (starter-scoped human timer), `browser_activity.record` (capped, estimated), and read-time derivations `getRunMeasurements`/`getTaskMeasurements`/`aggregateMeasurements`.
- `apps/control-worker/src/api/work.ts`: run/task measurement reads, review-timer start/stop, and browser-activity routes.
- `apps/web/src/work/measurements.tsx`: separated task-sheet display with explicit review-timer controls.
- `tools/measurements/run.ts`: real-Worker/D1 fault and derivation harness writing `calculation-snapshots.json`.

## Work plan

1. Freeze `docs/contracts/measurements.md` with D1 heads and the review-timer service; verify with `pnpm docs:check`.
2. Add D1 migration `0027_measurements` plus domain observations, derivations, and commands; verify with `vitest run packages/domain/test/measurements.test.ts`.
3. Serve REST measurement/review-timer/browser-activity endpoints; verify with `vitest run apps/control-worker/test/measurement-routes.test.ts`.
4. Add separated task-sheet measurements with review-timer controls; verify with `vitest run apps/web/test/measurements.test.ts` plus the browser spec on `BFB_E2E_PORT=4187`.
5. Prove hub races over real Workers and D1 with `tools/measurements/run.ts` (duplicate/replayed observations, overlapping intervals, offline gaps, price history, timer races).
6. Commit bounded redacted evidence at the manifest path and one `mvp.progress.md` checkpoint line; regenerate the index with `pnpm roadmap:write`.

## Acceptance

- Duplicate/replayed observations cannot inflate totals.
- Proved by: domain idempotent-replay tests, worker cross-worker duplicate harness with single-row counts, seeded interval-replay property sweep (`pnpm test:a04`).
- Overlapping activity/process/wait intervals deduplicate correctly.
- Proved by: seeded union property tests against brute-force coverage, domain paired turn/tool overlap test, harness overlapping external-wait union (`pnpm test:a04`).
- Runner-offline wall time remains visible rather than silently removed.
- Proved by: domain heartbeat-gap test asserting elapsed keeps the span while `offline_ms` reports the gap, harness offline snapshot (`pnpm test:a04`).
- Estimated/unavailable token values are never displayed/summed as exact.
- Proved by: domain quality-separation and unavailable tests, route honest-empty-state test, browser exact/estimated/unavailable assertions (`pnpm test:a04`).
- Human review time and attention latency remain distinct from agent time.
- Proved by: domain timer/attention-vs-active tests, task rollup keeping review separate, browser human section assertions (`pnpm test:a04`).
- A reviewer can trace every displayed total to source observations/provenance.
- Proved by: observation-ID lists on every token summary, per-total provenance counts, browser provenance section and run API assertions (`pnpm test:a04`).

## Evidence

- Evidence manifest: `docs/work-packages/evidence/WP-A04/manifest.json` (conforms to `docs/work-packages/evidence/manifest.schema.json`).
- Contents: calculation snapshots (`calculation-snapshots.json`), provider-usage fixtures (`fixtures/`), command result (`command-result.json`), acceptance matrix (`acceptance-matrix.md`), interval-property notes (`interval-property-notes.md`), review-timer trace (`review-timer.md`), browser snapshots (`browser/`).
- Evidence is bounded and redacted: synthetic identities only, no secrets, no local absolute paths, no raw terminal output.

## Risks and decisions

- Risk: metrics shape behavior toward false precision. Decision: honest incompleteness everywhere — unpaired starts contribute nothing and are counted, missing idle sources report null with reason, unknown models price as null, empty states name what is missing.
- Risk: sibling packages share the event ledger, MCP-adjacent surfaces, and task sheet. Decision: A04 adds additive tables/commands/routes only; E01, A02, and A03 code is untouched, and the one W01 spec assertion that pinned the replaced placeholder now pins the live panel.
- Risk: price catalogs rot. Decision: catalogs are frozen versioned constants with an explicit unknown-model null; history recomputes under the pinned version.

## Handoff

- State: implementation, `pnpm test:a04` gate, and evidence are complete on this branch at the committed hash recorded in the evidence manifest. `Status` is intentionally left at `planned`: `pnpm roadmap:check` rejects anything beyond `planned` while A02, A03, and E01 are not `done`.
- Consume: `docs/contracts/measurements.md` (v1), domain commands `token.report`, `interval.report`, `review_timer.start`, `review_timer.stop`, `browser_activity.record` plus reads `getRunMeasurements`, `getTaskMeasurements`, `aggregateMeasurements` in `packages/domain/src/measurements.ts`, REST routes under `/runs/:runId/measurements`, `/tasks/:taskId/measurements`, `/tasks/:taskId/review-timers`, `/review-timers/:timerId/stop`, `/browser-activity`, `MeasurementsPanel`/`MeasurementsView` in `apps/web/src/work/measurements.tsx`.
- V03: consume reviewed submission versions plus this review-timer service; never mutate submissions or create a second timer.
- G01: use these metrics as release assertions; no exact product metric comes from sampled logs.
- Token ingestion for live runners goes through the `token.report`/`interval.report` hub commands (same assignment validation as event ingest); no runner REST route was added in v1.
- Limitations: external wait/idle derive only from explicitly reported intervals (the v1 ledger carries no implicit source); failed/cancelled runs without submissions measure run age to read time and say so; aggregation caps at 200 runs with a `truncated` flag.
