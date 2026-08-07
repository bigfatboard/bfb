# WP-A04 — Measurements and provenance

Status: `planned`

Risk: High

## Outcome

BFB shows human attention, process elapsed time, active agent work, waiting, and token usage as separate provenance-labelled measurements rather than one misleading total.

## Dependencies

- **Requires:** A02, A03, E01, W01.
- **Unlocks:** G01, V03.
- **Can run with:** V01/V02 if UI ownership is coordinated.

## Scope

- Store uniquely identified typed observations and derive totals; never blindly increment on replay.
- Implement launch latency, process elapsed, process-alive union, active interval union, attention wait, external wait/idle, and run age.
- Normalize input/output/cache/reasoning token fields with `provider_reported`, `stream_derived`, `estimated`, or `unavailable` quality.
- Add optional versioned price-catalog calculations while keeping token facts independent.
- Own the explicit review-timer contract and observations, plus attention response/resolution time, intervention counts, and capped observed browser activity estimates.
- Display human minutes, active/elapsed/wait time, token total/quality, and provenance separately on task/run surfaces.
- Add project/provider/task-type aggregation suitable for later autonomy analysis without implementing autonomy rules.

## Non-goals

- Treating browser-open time as labor, estimated tokens as exact, process elapsed as active work, or absence of intervention as approval.

## Work plan

1. Define observation schemas, interval algebra, quality/provenance, and dedupe keys.
2. Implement derivations over replay-safe event data.
3. Implement human timers/interactions and product displays.
4. Test overlapping intervals, offline gaps, duplicate events, missing provider usage, and historical price changes.

## Acceptance

- Duplicate/replayed observations cannot inflate totals.
- Overlapping activity/process/wait intervals deduplicate correctly.
- Runner-offline wall time remains visible rather than silently removed.
- Estimated/unavailable token values are never displayed/summed as exact.
- Human review time and attention latency remain distinct from agent time.
- A reviewer can trace every displayed total to source observations/provenance.

## Evidence and handoff

- Commit interval/property tests, provider-usage fixtures, calculation snapshots, and task/run UI screenshots.
- Publish the stable review-timer service/observation contract that V03 consumes; visual-review code does not create a second timer implementation.
- G01 uses these metrics as release assertions; no exact product metric comes from sampled logs.

## Risks and decisions

- Metrics influence behavior. Prefer honest incompleteness over falsely precise totals.
