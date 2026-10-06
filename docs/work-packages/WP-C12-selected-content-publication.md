# WP-C12 — Selected-content publication

Status: `planned`

Risk: Very high

## Outcome

Explicitly publish previewed immutable intermediate/final content to a named
audience without sharing private source history or accepting a result.

## Dependencies

- **Requires:** C11, V03, X03.
- **Unlocks:** none.
- **Can run with:** no shared schema, authorization, Hub or publication-contract changes.

## Scope

Freeze publisher authority, selection/preview, destination audience, immutable
provenance and publish/revoke semantics; implement web/MCP parity after C11.
Publication never implicitly changes source ACL or task state.

## Non-goals

Public bearer links, automatic summary/history publication, result acceptance,
provider execution or secret sharing.

## Acceptance

Before `ready`, specify owning ADR, permission/audience matrix, exact clean
target and evidence path. Prove exact retry, stale preview, changed content,
cross-scope denial and revocation without source-history leaks.
