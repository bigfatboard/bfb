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

## Evidence

Not run. Assign the bounded manifest and exact target when publisher/audience
contracts are frozen; retain immutable selection hashes and permission results,
not private source contents or synthetic evidence presented as live delivery.

## Risks and decisions

Publication can widen access irreversibly to already-delivered bytes. The UI
must preview exact contents and explicit audience; no automatic history sharing
or task acceptance is authorized by this planned package.

## Handoff

Planned. C11 is not done and no publication implementation or certificate exists.
