# WP-C08 — Tasks, runs, context, and work APIs

Status: `planned`

Risk: High

## Outcome

Authorized humans and policy-scoped agents can manage the architecture's compact task/run domain, immutable context, and comments through stable APIs without importing Jira-scale workflow.

## Dependencies

- **Requires:** C01, C04, C07.
- **Unlocks:** A01, A03, C09, E01, W01, X02, X05.
- **Can run with:** C06 after the shared D1 migration head is sequenced.

## Scope

- Add tasks, dependencies, typed context items/versions, links, comments, runs, run executions, provider sessions, and immutable run-configuration snapshots.
- Implement the architecture's task, run-result, execution, and activity state foundations with optimistic version checks and allowed-state predicates.
- Gate agent-created root tasks as `proposed`; permit policy-scoped child tasks and reserve promotion/acceptance for authorized humans.
- Store task context with `human`, `agent`, or `both` audience and generate immutable context versions with canonical hash, generation time, and run binding.
- Build run snapshots from explicit C07 policy/profile/configuration version references; later configuration changes never rewrite history.
- Expose paginated `/api/v1` reads and typed hub commands for task/run/context/comment mutations.
- Keep significant changes in the semantic event ledger and preserve Task, Run, Run execution, and Provider session as distinct records.

## Non-goals

- Launch command delivery/claim, provider hooks, attention resolution, result submission/acceptance, artifact bytes, GitHub synchronization, automatic merge/deploy, or broader ticket workflows.
- Treating process/session end as a result or storing raw prompts/transcripts/tool output by default.

## Work plan

1. Add work-record migrations, composite constraints, and state-transition fixtures.
2. Implement task/run/execution/session commands and paginated reads.
3. Implement typed context audiences/versions, comments, links, and immutable run snapshots.
4. Add proposal, audience, stale-version, invalid-transition, and cross-project negative tests.

## Acceptance

- Authorized users can create/read/update only work in permitted projects.
- Invalid task/run/execution transitions and stale versions fail atomically.
- Agent root creation yields `proposed`; an agent cannot promote it or create an unbounded ready backlog.
- Human-only context never appears in an agent view, while authorized humans can inspect the agent-facing view.
- Every delivered agent context version has immutable hash/time/run binding; later edits create a new version/event.
- Changing C07 policy/profile/configuration never rewrites an existing run snapshot.
- Provider Stop, tool failure, session end, process exit, and socket loss cannot be represented as result submission or human acceptance by this package.

## Evidence and handoff

- Commit state diagrams as executable tests, API fixtures, pagination tests, context-view snapshots, and immutable run-snapshot fixtures.
- C09/A01/A03 receive stable work commands and record IDs, never direct repositories.

## Risks and decisions

- Resist workflow growth. States not required by the architecture need a reviewed domain decision, and execution presence must remain separate from run result.
