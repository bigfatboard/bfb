# WP-G02 — Release, self-hosting, and recovery

Status: `planned`

Risk: Very high

Test target: `pnpm test:g02`

Evidence manifest: `docs/work-packages/evidence/WP-G02/manifest.json`

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

## Contracts

### Consumes

- `docs/contracts/release-candidate.md` (frozen by G01): wire protocol `bfb-wire/1`, schema `1`, D1 head `0034_operations`, provider and auth pins, pre-release gate state, G02 entry procedure.
- `docs/contracts/operations.md` (X05): privileged recovery kinds, retention eligibility, diagnostic inventory, health-check contract.
- `docs/contracts/human-cli.md` (X02): CLI command matrix, JSON envelope, frozen `/api/v1/cli/version` shape.
- `docs/contracts/macos-app.md` (L04): hook launcher path, wake-link bounds, signing and entitlement model.
- `docs/contracts/runner-enrollment.md` (C06/L08): enrollment, challenge, token, and revocation semantics.
- `docs/contracts/cli-credentials.md` (C05): device bootstrap, hash-only storage, Keychain item.
- F03 substrate configs (`apps/control-worker/wrangler*.toml`, `apps/artifact-worker/wrangler*.toml`) and the F04 migration chain with `packages/db` verification tooling.

### Produces

- `docs/contracts/release.md` (frozen): release manifest, per-environment resource inventory, jurisdiction gate, deployment job split, migration and rollback limits, macOS artifact identities, golden flow, secret inventory with current/previous `kid` overlap, provenance and SBOM rules, clean-environment gate procedures.
- Stable test target `pnpm test:g02` and evidence manifest `docs/work-packages/evidence/WP-G02/manifest.json` consumed by checkpoint/release automation.
- Self-host configs `apps/control-worker/wrangler.selfhost.toml` and `apps/artifact-worker/wrangler.selfhost.toml` with separate resources and the jurisdiction choice sentinel.
- Release pipeline `.github/workflows/release.yml` (build-test, migrate, publish, smoke) for the separately confirmed rollout.
- `node tools/g02/smoke-commands.mjs` post-deploy authenticated smoke used by the pipeline and the rollout guide.

## Work plan

1. Build reproducible cloud/macOS release artifacts and provenance, and dry-run/validate managed-production configuration without deploying it.
2. Drill empty/previous migrations, rollback limits, key rotation, and operational recovery.
3. Run clean-account self-host and clean-Mac install/upgrade golden flow.
4. Prepare managed rollout options, smoke commands, and rollback/forward-repair decision tree for separate approval.

## Acceptance

| Bullet | State | Proof |
| --- | --- | --- |
| Clean Cloudflare account deploys without manually created hidden resources/namespaces | Prepared, `not_run` | Self-host guide lists every resource explicitly; AG-10 blank-account pass waits on a clean account (`docs/release/clean-install.md`) |
| Environment identifiers/secrets cannot be accidentally shared | Proven locally | `pnpm test:g02` parses all 8 env configs and fails on any shared D1/R2/queue/worker name; no secret values are committed |
| Empty and previous-release migrations pass; rollback drill states exactly when forward repair is required | Proven locally for the drill, `not_run` for rollout | `migration-drill.json` (empty + `0004` starts converge, rows preserved) and `rollback-limits.json` (Worker/data matrix); Time Travel restore and cross-release upgrade wait on rollout (`docs/release/migration-rollback.md`) |
| First-owner bootstrap consumes once and never promotes the first ordinary signer-in | Proven locally | `golden-flow.json` (consume-once, replay rejected, second bootstrap unavailable); blank-account replay waits on AG-10 |
| Signed/notarized Mac build preserves Keychain, Universal Link, hooks, database, locks, and recovery markers through upgrade | Proven locally except notarization and clean-Mac upgrade | `signing-result.json` (local dev-signed managed-link build, deep-strict verify); notarization is a prepared rollout step; clean-Mac upgrade waits on AG-10 |
| `bfb daemon install/status/logs` passes from a genuinely fresh macOS user account | `not_run` | Executable procedure in `docs/release/clean-install.md`; isolated-state install/status/logs passes locally per ADR 0003 but is not this proof |
| Self-host completes the same golden flow as managed staging | Proven locally | `golden-flow.json` (18 stages) plus `smoke.json` (authenticated handlers, self-host sentinel fails closed); clean-account pass waits on AG-10 |
| Staging and clean self-host post-deploy smoke verifies authenticated handlers, not merely CI/deploy success | Proven locally, `not_run` against deployments | `smoke.json` plus `tools/g02/smoke-commands.mjs`; no deployment exists yet |
| AG-10 and OG-02 are passed or explicitly waived under `ACCEPTANCE.md`, and the final report contains no remaining `not_run` release gate | `not_run` | `gate-report.json` inherits G01 with AG-10/OG-02 `not_run` and committed procedures; status stays `planned` until the clean environments exist |
| Package completion creates no managed-production resource and performs no production deployment; rollout remains separately confirmed | Proven | No `wrangler deploy`, D1/queue create, or secret command ran; only `--dry-run --outdir` and local workerd |

