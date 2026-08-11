# WP-F02 — Wire contracts and test doubles

Status: `in_progress`

Risk: High

Test target: `pnpm test:protocol`

Evidence manifest: `docs/work-packages/evidence/WP-F02/manifest.json`

## Outcome

Cloud, Go, Swift-facing RPC, and tests share one versioned wire language with generated TypeScript/Go types, Swift compatibility fixtures, and executable fake peers.

## Dependencies

- **Requires:** F01.
- **Unlocks:** C01, C06, F04, L01, L02, L03, L06, L08.
- **Can run with:** F03 after F01.

## Scope

- Establish JSON Schema as the canonical persisted/wire contract and generate checked-in TypeScript and Go types.
- Define bounded primitives for IDs, UTC timestamps, versions, pagination, idempotency, typed errors, principals, sources, and authorization references.
- Define the critical-path contracts: runner enrollment/connection, checkout summaries, launch intents/claims/final authorization, immutable execution assignments, local RPC envelopes, normalized event envelopes, source sequencing, and per-event dispositions.
- Give cloud wake intents and daemon-local Terminal intents distinct types and fields so neither can be substituted for the other or carry shell data.
- Define compatibility rules for additive changes, unknown versions/kinds, bounds, and deprecation.
- Add positive and adversarial golden fixtures consumed by TypeScript/Go and published unchanged for the Swift Local RPC decoder suite in L04.
- Build a fake control plane and synthetic protocol client supporting enrollment, command delivery, event acknowledgement, revocation, context, and attention fixtures. L03 owns the process-level fake provider.
- Reserve feature-specific schema ownership for the package that implements that feature; do not model all future payloads here.

## Non-goals

- Database schema generation, REST handlers, auth decisions, provider-specific raw hook schemas or parsing, or arbitrary payload maps.
- Prompts, transcripts, terminal output, or cloud-authoritative tenant fields supplied by a runner.
- Freezing internal Go or TypeScript package APIs that never cross a boundary.

## Contracts

### Consumes

- Repository layout, root verification commands, and `ABOUTME` header exemptions from F01.
- Wire-language decisions in `ARCHITECTURE.md` (event envelope, launch specification, wake vs Terminal intents, principal types, dispositions).

### Produces

- Versioned JSON Schemas under `protocol/schema/v1/` as the only wire contract authority.
- Generated TypeScript types in `packages/protocol-ts/src/generated/` and Go types in `internal/protocol/generated/`.
- Cross-language golden fixtures under `protocol/fixtures/v1/` with a deterministic fixture matrix.
- Compatibility rules in `protocol/docs/compatibility.md`.
- Fake control plane and synthetic protocol client under `packages/protocol-ts/src/fake/`.
- Stable test target `pnpm test:protocol` and evidence path `docs/work-packages/evidence/WP-F02/manifest.json`.

## Work plan

1. Implement schema layout, generator, and drift check with base primitives.
2. Add critical-path contracts, distinct wake/Terminal intent fixtures, and cross-language golden tests.
3. Add invalid/oversized/unknown-version fixtures and bounded diagnostics.
4. Implement the fake control plane/client and a synthetic launch/event round trip.

## Acceptance

- TypeScript and Go decode/re-encode every valid fixture consistently and reject every invalid fixture in the same diagnostic category.
- CI fails when generated files differ from canonical schemas.
- A launch specification cannot represent arbitrary command, executable, working directory, shell fragment, or provider argv.
- A cloud wake intent cannot decode as a daemon-local Terminal intent, and neither can contain task, checkout, executable, or argument data.
- Runner representations cannot make workspace/project/task/run attribution authoritative.
- All persisted arrays, strings, payloads, and timestamps have explicit bounds.
- Fake control-plane/client tests execute in CI; L03 adds macOS process behavior.

## Evidence and handoff

- Commit generated code, the Swift-consumable fixture corpus, fixture matrix, compatibility rules, and synthetic-run output.
- Downstream packages import generated wire types; L04 runs its handwritten Codable boundary against the same fixtures, and a later wire change starts with schema and fixtures.

## Risks and decisions

- The main risk is freezing guesses. Keep the first version narrow and let feature packages extend it deliberately.
