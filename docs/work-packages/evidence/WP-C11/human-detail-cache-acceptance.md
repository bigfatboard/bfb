# C11 human detail and cached business delivery

Browser and CLI attention detail now select the canonical body and ordered
observations together. Cached task create/update, human answer/resolve and
delegated attention request replies repeat current authority at final selection
while retaining their historical results. Denied reads and replays create no
business state.

Tested source: `61cb5ae4ae809b061a90b2b1acc061d7991062bc`.
Production change: `1f5879c8bd95329b928253a0bff2581cdd1472e2`.
Protocol: unchanged `bfb-wire/1`.
D1 head: `0047_security_audit_positions`; no migration added.

C11 remains `in_progress`. Private creation, creator sharing, inherited private
children and author-private checkpoints stay disabled; C12 is planned.

## Current authority and historical replies

Twenty domain and twelve mounted browser/CLI cases pass. Attention detail
retains read-only roles, answered/resolved ended history and authorized empty
observations; missing and denied parents share one 404. A concurrent answer is
read from canonical state. Captured project IDs remain a ceiling. Browser
attention replies now carry no-store and no-referrer, matching CLI replies.

Task retries retain historical fields, versions and cursor. Current read/edit
access and Owner/Member roles guard the exact target; unreadable historical
parents are masked in the same selection. Human attention retries require
contribution and the current kind's role. Delegated requests retain Reviewer,
write-only and historical assignment support while repeating current credential,
client, original nullable boundaries, safe write scope and SQL-clock expiry.
They do not adopt a newer execution or require a live lease.

Nineteen native-D1 groups pass. Five detail seams witness fused selection rather
than the old separate body read. Fourteen cache seams witness saved-result
selection, prepared final selection and an independent authority change.
Some groups loop several mutations; these are group/seam counts, not unique
case totals. Maximum queries use 30 bindings and 6,948 SQL bytes. Complete
canonical business/OAuth and cursor snapshots remain unchanged by reads or
replays after independent mutations.

## Old source reproduction

The final 32-case suite was replayed on committed unfixed source
`c34ce6529549d790b4b3e4982d791e672da19d54` and its separately built runtime:
23 fail and nine controls pass. Bounded shapes distinguish fourteen unauthorized
cached bodies and five unauthorized detail responses from two stale canonical
answers, one synthetic lineage robustness failure and one browser header failure.
The latter four are not additional permission disclosures.

The initial two native-D1 groups reproduce one unauthorized question returned
with status 200 and empty observations, plus a healthy control. The expanded
nineteen groups were not replayed on old source. Initial missed-transaction and
incorrect revocation-call fixtures are excluded from the witness counts. These
reproductions are not old-source clean package acceptance.

## Clean verification

Exact `pnpm test:c11` passes 2,527 stage case invocations in 97 file invocations,
plus C10 and C08 dependency gates. Fifteen stage D1 harnesses pass 200 checks.
The separate notification drill passes; its 41 record labels include setup and
repeated dispatch, not 41 independent cases. Exact X03 passes 71 unit cases,
11 Worker/D1/R2 checks and both OAuth browser scenarios.

Full `pnpm verify` passes 4,651 TypeScript cases in 213 files, Go and all 16
Swift cases without skipping selected platform checks. Frozen installation,
before/after worktree checks, unchanged source and empty final status pass.
The additive `pnpm test:c11:human-detail-cache` is composed once by C11.

The first clean attempt caught one existing healthy cached-update fixture with
an expired credential: fake JavaScript Date did not freeze SQLite's clock.
Only its issuance call now uses the existing SQL-relative helper; scopes,
boundaries and assertions are unchanged. All 35 existing cases and the fresh
clean certificate pass. Production clocks and expiry guards were not changed.

See the [manifest](human-detail-cache-manifest.json) and
[command result](human-detail-cache-command-result.json).

## Remaining delivery gates

Mounted browser/CLI tests and the native witness are separate. The native API
uses a synthetic pre-authenticated browser principal over disposable D1, not
cookie or CLI ingress. Genuine Hub task/run/attention setup uses dormant private
ACL and immutable waiter fixtures; cache guards run after business authorization.

This proves the final selection, not authority after it or original transport
ceilings before Hub admission. Remaining public business caches/fresh replies
and CLI binding lifetime/subset enforcement need one cohesive completion pass.
Execution-owned private consumers, GitHub policy, destructive retention and
private activation remain open. No private R2 byte, UI, installed-app, pilot,
deployment or external-CI certificate is included. Other mandatory product
features remain unfinished.
