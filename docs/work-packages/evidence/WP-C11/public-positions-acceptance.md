# C11 public position delivery checkpoint

Tested source: `9220606dec106003119a4c311712f689ae4b703b`.
Protocol: unchanged `bfb-wire/1`. D1 head: `0045_private_task_authority`.

Public raw ordering feeds and browser realtime are deliberately unavailable.
Authorized business responses omit the top-level Hub cursor without changing
internal ordering, runner acknowledgements or measurement arithmetic. The UI
explains unavailable history on demand and does not restore stale data.
C11 remains `in_progress`; private creation, sharing and author-private
checkpoints remain disabled. C12 stays planned.

## Covered boundaries

- Six public readers retain pure validation, then deny before database access.
  Mounted paths preserve credential/current-role and structural admission,
  followed by a uniform fixed 409/no-store hold before source or high-water reads.
- Public browser, human CLI and delegated MCP receipts use an explicit
  top-level projection. Fresh/cache, preference batches and special artifact
  replies omit the Hub cursor. Authorized business fields, one-time grants,
  conflict detail, context read wire and business-only DTOs retain their shapes.
- New browser admission stops before DO resolution, attachment or ready frames.
  Browser command callbacks do not read, send or close. Existing attachments
  retire independently; runner nudges cannot erase the retained browser alarm.
  Focused manager/channel cases prove that composition, not a live socket drill.
- Run and nested-task measurement sources are `null`, not a fabricated empty
  page or observed zero. Complete internal activity identities, arithmetic and
  final parent authority remain intact.
- Product consumers make no public feed/socket attempts, including hidden
  panels, and suppress stale history/presence. Compact notices remain inside
  existing disclosures. Authorized discussion manual/focus refresh and launch
  polling remain available without realtime.
- Four real-D1 checks prove held helpers without source queries, retained
  internal fresh/cached cursors, unchanged stored history and authorized
  zero-observation measurement shapes. They do not certify live arithmetic,
  artifact bytes or complete private delivery.

## Clean verification

Exact `pnpm test:c11` passes 1,999 invocation cases in 73 files and 67 real-D1
checks across seven harnesses. C10 separately passes 86 cases/nine D1 checks;
C08 passes 23 cases and its Worker race proof. Counts are not unique combined
cross-package totals.

Exact E01, E02, A04, X03 and X05 regressions pass. They retain synthetic
ingestion, arithmetic, compiled macOS capture, authenticated MCP and operations
controls while asserting the public hold truthfully. E02's five real-DO checks
do not claim available replay or live legacy attachment retirement. A04 passes
its Go race suite, compiled native proof, five bounded evidence checks and all
three browser cases.

Exact `pnpm test:w03` passes 186 unit cases in 28 files and all 83 shared
browser cases, including 16 W03 cases. Default actions, draft retention,
keyboard focus, both themes, contrast, narrow reflow and 200 percent zoom pass.
Fresh dark-board and mobile-task renders were inspected. Unavailable notices
add no default actions or false live labels.

Full `pnpm verify` passes 4,335 TypeScript cases in 191 files, Go and all
16 Swift cases without skipping selected platform checks. G01 compilation
passes, not runtime acceptance. Frozen install, before/after worktree checks,
unchanged source and empty final status pass. See the
[manifest](public-positions-manifest.json) and
[command result](public-positions-command-result.json).

The first clean attempt at `40814cf` caught an extra field in the upload-recovery
business response. Source was repaired to preserve the original exact DTO,
not to weaken its regression. The second at `4043876` caught an A04 test still
expecting an available public source page. It now asserts the hold while
retaining signed-ingestion, query-validation and stored-effect controls.
Fresh certification of the final source passes; neither failed attempt is
presented as a certificate.

## Regression provenance and remaining barriers

Meaningful old-source baselines fail nine of 11 domain cases, 13 of 14 mounted
cases and all seven UI cases; remaining cases are controls. Two additional
composition cases fail before retaining the browser alarm across actual runner
channel scheduling. Exploratory fixture/import/selector errors and Vite HMR
observations are not counted as security regressions.

Notification identities, security-audit anchors, GitHub key collisions,
execution-owning participant/runner/control delivery, destructive private
retention and natural in-flight expiry remain activation barriers. The
execution lane must own its parent-authority contract and proof; cleanup must
not be stranded by a blanket guard. Other mandatory product features remain
unbuilt. Earlier evidence is preserved. This checkpoint does not deploy or
operate the live pilot, activate private work or certify the whole MVP.
