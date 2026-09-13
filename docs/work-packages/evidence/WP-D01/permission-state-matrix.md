# D01 discussion authority and causal state

This bounded matrix describes executable synthetic assertions. Clean-checkout
certification is still pending; the package is not yet done. No provider executes
in these tests. The observed sessions are deliberately seeded at the internal
trusted-runtime boundary, not accepted from public browser requests.

## Real D1 and WorkspaceHub

`tools/discussions/run.ts` uses two independent Worker clients, the production
WorkspaceHub Durable Object and local Wrangler D1. No in-memory replacement
stands in for canonical persistence or hub serialization.

| Boundary | Asserted outcome |
| --- | --- |
| Empty migration and populated 0016 upgrade | 0017 applies; existing work runs gain `purpose=work`; task, snapshot, execution, session and event/cursor history remain identical; foreign keys pass |
| Injected failure at the final discussion receipt insert | Discussion, two runs/snapshots, roster, six turns and hub state all roll back; original-key retry can succeed |
| Twelve identical creates across two Workers | One discussion and two participant runs; all responses identify the same committed records |
| Hub eviction and original create retry | Durable receipt survives; changed question under the original key fails |
| Two interventions at the same expected version | One commit and one stale-version rejection |
| Two distinct dispatch keys for each of six turns | Exactly one effect per turn; no duplicate delivery |
| Eviction between initial positions and continuation | Existing causal input, session binding and discussion versions survive |
| Acknowledgement and completion retries | Original session/message/delivery IDs return without a second message or turn transition |
| Six complete turns and two simultaneous human decisions | Explicit conclusion retains final two recommendations; exactly one human decision commits |
| Discussion creation and conclusion | Normal task stays ready at version 1; participant results remain open; no ordinary launch is created |
| Changed authorization epoch | Old authority fails; even new authority cannot reuse an old-epoch request receipt |
| UPDATE/DELETE of frozen history | Immutable database constraints reject changes |
| Discussion semantic-event canaries | Question, recommendation and human-decision content stay outside the safe discussion receipts/events |

## Domain and mounted browser routes

| Input or state | Asserted boundary |
| --- | --- |
| No browser session, bearer substitution, absent CSRF or foreign origin | Rejected before discussion mutation |
| Reviewer, delegated human, forged system run, missing project access or cross-workspace ID | No unauthorized creation, participant read or mutation; inaccessible history remains hidden |
| Revoked sponsor epoch, runner/project grant or participant identity | Current checks precede both new effects and durable receipt replay |
| Directly authorized human reads after original sponsor revocation | Frozen human history remains readable, with explicit dispatch blocking; participant authority is not retained |
| Proposed, ready, active, review, blocked, done or cancelled task | Discussion-purpose runs preserve ordinary task/work-result state |
| Ordinary execution, session, activity, current-context or launch retry targeting discussion runs | Purpose-aware shared commands reject the target; normal work routes/projections do not present discussion runs as task work |
| Duplicate, unknown-key or malformed original JSON/UTF-8; oversized body; forged path/body binding | Strict route decoding rejects the request without discussion state |
| Public participant/turn/message endpoint or caller-selected run/scope | No such authority surface exists |
| Default and shortened discussion | Exactly two profiles; one to three rounds; at most six turns and fixed 60–3,600-second deadline |
| Initial positions and subsequent same-round peer output | Withheld until the next round; only earlier complete rounds and explicit human interventions enter accepted inputs |
| Human intervention after a turn has been accepted | Retained for later turns; cannot alter that accepted delivery's frozen source IDs |
| Maximum task-context count and human-only context | Existing C08 bound remains enforced; only agent/both-audience items enter the frozen brief |
| UTF-8 brief, intervention, recommendation or decision overflow | Atomic rejection at the relevant 65,536/8,192-byte limit, including multibyte text below the character limit |
| Changed agent-visible context | Frozen brief remains unchanged; new provider effects block explicitly; an established context-failure record can stop the discussion |
| Requested-only, wrong-run, changed observed or replacement logical session | Acknowledgement/completion rejects identity substitution |
| Two discussions claiming the same observed provider session on one runner | Durable uniqueness prevents a second binding; failed acknowledgement rolls back its version changes |
| Early turn, completion before acknowledgement or false failure reason | No transition or message |
| Deadline or possible unacknowledged provider effect | No new dispatch; verified failure or sticky ambiguity remains distinct from work completion |
| Private/unfrozen context, traversing repository path, wrong Git revision or unavailable peer message reference | Evidence and agreement/disagreement references reject unavailable authority/context |
| Thirteenth human intervention or duplicate output | No additional message |
| Agent conclusion or textual `[DONE]`/`[DECISION]` | At most an explicit bounded discussion conclusion; never a human decision or work acceptance |
| Human decision before stop, missing/foreign/intervention/duplicate recommendation reference, or second decision | Rejected; a valid decision remains immutable and excluded from participant views |

## Wire contract and limitations

`pnpm discussion:fixtures` owns 62 visibly synthetic fixtures. TypeScript and Go
test the same accept/reject matrix, and typed Go round trips retain conditional
turn output, session attribution, evidence and scoped views. Generated TypeScript,
Go and Swift output is drift-checked. The fixture generator's check mode performs
no writes.

Domain request keys and hub transport attempt keys are distinct, as documented in
the contract. Authorized retries have auditable transport attempts but only one
discussion/message/delivery/decision effect; consumers identify business records
by stable IDs and versions.

This is not evidence of real provider output, read-only provider enforcement,
native session fencing or process ownership, cancellation of a native process,
repository inspection, a discussion UI, deployed behavior, cross-device operation
or the complete local MVP. D02/D03 and the execution packages own those claims.
