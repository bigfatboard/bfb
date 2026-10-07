# C11 delegated list selection checkpoint

Delegated project and task pages now select current authority and canonical
records in one final statement. Authorized empty pages remain successful;
revoked authority cannot appear as an empty page. Reads create no business
state.

Tested source: `8e047007ff2d16eac8e0761a4c501e3f2f15d1ab`.
Protocol: unchanged `bfb-wire/1`.
D1 head: `0047_security_audit_positions`; no migration added.

C11 remains `in_progress`. Private creation, creator sharing, inherited
private children and author-private checkpoints stay disabled; C12 is planned.

## Current authority and readable history

Fifteen domain and twenty-one authenticated mounted MCP cases pass. Read-only
Owner, Member and Reviewer retain ready, completed and cancelled history and
the existing project/task page shapes. Project metadata follows current project
policy and grants, independently of task privacy. Captured project IDs remain
a ceiling: newly granted projects do not enter the same call.

Twenty-one native-D1 groups mount the compiled OAuth handler in the test
process. Production revocation, read-scope/client/original-boundary loss and
rooted scope loss after a successful advisory check withhold unauthorized
pages. Credentials unchanged since final SQL and argument preparation can
naturally expire before execution; delayed live controls remain readable.

Authorized empty and cursor-terminal pages differ from credential, membership,
epoch and root denial. Current root authority is necessary before cursor
filtering. Existing private filtering, visible-only lookahead, last-delivered
cursors, branch pruning, canonical edits and parent redaction are retained
controls, not new body-exposure findings.

Native queries remain bounded with more than 100 captured projects: the witness
records 41 bindings and 9,602 SQL bytes. Its capacity-only 120 project/grant
rows are explicitly synthetic. Complete canonical business/OAuth history and
cursor snapshots remain unchanged by reads after independent mutations.

Valid authority denial uses the SDK plain-text `delegated list not available`
error. Initial scope admission and unexpected database errors remain distinct.

## Old source reproduction

The final mounted suite was replayed on committed unfixed production source
`37310569402cae36e5fa5921f2c797fc44c34495` and its built runtime. Twelve of
twenty-one cases failed, with nine passing controls. Bounded response-shape
diagnostics distinguish seven unauthorized non-empty replies from five
authority losses incorrectly returned as successful empty pages.

The initial two native-D1 groups separately reproduced one production
revocation metadata exposure and one healthy control. The expanded twenty-one
groups were not replayed on old source. These reproductions are not old-source
clean package acceptance.

## Clean verification

Exact `pnpm test:c11` passes 2,495 stage case invocations in 95 file invocations,
plus C10 and C08 dependency gates. Fourteen stage D1 harnesses pass 181 checks. The
separate notification drill passes; its 41 record labels include setup and
repeated dispatch, not 41 independent acceptance cases. Exact X03 passes
71 unit cases, 11 Worker/D1/R2 checks and both OAuth browser cases.

Full `pnpm verify` passes 4,619 TypeScript cases in 211 files, Go and all
16 Swift cases without skipping selected platform checks. Frozen installation,
before/after worktree checks, unchanged source and empty final status pass.
The additive `pnpm test:c11:list-delivery` is composed once by C11.

A pre-certificate focused run found three expired healthy collection fixtures
in the existing private-work MCP suite: fake JavaScript Date did not freeze
SQLite's clock. Only their issuance calls now use the existing SQL-relative
helper, preserving scopes, boundaries and assertions. All 35 cases pass.
Production clocks and expiry guards were unchanged.

See the [manifest](list-delivery-manifest.json) and
[command result](list-delivery-command-result.json).

## Remaining gates

This proves final delegated collection selection, not authority after that
statement, other transports, business caches, opaque task cursors or private
activation. Mounted OAuth over native D1 is not a real HTTP Worker OAuth ingress
race. Independent policy and task edits are retained, not rolled back by reads.

Human attention-detail composition and late cache delivery need further proof.
GitHub collision policy, execution-owned consumers and destructive private
retention remain open. Publication, project knowledge, skills, vault, reminders
and contribution views remain unfinished. No fresh UI certificate, installed
app, live pilot, deployment or external CI is included.
