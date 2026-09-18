# WP-V03 — Immutable artifact review

Status: `planned`

Risk: High

Test target: `pnpm test:v03`

Evidence manifest: `docs/work-packages/evidence/WP-V03/manifest.json`

> Status note: implementation, gate, and evidence are complete on this branch,
> but `Status` stays `planned` because `pnpm roadmap:check` rejects any status
> beyond `planned` while dependencies A03, A04, and V02 are not `done`. See Handoff.

## Outcome

A human reviews an exact artifact version and records approval, changes requested, or comment without that decision leaking to later bytes or elevating unrelated permissions.

## Dependencies

- **Requires:** A03, A04, V02, W01.
- **Unlocks:** G01.
- **Can run with:** P01/P02 after feature contracts freeze.

## Scope

- Artifact review records bound to immutable `artifact_version_id`, hash, reviewer, timestamp, decision, optional commit SHA/config hash, comment, and optional A04 review-timer observation reference (D1 migration `0032_artifact_review`; hub command `artifact.record_review`).
- Review surface with provenance, evidence, safe viewer, comments, A04's explicit timer, approve, and request changes (`apps/web/src/artifacts/ArtifactReview.tsx` on the W01 task sheet; V02 viewer reused unmodified).
- Historical reviews preserved while each newer version reads unapproved until its own approve review lands.
- Review decision connected to the result/task flow through read-only linked submissions and the A03 evidence map, without conflating artifact approval with result acceptance.
- Permission checks distinguishing ordinary review (owner/member/reviewer with project scoping on run-bound artifacts) from credential/capability/destructive approvals (never granted, never usable as step-up).
- Semantic activity and security audit facts without secrets (`artifact.review_recorded` outbox row plus the hub audit row; payload carries identities and decision only).
- Outdated evidence shown when Git/config/result bindings no longer match (`newer_version`, `config_changed`, `git_changed` on reviews; `evidence_changed` on bound submissions).

## Non-goals

- Approval inheritance, automatic result acceptance, merge/deploy permission, or editing artifact bytes.

## Contracts

### Consumes

