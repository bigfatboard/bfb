# ADR 0015 — Creator-private work and explicit sharing

Status: accepted direction, 6 October 2026; implementation gated by C10–C12.

## Context

Timo confirmed “defaults”: creator plus explicitly shared humans, without
automatic workspace-owner access. Consumer audiences (`human`, `agent`, `both`)
do not provide per-person privacy. Workspace-wide event replay and realtime
hints would expose work if only a private task field were added.

## Decision

- Existing tasks stay project-shared. No automatic private conversion/backfill.
- A private task has one immutable creator-human owner and explicit named-human
  grants. Workspace ownership, profile assignment, runner ownership and project
  access do not bypass its ACL. No administrator override or public bearer link.
- Current membership/epoch and project access are always necessary. A grant
  cannot create project access. Grants bind the recipient's membership epoch;
  removal/rejoin or an epoch change cannot revive an old grant. Re-share explicitly.
- Grants are `read`, `contribute`, or `edit`. They intersect with existing role
  permissions: inspection; explicit comments/answers/reviews; task/context edits.
  Only the creator, currently member/owner with project access, manages sharing.
  No grant widens launch, result acceptance or privileged-action authority.
- The kernel takes the authenticated human/sponsor, not provider/profile labels.
  OAuth scope/boundary and local run/session/assignment checks remain mandatory.
  Agents cannot manage ACLs or create sharing authority.
- Child resources inherit task access. C11 must define private agent-child
  inheritance/internal progress and agent delivery. Changing consumer audience
  cannot widen human access.
- Unshared humans, including workspace owners, receive neither content nor
  private existence/IDs/titles/counts/event hints. Direct absent/denied task reads
  return the same `not_found`. Audit is not a private-content back door. Opaque
  principal-scoped replay positions must replace private workspace-cursor hints
  before activation; payload filtering alone is insufficient.
- Recheck access at delivery, cache return, pending replay, notification dispatch
  and artifact redemption. Revocation stops future delivery, not provider memory.
- C12 publication selects previewed immutable content and an explicit audience;
  it neither shares private history nor accepts a result.

## Implementation sequence

C10 adds dormant D1 policy/grant records and a common current-authority query
kernel. It exposes **no private-create/ACL command, API, MCP or UI control**.
Only synthetic tests insert policies directly. Absence preserves shared access;
once private, policy deletion cannot revert to project sharing.

C11's activation gate covers board/list/count/search/export, task/run/child
records, comments/progress/context, CLI, both MCP paths, ledger/realtime/timeline/
latest work/measurements, attention/notifications, artifacts/grant redemption,
external publication, audit/diagnostics and cached/pending outcomes. Unproved
surfaces reject private records or remain unavailable. Coordinate launch and
discussion consumers with their owning lane; do not change provider execution
here. C10 enables no pilot feature. C12 follows for selected-content publication.

Knowledge, skills, vault key lifecycle and broad UI keep separate contracts.
This is application authorization, not end-to-end encryption against the BFB
operator. Deployment administrators and authorized local providers remain inside
their documented trust zones. Privacy readiness is a cross-surface gate.
