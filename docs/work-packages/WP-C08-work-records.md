# WP-C08 — Tasks, runs, context, and work APIs

Status: `planned`

Risk: High

## Outcome

Authorized humans and policy-scoped agents can manage the architecture's compact task/run domain, immutable context, and comments through stable APIs without importing Jira-scale workflow.

## Dependencies

- **Requires:** C01, C04, C07.
- **Unlocks:** A01, A03, C09, E01, W01, X02, X03A, X05.
- **Can run with:** C06 after the shared D1 migration head is sequenced.

## Scope

- Add tasks, dependencies, typed context items/versions, links, comments, runs, run executions, provider sessions, and immutable run-configuration snapshots.
- Give tasks a small persisted routing surface: `P0`–`P3` priority, optional due time, mutually exclusive human/agent-profile/unassigned next owner, and a bounded next-action reason. An agent profile assignment routes intended work but never becomes actor identity or proof of activity.
- Implement the architecture's task, run-result, execution, and activity state foundations with optimistic version checks and allowed-state predicates.
- Gate agent-created root tasks as `proposed`; permit policy-scoped child tasks and reserve promotion/acceptance for authorized humans.
- Store task context with `human`, `agent`, or `both` audience and generate immutable context versions with canonical hash and generation time. Record each agent delivery against either a local run-scoped authority or a remote OAuth delegation/client without inventing a run.
- Build run snapshots from explicit C07 policy/profile/configuration version references; later configuration changes never rewrite history.
- Expose paginated `/api/v1` reads and typed hub commands for task/run/context/comment mutations.
- Expose transport-neutral agent commands for delegated task reads, agent-visible context, bounded comments/progress, task proposals, and idempotent mutation outcomes; web, local MCP, and remote MCP use the same handlers.
- Expose deterministic project-lane and current-human-attention projections. The attention projection contains only P0/P1 tasks whose persisted next owner is that human and whose task is blocked or due; it is not an A02 runtime attention request.
- Keep significant changes in the semantic event ledger and preserve Task, Run, Run execution, and Provider session as distinct records.

## Non-goals

- Launch command delivery/claim, provider hooks, A02 runtime attention requests/resolution, result submission/acceptance, artifact bytes, GitHub synchronization, automatic merge/deploy, or broader ticket workflows.
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
- Task priority, due time, next owner, and next-action reason change only through versioned authorized commands. Assigning an agent profile does not start a run or emit working presence.
- The current-human-attention projection excludes other humans, P2/P3 work, unblocked undued work, and agent-owned work and has deterministic ordering.
- Human-only context never appears in an agent view, while authorized humans can inspect the agent-facing view.
- Every delivered agent context version has immutable hash/time plus a delivery binding to the authenticated local run or remote delegation/client; later edits create a new version/event.
- Changing C07 policy/profile/configuration never rewrites an existing run snapshot.
- Provider Stop, tool failure, session end, process exit, and socket loss cannot be represented as result submission or human acceptance by this package.

## Evidence and handoff

- Commit state diagrams as executable tests, API fixtures, pagination/projection tests, context-view snapshots, and immutable run-snapshot fixtures.
- C09/A01/A03/X03A receive stable work commands and record IDs, never direct repositories.

## Risks and decisions

- Resist workflow growth. States not required by the architecture need a reviewed domain decision, and execution presence must remain separate from run result.
