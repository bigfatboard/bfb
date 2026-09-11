# WP-C06 — Runner identity, grants, and tokens

Status: `in_progress`

Risk: Very high

Test target: `pnpm test:c06`

Evidence manifest: `docs/work-packages/evidence/WP-C06/manifest.json`

## Outcome

The control plane can enroll one Mac separately into multiple workspaces and issue isolated runner identities, grants, proof-of-possession challenges, and short-lived tokens without learning local paths or private keys.

## Dependencies

- **Requires:** C01, C03, C04, C07, F02.
- **Unlocks:** C09, E01, L04, L08, W02, X02, X05.
- **Can run with:** C08 after the shared migration head is agreed.

## Scope

- Add server-side runner identity, owner, project-grant, named-human launch-grant, public-key, challenge, token/grant epoch, and revocation records/commands.
- Require fresh action-bound C03 passkey step-up for initial runner enrollment and for every named-human sharing/grant expansion or removal; a session cookie or generic recent assertion is insufficient.
- Implement browser approval, server-generated short-lived single-use challenge, domain-separated proof-of-possession transcript, and short-lived `bfb-runner` token with subject, workspace, audience, unique token ID, expiry, authorization/grant epoch, and `cnf` key thumbprint.
- Store only public keys and non-secret device metadata in D1.
- Make the runner private to its enrolling human by default; project grants constrain repositories while named-human launch grants constrain who may wake it.
- Require a new challenge for every token issuance/renewal and disable authority plus emit a typed live-channel revocation signal before asynchronous token/credential cleanup.
- Consume C01's durable abuse-control service for enrollment approval, challenge issuance, proof exchange, and renewal with bounded bodies, attempt caps, expiry, and uniform public failures.
- Return only bounded runner identifiers/grants and token material; absolute paths, checkout details, provider credentials, and private keys are never accepted or synchronized by this package.

## Non-goals

- Keychain/private-key creation, daemon or macOS client behavior, WSS lifecycle, socket attachments, reconnect/backoff, heartbeat, command pull/nudges, checkout/capability synchronization, Secure Enclave/XPC, launch claim/execution, or event ingestion.
- Provider credentials or workspace-wide implicit runner sharing.

## Contracts

### Consumes

- C01 WorkspaceHub atomic command lane and durable abuse budgets.
- C03 user-verifying action-bound proofs, C04 current membership/epochs, and C07 project access.
- F02 closed versioned wire schemas and cross-language validation.

### Produces

- `docs/contracts/runner-enrollment.md`: browser approval, native possession, stateful tokens, and L08/C09/E01 handoff.
- `runner-identity`, `runner-challenge`, and `runner-channel-close` v1 wire documents with generated Go/TypeScript bindings.
- Exact target `pnpm test:c06`; evidence manifest `docs/work-packages/evidence/WP-C06/manifest.json`.

## Work plan

1. Add runner/grant/key/challenge/epoch migrations and typed hub commands.
2. Implement step-up-bound enrollment/sharing approval and proof-of-possession token exchange/renewal.
3. Implement authoritative grant/epoch revocation and the typed live-channel close signal consumed by L08.
4. Test multiple workspaces, clock skew, challenge/proof replay, cross-isolate abuse, revocation, and grant changes.

## Acceptance

- Two enrollment fixtures for one device use distinct public keys, runner IDs, tokens, grants, and epochs.
- Workspace A proof/token cannot authenticate to B; consumed challenges cannot replay.
- Initial enrollment fails for a stolen/session-only cookie, missing/expired proof, assertion bound to another action, replayed proof, wrong workspace, or non-user-verifying assertion.
- Sharing/grant changes require their own fresh action-bound proof; an enrollment proof cannot be reused.
- Revocation prevents token renewal and emits the close signal before asynchronous token cleanup.
- An ungranted teammate cannot receive launch authority for another human's runner.
- Challenge/proof abuse limits survive Worker-isolate changes and no raw IP, nonce, proof, private key, local path, or provider credential enters D1 or logs.

## Evidence and handoff

- Exact gate: `pnpm test:c06`.
- Evidence manifest: `docs/work-packages/evidence/WP-C06/manifest.json`.
- Contracts: `packages/domain/src/runners.ts`, `packages/domain/src/runner-crypto.ts`, and `docs/contracts/runner-enrollment.md`.

- Commit enrollment transcript, passkey-bound negative matrix, token fixtures, multi-workspace isolation tests, revocation-signal contract, and abuse-control evidence.
- L08 owns the runner-side key, socket, renewal, reconnect, heartbeat, pull, and capability-sync client. C09/E01 consume authenticated runner identity but reauthorize every command/event.

## Risks and decisions

- Challenge transcripts must bind challenge ID, server nonce, workspace, runner, audience, and key thumbprint. Client/socket risks are deliberately deferred to L08 rather than hidden in this server package.
