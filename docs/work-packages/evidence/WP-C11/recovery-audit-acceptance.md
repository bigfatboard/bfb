# C11 upload-recovery audit checkpoint

Tested source: `ac3f86e7ef58aeae07a2edae4bbfe6a849afb81a`.
Protocol: unchanged `bfb-wire/1`. D1 head: `0045_private_task_authority`.

This checkpoint covers stuck-upload recovery audit delivery and valid UTC
page/anchor ordering. It is not complete C11 acceptance. C11 stays
`in_progress`; private creation, creator sharing and author-private checkpoints
remain unavailable. C12 remains planned. Synthetic policies are fixtures, not
feature activation.

## Covered boundaries

- The recovery namespace is quarantined case-insensitively. Only the exact
  registered lowercase action is recognized, through a closed duplicate-free
  envelope with actual actor/input/result objects and typed identities/times.
- Input contains 1–50 distinct typed version IDs in preserved order. Typed
  result fields resolve an applied same-workspace ledger, whose closed target
  array matches decoded values and positions. Equivalent JSON escape spellings
  remain valid; strings containing serialized arrays are not arrays.
- Every current failed version resolves exact artifact/run/task/project lineage
  and shared read/project authority. A mixed private target omits the whole
  receipt even for its creator or grantee. Only genuine NULL artifact runs use
  workspace authority. Missing, foreign, malformed and nonfailed targets deny.
- Originals bind ledger creator/creation time. Fresh target-ledger retries may
  have a different historical direct human and later timestamp. Older legitimate
  applied ledgers need no modern original counterpart or attempt-count-one
  requirement. The ledger does not attest historical actor epoch or proof.
- The final Owner/retained-epoch sentinel applies before page/count/anchor
  delivery, including empty pages. Hidden and unknown anchors share denial.
  Synchronous typed reconstruction preserves the literal `[redacted]` array
  display; it neither rewrites history nor consumes proof or execution authority.
- Independent probes reproduced lexical UTC misordering. Valid timestamps now
  use one internal six-fraction-digit key for both pages and anchors, including
  canonical artifact receipts and valid UTC legacy rows. Microsecond precision
  and insertion-order equal-instant ties survive; displayed timestamps and
  audit-ID cursor wire form are unchanged. Malformed legacy timestamps retain
  raw ordering and remain uncertified.
- Domain, mounted API and real-D1 chronology regressions failed meaningfully
  before the repair. Independent post-repair review and the same chronology
  probe pass. Real Hub fixtures use observed server time rather than an
  authorization-clock override.

## Clean verification

Exact `pnpm test:c11` passes 1,574 cases in 60 files and 37 production-Hub/real-D1
checks. Its separate C10 invocation passes 86 cases and nine D1 checks; C08 passes
23 cases and its independent-worker race proof. Counts overlap rather than form
a unique combined total. New suites contain 99 domain and 102 mounted cases.

Exact `pnpm test:x05` passes 58 cases, 11 runtime scenarios and four browser
cases. Historical X05 evidence and its dependency hold remain unchanged.

Full `pnpm verify` passes 3,915 TypeScript cases in 178 files, Go checks and all
16 Swift cases. No platform gate is skipped. Frozen install and worktree checks
pass before and after; tested source is unchanged and final status is empty.
See the [command result](recovery-audit-command-result.json) and
[manifest](recovery-audit-manifest.json). Earlier checkpoints remain historical.

## Remaining limits

Other audit families, opaque positions, queue/health aggregates, frozen
diagnostics, other recovery, destructive private retention and coordination
consumers remain open. An earlier independent real-clock in-flight expiry
reproducer remains unresolved; this slice does not repair credential/lease
expiry during a batch. It also does not establish cryptographic action-ID or
historical proof/epoch provenance.

No complete private workflow, live private R2 byte delivery, external recipients,
provider execution, pilot operation, deployment or external CI is claimed.
This slice adds no UI, project knowledge, skills, vault, reminders or contribution
feature. Only bounded evidence is committed.
