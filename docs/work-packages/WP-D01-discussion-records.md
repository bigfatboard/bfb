# WP-D01 — Discussion records and permissions

Status: `planned`

Risk: Very high

Test target: `pnpm test:d01`

Evidence manifest: `docs/work-packages/evidence/WP-D01/manifest.json`

## Outcome

A human can create a task-linked discussion with two authorized participants and an immutable agent-visible brief without starting or completing normal task work.

## Dependencies

- **Requires:** C01, C04, C08.
- **Unlocks:** D02, D03.
- **Can run with:** none during shared D1/hub/domain changes.

## Scope

- Implement ADR 0002 records: discussion, human sponsor, participant runs with discussion purpose, immutable brief/revision, messages, turns, deliveries, and conclusions.
- Add transport-neutral authorized commands through WorkspaceHub, tenant-scoped D1 repositories, migrations, idempotency, version checks, and semantic events.
- Freeze the two-participant roster, permitted runner/checkouts, three-round/six-turn default, deadline, body bounds, and typed reasons for failure/cancellation/changed context.
- Bind messages to authenticated participant/run/session identity rather than self-reported profile names. Keep peer recommendations separate from committed human decisions.

## Non-goals

- Provider execution, live-session invitations, automatic implementation, peer-created participants, inferred agreement, or ordinary task lifecycle changes.

## Contracts

### Consumes

- C01 workspace command serialization/idempotency and event cursor; C04 current human/project authority; C08 task/context/run records and agent-visible audience rules; ADR 0002.

### Produces

- Discussion command/record v1 and versioned wire schemas with immutable brief, participant purpose, message/turn/delivery correlation, typed conclusions and human decision semantics.
- `pnpm test:d01` and the declared redacted evidence manifest.

## Work plan

1. Add records and migrations with purpose-aware invariants that preserve existing work-run behavior.
2. Add create/read/intervene/cancel/conclude/decide commands and participant-scoped delivery transitions.
3. Test permission, concurrency, idempotency, revision and terminal-state failures.

## Acceptance

- Cross-workspace, inaccessible task, human-only context, false participant identity and revoked-sponsor requests fail without state effects.
- Participant run creation and every terminal state leave the task's normal work/result state unchanged.
- Duplicate creation/messages/decisions have one effect; concurrent edits and illegal/out-of-order transitions fail.
- Brief/history are immutable and bounded; changed context is surfaced, never silently substituted.
- Agent recommendation cannot become human acceptance or launch authority; only current authorized humans can decide.
- Exact target passes from a clean checkout, including D1 migration and hub contention cases.

## Evidence and handoff

- Commit schema/migration head, permission/state-transition matrix, replay/concurrency results, and bounded synthetic contract fixtures indexed by the manifest. D02 consumes these frozen commands rather than duplicating business logic.

## Risks and decisions

- Discussion-purpose runs require auditing every normal result transition; purpose enforcement belongs in shared domain commands, not only in UI routes.
