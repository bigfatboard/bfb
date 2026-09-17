# WP-X03 — Remote MCP parity extensions

Status: `planned`

Risk: Very high

Test target: `pnpm test:x03`

Evidence manifest: `docs/work-packages/evidence/WP-X03/manifest.json`

## Outcome

The remote MCP surface can use later attention, result, and artifact commands through the same X03A delegation boundary without changing principal or transport semantics.

## Dependencies

- **Requires:** A01, A02, A03, V01, X03A.
- **Unlocks:** G01.
- **Can run with:** X02/X04 after auth migrations are sequenced.

## Scope

- Extend X03A's fixed tool map with attention request/read, immutable result submission, and artifact publication only after their owning packages are done.
- Reuse A02/A03/V01 transport-neutral commands and the X03A authorization, delegation, idempotency, pagination, revocation, and abuse-control contracts.
- Preserve human-delegated remote attribution. A remote provider label remains client-reported and never becomes a run-scoped `agent_run` identity.
- Prove later tools cannot resolve attention, accept results, approve artifacts, promote root tasks, or administer policy.

## Non-goals

- Changing the X03A transport/OAuth model, service-account automation, workspace administration, result acceptance, artifact approval, or inferring live agent presence.

## Contracts

### Consumes

- X03A stateless MCP/OAuth delegation and A01/A02/A03/V01 command boundaries.
- A02 attention records (`docs/contracts/attention.md`), A03 result submission (`docs/contracts/results.md`), V01 artifact state machine (`docs/contracts/artifacts.md`), local tool naming (`docs/contracts/local-mcp.md`).

### Produces

- A versioned extension to the X03A tool map for attention, result submission, and artifact publication: `docs/contracts/remote-mcp-extensions.md` (tool map v2, twelve tools).
- Four X03-owned hub commands (`attention.request.delegation`, `result.submit.delegation`, `artifact.create_version.delegation`, `artifact.finalize_version.delegation`) registered in the command catalog; owning-package commands keep rejecting delegation.
- Stable test target `pnpm test:x03` and evidence manifest `docs/work-packages/evidence/WP-X03/manifest.json`.

## Work plan

1. Freeze the additional tool schemas and permissions without altering X03A tools.
2. Bind later domain commands to the existing per-request MCP server.
3. Attack resolution/acceptance/approval/promotion and cross-boundary negatives.

## Acceptance

- Every extension tool has parity tests against its domain command and preserves X03A's authorization/revocation negatives.
- A client may request attention, submit a result, or publish an artifact when delegated; it cannot resolve, accept, approve, promote, or administer.
- Adding extension tools does not introduce persistent MCP session state or widen an existing token's scope/boundary.

## Evidence

- Extension tool-map fixture (twelve-tool list in `mcp-remote-parity.test.ts` and the OAuth browser spec), parity tests, permission-negative results, and the attack matrix at the declared manifest.
- `docs/work-packages/evidence/WP-X03/acceptance-matrix.md` maps each Acceptance bullet to its proving test; `attack-matrix.md` records every denied privilege path.
- No migration was needed: no D1 or local schema change; the harness asserts registered/applied state only where migrations are touched (none).

## Risks and decisions

- This remains a later parity package. The narrow X03A task loop is the web/MCP checkpoint; richer tools wait for their domain owners.
- Delegated submission records the authorizing human, never `agent_run` identity; delegated attention binds the run's latest execution assignment; delegated publication requires a run-bound version. The hub audit trail carries the delegation for exact provenance.
- The X03A exact tool-list assertions (handler unit test and OAuth browser spec) now expect twelve tools. X03A tools themselves are unaltered.

## Handoff

- Implementation, gate, and evidence are complete on this branch, but status stays `planned`: dependencies A01, A02, A03, and V01 are not `done`, so `pnpm roadmap:check` rejects any status beyond `planned`.
- Commands: `pnpm test:x03` (build, seven vitest suites, OAuth browser flow on `BFB_E2E_PORT=4193`), plus `pnpm test:x03a`, `pnpm verify`, `pnpm worktree:check`.
- X03A's transport, OAuth model, scopes, and seven tools are untouched; only the tool map grows. No service-account automation was added.
- G01 treats this public auth surface as a separate adversarial target.
