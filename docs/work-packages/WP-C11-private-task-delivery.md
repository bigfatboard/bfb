# WP-C11 — Private-task delivery and sharing

Status: `planned`

Risk: Very high

## Outcome

Create private work and explicitly share it without leaking content/existence
through another BFB surface.

## Dependencies

- **Requires:** C10, C05, C06, A01, A02, A03, A04, D01, E02, V03, W01, X03.
- **Unlocks:** C12.
- **Can run with:** no shared authorization, migration, Hub or generated-contract changes.

## Scope

ADR 0014's full delivery matrix, private child/internal-content and agent-view
authority, creator-only ACL commands, named-human read/contribute/edit grants,
opaque principal-scoped cursors and revocation. Uncertified notification/external
integrations fail closed for private resources. Coordinate launch/discussion
consumers with the other lane without implementing provider execution here.

## Non-goals

Publication, provider adapters/remote start, vault values and owner override.

## Acceptance

Before `ready`, freeze complete surface inventory, command/route shapes,
internal-content author authority, opaque cursor contract, activation switch,
exact clean target and evidence path. Prove denied/cached/revoked/concurrent
delivery and existence/count metadata. Every existing surface enforces current
task access or rejects private records. C10 tests alone cannot activate privacy.
