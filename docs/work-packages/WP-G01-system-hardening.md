# WP-G01 — Integrated adversarial hardening

Status: `planned`

Risk: Very high

## Outcome

The complete retained v0.1 feature set passes every pre-release tenant, launch, replay, provider, attention, artifact, revocation, injection, and operations gate as one system, leaving only G02-owned clean-release proofs outstanding.

## Dependencies

- **Requires:** A04, E02, L07, P01, P02, V03, W02, X01, X02, X03, X04, X05.
- **Unlocks:** G02.
- **Can run with:** nothing against shared release candidates.

## Scope

- Build a deterministic golden system fixture: three humans, ten projects, five profiles, multiple Macs/workspaces, and concurrent runs.
- Execute every pre-release architecture/security/operations gate end to end. AG-10 and OG-02 remain explicitly `not_run` because G02 owns clean-install and release/rollback proof.
- Add tenant/project/runner credential confusion, malicious IDs/text/config, CSRF/OAuth, stale epoch, duplicate/out-of-order, socket eviction, network/disk/daemon/Mac crash, and PID reuse suites.
- Run cross-provider lifecycle parity while preserving documented capability differences.
- Run hostile artifact/browser isolation and view-secret leakage suites.
- Verify logs/diagnostics/audit/provenance and exact measurement derivation.
- Exercise Queue/DLQ/Cron/GitHub recovery and migration paths.
- Establish bounded performance/resource baselines for the intended 3-person/10-project/5-profile operating envelope.
- Fix discovered root causes in their owning package; do not add test-only workarounds.

## Non-goals

- Deferring feature-package safety tests here, expanding scope, load testing for enterprise scale, or weakening invariants to make the suite green.

## Work plan

1. Assemble reproducible local/staging system fixture and seeded identities/projects/runners/providers.
2. Run architecture gate matrix and adversarial/fault injection.
3. Route failures to owning package, fix root causes, and rerun affected earlier checkpoints.
4. Freeze release-candidate schema/protocol versions and produce final evidence bundle.

## Acceptance

- Every gate not owned by G02 is `passed` or explicitly `waived` under the acceptance rules; AG-10 and OG-02 remain `not_run` with their required procedure/evidence contract ready for G02.
- No cross-workspace/project/runner credential confusion succeeds.
- Exact-checkout, process containment, offline replay, attention/result, and artifact isolation survive injected failures.
- Claude/Codex/Grok never turn Stop/exit into result submission and degrade only as declared.
- Revocation takes effect before asynchronous credential cleanup.
- No secret/private payload appears in URLs, logs, diagnostics, artifacts, or notification text outside policy.
- Clean rerun is deterministic from committed fixtures.
- Every retained result follows `ACCEPTANCE.md` evidence/redaction fields and records exact commit, schema/protocol heads, environment, command, and repository evidence path.

## Evidence and handoff

- Commit the pre-release gate report, fixture seed/version, failure-injection traces, browser security report, and performance/resource baseline.
- G02 receives one tagged release candidate with frozen contracts, AG-10/OG-02 marked `not_run`, their executable procedures prepared, and no undocumented manual repair.

## Risks and decisions

- Integrated testing will expose ownership gaps. Fix the owning package and its tests rather than centralizing behavior in the harness.
