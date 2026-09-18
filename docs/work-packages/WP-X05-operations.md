# WP-X05 — Operations, audit and retention

Status: `done`

Risk: High

Test target: `pnpm test:x05`

Evidence manifest: `docs/work-packages/evidence/WP-X05/manifest.json`

## Outcome

Owners audit security events, recover stuck delivery work idempotently,
enforce raw-log retention, ship redacted diagnostic bundles with explicit
consent, and read workspace health from one permission-aware Operations
surface in the W01 product shell.

## Dependencies

- **Requires:** C01, C03, C04, C06, C07, C08, C09, E01, L01, L02, L03, L08, V01, W01, X01, X04.
- **Unlocks:** G01, G02.
- **Can run with:** D03, L05, L06, L07, X02.

## Scope

- Operations UI for members/grants/runners/checkouts/policies, GitHub, notifications, retention, and audit surfaces.
- Implement the Owner versus member/reviewer permission-aware UI, including health-check submission and recovery affordances.
- Query/read models for security audit distinct from ordinary activity.
- Configure Queue/DLQ visibility, retry controls, durable integration/audit outbox monitoring, and recovery tooling (idempotent retry for privileged jobs and explicit clearing operations).
- Configure Cron for outbox dispatch, missed nudges, stuck uploads, independently keyed raw-log retention, and notification recovery.
- Implement the retention policy metadata (retention windows, exclusions, legal/consent basis) and per run/object lifecycle observability of what was deleted, retained, or blocked.
- Implement structured diagnostics: deterministic redaction (IDs, counts, cursors, hashes only, no task content or payloads), medium classification, bundle format and inventory, upload mechanics (explicit consent per upload, no silent auto-upload), and per diagnostic retention/disposal semantics.
- Implement health checks: migrations, bindings, queue lag, stuck commands/uploads, token/key rotation, and the generic provider integration records L03 exposes (provider-specific packages remain responsible for populating their records).
- Require Owner plus fresh action-bound step-up for privileged operations: retrying privileged jobs, clearing recovery state, changing retention policy, generating/uploading a diagnostic bundle.

## Non-goals

- Hard deletes of audit, events, reviews, or artifact versions; artifact blob garbage collection (hashes, metadata, and blobs are always retained).
- Silent diagnostic upload or any external upload destination in v0.1 (uploads land in the workspace diagnostics prefix only).
- Provider-specific capability interpretation (provider packages own their record contents).
- Sampled logs presented as exact metrics; all health figures come from committed rows.

## Contracts

### Consumes

- C01 command kernel, audit rows, durable abuse controls (`packages/domain/src`).
- C04 roles and action-bound step-up (`packages/domain/src/step-up.ts`).
- C06 to C09 runner, project, work, and launch records.
- `docs/contracts/event-ledger.md` (E01 activity envelope).
- L01 to L03 and L08 daemon, checkout, and provider integration records (`runner_inventories`).
- `docs/contracts/artifacts.md` (V01 hashes and metadata that retention must keep).
- W01 product shell (`apps/web`).
- `docs/contracts/notifications.md` (X01 delivery, DLQ, and recovery).
- X04 GitHub integration outbox and contract (`docs/contracts/`).

### Produces

- `docs/contracts/operations.md` (frozen): security-audit read model,
  retention policy metadata, diagnostic bundle inventory, health-check
  contract, queue/DLQ/Cron inventory.
- Stable test target `pnpm test:x05` and evidence manifest
  `docs/work-packages/evidence/WP-X05/manifest.json` consumed by
  checkpoint/release automation.
- D1 migration `0034_operations` (`retention_policies`, `retention_runs`,
  `diagnostic_bundles`, `ops_recovery_ledger`).
- OPS queues `bfb-ops(-staging|-local)` / `bfb-ops-dlq(-staging|-local)`
  with `OPS_JOBS`/`OPS_DLQ` bindings (additive; X01/X04 names untouched).

## Work plan

1. D1 migration 0034 plus domain read models, retention, redaction, diagnostics, and recovery — verified by `packages/domain/test/operations.test.ts`.
2. Control-worker browser API, OPS queue/DLQ consumer, retention sweep, and Cron wiring — verified by worker route/queue tests and the wrangler config test.
3. Permission-aware Operations UI plus Playwright spec on `BFB_E2E_PORT=4196` — verified by `apps/web/test/e2e/x05-operations.spec.ts`.
4. Real-Worker drill harness with local Queue/DLQ, planted-canary secret scan, and bounded evidence — `tools/operations/run.ts`.
5. Frozen contract, package file, index regeneration, and checkpoint line.

## Acceptance

- Only Owners see security audit and privileged recovery actions.
- Privileged recovery, retention changes, and diagnostic generation/upload fail with stale, replayed, missing, or action-mismatched step-up proof.
- Activity feed and security audit are distinct, attributable, and queryable.
- DLQ, stuck outbox, stuck upload, and stuck launch conditions become visible and recoverable/idempotent.
- Retention removes only eligible raw log chunks, never artifact hashes.
- Logs/bundles exclude cookies, bearer/grant secrets, task bodies, prompts, paths, hook payloads, artifact bytes, and terminal output.
- Diagnostic upload requires explicit inventory review plus action.
- Exact test command exits non-zero on every listed negative case and works from a clean checkout: `pnpm test:x05`.

## Evidence

- `docs/work-packages/evidence/WP-X05/manifest.json` (conforms to
  `docs/work-packages/evidence/manifest.schema.json`): gate runs,
  drill recording (`drill.jsonl`), retention fixture
  (`retention-fixture.json`), log and bundle secret scan
  (`redaction-scan.json`), browser recording (`operations-ui.json`),
  commit, schema heads, environment, commands, outcomes, redaction status.
- The secret scan plants task-body, cookie, bearer, path, hook-payload,
  artifact-bytes, and terminal-output canaries in D1-adjacent rows and
  asserts their absence from every harvested output.

## Risks and decisions

- D1 batches forbid reads after a queued write, so recovery effects (which
  interleave reads and writes) run outside hub transactions with a
  write-only single-winner step-up guard; hub commands keep strict
  reads-before-writes. This preserves idempotency on real D1, where the
  first drill run caught the violation.
- Retention enforces only explicitly Owner-configured policies; without a
  policy row the sweep records nothing and deletes nothing.
- Uploads land in the workspace's own R2 diagnostics prefix; no external
  destination exists, so consent cannot exfiltrate silently.

## Handoff

- Implementation, gate (`pnpm test:x05`, `pnpm verify`,
  `pnpm worktree:check`, `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build
  ./...`, clean-checkout gate), and evidence are complete on branch
  `muse/x05`. Settled 18 September: `done`. E01, V01, X01, and X04 are
  `done`, and `pnpm test:x05` passed in a detached clean checkout at
  `9372c0f` (install, build, exact target with the real-Worker/D1/Queue
  drill and 4 Chromium scenarios). The evidence manifest is re-based on
  that rerun; the implementation evidence stays listed as manifest
  artifacts.
- G01 and G02 unlock when this package flips to `done` after those four
  dependencies land; no code changes are expected for the flip.
- Known limitations: the e2e fixture server needed a one-line fix
  (`snapshot` was undefined in `seedE02Chains`); health figures are
  committed-row counts, not sampled metrics; the OPS `retention.sweep`
  queue message exists so the drill can drive the sweep through the local
  Queue — production Cron calls the same function directly.
