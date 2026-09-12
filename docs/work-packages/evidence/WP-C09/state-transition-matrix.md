# C09 launch, control and containment evidence

Certified implementation: `e22e2cfbde79c6430047f9f9bf0ef1acd88383ec`.
All identities and observations in these checks are synthetic. The native process
states below are authenticated typed runner reports, not macOS inspection proof;
L05 owns actual processes, Terminal effects and physical locks.

## Real Worker/D1 traces

`tools/launches/run.ts` runs two API Worker isolates, the production WorkspaceHub
and RunnerChannels implementations, real request-possession signatures, a real
WebSocket, and local Wrangler D1. The following are bounded assertion summaries,
not retained request bodies or raw logs.

| Boundary | Observed durable outcome |
| --- | --- |
| Empty installation and populated 0015 upgrade | Head 0016; profile/version, run, snapshot, execution and provider-session rows preserved; original snapshot generation 1; foreign keys and immutable-history protection remain valid |
| Injected outbox failure during Start | Entire state/event/audit/outbox/idempotency batch rolled back; task remains ready at version 1; retry with the original Start key succeeds |
| Concurrent duplicate Start | Both Workers return one launch and one immutable assignment |
| Second Start through a physical checkout alias | Separate pending assignment exists, but the two claim requests produce one claimed winner and one rejected loser; only fence 1 is acquired |
| Socket nudge concurrent with two wake redemptions | One 200 and one uniform 403; delivery does not add an assignment or acquire a lease |
| Closed socket and command pull | The existing unexpired launch is returned without requiring a nudge |
| Duplicate winning claims and Hub eviction | Same execution and fence 1 survive retries and actual Durable Object eviction |
| Final authorization and verified live report | Authorized binding becomes a live lease; no run result is submitted |
| Duplicate interrupt creation, claim and acknowledgement | One control identity and applied disposition; read only exposes the authorized target without claiming; wrong assignment generation is rejected |
| Escaped-descendant report, 121-second clock advance and Hub eviction | Durable `containment_unknown` survives lease TTL and eviction; a subsequent Start is rejected |
| Ordinary all-gone report after containment became unknown | Still `containment_unknown`; no silent release |
| Explicit local recovery with complete group/descendant/lock absence | Fence released; run result remains open |
| Duplicate exact-session resume claims | One new launch, execution and assignment under the same run; fence 2; original control deadline and exact observed session retained |
| Launch grant revoked after resumed claim | Final authorization rejected; reserved checkout remains reserved until never-started local release proof |
| Reconnect after launch deadline | Execution ends with `launch_expired`, run result stays open; no execution authorization |
| Shared wake/control abuse budget | After one Start, 22 concurrent wake creations across two Workers yield 19 creations and three identical 403 failures |
| Capability retention scan | Raw wake values, runner token, request secret and browser session canaries absent from wake rows, events, audit, outbox, idempotency, rate keys and runtime logs |

## Authorization, replay and immutable history

Domain and mounted-route tests supplement the real-D1 trace with the full bounded
negative matrix. Their source files are listed in the evidence manifest.

| Input or state change | Required result proved by the gate |
| --- | --- |
| Twelve identical Starts, changed Start data or another human under the same key | One original assignment; changed input/principal rejected |
| Twelve distinct claim keys for one launch | One winner; an exact winning retry cannot acquire another fence |
| Requesting human removed before claim or final authorization, independently of runner ownership | Current human epoch rejects the launch; run result remains open |
| Revoked named-human grant, removed project grant, missing checkout, changed manifest/policy, stale snapshot or changed supervisor identity | Final authorization rejects even after an earlier successful check; occupancy is retained |
| Narrower local repository configuration | New immutable snapshot and hash; original final-check binding rejected; current binding requires a new online check |
| Wider configuration or a lost tightening response | Widening rejected without another snapshot; same claim recovers the existing tighter snapshot without duplicating history |
| UPDATE of snapshot or assignment history | Database immutable-history constraints reject it |
| Fully released rejected execution without a provider session | Explicit retry may retain the run while creating execution/assignment/snapshot generation 2 |
| Same retry with any attached provider-session history | Rejected; caller must use the appropriate independent attempt or exact-session resume flow |
| Wrong control key, generation, execution, action, principal, grant or expiry | No authorized control effect/disposition; stale authority is not replayed |
| Duplicate focus, interrupt, terminate or cancel | One durable effective disposition, bound to the original immutable target |
| Resume of a live execution or ambiguous observed session | Rejected without guessing or concurrent session takeover |
| Wake bound to another human, runner, device or workspace; expired, revoked or replayed wake | Uniform rejection; no launch authority or extra assignment |
| Browser/runner credential substitution, missing CSRF, oversized body, duplicate JSON keys, numeric loss or unknown shell fields | Rejected before the requested business mutation |

## Lease-release proof matrix

Every observation also binds runner, execution, assignment generation, fencing
generation, monotonic sequence, timestamp and local lock identity.

| Observation | Durable lease outcome |
| --- | --- |
| Verified supervisor identity, live owned group, held local lock, contained descendants, after final authorization | `live` |
| Verified whole group, descendants, supervisor and lock gone, with no unknown marker | `released`; execution ended; run result still open |
| Parent gone but child/group live, held lock, escaped/unknown descendant, ambiguous supervisor, unknown group or unknown lock | `containment_unknown` |
| PID number reused with a different start identity | `containment_unknown`; original identity retained for recovery |
| Renew before final authorization | `containment_unknown`, not executable authority |
| Stale sequence, wrong fence/assignment or stale observation time | Rejected; current owner's state and sequence not changed |
| TTL, reconnect, live renewal or ordinary release after unknown containment | Remains `containment_unknown` |
| Explicit local recovery with complete absence, or verified never-started/never-acquired evidence | `released` |

## Wire and verification scope

`pnpm launch:fixtures` owns 62 C09 protocol fixtures: 23 valid and 39 invalid.
They exercise strict launch/snapshot/control/wake/observation schemas, nested and
outer injection fields, unsafe model/session labels and malformed recovery proof.
TypeScript and Go agree on acceptance and diagnostics; an additional typed Go
round-trip test prevents a shared `$ref` from silently generating an empty execution
configuration. Generated TypeScript, Go and Swift output is drift-checked.

This evidence does not certify Terminal/PTY behavior, native process identity,
actual local lock acquisition, real Claude/Codex execution, a browser launch UI,
public link association, deployed Cloudflare behavior, cross-device reachability
or completion of the local MVP. Those remain with their owning packages.
