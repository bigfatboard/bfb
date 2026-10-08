# C11 diagnostic snapshot quarantine checkpoint

Tested source: `03c0b81a8325b8a7c3a3f5cc5553c2753af63b1f`.
Protocol: unchanged `bfb-wire/1`. D1 head: `0045_private_task_authority`.

Legacy workspace-wide inventories have no immutable source/audience manifest.
This checkpoint makes their delivery uniformly unavailable rather than claiming
that scans or current access can repair historical provenance. C11 remains
`in_progress`; private creation/sharing/checkpoints stay disabled and C12 stays
planned.

## Covered boundaries

- Existing browser authentication, role, CSRF and structural gates remain.
  List/detail/generation/consent then use fixed 409 `request_rejected` with
  `diagnostic bundles are unavailable`, without reading bundle existence,
  body/state/expiry, proof validity or private-work presence.
- Both registered Hub commands recheck current direct-human Owner and retained
  epoch before cache. A required nonempty proof-ID string retains the old pure
  structural denial; no proof preparation, lookup or consumption occurs.
  Generation, consent, cursor and business writes cannot follow the quarantine.
- Production inventory construction and body renderers deny. Pure scanners and
  sanitizers remain separate. Orphaned raw-count, hash and TTL helpers are removed.
- Valid diagnostic jobs acknowledge before bundle lookup, with no DB/R2/DLQ,
  state or retry effects. Retention and malformed poison-message behavior remain
  separate. Existing expiry bookkeeping is not changed.
- The case-insensitive diagnostic namespace is omitted before security-audit
  page/count/has-more/anchor selection and exported semantic replay limits.
  Hidden and unknown anchors share the existing denial; current scope-loss
  priority is retained even for empty pages.
- Stored bundles, copies, cache and objects are preserved, not rewritten or
  reconstructed. Large genuine audit inventory strings were normally redacted;
  this does not claim every old audit row contained the full inventory.
- Impeccable hardening keeps a compact Owner/Member unavailable notice with a
  native keyboard-operable explanation. No inventory list, generation/consent
  controls, passkey request, diagnostic fetch or stale bundle state remains.
- Meaningful domain, mounted/queue and browser regressions failed before repair.
  Two malformed-proof regressions also failed before preserving the pure input
  guard. The first actual-D1 run failed a synthetic fixture constraint, not a
  security regression; after adding its consent timestamp, four checks passed.
  Independent final review and 36 cases across three files pass.

## Clean verification

Exact `pnpm test:c11` passes 1,828 cases in 64 files and 49 real-D1 checks across
three harnesses (37 retained, eight aggregate and four quarantine checks).
Its separate C10 invocation passes 86 cases and nine D1 checks; C08 passes 23
cases and its independent-worker race proof. These invocation totals overlap.
New suites contain 17 domain and nine mounted cases.

Exact `pnpm test:x05` passes 60 cases, 11 synthetic runtime scenarios and five
Chromium cases. Its current D9 proves the held policy, not working v1 upload.
Dated X05 evidence and package dependency hold are unchanged.

Full `pnpm verify` passes 4,169 TypeScript cases in 182 files, Go checks and all
16 Swift cases. No platform gate is skipped. G01 caller compilation passes;
its runtime acceptance was not run. Frozen install and worktree checks pass
before/after; tested source remains unchanged and final status is empty.
See the [command result](diagnostic-command-result.json) and
[manifest](diagnostic-manifest.json).

## Remaining limits

A future diagnostic format needs its own retained-source/audience contract and
recipient delivery certificate. Other audit families, opaque positions, other
recovery, destructive private retention, composite board/deck delivery and
coordination consumers remain open. Natural credential/lease expiry during an
in-flight D1 batch remains unresolved.

No complete private workflow, live private R2 delivery, provider or pilot
operation, deployment or external CI is claimed. New project knowledge, skills,
vault values, checkpoint reminders and contribution views remain unbuilt.
Earlier certificates stay historical.

