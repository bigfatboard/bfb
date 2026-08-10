# WP-X03 — Remote MCP parity extensions

Status: `planned`

Risk: Very high

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

### Produces

- A versioned extension to the X03A tool map for attention, result submission, and artifact publication.

## Work plan

1. Freeze the additional tool schemas and permissions without altering X03A tools.
2. Bind later domain commands to the existing per-request MCP server.
3. Attack resolution/acceptance/approval/promotion and cross-boundary negatives.

## Acceptance

- Every extension tool has parity tests against its domain command and preserves X03A's authorization/revocation negatives.
- A client may request attention, submit a result, or publish an artifact when delegated; it cannot resolve, accept, approve, promote, or administer.
- Adding extension tools does not introduce persistent MCP session state or widen an existing token's scope/boundary.

## Evidence and handoff

- Commit extension tool-map fixtures, parity tests, and permission-negative results.
- G01 treats this public auth surface as a separate adversarial target.

## Risks and decisions

- This remains a later parity package. The narrow X03A task loop is the web/MCP checkpoint; richer tools wait for their domain owners.
