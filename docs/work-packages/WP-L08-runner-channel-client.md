# WP-L08 — Runner enrollment and channel client

Status: `in_progress`

Risk: Very high

Test target: `pnpm test:l08`

Evidence manifest: `docs/work-packages/evidence/WP-L08/manifest.json`

## Outcome

The unprivileged daemon enrolls one Mac separately into each selected workspace and maintains isolated authenticated outbound runner channels without exposing keys, local paths, or provider credentials.

## Dependencies

- **Requires:** C06, F02, L01, L02, L03.
- **Unlocks:** A01, D02, G02, L04, L05, L06, W02, X02, X05.
- **Can run with:** C09 after C06's server runner contracts freeze.

## Scope

- Create one distinct P-256 software signing key and Keychain item for each workspace runner enrollment; C06 owns the server runner identity, grants, challenges, and token issuance.
- Initiate browser enrollment through Local RPC, generate the local key before approval, and complete the server challenge/proof exchange without creating a human CLI credential.
- Sign the domain-separated challenge transcript and exchange it for a short-lived proof-of-possession runner token bound to the enrolled key thumbprint.
- Maintain one outbound WSS/HTTPS connection per workspace enrollment with fresh-challenge renewal, reconnect/backoff, sleep/wake recovery, token/grant epoch handling, and revocation closure.
- Pull durable pending commands on connect, active heartbeat, and periodic recovery; socket nudges are never treated as durable delivery.
- Synchronize bounded provider capabilities and sanitized checkout summaries from L02/L03 without absolute paths, local provider configuration, or provider credentials.
- Keep connection heartbeat distinct from L05's process/session heartbeat.
- Apply Keychain access control that limits key/token access to signed BFB components while allowing the per-user `launchd` daemon to renew when the menu-bar app is absent.
- Expose one `RunnerConnection` boundary for authenticated requests, nudges, command pull, event upload, and connection state; it does not authorize commands or delete journal rows from replay cursors.

## Non-goals

- Server-side runner identity/grants/challenges/tokens, Secure Enclave/XPC, launch claim/execution, provider credentials, event semantics, human CLI credentials, or workspace-wide implicit sharing.

## Contracts

### Consumes

- C06's [runner identity and possession contract](../contracts/runner-enrollment.md), `runner-identity`, `runner-challenge` and `runner-channel-close` v1, with migration head `0014_runner_identity.sql`.
- L01's private Local RPC and credential interfaces, L02's path-free checkout summaries and L03's bounded provider probes. Local migration head is `002_checkouts.sql`.
- Previous checkpoint: C06 clean certification at `0247574` (`pnpm test:c06`, `pnpm verify`, full browser regression and clean-worktree assertion), with evidence committed at `48f925b`.

### Produces

- `internal/runner` owns enrollment, isolated credential generations, authenticated requests, connection state and recovery behind one `RunnerConnection` boundary.
- Native `internal/auth` owns signed-daemon Keychain access without an executable signing oracle or plaintext fallback. The app requests enrollment over Local RPC and does not need raw credentials.
- A hibernating workspace socket stores only principal metadata and expiry. Transport-level command hints do not authorize launch, claim work, infer activity or acknowledge event persistence.
- Exact target `pnpm test:l08`; evidence manifest `docs/work-packages/evidence/WP-L08/manifest.json`.
- [Native channel and RunnerConnection contract](../contracts/runner-channel.md), including local migration `003_runner_enrollments.sql` and D1 migration `0015_runner_channel.sql`.

## Work plan

1. Implement per-workspace Keychain keys, enrollment initiation, browser handoff, challenge signing, and token exchange against C06 fixtures.
2. Implement isolated WSS/HTTPS lifecycles, renewal, reconnect, sleep/wake, epochs, and revocation.
3. Add durable command pull plus bounded checkout/provider capability synchronization.
4. Test multiple workspaces, renewal races, replay, clock skew, lost nudges, app absence, and signed-component Keychain ACLs.

## Acceptance

- Two workspace enrollments on one Mac use distinct keys, runner IDs, tokens, storage records, and sockets; neither key/proof/token authenticates to the other workspace.
- A consumed or audience/workspace-altered challenge cannot replay, and only one renewal attempt updates an enrollment credential.
- Revocation closes the live socket and prevents renewal before local cleanup; reconnect never restores revoked authority.
- Lost nudges, daemon restart, and sleep/wake recover through durable pull without duplicate command handling.
- Capability/checkout synchronization contains no absolute path, provider credential, or provider configuration body.
- A same-user unsigned test process cannot read the runner private key/token, while the signed background daemon can sign and renew without the app running; G02 repeats this gate with notarized release identities and through upgrade.

## Evidence and handoff

- Commit enrollment/channel transcripts, multi-workspace isolation and renewal traces, sleep/wake/lost-nudge results, sanitized sync fixtures, signed-component ACL report, and the `RunnerConnection` contract.
- L05 consumes durable command delivery but performs claim/final authorization and execution; L06 consumes authenticated event upload but retains explicit disposition authority.

## Risks and decisions

- Keychain ACL behavior changes with signing identity, and macOS sleep can collapse several expiry/reconnect boundaries. Both require real signed macOS tests rather than mocks alone.
- The local gate uses an available Apple development identity and isolated synthetic Keychain items. G02 must repeat the boundary with notarized release identities and upgrades; local development signing is not release certification.
- L08 owns transport recovery and bounded durable command references. C09 owns command creation/claim/final authorization and terminal resolution; E01 owns event dispositions. Neither socket nudges nor a connection cursor deletes durable work.
