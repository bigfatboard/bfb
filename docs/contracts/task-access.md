# Task-access kernel v1

Owner: C10. Activation owner: C11. [ADR 0015](../adr/0015-private-work-authorization.md).

Dormant kernel, **not shipped private-task creation**. C10 exposes no creation or
ACL mutation command. C11's separately certified sharing commands insert and
revoke grants through WorkspaceHub; private creation remains unavailable until
C11's complete delivery matrix passes. Every mutation serializes through
WorkspaceHub.

## Records

Absent both direct `task_privacy` and retained `task_privacy_inheritance` rows
retains project-shared behavior. A direct policy row binds a root task to its
immutable direct-human creator and an access version for conditional future
commands. Identity/owner cannot change; deletion cannot revert to shared mode.
No existing task is backfilled. C11's [ADR 0017](../adr/0017-retained-private-task-inheritance.md)
and migration 0050 own the retained descendant-to-root association. It binds exact
workspace/project/task/root and immediate-parent lineage without copying root
ownership into creation-author fields. Association deletion/rebinding and
associated-task parent/project/creation-author changes reject; ordinary workflow
edits remain possible. A task cannot have both direct and inherited privacy.

`task_human_grants` binds private task, named workspace human and authorization
epoch. Permission is `read`, `contribute` or `edit`; revocation is explicit.
Tenant/task/human/epoch identity cannot be rebound. Epoch changes invalidate
old grants; re-sharing requires a new epoch-bound row. C11 owns its commands.
Insertion checks the recipient's current live membership epoch; a future or
revoked epoch cannot be pre-authorized in advance of rejoining.

## Queries

`TaskAccessContext` contains `workspaceId`, authenticated `humanId`, and expected
`authorizationEpoch`. The kernel does not authenticate them; transport-specific
credential, scope/boundary and session validation is independently mandatory.

`taskAccessPredicate(context, action, taskAlias)` returns SQL and parameters.
Membership/epoch, current role, project and task ACL are checked in the **same
query**, before LIMIT/aggregation. Read/contribute/edit resolve the root policy;
`manage_sharing` remains exact-root only. Shared-only predicates exclude an
association even if its policy cannot resolve. Missing inheritance schema never
creates shared authority. Join children to their parent task. A bounded
SQL alias is an identifier, never caller text/an expression. Do not cache access.

`assertTaskAccess(db, context, taskId, action)` uses the same predicate and returns
only task/project/root-policy metadata with its existing DTO keys; root ownership
is not descendant authorship. Missing, other-tenant, stale and denied tasks
raise `not_found` with one constant message.

| Action | Role ceiling | Project-shared | Private |
| --- | --- | --- | --- |
| read | Owner/member/reviewer | Project access | Creator or current grant |
| contribute | Owner/member/reviewer | Project access | Creator or contribute/edit grant |
| edit | Owner/member | Project access | Creator or edit grant |
| manage_sharing | Owner/member | No private policy | Creator only |

This is necessary, not sufficient: no elevated acceptance, launch, policy or
credential authority; context audiences still apply. C10 checks only synthetic
policies on SQLite/real D1 and exposes no creation command. C11 must prove the
complete delivery matrix before activation.

Migration owner: `migrations/d1/manifest.json`; deployment uses Wrangler, never
startup migration. Proof owner: `pnpm test:c10` and disposable
`tools/work-records/privacy.ts`. Fixture writes are test-only, not another
production mutation lane. The D1 adapter follows
[documented atomic batch semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
