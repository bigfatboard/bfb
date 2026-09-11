# WP-G02 — Release, self-hosting, and recovery

Status: `planned`

Risk: Very high

## Outcome

A clean Cloudflare account and clean Mac can install a reproducible tagged BFB v0.1 release, bootstrap its first owner, complete the golden flow, upgrade safely, and follow tested recovery/rollback limits.

## Dependencies

- **Requires:** F03, F04, G01, L04, L08, X02, X05.
- **Unlocks:** none.
- **Can run with:** nothing.

## Scope

- Finalize local/staging/managed-production/self-host manifests with separate D1/R2/DO/Queue/DLQ/OAuth/key/secret resources.
- Prepare and validate managed-production manifests for EU jurisdiction without creating or changing production resources; require self-host jurisdiction choice before resource creation.
- Build reviewed deployment jobs separating build/test, migration, Worker publication, and post-deploy smoke.
- Document/test expand-contract D1 migrations, pre-destructive Time Travel/export, Durable Object lifecycle constraints, and Worker-vs-data rollback limits.
- Build signed/notarized macOS application/binary with stable hook launcher path, Universal Link entitlement, self-host custom scheme, and preserved Keychain/database state.
- Test clean install, first-owner bootstrap, enrollment, checkout link, provider setup, launch, realtime, attention, result, artifact review, and uninstall/upgrade behavior.
- Include the genuinely fresh macOS user-account daemon installation, status and logs check deferred from L01 by [ADR 0003](../adr/0003-local-mvp-account-test-scope.md). Empty BFB state in an existing account is not this proof.
- Add secret/key rotation with current/previous `kid`, incident recovery, DLQ/stuck outbox/upload/containment procedures, and release provenance/inventory.
- Publish self-host instructions containing no hidden dashboard/manual prerequisites.
- Execute AG-10 and OG-02 against clean release environments, then finalize the acceptance report inherited from G01.

## Non-goals

- Production rollout without Timo’s separate confirmation, mixed per-workspace jurisdiction in one deployment, automatic incompatible DO rollout, billing/marketplace, or claiming all edge/log processing remains in EU.

## Work plan

1. Build reproducible cloud/macOS release artifacts and provenance, and dry-run/validate managed-production configuration without deploying it.
2. Drill empty/previous migrations, rollback limits, key rotation, and operational recovery.
3. Run clean-account self-host and clean-Mac install/upgrade golden flow.
4. Prepare managed rollout options, smoke commands, and rollback/forward-repair decision tree for separate approval.

## Acceptance

- Clean Cloudflare account deploys without manually created hidden resources/namespaces.
- Environment identifiers/secrets cannot be accidentally shared.
- Empty and previous-release migrations pass; rollback drill states exactly when forward repair is required.
- First-owner bootstrap consumes once and never promotes the first ordinary signer-in.
- Signed/notarized Mac build preserves Keychain, Universal Link, hooks, database, locks, and recovery markers through upgrade.
- `bfb daemon install/status/logs` passes from a genuinely fresh macOS user account, with account/environment evidence separate from L01's isolated-state fixtures.
- Self-host completes the same golden flow as managed staging.
- Staging and clean self-host post-deploy smoke verifies authenticated handlers, not merely CI/deploy success.
- AG-10 and OG-02 are passed or explicitly waived under `ACCEPTANCE.md`, and the final report contains no remaining `not_run` release gate.
- Package completion creates no managed-production resource and performs no production deployment; rollout remains separately confirmed.

## Evidence and handoff

- Commit release manifest/SBOM/provenance, notarization result, clean-account recording, migration/rollback drill, finalized acceptance report, recovery runbooks, and smoke output.
- Production execution remains a separately confirmed rollout using these artifacts.

## Risks and decisions

- Worker rollback is not database rollback, and incompatible Durable Object changes cannot be gradually mixed. Release automation must encode those limits.
