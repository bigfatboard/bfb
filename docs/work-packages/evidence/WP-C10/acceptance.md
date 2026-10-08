# C10 dormant task-access acceptance

Tested source: `a7edf14fc61d181152d6cc5ed0694fdaa5b1fa89`.
Protocol: unchanged `bfb-wire/1`. D1 head: `0045_private_task_authority`.

## Scope

The clean exact target proves a **dormant authorization kernel**, not a shipped
private-task feature. Existing task creation remains project-shared. No private
creation, ACL mutation, UI control or MCP tool is registered. C11 owns all
delivery/activation gates; C12 owns selected-content publication.

The runtime uses two independent synthetic command proxies to the production
WorkspaceHub and disposable real workerd D1. Shared tasks are created through
Hub HTTP dispatch. Only test fixtures insert private policies/grants. Kernel
queries execute from the test host against the real D1 binding; this is not
browser-cookie, private-route, private-MCP or artifact-redemption proof.

## Acceptance mapping

| Boundary | Committed proof |
| --- | --- |
| Creator plus explicit human grants, no owner bypass | `task-access.test.ts`: 32 unshared-owner/reviewer grant/action cases, four creator cases, twelve shared-role/action cases; real D1 creator-only check |
| Grant/role intersection and creator-only sharing | Same matrix; role-demotion and real D1 reviewer-edit denial |
| Current epoch/member/project authority | Revocation, epoch rotation, removed/rejoined membership, restricted project and revoked/mismatched epochs; real D1 revocation/project fences |
| No existence disclosure from direct denial | Equal constant `not_found` for private, absent and cross-workspace tasks; invalid authority/alias/action rejection |
| Filter before pagination/aggregation | SQL list/count and joined-comment tests; real D1 list/count proof |
| Preserve existing shared records | Previous-to-current migration preserves complete task rows and empty new policy/grant tables; real Hub creation retains shared mode |
| Tenant/creator/retained policy constraints | `task-access-migration.test.ts`: creator and composite-tenant binding, identity/deletion/version constraints; real D1 creator/retention denial |
| Grant identity, epoch and revocation constraints | Same migration tests: active uniqueness, permission/epoch rejection, no rebinding/undelete, explicit new grant; real D1 epoch rejection |
| No partial grants after D1 failure | Real D1 adapter batch rolls back an initial grant when later creator binding fails |
| No activation | Unknown private/ACL command assertions, metadata-only kernel result shape and empty policy table after real production Hub task creation |

Exact `pnpm test:c10` passes 86 cases in eight files, including 58 access cases,
six dedicated migration cases and retained migration/work/board/MCP regressions.
The real D1 harness reports nine checks and all 40 ordered migrations applied.
Separate clean C08 regression passes 23 cases and its real Hub/D1 race proof;
X03 passes 71 cases, eleven Worker/D1/R2 checks and two OAuth browser scenarios.
Full repository/platform verification is recorded separately in the manifest.

## Failing-first and repairs

Four initial schema tests fail before the new migration exists. An additional
negative test then demonstrates a future membership epoch could be pre-granted;
the insertion trigger now requires the recipient's current live membership
epoch. Revocation cannot be cleared and immutable grant authority cannot be
rebound. SQL alias reservation is case-insensitive like SQLite identifiers.

The first full gate also found missing template handoff sections on the planned
C11/C12 records. Those records were corrected without marking them implemented,
and the final source includes the documentation repair.

## Limits and redaction

- No private creation or complete delivery enforcement: existing routes,
  replay/realtime, CLI/MCP, artifacts, notifications and audit are not newly
  certified for private work. Never insert a private policy on pilot/production
  state using this kernel alone.
- Direct-human-created private task fixtures only. C11 must explicitly define
  private agent-child ownership/inheritance and internal-progress audiences.
- No immutable selected-content publication, project-root knowledge, catalogs,
  vault encryption/key recovery, new themes, provider execution or discussions.
- Application authorization is not operator-blind encryption and cannot erase
  provider memory after delivery.
- Only synthetic labels, aggregate counts, source identity and bounded results
  are retained. No credentials, private bodies, raw output or local absolute
  paths are committed. No pilot, real Terminal or deployment was operated.
