# WP-C10 — Private-task authorization kernel

Status: `done`

Risk: Very high

Test target: `pnpm test:c10`

Evidence manifest: `docs/work-packages/evidence/WP-C10/manifest.json`

## Outcome

C11 can use one D1-backed creator/named-human task predicate without an owner
bypass or post-pagination filtering. Existing shared tasks are unchanged.
The kernel does not enable private creation or certify transport delivery.

## Dependencies

- **Requires:** C04, C08.
- **Unlocks:** C11.
- **Can run with:** provider-local work not editing D1, authorization or Hub contracts; sequence shared merges.

## Scope

Dormant policy/grant records with tenant FKs, creator binding, immutable policy
identity and epoch-bound grants. Parameterized fresh membership/project/ACL
predicates for individual, paginated, count and child-resource queries. Uniform
absent task denial. Migration/constraint attacks, stale-authority and permission
matrix tests plus disposable real-D1 proof.

## Non-goals

Private creation, ACL mutation commands/routes, transport/UI enforcement,
agent-child inheritance, internal progress and publication belong to C11/C12.
No provider execution, administrator override, agent identity or credential.

## Contracts

### Consumes

C04 memberships/epochs/project grants; C08 task records; migration head
`0044_agent_profile_permissions`; protocol v1 unchanged; async SqlDatabase;
WorkspaceHub mutation ownership; [ADR 0014](../adr/0014-private-work-authorization.md).

### Produces

[Task-access kernel v1](../contracts/task-access.md), migration
`0045_private_task_authority`, `taskAccessPredicate` and `assertTaskAccess` for
C11. No new command registered. Exact `pnpm test:c10` builds, runs migration/
kernel regressions and dormant-activation checks, then real D1 assertions.

## Work plan

1. Run unchanged C08 checkpoint; record defaults and ADR before implementation.
2. Add failing-first tests, then schema/kernel; prove disposable real D1.
3. Commit source; run exact acceptance and full verification in a clean
   checkout; commit bounded evidence and generated roadmap state.

## Acceptance

- Creator and explicit grants require current membership/epoch/project access.
  Unshared owners/members/reviewers cannot read private tasks.
- Grant permissions intersect current role; edit grants cannot elevate a
  reviewer and grantees cannot manage sharing. Invalid IDs/actions fail closed.
- Revocation, epoch change, project/member removal/rejoin and role changes
  defeat stale contexts. Missing/cross-tenant/unshared reads fail identically.
- List/count/child predicates omit private rows before LIMIT/aggregation.
- Migration preserves shared task content. Constraints reject foreign task/
  human binding, non-creator policy, policy deletion/owner mutation, invalid
  permission/epoch and grant authority rebinding.
- No private/ACL command or control is enabled. Exact clean target, real D1 and
  full `pnpm verify` pass; no pilot/provider execution.

## Evidence

Declared manifest records committed source, heads/tools, exact commands,
permission/constraint counts and limits. Only bounded synthetic evidence;
no secrets/private bodies/raw output/local paths.

## Risks and decisions

C10 is dormant, not private delivery. Only direct-human-created tasks are in
its fixture contract; C11 must define private agent-child inheritance explicitly.

## Handoff

Clean-certified 6 October at `a7edf14`. Frozen install, exact acceptance (86
cases/eight files and nine real-D1 checks), C08/X03 regressions and full
verification (2,987 TypeScript cases, Go and 16 Swift cases) pass at the same
source. Both clean-worktree checks pass; evidence is committed at the declared
manifest. The kernel is dormant: no private creation/ACL command, UI or delivery
certificate. C11 can now freeze its activation contract without enabling the
pilot or treating kernel tests as cross-surface proof.
