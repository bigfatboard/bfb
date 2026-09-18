# Artifact review (V03)

| Version | Date | Change |
| --- | --- | --- |
| 1 | 2026-09-18 | Freeze review records, reads, routes, and A03/A04 integration. |

Consumers: G01 (visual-review release proof), X02 (CLI parity reads only).

This contract freezes the immutable review flow that WP-V03 owns. Readers must
also follow [`artifacts.md`](artifacts.md) for storage, roles, and kinds,
[`artifact-viewer.md`](artifact-viewer.md) for isolated previews,
[`results.md`](results.md) for submission and acceptance semantics, and
[`measurements.md`](measurements.md) for the review-timer service. V03 consumes
the review-timer service and creates no second timer.

## 1. Review record

One immutable `artifact_reviews` row per decision (D1 migration
`0032_artifact_review`).

- `artifact_id`, `version_id`: the exact reviewed version.
- `content_hash`: bound at decision time; must equal the version's stored hash.
- `reviewer_human_id`, `authorization_epoch`: the deciding direct human.
- `decision`: `approve` | `request_changes` | `comment`. All three are
  ordinary reviews; none accepts a result or grants launch, policy,
  credential, or step-up authority.
- `comment`: optional 1–2048 character reviewer note, stored verbatim and
  rendered as inert text only.
- `git_commit`: optional observed 40-character lowercase hex commit.
- `config_hash`: optional observed `sha256:` configuration hash.
- `review_timer_observation_id`: optional A04 `review_timer_observations`
  reference. V03 reads durations from A04 observations and never computes,
  stores, or derives timer state of its own.
- `created_at`: server time.

`artifact_reviews` has no update and no delete path: the migration triggers
abort both. Reviews are history, exactly like submissions.

## 2. Recording (`artifact.record_review`)

Hub command input:

```json
{
  "artifactId": "01J...",
  "versionId": "01J...",
  "expectedContentHash": "<64 hex>",
  "expectedLatestVersionId": "01J...",
  "decision": "approve",
  "comment": "optional note",
  "gitCommit": "40 hex, optional",
  "configHash": "sha256:..., optional",
  "reviewTimerObservationId": "01J..., optional"
}
```

Rules, in order:

1. The artifact must exist; the version must belong to it, be `available`,
   and carry a stored hash. Otherwise `not_found`. Uploading rows hold no
   trusted bytes and failed rows are terminal, so neither is reviewable.
2. `expectedContentHash` must equal the version's stored hash, otherwise
   `version_mismatch`. A review always references exact bytes.
3. The reviewed version must be the latest available version, otherwise
   `stale_version`. Publication order is insert order (`created_at`, then
   `rowid`, because version ids are random): a newer available version makes
   earlier reviews historical without rewriting them.
4. `expectedLatestVersionId` must equal the current latest available version,
   otherwise `stale_version`. A reviewer holding an older page reloads and
   re-checks the current bytes instead of approving history.
5. Authority: direct human only, role `owner`, `member`, or `reviewer`, at the
   current authorization epoch. Runner, delegated, and system actors fail as
   `forbidden`. When the artifact names a run, the reviewer must hold project
   access to that run's project (reviewer project scoping for artifact
   surfaces is a V03 concern); run-free artifacts need membership only.
6. The timer observation, when supplied, must exist in the workspace,
   otherwise `not_found`.

The command inserts the review row plus one `artifact.review_recorded` audit
row and touches nothing else: no version, run, task, submission, launch,
policy, or credential row changes. The hub's own `audit_events` row carries
the actor. The audit payload carries artifact, version, review, reviewer, and
decision ids only — no comment text and no secrets (reviews mint none).

## 3. Reads

`getArtifactReviewStatus` returns one artifact's full review state:

- `latest_version` with per-version `approvals`/`changes_requested` counts.
- `approved`: the latest available version carries its own `approve` review.
  Every newer version reads unapproved until a new approve review lands;
  earlier approvals stay historical.
- `changes_requested`: the latest available version carries a
  `request_changes` review.
