# Trusted observed-session binding

Owner: [L06](../work-packages/WP-L06-hook-journal.md). Gate: `pnpm test:l06`.

## Read path

```go
binding, err := store.BoundSession(ctx, executionID, generation)
```

`internal/journal.SessionReader` is the only trusted read path for the
provider session observed behind a run. It returns `ObservedSession` with the
bound provider, session ID, run/execution IDs, generation and bind time. An
unbound execution fails with `session_unbound`; the reader never guesses a
current run and never exposes the correlation capability, paths, credentials
or provider payloads.

A01 consumes this interface to scope run-local MCP context to the exact bound
session. The supervisor adapter (`internal/supervisor.JournalBackend`)
implements the assignment side; the journal owns the binding rows created by
hook ingest or inbox import.

## Binding rules

- The first session-scoped hook for an unbound assignment atomically binds its
  session ID. Concurrent first hooks have exactly one winner.
- A duplicate SessionStart matching the binding is idempotent and journals no
  second session event.
- A competing session ID is rejected and quarantined; it never rebinds the
  execution.
- Later session-scoped hooks must match the binding or quarantine with
  `session_conflict`.
- Daemon-observed facts (`runner_observed`) never create or satisfy a binding;
  provider hooks (`agent_reported`) never assert daemon kinds.

## Upload contract

The uploader batches journaled `runner-event-submission` documents through
`RunnerConnection.Request(ctx, "POST", "events/submit", body)` with
`{"schema_version":1,"events":[...]}` and applies the returned
`{"schema_version":1,"dispositions":[...]}` per event: `accepted` and
`already_committed` delete the row, `permanently_rejected` quarantines it, and
`retryable` or any transport fault keeps it queued with backoff. Only an
explicit disposition deletes or quarantines a row. The submission carries the
immutable assignment reference and the runner credential proof; it never
carries the correlation secret, so delayed final-hook replay needs no expired
capability. E01 owns the real ingest endpoint and must preserve
disposition-only deletion.
