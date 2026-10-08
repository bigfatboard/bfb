# C11 stage-1 human-task delivery checkpoint

Tested source: `02dffa68354ae3897a93bc5a77d08267784156d8`.
Protocol: unchanged `bfb-wire/1`. D1 head: `0045_private_task_authority`.

## Scope and activation

This is the first stage of C11, **not complete package acceptance**. Private
creation, sharing controls and author-private checkpoints remain unavailable.
Existing task creation stays shared. Tests insert synthetic policies only;
neither these fixtures nor a partial certificate authorize pilot activation.
C11 stays `in_progress`; C12 cannot consume it yet.

The stage covers current human task/board/deck selection, delegated task/context
reads, work-command action checks and cached replies. It includes conservative
private-parent child/dependency rejection, parent-reference redaction and
metadata-only receipts. It does not certify arbitrary child records, artifact
bytes, local agent authority, realtime ordering, notifications or diagnostics.
The complete remaining matrix is in `docs/contracts/private-task-delivery.md`.

## Acceptance mapping

| Boundary | Committed proof |
| --- | --- |
| Creator/grantee access without an owner bypass | Domain, mounted browser and mounted MCP tests cover private/missing/current grant/role/project/epoch outcomes |
| Filter before task pages, board and ranked deck | Domain/HTTP/MCP pagination and subtree tests; real-D1 selection and 49-card board proof |
| Narrower credential ceilings | CLI project-subset regression, delegated project/task boundaries and parent redaction above a task-bound root |
| Current credential at selection | Mounted MCP interleavings rotate membership after token resolution and revoke delegation before task selection |
| Action-specific shared work commands | Read/contribute/edit intersections, reviewer ceilings and private-child/dependency denial |
| Fresh authority before cached delivery | Comment/progress/context/link/update/delegated-context retries deny after grant or project loss; stored task relations are re-projected |
| Exact retry identity | Changed-input retries reject; cross-isolate D1 concurrent calls have one effect; historical fingerprintless outcomes fail closed |
| No covered prose in receipts | Synthetic title/comment/context canaries are absent from covered audit, semantic-event and outbox receipts |
| Historical migration compatibility | Five historical migration suites retain original heads/lifecycle/hash preservation; before/after catalog tests discard rows made private during a legacy read |
| D1 adapter parity | Missing `getTask` results normalize D1 null to undefined; full-board queries stay within real D1's parameter ceiling |
| No activation | Browser/MCP private-parent calls and unknown private controls reject; real production-Hub creation produces shared records |
| Reject unsupported private intent | Strict task-tool inputs reject unknown visibility/ownership/audience fields before any task/comment is created; positive shared proposals and progress remain allowed |

Clean exact `pnpm test:c11` composes 86 C10 cases and nine kernel D1 checks,
23 C08 cases and its production-Hub race proof, then 121 stage/regression cases
in six files and nine new real-D1 stage checks. Its dedicated new suites contain
21 domain, four migration-transition, 42 browser/API and 35 MCP cases.

The D1 stage uses independent synthetic command proxies, the production Hub and
disposable workerd D1. Read queries run from the test host against its D1 binding;
the mounted browser/MCP suites separately exercise synthetic real authority
boundaries. Neither is a live-provider or deployed-private-feature certificate.
Separate X03 regression retains 71 cases, eleven Worker/D1/R2 checks and both
OAuth browser scenarios. Full platform results are recorded in the manifest.

## Failing-first and repairs

- The initial focused suite fails 17 of 18 cases before delivery enforcement.
- Historical schema proofs then reveal five pre-0045 fixture paths using the
  shared task reader. Only unscoped historical reads receive schema compatibility,
  with an uncached catalog recheck after reading; explicit human reads never
  fall back. The pre-0038 comment fixture uses its historical synthetic row,
  preserving the existing launch lifecycle and before/after row assertions.
- Real D1 reveals its missing-row null contract; the task helper normalizes it.
- Review finds the board's repeated task-ID lists exceed D1's bind ceiling at
  34 tasks. One visible-task CTE plus a full-page real-D1 regression repairs it.
- Review finds an old delegation could adopt a newer human epoch during task
  listing. Selection now retains the credential epoch and rechecks the active
  delegation. Three mounted adversarial cases retain the reproducer.
- SDK raw-shape wrapping silently strips unsupported private visibility,
  ownership and audience arguments. Ten failing-first mounted cases demonstrate
  actual shared task/comment insertion, not just an unexpected status. Strict
  task-tool schemas reject them while a positive shared-proposal control passes.
  This repair is included in the final source, after the first clean checkpoint.
- Cached child results and task-bound roots initially retained inaccessible
  parent IDs. Fresh scoped relation projection repairs both without rewriting
  stored historical outcomes.

## Limits and redaction

Only synthetic aggregate counts, proof labels and source identity are retained;
no credentials, private bodies, raw output or local absolute paths are committed.
No provider execution, runner enrollment, Terminal consent, menu-app state,
pilot configuration, remote start, agent discussion or deployment was operated.
Project-wide knowledge, catalogs, vault encryption and new theme/design behavior
are not part of this checkpoint. Application authorization cannot erase content
already delivered to a provider or make D1 operator-blind.
