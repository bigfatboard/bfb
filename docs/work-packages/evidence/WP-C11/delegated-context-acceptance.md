# C11 delegated context delivery checkpoint

Delegated context delivery now checks current read authority at fresh selection,
the committing delivery batch, cached replay and the final MCP response.
Original OAuth client, nullable project/task boundaries and sponsor epoch remain
restrictions. Successful retries reconstruct the canonical versions previously
delivered, excluding appended context and cached bodies.

Tested source: `7aaf6257e845a2935be98536cad3a4917862d182`.
Protocol: unchanged `bfb-wire/1`.
D1 head: `0047_security_audit_positions`; no migration added.

C11 remains `in_progress`. Private creation, creator sharing and author-private
checkpoints stay disabled; C12 remains planned.

## Regression and retained history

Twenty-one domain and ten authenticated mounted MCP cases pass. Read-only
Owner/Member/Reviewer controls retain prepared timestamps and one successful
delivery. Empty context still requires permission; empty and nonempty retries
retain their original subset after later context is added. Changed tasks reject.
Missing or malformed cached results fail closed, and deliberately corrupted
cached bodies are replaced with canonical bodies without rewriting history.

Independent production revocation before fresh selection, committing batch,
cache return or final MCP delivery withholds unauthorized context. Epoch,
project, read scope, subtree and private read-grant loss are witnessed. Failed
fresh keys succeed after a valid new read grant. A post-Hub denial preserves
already committed deliveries and receipts rather than claiming rollback.

Twelve actual-D1 groups use native bound statements. Natural expiry of an
unchanged credential is tested at selection and committing batch, alongside
delayed live controls. Ledger, semantic/audit/outbox/idempotency and cursor
roll back on a failed guard; independently committed permission changes remain.
Prior delivery records bind the retained task/version/hash to the same
delegation/client, not to a particular request key.

The temporal claim is limited to each selection or guard statement, consistent
with [SQLite clock behavior](https://www.sqlite.org/lang_datefunc.html) and
[D1 batch rollback](https://developers.cloudflare.com/d1/worker-api/d1-database/).
MCP serializes immediately after its final selector without another await.

Initial reproducers on the unfixed runtime produced 14 expected focused
failures and seven healthy passes across 21 cases; D1 produced ten expected
failing groups and two healthy groups. These are local regression observations,
not an old-source clean package certificate. Later cache and boundary controls
were added before final fixed-source verification.

## Clean verification

Exact `pnpm test:c11` passes 2,393 stage cases in 89 file
invocations, plus C10/C08 dependency gates. Eleven stage D1 harnesses pass
122 checks. The notification drill passes separately; its 41 record labels
include setup and repeated dispatch, not 41 independent cases. Exact X03 passes
71 unit cases, 11 Worker/D1/R2 checks and both OAuth browser cases.

Full `pnpm verify` passes 4,517 TypeScript cases in 205 files, Go and
all 16 Swift cases without skipping selected platform checks. Frozen install,
before/after worktree checks, unchanged source identity and empty final status
pass.

Historical healthy context fixtures now use a database-relative credential
window; OAuth setup proof creation and expiry use that same window. Shared fake
clocks, provider clocks and production TTL rules remain unchanged. The first
certificate was superseded after C11 and X03 because a missing-cache-result
guard was added; only the final source is certified here.

The additive `pnpm test:c11:delegated-context` is composed once by C11.
Its D1 witness records 24 bindings, 5,268 SQL bytes and 11 batch statements.
The largest returned context in that drill is two items; the implementation
retains the existing 64-item and body-byte ceilings, not a claimed 64-item
D1 stress test.

See the [manifest](delegated-context-manifest.json) and
[command result](delegated-context-command-result.json).

## Remaining gates

This proves delegated context delivery, not every OAuth tool, later statement,
provider token state or complete private activation. Mounted OAuth races use
staged SQLite; actual D1 is separately proven through domain/Hub, not a real
HTTP Worker/D1 OAuth race.

Delegated attention reads are the next bounded slice to reproduce. Other read
responses, GitHub key policy, execution-owned consumers and destructive private
retention remain open. Publication, project knowledge, skills, vault, reminders
and contribution views remain unfinished. The approved Impeccable UI direction
carries forward without fresh UI certification here. No live pilot, installed
app, deployment or external CI was operated.
