# A03 connected result acceptance

The clean checkout at `9077a085939d89d0da4709dd24cc69bdf991dee0` passes the exact
A03 target, affected A01/A02/L08/C07/C09 targets, repository verification,
Linux cross-build and clean-worktree check. The [manifest](runtime-manifest.json)
and [command results](runtime-command-result.json) record the exact source and
separate proof scopes. Historical A03 evidence remains unchanged and is not
the certificate for this production connection.

| Contract | Evidence |
| --- | --- |
| Closed result-only v5 negotiation, exact correlation and no fallback | 942 shared protocol cases plus Go daemon/Host/CLI transport tests; existing v1/v2/v3/v4 families retain their contracts |
| Independent default-denied result permission | Domain/Worker policy tests cover complete V3 step-up targets, all policy tiers, tightening, omitted/explicit deny, proof substitution, atomic proof/head/version/outcome and historical snapshot/hash preservation under D1 migration 0040 |
| Actual online MCP and fresh one-shot CLI submission | Compiled processes through development-signed daemon/Keychain, genuine L06 observation, real kernel/native ownership and held flock, runner possession and local Worker/Hub/D1; exact retries create one immutable submission |
| Authority before cached results and new-effect eligibility after idempotency | Current runner/requester/owner grants, latest assignment, canonical session, policy/hash and unreleased lease/fence remain checked; the original submitted request reconciles, changed input conflicts, and a new submitted-state request cannot create a version |
| Changes requested, resubmission and human acceptance | Native explicit review cycle retains immutable versions and real lock; domain/route/browser matrix allows reviewer/member/owner changes, member/owner acceptance and no agent review command |
| No inference and honest history | Headless predicate and no-inference tests keep Stop, hook telemetry, process/session end and transport loss separate from submission/acceptance; superseded/config/evidence-version reasons are computed without rewriting rows |
| Protected outage capture and restart | Native permitted MCP and fresh CLI capture, MCP exit and signed-daemon restart replay the original signed identity after ordinary same-owner renewal of the same lease/fence, producing one canonical effect |
| Missing or stale proof fails closed | Native/component cases reject missing, A01-only, expired and restart-lost new-capture permission; confirmations retain their original suspend-inclusive send anchor, and repeated clients cannot extend the window |
| Online-only intents cannot acquire offline permission | Native/component proof retains online-only mode across lost reply, client exit, restart and later policy enablement; no autonomous drain or upgraded signed capture |
| Durable marker, acknowledgement and reply loss | Real fixture marker UPDATE failure sends no business request; real acknowledgement UPDATE failure and committed-response loss retain possibly-applied state, then exact authorized restart retry reconciles one effect |
| Current denial preserves dispatched or never-sent state | TTL/grant denial after committed-response loss retains possibly-applied state; queued session/policy/held-lock denial sends nothing; real postflight lock loss withholds a confirmed response while preserving original capture/key/fence |
| Result priming and denial fencing are bounded | Go race tests cover queue 16, per-assignment singleflight, cache 1024, original 45-second horizon, cancellation/join and late denial; confirmed submission closes new-capture eligibility, and registered legacy UDS denial fences cached/in-flight proof |
| Protected shared journal migration and capacity | Component race tests cover v13-to-v14 A01 byte/history preservation, legacy quarantine, interrupted rollback, corruption, shared 256-per-run/1024-daemon unresolved and 10000-retained limits, claims and checked acknowledgement |
| Private payloads and credential separation | Native maximum-input canaries are absent from result audit, semantic events and outbox receipts; the committed projection uses `version` and bounded origin, not result bodies; provider-side processes receive no browser/runner credential and open no journal |
| Human-command races and deterministic evidence | Ten real-D1 checks prove the isolated human review path; five evidence tests pin the bounded runtime recording/transition projection and preserve separately identified historical fixtures |
| UI and unaffected runtime behavior | One fresh result/review browser case passes; exact A01/A02 protected-work/attention, L08 runner channel, C07 policy and C09 launch gates also pass at this source |

The native A03 proof reaches `A03_NATIVE_PROOF_COMPLETE` in 192.06 seconds.
This is distinct from `tools/results/cli.ts`, which uses an actual compiled
binary with a synthetic v5 transport, and from the deterministic
[recording](runtime-recording.jsonl) and
[transition matrix](runtime-transition-matrix.json), which describe only the
isolated human-command Worker/Hub/D1 trace. Neither isolated harness is a
substitute for the signed native authority proof.

The final source includes `f1a9d35`, closing pre-submit capture eligibility after
a validated committed submission, and `9077a08`, invalidating cached/in-flight
result proof on genuine legacy RPC authority denial. Original submitted retries
remain reachable; late confirmation cannot resurrect a denied window.

Agent submission and reconciliation read current checkout-lease authority.
Neither result submission nor human review mutates or releases the lease or
live local flock. The historical revocation trace's stronger no-read statement
does not describe this connected runtime.

Captures use the enrolled P-256 signer with the separate
`BFB-AGENT-RESULT-CAPTURE-V1` domain, binding immutable capture metadata and the
complete canonical original request digest. This is not a recomputable legacy
hash or a task-work proof. Signature validation does not authenticate mutable
local delivery history or protect against filesystem deletion/rollback.
Pending receipts are not cloud submissions; `possibly_applied` is never
rewritten into a false no-effect rejection merely because authority expired.
Confirmed durable state is not permission to disclose a cached private outcome.

The browser gate proves fresh automated assertions. Its new screenshots are
temporary test output; retained `browser/` images and flow remain historical,
not newly captured evidence for this source.

This acceptance uses a synthetic provider-shaped process and local real cloud
services. It does not open Terminal, invoke AppleScript/System Events, run a
live provider turn, prove the full MVP or a cross-device pilot, enable offline
permission in a real workspace, or certify remote result parity or release.
No automatic headless submission caller exists: headless runs also submit
explicitly. Artifact rendering/validation, merge and deployment remain outside
this proof. No descendant package becomes done merely by consuming it.
