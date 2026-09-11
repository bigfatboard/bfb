# WP-L06 — Hook journal and offline inbox

Status: `planned`

Risk: Very high

## Outcome

Provider hooks return quickly while every accepted provider or daemon observation survives daemon/network failure and receives an explicit server disposition or local quarantine.

## Dependencies

- **Requires:** F02, L01, L03, L05, L08.
- **Unlocks:** A01, D02, E01, L07, P01, P02, X02.
- **Can run with:** W01 and other web work while using the F02 fake ingest server.

## Scope

- Implement bounded `bfb hook ingest --provider` stdin handling.
- Consume the authenticated execution-assignment/correlation record and creation/grace-window state owned by L05; validate correlation, OS user, immutable assignment/generation, and capture time.
- Accept the first trusted `SessionStart` for an unbound assignment as an atomic bind of the observed provider session. An idempotent duplicate may match that session; a competing session ID is rejected/quarantined, and every later session-scoped hook must match the binding.
- Allocate durable event IDs/source sequences transactionally in SQLite; use one source stream per enrollment/database epoch.
- Accept only the bounded semantic candidate produced by the provider-owned L03 parser, then create the canonical BFB envelope, capture origin, assignment reference, and provenance. L06 never re-parses provider raw schemas.
- Journal daemon-observed execution start/block/end, verified process/session heartbeat, containment, and run-control observations through the same durable event sink with `runner_observed` capture provenance; provider hooks remain `agent_reported` candidates.
- Add daemon-down user-only authenticated atomic inbox, import, corruption/capacity quarantine, and `telemetry_degraded` state.
- Upload through L08 asynchronously with retry/backoff and per-event accepted/already/retryable/permanently-rejected behavior.
- Delete/quarantine only from explicit event disposition, never browser/workspace cursor.
- Retain capture authentication through delayed final-hook replay without sending an expired correlation secret to cloud.

## Non-goals

- Provider raw-schema ownership, attention/result/artifact business mutations, terminal transcript upload, guessing a current run, or treating correlation as objective truth.

## Work plan

1. Implement the common event sink/journal/source sequencing and bounded parsed-hook path.
2. Add offline inbox/authenticator/import/quarantine.
3. Add fake-server upload/disposition/retry behavior.
4. Fault-inject disk full, power loss, daemon/network death, first-session races, duplicates, concurrent runs, heartbeat gaps, and final-hook delay.

## Acceptance

- Killing daemon during a hook and network at every upload/ack boundary loses no accepted event and creates one server effect.
- Concurrent/delayed events remain bound to immutable execution assignments.
- Concurrent first `SessionStart` events can establish only one observed provider-session binding; duplicates match it and a different session ID never rebinds the execution.
- A permanent reject cannot block later events.
- Invalid correlation/generation, oversized input, corrupt/full inbox, or closed creation window is visible and safe.
- Hook latency is bounded independently of cloud availability.
- Raw unknown provider fields never reach the cloud semantic ledger.
- Daemon-observed start/heartbeat/end events survive the same restart/upload boundaries as hooks and cannot be asserted through the provider hook path.
- Hooks captured inside the final grace period remain replayable after the creation window closes; later hooks are rejected without invalidating earlier envelopes.

## Evidence and handoff

- Commit fault-injection matrix, session-binding race and heartbeat traces, latency results, SQLite/inbox fixtures, and disposition traces.
- E01 supplies the real ingest endpoint without changing journal deletion semantics.

## Risks and decisions

- Hooks may execute concurrently and more than once. No code may rely on provider hook serialization.
