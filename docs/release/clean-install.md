# AG-10 executable procedure: clean install and golden flow

Gate AG-10 claims a clean Cloudflare account and a clean Mac install a
reproducible tagged BFB v0.1 release, bootstrap its first owner, complete
the golden flow, and survive upgrade and recovery smoke.

Status: `not_run`. This agent has no second Cloudflare account, no second
macOS user account, and no spare Mac, and its hard limits forbid creating
remote resources or using stored credentials. The procedure below is
implemented, its local halves are proven by `pnpm test:g02`, and the clean
passes run when the environments exist. Nothing here is simulated: a clean
pass needs a genuinely blank account and a genuinely fresh Mac or user
account; empty BFB state in an existing account is not this proof (see
`docs/adr/0003-local-mvp-account-test-scope.md`).

## Environment

- Blank Cloudflare account: no prior BFB workers, D1 databases, R2
  buckets, queues, or secrets. Record the account id alias only.
- Clean Mac: a fresh macOS user account (for the daemon install/status/logs
  check deferred from L01) or a clean Mac (for the full install/upgrade
  flow). Record the macOS version and Xcode version.
- Release inputs: tag `v0.1.<n>`, the release manifest at
  `docs/work-packages/evidence/WP-G02/release-manifest.json`, the SBOM and
  provenance beside it.

## Procedure

1. Check out the tag on the clean Mac and verify the four frozen heads
   against `docs/contracts/release.md` (protocol, schema, D1 head, CLI
   API). Record commit, heads, and toolchain versions.
2. Follow [../self-host.md](../self-host.md) steps 1-5 against the blank
   account with a chosen jurisdiction. No resource may require a manual
   dashboard step outside the guide; any such step fails the gate.
3. First-owner bootstrap: complete bootstrap once, then prove a replayed
   bootstrap is rejected and the first ordinary signer-in stays a
   non-owner. Record both outcomes.
4. Mac install: build and sign with the development profile
   (`node tools/macos/build.mjs`), move the bundle to its stable location,
   and prove the hook launcher path (`Contents/Helpers/bfb __launch`),
   the `bfb://launch/` custom scheme, and the Associated Domains
   entitlement on the signed bundle.
5. Fresh-account daemon check: from the genuinely fresh macOS user
   account, run `bfb daemon install`, `bfb daemon status`, and
   `bfb daemon logs`; prove install, liveness, bounded redacted logs, and
   crash/restart. Record the account-designation evidence separately from
   any isolated-state fixture.
6. Golden flow on the clean pair: enrollment, checkout link, provider
   setup, launch, realtime, attention, result, artifact review. Record one
   line per stage with command and outcome.
7. Upgrade and recovery smoke: install the next release candidate bundle
   over the stable location, prove Keychain items, the daemon database,
   Universal Link handling, hooks, locks, and recovery markers survive,
   then run the DLQ, stuck outbox, and stuck upload recoveries from
   [../runbooks/incident-recovery.md](../runbooks/incident-recovery.md).
8. Append the completed report to the acceptance table in
   `docs/work-packages/WP-G02-release-self-host.md` and flip AG-10 to
   `passed` (or record the failure and the waiver ADR).

## Evidence

Blank-account recording, first-owner bootstrap outcomes, fresh-account
daemon outputs (redacted), golden-flow stage table, upgrade survival
checklist, and smoke output go to
`docs/work-packages/evidence/WP-G02/` under the tested tag. No secrets,
credentials, or local absolute paths are retained.