## Evidence

- `docs/work-packages/evidence/WP-G02/manifest.json` (conforms to `docs/work-packages/evidence/manifest.schema.json`): gate runs, commit, schema heads, environment, commands, outcomes, redaction status.
- Release manifest, SBOM, and provenance (`release-manifest.json`, `sbom.json`, `provenance.json`): frozen heads, per-env resources, components, toolchain pins, input hashes; no timestamps or generated ids.
- Local signing result (`signing-result.json`): identifiers, hook path, scheme, entitlement, deep-strict verify; notarization recorded as a prepared step.
- Migration and rollback drills (`migration-drill.json`, `rollback-limits.json`, `rotation-drill.json`): empty/previous convergence, expand-contract audit, Worker/data matrix, `kid` overlap on the real parser.
- Golden flow, smoke, and browser proof (`golden-flow.json`, `smoke.json`, `browser-smoke.json`): 18 local stages, 8 dry-runs, authenticated-handler smoke, Chromium board/attention/review on `BFB_E2E_PORT=4198`.
- Final acceptance report (`gate-report.json`): G01 rows inherited, AG-10 and OG-02 `not_run` with procedures and reasons.
- Recovery runbooks (`docs/runbooks/key-rotation.md`, `docs/runbooks/incident-recovery.md`), self-host guide (`docs/self-host.md`), rollout and procedure docs (`docs/release/`).

## Risks and decisions

- Worker rollback is not database rollback, and incompatible Durable Object changes cannot be gradually mixed. Release automation must encode those limits.
- AG-10 and OG-02 remain `not_run` because this agent has no second Cloudflare account, macOS user account, or spare Mac, and remote preparation is dry-run only. The executable procedures are committed; nothing is simulated or marked passed.

## Handoff

- Implementation, gate (`pnpm test:g02`, `pnpm verify`, `pnpm worktree:check`, clean-checkout gate), and evidence are complete on branch `muse/g02`. Status is left at `planned` because `pnpm roadmap:check` rejects anything beyond `planned` while G01 and X02 are `planned` (F03, F04, L04, L08, and X05 are `done`; per `docs/work-packages/README.md`); AG-10 and OG-02 additionally require clean environments that do not exist here.
- A confirmed rollout executes next, in order: check out the tag and verify the four frozen heads; create self-host or managed resources per `docs/self-host.md` or the approved option in `docs/release/rollout.md`; capture the D1 backstop; run `.github/workflows/release.yml` (build-test, migrate, publish, smoke); notarize and staple the Mac app; run `docs/release/clean-install.md` (AG-10) and `docs/release/migration-rollback.md` (OG-02) and append their reports here.
- Known limitations: notarization, blank-account install, blank-Mac install/upgrade, fresh-account daemon check, Time Travel restore, and cross-release upgrade are prepared but `not_run` (see the acceptance table); live provider turns stay L05-owned; performance figures stay the G01 bounded envelope.
