# WP-L06 — Hook journal and offline inbox

Status: `done`

Risk: Very high

Test target: `pnpm test:l06`

Evidence manifest: `docs/work-packages/evidence/WP-L06/manifest.json`

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

## Contracts

### Consumes

- F02 `runner-event-submission`, `event-disposition` and `event-envelope` v1 wire contracts with the TypeScript/Go/Swift codecs and the `FakeControlPlane` ingest double.
- L01 daemon SQLite WAL store, private state paths, bounded local RPC envelope and `local-rpc` v1 (extended additively with `hook_status`, `hook_event_id`, `hook_sequence`, `hook_code`, `hook_pending`, `hook_quarantined`, `telemetry_degraded`, `degraded_reason`).
- L03 provider-owned hook parser (`provider.Registry.NormalizeHook`, `provider.Candidate`); currently only the fake adapter normalizes hooks, so real-provider parsing stays with L07/P01.
- L05 immutable execution assignment, correlation capability, creation time and final-hook grace window through the read-only `supervisor.JournalBackend` adapter; L05 semantics unchanged.
- L08 `RunnerConnection.Request` transport boundary for the `events/submit` upload action; L08 owns credentials, renewal and sockets.

### Produces

- `internal/journal` owning the hook journal, offline inbox, uploader and observed-session binding behind `SessionReader`, `Assignments` and `Observers` interfaces.
- [Observed-session and upload contract](../contracts/observed-session.md) consumed by A01 for run-scoped context and by E01 for the real ingest endpoint.
- Local SQLite migrations `009_hook_journal.sql` and `010_hook_inbox.sql` (storage head 10).
- Deterministic `local-rpc` hook fixtures owned by `pnpm journal:fixtures`; generated codecs via `pnpm protocol:generate`.
- Exact target `pnpm test:l06`; evidence manifest `docs/work-packages/evidence/WP-L06/manifest.json`.

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

## Evidence

- `docs/work-packages/evidence/WP-L06/manifest.json` indexing the tested commit, protocol/schema versions, migration head, toolchains, commands and redaction status per the evidence manifest schema.
- `docs/work-packages/evidence/WP-L06/fault-matrix.md`: the fault-injection matrix with owning test and observed result per boundary.
- `docs/work-packages/evidence/WP-L06/fake-ingest.json`: F02 fake-server disposition report produced by `tools/journal/run.ts`.
- `docs/work-packages/evidence/WP-L06/command-result.json`: bounded aggregate command outcomes.
- `internal/journal` race-tested suites, `internal/supervisor/journal_test.go` backend proof, `internal/cli/hook_test.go` CLI proof and the deterministic `local-rpc.l06-*` fixture corpus.

## Risks and decisions

- Hooks may execute concurrently and more than once. No code may rely on provider hook serialization.
- The first session-scoped hook binds the observed session (a turn may win the race against its own SessionStart); a competing session still quarantines and never rebinds. This keeps benign races out of quarantine while preserving exactly-one-binding.
- Hook ingest commits directly to SQLite instead of proxying through the daemon socket, so a dead daemon cannot lose or delay a capture; the socket was never needed for capture authority.
- Journal failure codes stay local raw strings because the daemon CLI diagnostic table collapses unknown codes; only listed daemon codes cross the CLI boundary.
- Disk-full coverage injects a write fault of the same class (read-only connection) rather than filling the CI volume; the journal reacts identically to every failed SQLite write.

## Handoff

- Settled 18 September: `done`. L05 is `done`, and `pnpm test:l06` passed in a detached clean checkout at `9372c0f` (install, build, exact target with Go race suites and the fake-ingest harness). The evidence manifest is re-based on that rerun; the implementation evidence stays listed as manifest artifacts.
- Commands: `pnpm test:l06`, `pnpm journal:fixtures`, `pnpm journal:fixtures --check` via `pnpm protocol:generate` for codec drift, `bfb hook ingest --provider <provider>`, `bfb hook status`.
- Upload action `events/submit` is served today only by the F02 fake and the journal test double; E01 supplies the real ingest endpoint without changing journal deletion semantics.
- The real Terminal acceptance that blocks L05 is orthogonal: the journal consumed only L05's SQLite assignment and observation state, which the backend proof exercises directly.
- Known limitations: only the fake provider adapter normalizes hooks (real-provider hook shapes belong to L07/P01); no browser or macOS app surface was added; degraded state clears only after a clean inbox drain.
- E01 supplies the real ingest endpoint without changing journal deletion semantics.
