# ADR 0009 — Connected measurement telemetry and truthful derivation

Status: Accepted for implementation under the approved local-MVP scope in
[mvp.plan.md](../../mvp.plan.md), 6 October 2026, after independent protocol,
runtime and acceptance review. A03 is done at its committed runtime certificate.
This decision starts A04 integration; it is not A04 acceptance or permission
for Terminal automation, live-provider work or deployment.

## Context

A04's historical tests populate measurements directly. The production hook
journal drops usage counters, and its acknowledgement decoder rejects the
Worker's real response fields. Existing isolated acceptance therefore does not
prove durable provider-to-measurement delivery. Frozen submission and replay
v1 documents permit only empty payloads and must not be widened.

Review also reproduced cached measurement commands bypassing current authority
and changed-input checks, process time fabricated from never-attached execution
creation, live trailing offline time suppressed, and future reported activity
counted before it occurs. These defects violate the existing truthful-measurement
contract; they are not reasons to relax authorization or label estimates exact.

## Decision

### Versioned telemetry on the existing durable event path

Add a separately named, closed `runner-telemetry-submission` document with
`schema_version: 2`. Keep `runner-event-submission` v1, `event-envelope` v1,
`event-disposition` v1, the outer `{schema_version: 1, events: [...]}` batch,
the existing ingest URL and their old fixtures unchanged. Dispatch each batch
item by its explicit version; a mixed batch is permitted.

The v2 item retains event ID, source stream/sequence, execution/generation,
occurrence time, capture origin and optional provider event/session identity.
It carries no claimed provider, local path, text, tool argument/output, prompt,
credential or caller-selected task/run authority. Its closed kind/payload pairs
are:

- Existing turn/tool lifecycle kinds with `payload: {activity_id}`. Activity
  identity is bounded opaque data, scoped to the immutable execution and
  activity family; optional `parent_turn_id` is permitted only for tool events.
- `progress_reported` with `payload: {measurement: "tokens", usage_id,
  basis: "turn_delta", model, quality, tokens}`. This is a typed telemetry
  subtype, not an A01 business progress report or task mutation. `tokens` has
  exactly `input`, `output`, `cache_read`, `cache_write`, `reasoning`, each a
  nullable non-negative safe integer. Model is bounded reported metadata or
  null. Unavailable quality requires all-null counters. Missing fields never
  become measured zero.

Adapters may emit delta usage only when their pinned tested source establishes
that basis and stable identity. Cumulative or unidentified reports cannot be
invented into independent additive deltas. Preserve available cache/reasoning
fields without claiming support for newer provider versions. A missing source
stays unavailable. Native capture retains typed activity identity rather than
pairing unrelated tools by arrival order.

The uploader first reads a fixed possession-authenticated `events/capabilities`
action. Its closed response is `{schema_version: 1, accepted_event_versions:
[1, 2]}` for this implementation. Absence, unsupported versions or discovery
failure keeps v2 rows durable and visibly upgrade-required/unavailable; never
strip the payload, relabel it v1 or quarantine it merely for peer-version
incompatibility. Recheck support after reconnect and fail closed after an
unexpected unsupported-version response. v1-only work remains usable.

Retain current item/batch limits, budgets and uploader cadence. Validate the
actual closed acknowledgement `{schema_version, workspace_id,
high_water_cursor, dispositions}` including the expected workspace and every
event/stream/sequence. Only explicit matching per-item dispositions can delete
or quarantine an outbox row; the high-water cursor never acknowledges work.
Malformed, duplicate-conflicting or cross-workspace acknowledgements retain it.

### Atomic observation persistence and historical attribution

Use the existing authenticated hook/inbox, SQLite journal, runner channel and
WorkspaceHub ingestion command. No second upload queue, measurement transport,
parallel mutation path or recursive Hub command is introduced. Current runner
credentials/grants and the immutable historical execution assignment authorize
captured telemetry, including delayed replay after execution end. Do not reuse
the live-session/lease/result requirements of A01–A03 business writes.

Derive provider and execution configuration from the immutable launch snapshot,
not a mutable agent profile. Within one staged D1 batch, commit the ledger row,
typed source identity/fingerprint and corresponding token observation. Share
measurement validation and row construction with explicit measurement commands.
Hooks remain telemetry: they cannot create attention, results, task progress,
human review or completion.

