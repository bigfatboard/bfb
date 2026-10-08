# WP-V03 acceptance matrix

Every Scope and Acceptance bullet maps to automated proof in `pnpm test:v03`.
All fixtures are synthetic; no live provider, credential, or production state.

| Contract claim | Proof |
| --- | --- |
| Review always references an exact version/hash and cannot mutate it | Domain exact-binding test (version row byte-identical before/after); `version_mismatch` on wrong hash; `not_found` on uploading/unknown versions (`packages/domain/test/artifact-reviews.test.ts`); worker `approve binds the exact version` check (`tools/artifact-review/run.ts`) |
| Publishing a new version leaves prior review historical and new version visibly unapproved | Domain history test (`historical`, `newer_version`, counts); route conflict test reads `approved: false`; worker `new version reads unapproved` snapshot; browser seed state plus live publish (`apps/web/test/e2e/v03-review.spec.ts`) |
| Artifact approval does not accept a result or grant launch/policy/credential authority | Domain authority test (run/task rows and nine table counts identical; reviewer `accept` still `forbidden`); worker `never move run, task, or result state`; browser run-still-open/task-still-ready assertions |
| Concurrent/stale review decisions resolve through explicit version conflict | Domain stale-triple test (`stale_version` both directions); route 409 codes; worker cross-isolate stale race; browser live-publish conflict with reload recovery |
| Review timer is human-controlled and stored separately from browser presence | Worker presence check (status carries no presence keys; review writes no timer/presence rows); browser presence test (5-minute observation stays in the estimated browser section, never in review reads) |
| Review duration comes from A04 observations; no parallel V03 timer | Domain timer-link test (observation must exist; timer tables unchanged by review); worker `stopped_total_ms` read through `getTaskMeasurements`; Review surface reuses `MeasurementsPanel` with no V03 duration math |
| Hostile artifact remains isolated throughout comments/review actions | Domain verbatim-storage plus secret-free audit test; browser hostile note (inert text, zero script/`onerror` elements) and sandboxed frame wiring (`sandbox="allow-scripts allow-forms"`, `referrerpolicy="no-referrer"`, artifact-origin src, no bytes in trusted DOM) |
| Reviewer project scoping; ordinary review distinct from elevated approvals | Domain scoping matrix (reviewer allowed on granted project, `forbidden` without grant; runner/delegated/system/epoch failures); route 403 on ungranted project; `docs/work-packages/evidence/WP-V03/permission-matrix.md` |
| Outdated Git/config/result bindings shown, never rewritten | Domain drift test (`config_changed`, `git_changed`); worker evidence-map check (`evidence_changed` on bound submissions); browser outdated display |
| Changes-requested and outdated evidence integrated with A03 | `linked_submissions` read with live `result_state`; run results read passes the V03 evidence map (A03 route regression in `test:v03`); no run/task/result mutation from any review decision |

Negative cases exit non-zero: every `failure`/`assert` above fails the gate when the code regresses.
