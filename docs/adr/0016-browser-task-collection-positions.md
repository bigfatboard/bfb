# ADR 0016 — Browser task child-collection positions

Status: accepted, 7 October 2026; implementation and activation gated by C11.

## Context

Browser comments, dependencies, links and work-run pages currently expose their
last delivered record ID as a continuation. Timo approved retiring that wire in
favor of per-human opaque positions without a raw-ID fallback. The browser does
not currently consume continuation pages. Filtering private bodies alone does
not provide a recipient-bound position or a stable capture ceiling.

## Decision

- Keep the four existing browser routes and their record DTOs. Their `cursor`
  parameter now accepts only canonical random 32-byte base64url positions. A
  terminal page returns `next_cursor: null`; a nonterminal page returns a new
  position. Raw record IDs are rejected, not translated or silently restarted.
- Bind each position to the authenticated workspace, human, membership epoch,
  exact canonical project audience, parent task/project, collection, page size
  and projection version. Current parent and dependency-target access remains
  necessary on every delivery. A position is not an authorization grant.
- Capture a collection insertion ceiling and a fixed ten-minute expiry using
  the database clock. Descendants inherit both. Retain the exact readable
  last-delivered anchor identity and insertion tuple; hidden rows never count
  toward lookahead and newer backdated records do not enter the captured page.
- Store only domain-separated position hashes and bounded internal metadata in
  an additive D1 table. Use the existing registered WorkspaceHub command lane
  for issuance, including its ordinary redacted audit, outbox, idempotency and
  internal cursor bookkeeping. This read-position exception creates no task,
  comment, progress, interaction, attention or other business action. It does
  not change the Hub kernel or permit direct transport-owned mutations.
- Issue only for direct authenticated humans, including Reviewers with current
  read access. Never send plaintext positions through the Hub, fingerprint,
  receipt, audit or event. Issuance does not replay cached successes. Complete
  selection guards roll back issuance bookkeeping on a committing race; final
  delivery reselects current authority and verifies the issued cut after the
  actual Hub response. Post-commit denial does not erase committed history.
- Retain the original transport project ceiling across all awaits. Uniform
  absent/denied parent delivery takes precedence over cursor validation.
  Invalid, foreign, expired or drifted positions share one bounded rejection.

## Scope and consequences

Context collections remain unpaged. Internal SQL helpers may use internal
record anchors but no browser route accepts one as a fallback. Event/realtime,
other collection positions, execution-owned delivery and private activation
remain separately gated. Expired positions confer no authority; this change
does not add deletion, cleanup or a compatibility flag.

The exact additive acceptance target is `pnpm test:c11:task-positions`, composed
by C11. Migration, mounted routes and native D1 must prove the finite wire and
race contract before its clean-checkout evidence is claimed.
