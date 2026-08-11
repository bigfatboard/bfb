# WP-C03 — Passkey enrollment and step-up

Status: `planned`

Risk: High

Test target: `pnpm test:c03`

Evidence manifest: `docs/work-packages/evidence/WP-C03/manifest.json`

## Outcome

Sensitive BFB actions require a fresh, user-verifying, action-bound WebAuthn assertion that a stolen session cookie cannot manufacture.

## Dependencies

- **Requires:** C01, C02.
- **Unlocks:** C04, C06, W01, W02, X03A, X04, X05.
- **Can run with:** none against the same auth routes.

## Scope

- Configure Better Auth Passkey with `userVerification: "required"`.
- Hide ordinary passkey mutation routes behind BFB-owned enrollment/removal flows.
- Require fresh GitHub reauthentication plus an action-bound nonce for initial enrollment.
- Require an existing passkey assertion for later additions/removals.
- Define freshness, replay, origin/RP ID, challenge, and action-binding rules.
- Produce reusable step-up middleware returning a bounded proof reference for one action.
- Record non-secret security audit events for enrollment, removal, success, and failure.
- Apply C01's durable abuse-control service to enrollment, challenge, assertion, and removal attempts with bounded request bodies and uniform public failures.

## Non-goals

- Automatic account recovery, enterprise hardware-key policy, or treating a fresh cookie as step-up.
- Workspace role/final-owner logic; C04 decides which actions require proof and prevents an owner from deleting the final user-verifying authenticator.


## Contracts

### Consumes

- C01/C02 human principal records.

### Produces

- Action-bound passkey step-up proofs with consume-once semantics.
- Stable test target `pnpm test:c03` and evidence path `docs/work-packages/evidence/WP-C03/manifest.json`.

## Work plan

1. Implement nonce/challenge state and strict passkey configuration.
2. Implement first and subsequent authenticator management flows.
3. Add action-bound middleware and audit events.
4. Test replay, stolen-cookie, wrong-origin, expired-proof, oversized-body, and durable abuse-limit paths.

## Acceptance

- A session cookie alone cannot enroll a passkey or perform a sensitive action.
- An assertion for action A cannot authorize action B or be replayed.
- Initial enrollment fails without fresh GitHub reauthentication.
- Later mutation fails without an existing passkey assertion.
- Challenges and proof references expire and are consumed once.
- Challenge/assertion abuse limits survive Worker-isolate changes, store no raw capability/IP value, and return bounded uniform failures.

## Evidence and handoff

- Commit a browser integration test recording, negative-test matrix, and the typed step-up middleware contract.
- C04 consumes the authenticator-management guard to enforce the workspace-owner final-authenticator invariant; C04/C06/X03A name sensitive operations and do not implement alternate step-up paths.

## Risks and decisions

- Recovery is deliberately an operator procedure in v0.1; adding a convenient cookie-only fallback would defeat this package.
