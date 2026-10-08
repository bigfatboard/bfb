# WP-A06 — Attributable human contribution history

Status: `planned`

Risk: High

Test target: `pnpm test:a06`

Evidence manifest: `docs/work-packages/evidence/WP-A06/manifest.json`

## Outcome

Humans can inspect a compact task contribution history that identifies who
explicitly contributed, where and when, separately from agent checkpoints and
telemetry. It does not estimate labor, participation quality or time from presence.

## Dependencies

- **Requires:** C11, W03.
- **Unlocks:** W04.
- **Can run with:** no concurrent contribution-source, shared projection, authority, paging or task-detail changes.

## Scope

- Freeze a minimal allowlist of canonical human contribution sources, starting
  with direct human comments/progress, attention actions and result/artifact decisions.
- Project exact actor, committed timestamp, source identity and authorized
  task/object lineage; deduplicate semantic event copies against canonical rows.
- Distinguish direct humans from sponsored agents/delegations and preserve
  author-private checkpoint history as a separate owner/origin view.
- Add an on-demand task history with truthful source-labelled counts and bounded
  ordering/paging; expose the same projection through authenticated web/MCP.
- Include context edits only when their actor/time provenance can be proven from
  immutable Hub records; current context rows alone are insufficient.

## Non-goals

Leaderboards, productivity scores, billing or inferred labor, raw conversations,
browser-open/session time, counting context reads/transport presence, and a generic
security-audit feed that bypasses private task or private checkpoint authority.

## Contracts

### Consumes

- C11 current task/root and checkpoint owner/origin authority and safe delivery;
  C08, A02/A03 and V03 attributed source records through its completed dependencies.
- Existing immutable Hub provenance, explicit A04 measurements and W03 disclosure.

### Produces

- A versioned source/attribution/projection contract with audience-safe counts,
  source dedupe, bounded ordering and continuation semantics.
- One common authorized domain projection, task UI and remote MCP DTO, plus the
  reserved owning test target and manifest. No acceptance command exists yet.

## Work plan

1. Freeze the source matrix and actor/time/object provenance, privacy rules and
   paging limits. Exclude a source with unavailable provenance rather than guess.
2. Implement the projection using canonical records and current-authority guards;
   test duplicates, tied ordering, missing source data and narrowed credentials.
3. Add an on-demand history and MCP read; prove no stale-selection, revoked-cache
   or author-private leakage in useful empty and populated views.
4. Certify bounded domain/transport/browser evidence through the clean target and
   full repository verification.

## Acceptance

- Every visible entry traces to one canonical explicit source with exact actor,
  committed time and object. A sponsored agent is not labelled a human author.
- Retry/event replay yields one contribution; deterministic tied ordering and
  continuation cannot omit, repeat or leak entries/counts across audiences.
- Revocation, restricted projects, private roots and narrower delegation scopes
  deny forbidden current and cached history. Private notes remain author-only.
- Missing actor/time is unavailable, never inferred. Explicit timers are labelled
  measurements and do not count as comments or inferred effort.
- Rendering/retrieving history creates no new contribution. UI is discoverable
  on demand, preserves selection/drafts and works in both themes with W03 limits.

## Evidence

Not run. Future evidence uses bounded synthetic records and source lineage,
dedupe/count/order/permission matrices and compiled UI checks, not real human
messages, task bodies, session history or private audit payloads.

## Risks and decisions

An aggregate can disclose private participation without showing text. Before
`ready`, freeze eligible actions, count semantics and recipient-safe paging.
Use an ADR before changing activity/privacy invariants or adding new collection.

## Handoff

Planned; existing attributed records and timers are foundations, not a compact
cross-record contribution projection or whole-workspace participation report.
