# ADR 0017 — Retained private-task inheritance

Status: accepted implementation direction, 8 October 2026; C11 activation held.

## Context

ADR 0015 gives a private root one immutable human creator and named-human grants.
Copying that creator into an agent-authored child would falsify attribution.
Checking only a child's direct `task_privacy` row would instead classify the child
as shared. C11 must resolve the same retained root in authorization, shared-only
selection and private metadata before it can enable creation.

## Decision

- Keep `task_privacy` and its grants attached to the exact root task. Add an
  immutable, retained `task_privacy_inheritance` association for each descendant,
  binding workspace, project, task and root. Composite foreign keys bind both
  tasks to the same project and the root to its existing policy. Association
  insertion requires an immediate parent that is the root or inherits that same
  root. A task cannot have both a direct policy and inherited authority.
- Preserve the descendant's actual human/delegation attribution, including null
  human attribution for execution-authored records. Inherited authority is not
  an author field. Retain association identity, parent/project lineage and
  recorded creation authorship; deletion cannot turn a descendant shared.
- Resolve the effective root in the common task-access kernel and metadata
  lookup. Shared-only consumers exclude both direct policies and associations,
  even when a malformed relationship could not resolve a policy. Missing schema
  or relationship data must not create new shared authority. Keep only the
  existing narrow pre-0045 historical `getTask` fallback.
- Read/contribute/edit use the current root's creator/grants plus current
  membership epoch, role, project and each transport's independent ceilings.
  Sharing management, grant records and receipts remain exact-root operations;
  descendant IDs are not silently reinterpreted as root sharing commands.
- A future direct-human `task.private.create` uses the existing creation fields
  and infers root ownership from the authenticated human. With no parent, or a
  shared parent the caller may edit, it creates a new private root. With a
  private parent the caller may edit, it creates an inherited descendant, not
  another independent ACL. Existing shared root creation never changes mode.
  There is no conversion, backfill, caller-selected privacy owner or agent root
  private-creation command.
- Independent private roots beneath shared parents must not consume a hidden
  shared-agent child quota. The existing twenty-active-child quota is measured
  within the parent's authority family: shared children of a shared parent, or
  descendants inheriting the same root as a private parent. Terminal children
  remain excluded. This quota does not count only agent-authored records, does
  not depend on the requesting human's personal grants and does not expose a
  private-root count to a shared caller. Existing serialized-command scheduling
  remains unchanged; this is not a new external concurrency guarantee.
- Prepare the domain creation command and synthetic inheritance proofs without
  registering private creation in the production command catalog, browser, CLI
  or MCP. No flag or test endpoint may open it. Existing private-parent creation
  and execution proposals remain held until their own integration is certified.
  Browser controls and command registration follow only after C11's complete
  delivery matrix passes at one clean committed source.

## Consequences and proof

This is an additive authority association, not a replacement authorization
system or provider/runner protocol change. Existing task and policy rows are not
rewritten. Full C11 activation, execution-owned private delivery, destructive
private retention and C12 publication remain separate gates.

The finite inheritance slice proves populated migration preservation, immutable
tenant/project/root/parent relationships, truthful descendant authorship,
creator/grant/role/epoch intersections, root revocation, filtering before limits,
shared-only exclusion, exact-root sharing, author-private checkpoint separation,
creation receipts/retries/atomic rollback and authority-family child quotas.
Synthetic policy/association fixtures and parallel-Hub backstop probes must be
labelled; they cannot certify live provider delivery or enable private creation.
