# WP-C04 — Workspace authorization

Status: `planned`

Risk: Very high

## Outcome

Three humans can share a BFB workspace with different roles while BFB remains the only tenant authorization authority; later resource packages extend this framework with project and runner grants.

## Dependencies

- **Requires:** C01, C02, C03.
- **Unlocks:** C05, C06, C07, C08, C09, E01, V01, W01, X03, X04, X05.
- **Can run with:** local-only packages after L01.

## Scope

- Extend F04's minimal workspace registry with authorization-owned state; add membership, invitation, role, authorization-epoch, and resource-grant authorization primitives. C07 and C06 own project and runner grant rows after those resources exist.
- Create first-owner bootstrap with a hashed one-time secret and fresh GitHub authentication.
- Add copyable invitations bound to normalized verified email, server-assigned role, expiry, and hashed one-time secret.
- Enforce Owner, Member, and Reviewer workspace permissions and a typed resource-authorization extension point.
- Enforce final-owner, workspace-owner final-user-verifying-authenticator, and identity `ON DELETE RESTRICT` invariants.
- Resolve workspace routes explicitly; never authorize from a cached active-workspace preference.
- Revoke access by disabling BFB grants/epochs before asynchronous credential cleanup.
- Apply C01's durable abuse-control service to bootstrap and invitation creation/acceptance with bounded request bodies, attempt caps, expiry, and uniform public failures.
- Keep Better Auth Organization disabled and make its routes unreachable.

## Non-goals

- Projects/project grants, runner/launch grants, runner key enrollment, tasks, provider policy, remote MCP OAuth, enterprise directory sync, or user deletion.

## Work plan

1. Add authorization migrations and hub commands.
2. Implement bootstrap, invitations, memberships, roles, and the resource-authorization extension point.
3. Add revocation epoch/outbox behavior plus final-owner and final-authenticator constraints.
4. Generate exhaustive cross-tenant, workspace-role, authenticator, and abuse-control tests.

## Acceptance

- Three fixture humans have demonstrably different workspace roles.
- Every tenant repository/API test rejects cross-workspace IDs; C07 adds project-level coverage.
- Workspace IDs come from route/grant context, never request JSON.
- The first ordinary signer-in is not promoted; bootstrap consumes exactly once.
- Invitation secrets are hashed, consumed once, and accepted only by the matching verified email.
- The final owner cannot leave/demote or delete the final user-verifying authenticator, and referenced identities cannot be deleted.
- Revocation blocks the next authorized command before credential cleanup runs.
- Bootstrap/invitation limits remain durable across Worker isolates; raw IPs and one-time values appear in neither rate keys nor logs.

## Evidence and handoff

- Commit the permission matrix as executable tests, migration constraints, and revocation event contract.
- Downstream handlers receive immutable `Principal` plus derived `AuthorizationContext`; C07/C06 extend it with project/runner resources.

## Risks and decisions

- D1 has no row-level security. A missing workspace predicate is critical, so repository shapes and tests must make omission difficult.