An original event identity always binds its full canonical v2 input. A semantic
usage identity binds one immutable execution, basis and normalized counter set;
another capture or stream of the same usage cannot inflate totals. Activity
dedupe includes its phase, so a start does not suppress the matching finish.
Changed data under an existing identity is a visible conflict. Native dedupe
identity survives outbox acknowledgement/deletion and restart. Retention and
capacity remain bounded; inability to retain required identity fails visibly
instead of evicting it and silently admitting duplicate measurements.

Add only the source-identity persistence required for this slice: reserve D1
`0041_measurement_sources` and daemon `011_measurement_telemetry`. Preserve
historical ledger, snapshot, token and protected agent-journal bytes. The A03
protected business journal remains independently at `014_result_journal`.

Replay v1 is explicitly a safe metadata projection, with empty payload, for
typed telemetry rows; it is not a raw canonical-payload export. WebSockets still
send cursor invalidations. Authorized measurement reads expose bounded source
identities/provenance sufficient to trace displayed totals, without putting
usage payloads in audit, notifications or task prose.

### Authorization, derivation and honest display

All five measurement commands validate current authority inside the Hub FIFO
before cache delivery and fingerprint the exact business request. Cached timer
stop may replay after the transition, but only for its currently authorized
starting human. Changed input, stale epoch, revoked project/runner grant and
cross-workspace retry cannot reuse a cached success.

Observed attachment or an explicit valid process interval is required for
process measurements. Creation, queued/launching state and transport presence
are not process start. Derive elapsed/alive/offline intervals per execution,
clip to observed bounds and read time, retain offline wall time inside elapsed,
and show the stale tail of a still-live execution. Do not mask a resumed
execution's outage with another execution's historical heartbeat.

Typed active intervals pair only matching execution/activity identities.
Legacy identity-free evidence must remain visibly lower-confidence or
unavailable where it cannot support an unambiguous pair. Unpaired starts do not
become continuous active work. Future/out-of-execution reported intervals must
not inflate current totals; delayed valid telemetry remains admissible.

Validate all supplied token aliases, rejecting conflicting or invalid values.
Checked aggregation must never return an unsafe rounded integer as exact.
Overflow is explicit and its affected total/cost unavailable, with original
observations preserved. Display input/output totals without double-counting
cache or reasoning subsets. Keep provider-reported, estimated and unavailable
facts, human review, attention, elapsed, active, external/idle and offline time
separate. Aggregated human review stays distinct from agent measures.

Preserve existing visual styling. Add the missing measures, concise provenance
and honest loading/empty/denied/overflow states with accessible controls. This
is not the mandatory product-wide neon/light-dark redesign or the broader
private human-contribution history feature.

## Verification and evidence

Retain failing repros for acknowledgement shape, cached authority/input changes,
never-attached executions, live stale tails, future intervals and unsafe sums.
Prove mixed versions and frozen-v1 drift; native capture, lost acknowledgements,
restart/offline replay and persistent dedupe; current/historical assignment
boundaries; atomic ledger/observation rollback; immutable provider attribution;
and private-body redaction. An unsupported server must leave typed rows visible
and durable without silent downgrade or poison disposal.

Repair the real-D1 harness using actual current-authorized A02 binding and
attention before execution end, plus canonical A03 submissions/reviews. Keep
fixed-date calculation fixtures separate from current security clocks. Add a
compiled synthetic capture-to-authenticated-Worker/Hub/D1 proof, separated API/UI
assertions and deterministic bounded runtime evidence. Preserve historical
manifests, snapshots and images; never relabel them as fresh proof.

Expand exact `pnpm test:a04` to own the necessary protocol, native/journal,
cloud, arithmetic and browser checks. Re-run affected E01/L06 gates and repository
verification from a clean committed candidate. Any changed A01–A03 authority or
native path also requires its affected regression. Only committed clean evidence
can close A04; synthetic proof is not IC-5/live-provider or full-MVP acceptance.

Cloud persistence continues using the existing Hub FIFO and staged transaction
adapter, consistent with current [D1 batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
Do not substitute Durable Object local storage for canonical D1 or assume that
awaited external I/O needs no serialization; see [Durable Object state](https://developers.cloudflare.com/durable-objects/api/state/).