- `reviews` oldest-first, each with `historical` plus computed `outdated`
  flags (never mutated):
  - `newer_version`: a newer available version exists.
  - `config_changed`: the bound `config_hash` differs from the run's latest
    configuration snapshot hash.
  - `git_changed`: the bound `git_commit` differs from the run's latest
    submission commit.
- `linked_submissions`: result submissions whose `artifact_version` evidence
  refs name this artifact or one of its versions, each with its current
  `result_state`, bound version, and whether it references the current
  version. Read-only: V03 never mutates submissions, runs, or tasks.
- Reviews carrying a timer observation attach the raw A04 observation plus
  its parent timer row (`readReviewTimerContext`). Durations always come from
  A04's reads and derivations.

`listArtifactsWithReviewState` lists artifacts (optionally for one run) with
the same latest-version approval state for the Review surface.

## 4. A03 integration

Submitters bind reviewed bytes with a generic evidence reference:

```json
{ "kind": "artifact_version", "ref": "<artifactId>", "version": "<versionId>", "hash": "sha256:<contentHash>" }
```

`artifactEvidenceVersionMap` maps `artifact_version\n<artifactId>` to the
latest available version id. The run results read passes this map into A03's
`listResultSubmissions`, so a submission bound to an older artifact version
reads `evidence_changed` without mutating history. Recording an artifact
review — including `request_changes` — never moves run, task, or result
state; a human still uses the explicit A03 `result.request_changes` and
`result.accept` commands.

## 5. A04 integration

The reviewer explicitly starts and stops timers through A04's
`review_timer.start`/`stop` commands and REST routes; the V03 Review surface
reuses A04's task-sheet timer controls and duration displays unchanged.
Timers persist in A04's tables, separately from browser presence:
`browser_activity.record` observations never enter review durations, and
review durations never derive from presence. V03 proves the separation by
asserting its command writes no `review_timers`, `review_timer_observations`,
or `browser_activity_observations` rows and computes no interval of its own.

## 6. Control routes (browser session + CSRF)

- `GET /api/v1/workspaces/:ws/artifacts` (`?run_id=` optional) →
  `200 {artifacts}` summaries for the Review surface.
- `GET /api/v1/workspaces/:ws/artifacts/:artifactId/reviews` →
  `200` full review status with raw timer contexts.
- `POST /api/v1/workspaces/:ws/artifacts/:artifactId/reviews`
  `{version_id, expected_content_hash, expected_latest_version_id, decision,
  comment?, git_commit?, config_hash?, review_timer_observation_id?,
  request_id?}` → `201 {review}`.

Creation consumes the durable `artifact:review-create` attempt budget
per-human subject and fails closed while `AUTH_ABUSE_SECRET` is missing or
short. Failures are explicit so the surface can show them:
`not_found` → 404, `forbidden` → 403, `invalid_argument` → 400,
`stale_version` and `version_mismatch` → 409 with the code intact.
Budget exhaustion stays a uniform `403 {error: request_rejected}`.

## 7. Review surface (web)

`ReviewPanel`/`ReviewView` in `apps/web/src/artifacts/ArtifactReview.tsx`
mount on the W01 task sheet beside the result and measurement panels:

- Artifact picker with per-artifact approval state; provenance (exact version,
  content hash, reviewer, timestamp, decision, bindings); outdated reasons in
  words; linked submissions with result state.
- The V02 `ArtifactViewer` renders the latest version's bytes inside the
  unchanged sandboxed cross-origin frame. Review comments and every
  artifact-derived string render as inert text; hostile bytes and hostile
  notes never reach trusted DOM, URLs, or attributes.
- Approve sends the exact version triple with an optional note; Request changes
  and Comment require a note. All three actions send the exact
  version/hash/latest triple; `stale_version`/`version_mismatch` responses
  show the "version changed, reload" state instead of failing silently.
- A04's `MeasurementsPanel` supplies the explicit timer controls and review
  durations; V03 renders no timer of its own and never presents browser
  presence as review time.
- A standing note states the authority boundary: artifact approval never
  accepts the run result and never grants launch, policy, or credential
  authority.

## 8. Non-goals

Approval inheritance, automatic result acceptance, merge/deploy permission,
editing artifact bytes, reviewer management UI, server-side rendering of
artifact content outside the V02 frame, and a second review timer or
presence-derived duration.
