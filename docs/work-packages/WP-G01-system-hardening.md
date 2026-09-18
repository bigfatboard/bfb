# WP-G01 — Integrated adversarial hardening

Status: `planned`

Risk: Very high

Test target: `pnpm test:g01`

Evidence manifest: `docs/work-packages/evidence/WP-G01/manifest.json`

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

## Contracts

### Consumes

- Every frozen domain contract in `docs/contracts/`: `artifact-review.md`, `artifact-viewer.md`, `artifacts.md`, `attention.md`, `browser-realtime.md`, `cli-credentials.md`, `discussion-delivery.md`, `discussions.md`, `event-ledger.md`, `execution-supervisor.md`, `github.md`, `human-cli.md`, `launch-orchestration.md`, `local-mcp.md`, `macos-app.md`, `measurements.md`, `notifications.md`, `observed-session.md`, `operations.md`, `remote-mcp-extensions.md`, `results.md`, `runner-channel.md`, `runner-enrollment.md`.
- The versioned wire protocol (`bfb-wire/1`, schema `1`) and the D1 migration head `0034_operations`.
- Committed fixtures from the owning packages, including the X04 GitHub webhook corpus (`tools/github/fixtures/webhooks/`).

### Produces

- `docs/contracts/release-candidate.md` (frozen): the release-candidate schema/protocol heads, pinned providers, pre-release gate state, and the G02 entry procedure.
- Stable test target `pnpm test:g01` and evidence manifest `docs/work-packages/evidence/WP-G01/manifest.json` consumed by checkpoint/release automation.

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

## Evidence

- `docs/work-packages/evidence/WP-G01/manifest.json` (conforms to `docs/work-packages/evidence/manifest.schema.json`): gate runs, commit, schema heads, environment, commands, outcomes, redaction status.
- Pre-release gate report (`gate-report.json`): one row per architecture/security/operations gate with status, command, evidence, waiver, and detail; AG-10 and OG-02 are `not_run` for G02.
- Golden fixture (`fixture.json`): seed `bfb-g01/v1`, three humans, ten projects, five profiles, two runners with four checkouts, ten envelope tasks.
- Failure-injection traces (`traces.jsonl`): stable per-suite lines without generated ids or timestamps.
- Browser security report (`browser-security.json`): bearer/CSRF/cookie/hostile-inert Chromium scenarios on `BFB_E2E_PORT=4197`.
- Performance baseline (`perf-baseline.json`): envelope counts plus the bounded hub-burst verdict (no raw timings).
- Redaction scan (`redaction-scan.json`): planted canary classes across every output channel with zero hits.

## Risks and decisions

- Integrated testing will expose ownership gaps. Fix the owning package and its tests rather than centralizing behavior in the harness.
- Native Terminal, live provider turns, and supervisor crash/PID-reuse proofs stay L05-owned: this machine cannot drive Terminal from G01 while the L05 certification agent owns it, so AG-02 and AG-04 carry a scoped waiver with the cloud-plane proof passed in G01.
- Evidence files embed no commit hash, timestamp, or generated id, so `pnpm test:g01` regenerates them byte-identically; the tested commit is bound once in the manifest and command result.

## Handoff

- Implementation, gate (`pnpm test:g01`, `pnpm verify`, `pnpm worktree:check`, clean-checkout gate), and evidence are complete on branch `muse/g01`. Status is left at `planned` (note recorded here and in `mvp.progress.md`) because `pnpm roadmap:check` rejects anything beyond `planned` while A04, E02, L07, P01, P02, V03, W02, X01, X02, X03, X04, and X05 are not `done` (per `docs/work-packages/README.md`).
- G02 receives one tagged release candidate with frozen contracts (`docs/contracts/release-candidate.md`), AG-10/OG-02 marked `not_run`, their executable procedures prepared, and no undocumented manual repair.
- Known limitations: the native Terminal launch trace, live provider turns, and supervisor crash/PID-reuse proofs wait on L05 Terminal acceptance; real-network partition behavior beyond workerd eviction is covered by owning-package evidence; performance figures are bounded-verdict counts for the 3/10/5 envelope, not enterprise load figures.
