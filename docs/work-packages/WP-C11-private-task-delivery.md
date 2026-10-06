# WP-C11 — Private-task delivery and sharing

Status: `in_progress`

Risk: Very high

Test target: `pnpm test:c11`

Evidence manifest: `docs/work-packages/evidence/WP-C11/manifest.json`

## Outcome

Create private work and explicitly share it without leaking content/existence
through another BFB surface.

## Dependencies

- **Requires:** C10, C05, C06, A01, A02, A03, A04, D01, E02, V03, W01, X03.
- **Unlocks:** C12.
- **Can run with:** no shared authorization, migration, Hub or generated-contract changes.

## Scope

ADR 0015's full delivery matrix, private child/internal-content and agent-view
authority, creator-only ACL commands, named-human read/contribute/edit grants,
opaque principal-scoped cursors and revocation. Uncertified notification/external
integrations fail closed for private resources. Coordinate launch/discussion
consumers with the other lane without implementing provider execution here.

## Non-goals

Publication, provider adapters/remote start, vault values and owner override.

## Contracts

### Consumes

- C10 task-access kernel v1 and migration 0045.
- Current human, CLI, delegation and run-scoped credential contracts as
  independent authority ceilings; no provider/runner acknowledgement wire changes.

### Produces

- [Private task delivery v1](../contracts/private-task-delivery.md), including
  full surface inventory, staged activation, typed commands, internal author
  authority and the opaque recipient-position contract.
- `pnpm test:c11` and its stage-labelled stable evidence manifest.

## Work plan

1. Fence human/delegated task reads and shared work-command cache returns.
2. Fence child records, local agent/pending operations and artifact bytes.
3. Fence metadata/replay/notifications/integrations and coordination consumers.
4. Add creation/sharing/internal-progress controls and certify all stages.

## Acceptance

The delivery contract freezes the complete surface inventory, command shapes,
internal author authority, opaque cursor contract and activation gate.
Prove denied/cached/revoked/concurrent
delivery and existence/count metadata. Every existing surface enforces current
task access or rejects private records. C10 tests alone cannot activate privacy.

## Evidence

The manifest must identify completed stages separately from the complete matrix,
committed source, exact commands and redacted deny/revoke/race results. Kernel
evidence is a dependency, not a delivery certificate. Current baseline:
`pnpm test:c10` passes 86 cases and nine real-D1 checks before C11 code changes.

## Risks and decisions

Existence/cursor metadata can leak even when content is filtered. No private
creation is enabled until every delivery surface is fenced or unavailable.
Coordinate shared contracts without changing the other lane's execution work.

## Handoff

In progress. Contracts and exact target are assigned; private creation remains
unavailable. Stage 1 is clean-certified at `02dffa6`: 121 focused cases, nine
real-D1 checks, C10/C08/X03 regressions and full repository/platform verification
pass. Its manifest explicitly excludes complete package acceptance. The
[child-delivery checkpoint](evidence/WP-C11/stage-two-manifest.json) is
clean-certified at `21e6d8b`: 821 focused cases, 14 real-D1 checks, retained
C10/C08/X03 regressions and full verification with 3,296 TypeScript cases, Go
and all 16 Swift cases. Synthetic task-parent child/content and artifact
authority are fenced; reference-existence privacy, metadata/realtime,
notifications/integrations and creation/sharing/internal-progress controls
remain open. No full delivery certificate, live private R2 byte certificate or
deployment exists. Downstream C12 remains planned until all stages pass from
one clean committed checkout.
