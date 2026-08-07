# WP-C02 — Human identity and sessions

Status: `planned`

Risk: High

## Outcome

A human can sign in with GitHub and receive a secure BFB web session, without gaining any workspace authority merely by authenticating.

## Dependencies

- **Requires:** C01, F03.
- **Unlocks:** C03, C04, C05, W01, X03.
- **Can run with:** L02/L03 after L01.

## Scope

- Pin Better Auth exactly to `1.6.26` and add its reviewed generated schema to the ordered D1 migration chain.
- Configure GitHub OAuth, D1 sessions, encrypted provider tokens, exact trusted origins, secure HTTP-only same-origin cookies, and `SameSite=Lax`.
- Disable cookie session caching initially, self-host telemetry, implicit email-based account linking, and user deletion.
- Enforce exact `Origin`, Fetch Metadata, and session-bound CSRF on cookie-authenticated mutations.
- Prohibit session cookies on runner, CLI, MCP, artifact, and webhook credential surfaces.
- Add `kid`-based current/previous encryption/signing key overlap.
- Produce a normalized human principal with no embedded workspace permission.
- Verify auth schema drift in CI.
- Apply C01's durable abuse-control service and bounded request bodies to sign-in initiation, callback/state failures, and other public auth mutations without storing raw OAuth state, code, token, email, or IP values in rate keys or logs.

## Non-goals

- Passkeys, workspace memberships, device credentials, remote MCP grants, GitHub App installation, or enterprise identity.
- Better Auth Organization plugin or wildcard cookies.

## Work plan

1. Generate/review migrations and configure GitHub sign-in/session behavior.
2. Add credential-route separation, Origin/CSRF enforcement, and token encryption.
3. Add key rotation and schema-drift tests.
4. Verify a valid session has zero tenant access until C04 grants it.

## Acceptance

- GitHub sign-in creates a D1 session and normalized human principal.
- A valid session without BFB membership cannot read or mutate a workspace.
- Wrong/missing Origin, Fetch Metadata, or CSRF state rejects browser mutations.
- Browser cookies are ignored/rejected on every non-browser credential route.
- OAuth provider tokens are encrypted at rest and absent from logs.
- Better Auth user deletion and Organization mutation routes are unreachable.
- Accounts sharing an email are not linked implicitly.
- Public auth abuse limits survive Worker-isolate changes and return bounded uniform failures without logging raw OAuth or identity material.

## Evidence and handoff

- Commit auth configuration snapshot, migration diff, route credential matrix, and negative-test report.
- C03/C04 consume only the normalized human principal, not Better Auth internals.

## Risks and decisions

- Plugin defaults are part of the threat model; tests must prove disabled routes stay disabled after upgrades.