- [Artifact storage v1](../contracts/artifacts.md) (V01 state machine, versions, and hashes; `uploading` rows unreviewable).
- [Artifact viewer v1](../contracts/artifact-viewer.md) (V02 one-time grants, bootstrap/redemption flow, sandbox CSP; reviewer project scoping for artifact surfaces is V03's addition).
- [Result submission and acceptance v1](../contracts/results.md) (A03 outdated evidence shape; V03 supplies the artifact version map and links submissions read-only).
- [Measurements and provenance v1](../contracts/measurements.md) (A04 review-timer service and observations; V03 consumes them and creates no second timer or interval calculation).
- C04 roles and step-up distinctions (reviewer role; ordinary review needs no step-up and grants none).
- W01's task sheet in `apps/web` and `packages/ui` (task-sheet slot, component conventions; Review surface mounts beside the result and measurement panels).

### Produces

- [Artifact review v1](../contracts/artifact-review.md), freezing the review record, `artifact.record_review` rules, reads, routes, and A03/A04 integration; D1 head `0032_artifact_review`.
- Stable test target `pnpm test:v03` and evidence-manifest path `docs/work-packages/evidence/WP-V03/manifest.json`.
- `packages/domain/src/artifact-reviews.ts`: `artifact.record_review` (exact hash/latest binding, `stale_version`/`version_mismatch` conflicts, direct-human project-scoped authority), `getArtifactReviewStatus`/`listArtifactReviews` (historical and outdated flags), `listLinkedSubmissions`, `listArtifactsWithReviewState`, `artifactEvidenceVersionMap`, `readReviewTimerContext` (raw A04 rows, no duration math).
- `apps/control-worker/src/api/artifact-reviews.ts`: artifact list, review status, and review-record routes with explicit 409 conflicts.
- `apps/web/src/artifacts/ArtifactReview.tsx`: Review surface with provenance, evidence, safe viewer, comments, A04 timer reuse, and approve/request-changes actions.
- `tools/artifact-review/run.ts`: real-Worker/D1 race and integration harness writing `review-binding.json`.

## Work plan

1. Freeze `docs/contracts/artifact-review.md` with D1 heads and the timer/A03 integration; verify with `pnpm docs:check`.
2. Add D1 migration `0032_artifact_review` plus the review domain command and reads; verify with `vitest run packages/domain/test/artifact-reviews.test.ts`.
3. Serve REST review endpoints and wire the A03 evidence map into the run results read; verify with `vitest run apps/control-worker/test/artifact-review-routes.test.ts` plus the A03 route regression.
4. Add the task-sheet Review surface reusing the V02 viewer and A04 timer panel; verify with `vitest run apps/web/test/artifact-review.test.ts` plus the browser spec on `BFB_E2E_PORT=4194`.
5. Prove hub races over real Workers and D1 with `tools/artifact-review/run.ts` (exact binding, stale-version race, authority limits, timer/presence separation, evidence map, audit).
6. Commit bounded redacted evidence at the manifest path and one `mvp.progress.md` checkpoint line; regenerate the index with `pnpm roadmap:write`.

## Acceptance

- Review always references an exact version/hash and cannot mutate it.
- Proved by: domain version-row identity test plus `version_mismatch`/`not_found` negatives, worker binding check, browser approval of the exact version (`pnpm test:v03`).
- Publishing a new version leaves prior review historical and new version visibly unapproved.
- Proved by: domain history test, route unapproved read, worker status snapshot, browser seed plus live publish (`pnpm test:v03`).
- Artifact approval does not accept a result or grant launch/policy/credential authority.
- Proved by: domain nine-table identity plus reviewer-accept `forbidden`, worker run/task/result identity, browser run-open/task-ready assertions (`pnpm test:v03`).
- Concurrent/stale review decisions resolve through explicit version conflict.
- Proved by: domain stale-triple negatives, route 409 codes, worker cross-isolate race, browser live-publish conflict with reload recovery (`pnpm test:v03`).
- Review timer is human-controlled and stored separately from browser presence.
- Proved by: domain timer-table identity, worker presence-key absence, browser presence-separation test (`pnpm test:v03`).
- Review duration comes from A04 observations; V03 does not implement a parallel timer store or interval calculation.
- Proved by: observation-existence requirement, `getTaskMeasurements` consumption in the worker snapshot, timer-panel reuse with no V03 duration math (`pnpm test:v03`).
- Hostile artifact remains isolated throughout comments/review actions.
- Proved by: domain verbatim/audit-payload test, browser inert-note plus sandbox-wiring assertions and screenshots (`pnpm test:v03`).

## Evidence

- Evidence manifest: `docs/work-packages/evidence/WP-V03/manifest.json` (conforms to `docs/work-packages/evidence/manifest.schema.json`).
- Contents: worker binding snapshot (`review-binding.json`), command result (`command-result.json`), acceptance matrix (`acceptance-matrix.md`), permission matrix (`permission-matrix.md`), timer evidence (`review-timer.md`), hostile review notes (`hostile-review.md`), browser flow and screenshots (`browser/`).
- Evidence is bounded and redacted: synthetic identities only, no secrets, no local absolute paths, no raw terminal output.

## Risks and decisions

- Risk: approval semantics leak into result or launch authority. Decision: the record command writes only the review row plus audit; authority tests snapshot run/task/result/launch state and prove reviewer acceptance stays forbidden.
- Risk: version ordering ties when two versions share a timestamp. Decision: publication order is insert order (`created_at`, then `rowid`; version and review ids are random), proven by same-millisecond publish/decision tests.
- Risk: sibling packages share the e2e server, task sheet, and results read. Decision: V03 adds additive seed rows, one task-sheet section, and one evidence-map argument; W01/A02/A03/A04 browser regressions pass unchanged, and the embedded timer panel mounts only when review artifacts exist.
- Risk: a second review timer or presence-derived duration creeps in. Decision: V03 owns no timer table, computation, or display; durations arrive only through A04 reads and the reused timer panel.

## Handoff

- State: implementation, `pnpm test:v03` gate, and evidence are complete on this branch at the committed hash recorded in the evidence manifest. `Status` is intentionally left at `planned`: `pnpm roadmap:check` rejects anything beyond `planned` while A03, A04, and V02 are not `done`.
- Consume: `docs/contracts/artifact-review.md` (v1), domain command `artifact.record_review` plus reads `getArtifactReviewStatus`, `listArtifactReviews`, `listLinkedSubmissions`, `listArtifactsWithReviewState`, `artifactEvidenceVersionMap` in `packages/domain/src/artifact-reviews.ts`, REST routes under `/artifacts` and `/artifacts/:artifactId/reviews`, `ReviewPanel`/`ReviewView` in `apps/web/src/artifacts/ArtifactReview.tsx`.
- A03: the run results read now passes the V03 evidence map so artifact-bound submissions read `evidence_changed`; submission storage and transitions are untouched.
- V03 creates no second timer: review durations come from A04 `review_timer` reads and the reused `MeasurementsPanel`.
- G01: use this immutable version/hash binding plus the hostile-review evidence as the visual-review release proof.
- Limitations: previews redeem through V02 grants against the configured artifact origin (the shared e2e origin is unconfigured, so browser bytes stay unloaded while wiring is asserted); the `__test/v03-publish` hook exists only in the e2e server; aggregation caps follow A04; no CLI parity (X02 reads only).
