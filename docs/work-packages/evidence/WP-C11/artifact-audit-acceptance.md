# C11 canonical artifact audit checkpoint

Tested source: `80abaa6f55ccacfc34197c5ae731a86a4a7bd1a9`.
Protocol: unchanged `bfb-wire/1`. D1 head: `0045_private_task_authority`.

This bounded checkpoint authorizes delivery of the nine canonical artifact
audit actions and their dispatch wrappers. It is not complete C11 acceptance.
C11 stays `in_progress`; private creation, creator sharing and author-private
checkpoints remain unavailable. C12 remains planned. Synthetic private policies
are fixtures, not feature activation.

## Covered boundaries

- The authenticated browser passes its captured human principal explicitly.
  One final selecting-query sentinel checks current Owner membership and retained
  epoch, even with an empty page. Scope loss precedes anchor validation. Hidden,
  foreign, malformed, unsupported and absent anchors share the existing denial.
- The artifact namespace is quarantined case-insensitively. Only the nine exact
  canonical actions and their exact dispatch wrapper are recognized. Direct
  receipts bind outbox identity/action, fixed system actor and dispatch time.
  Wrappers also require a matching direct receipt and closed, duplicate-free
  actual actor/input/result objects. Serialized JSON strings are not objects.
- Exact same-workspace outbox→version→artifact→run→task/project lineage and
  current shared-parent read/project authority govern visibility. Private creators
  and named-human grants confer no operations override. Only genuinely NULL
  artifact runs use workspace authority; dangling parents are unavailable.
- Upload actions resolve their matching upload-grant/version/nullable-run tuple;
  view actions use the view-grant table. Finalization, abandonment and review
  require a genuinely NULL grant. Expired/consumed grants and retained artifact
  states preserve authorized history without restoring a live capability.
- Typed canonical source fields replace historical payload JSON. Malformed or
  unauthorized rows are omitted before ordering, `LIMIT + 1`, `has_more` and
  anchor selection. No awaited hydration follows the final query. Stored history
  and internal dispatch are unchanged.
- Independent probes reproduced NUL-suffixed ULID and UTC fields leaking the
  suffix into JSON, despite SQLite prefix validation. Explicit NUL rejection
  now fences both typed helpers before page and anchor selection. Genuine-source
  regression cases cover domain, mounted API and real D1.
- The real-D1 pattern-limit failure is repaired without weakening timestamp
  validation: date and time GLOB patterns are 42 and 32 bytes. Cloudflare documents
  a [50-byte LIKE/GLOB pattern limit](https://developers.cloudflare.com/d1/platform/limits/).
  Calendar, literal UTC separator, time bounds and fractional validation remain.
- The runtime harness uses an observed pagination anchor and persisted Hub
  dispatch timestamps; request timestamps do not override the authorization
  clock. Independent parent privatization and epoch loss occur before the final
  real-D1 selection, including an empty page.
- Three additional stored upload-recovery retry races change the ledger,
  independently consume a fresh proof, or privatize a target parent before the
  batch. The failed retry preserves the independent mutation and adds no effect,
  receipt or cursor. These regressions extend the prior retention certificate;
  they were not part of its tested source.

## Clean verification

Exact `pnpm test:c11` passes 1,373 cases in 58 files and 30 production-Hub/real-D1
checks. Its separate C10 invocation passes 86 cases and nine D1 checks; C08 passes
23 cases and its independent-worker race proof. Counts overlap rather than form
a unique combined total. The new audit suites contain 97 domain and 94 mounted
cases.

Exact `pnpm test:x05` passes 58 cases, 11 runtime scenarios and four browser
cases. Historical X05 evidence and its dependency hold remain unchanged.
Clean scoped G01 tool compilation proves explicit-principal caller compatibility,
not G01 runtime acceptance.

Full `pnpm verify` passes 3,714 TypeScript cases in 176 files, Go checks and all
16 Swift cases. No platform gate is skipped. Frozen install and clean-worktree
checks pass before and after; the tested source is unchanged and the proof
checkout remains clean. See the [command result](artifact-audit-command-result.json)
and [manifest](artifact-audit-manifest.json).

## Remaining limits

Unrelated audit families retain their historical sanitizer and remain
uncertified. Audit-ID cursor wire form is unchanged; this is not an opaque
recipient-position or audit-load certificate. Operations aggregates, frozen
diagnostics, other recovery kinds, destructive private retention, coordination
consumers and the full delivery matrix remain open. Natural credential or lease
expiry during an in-flight batch remains uncertified.

The proof does not establish a deployed private workflow, live private R2 byte
delivery, external recipients or provider execution. No remote start, agent
discussion, pilot operation, provider configuration, deployment or external CI
is claimed. This slice adds no UI, project-wide knowledge, skill catalog, vault,
reminder or contribution feature. Only bounded evidence is committed.
