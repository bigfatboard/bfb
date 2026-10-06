# Connected measurement telemetry fixtures

`pnpm protocol:generate` owns the deterministic schema-2 fixture matrix.
`pnpm protocol:check` checks drift. TypeScript and Go production codec tests
consume the same matrix. Existing schema-1 submissions and replay stay frozen;
the schema-1 capabilities/acknowledgement documents name their existing outer
contract without widening it. ADR 0009 defines the production boundary.

Typed synthetic token fixtures prove the closed transport and connected ingestion
path, not live provider usage certification. Pinned Codex/Claude sources without
certified stable usage identity and delta semantics remain unavailable; see
`internal/providers/README.md`. Schema 2 never guesses a cumulative-to-delta conversion.
