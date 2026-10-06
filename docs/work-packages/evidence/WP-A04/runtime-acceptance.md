# A04 connected measurements acceptance

The exact expanded A04 gate and full repository verification pass in a clean
checkout at `a7a763cb5dea49089704618c54c330ac4df71f17`. The [manifest](runtime-manifest.json) and
[command results](runtime-command-result.json) name each tested source.
Historical A04 calculations, provider examples, manifests and screenshots are
retained without relabelling them as current connected proof.

Affected E01/L06/A01/A02/L08 gates pass at the clean regression base
`312a2018af409c6f474935e6f6adb22d4e0e30c2`. The final candidate changes only
the A04 test command/omission guard and A03 harness/evidence validation; all
production code is identical. Exact A04, exact A03, full verification and
final build/cleanliness checks run again at the final candidate. The initial
A03 base attempt failed its stale migration-head assertion and is not a
passing result. The repaired harness validates the actual 0041 head without
rewriting the A03 certificate's 0040 recording.

| Contract | Current evidence |
| --- | --- |
| Closed versioned transport without weakening v1 | 992 protocol cases plus Go parity; named schema-version-2 telemetry uses the existing version-1 ingest batch, authenticated capability discovery and regenerated deterministic bindings |
| Durable identified capture and replay | Journal/daemon/provider race checks and signed compiled-hook proof cover original identity across acknowledgement loss, daemon restart and acknowledgement deletion, changed-input conflict, phase-aware deduplication and bounded storage failure |
| Safe acknowledgement and negotiation | Exact workspace/item correlation, unsupported typed-peer retention with visible degradation and usable legacy traffic, corrected acknowledgement replay and persisted backoff; native foreign-workspace ACK occurs after the exact typed measurement has committed |
| Atomic canonical persistence | Domain staged-D1 rollback and mounted signed Worker tests co-commit ledger, token observations, canonical sources and aliases; replays and semantic aliases cannot increment totals |
| Current authority before replay/cache | FIFO-serialized runner/human authorization, current epochs/project grants and exact command-input binding; native revoked-grant delivery retains the queued row without publishing it |
| Historical attribution | Signed native old-execution replay survives a new execution and mutable profile change while retaining the original execution/run and immutable provider snapshot |
| Raw numeric and quality boundaries | Mounted Worker tests preserve signed raw lexemes and reject unsafe/noninteger values before rounding; reported zero remains distinct from null, estimates and unavailable usage |
| Honest arithmetic | Per-execution/process/read-time clipping, identity/session pairing, concurrent legacy ambiguity, same-timestamp observed zero, never-attached unknown state, live offline tails, checked sticky overflow, unknown-run counts and incomplete cost calculations are independently tested |
| Human contribution remains separate | Real current-clock review start/stop races, current canonical attention and explicit submission/human acceptance are separate from fixed-date calculation fixtures; aggregate review totals name their run-linked scope |
| Provenance is inspectable | Authorized bounded canonical source pages omit raw payloads and keep cursor pagination separate from full derivation; browser assertions cover source metadata, safe overflow, unavailable states and narrow layout |
| Current calculation evidence | Thirteen real-D1 harness steps and five deterministic evidence checks produce the bounded runtime-calculation projection; the current human loop is explicitly separated from historical arithmetic |
| Human UI and native regressions | Three measurement browser cases plus affected signed agent-work/attention/result and two-workspace channel proofs; no platform checks are skipped |

The native A04 gate reaches `A04_NATIVE_PROOF_COMPLETE` in 75.36 seconds.
It uses an actual compiled hook/client, development-signed daemon, Keychain
enrollment, genuine local journal, request-bound runner possession and a real
local Worker/WorkspaceHub/D1. Its synthetic provider-shaped process proves
typed lifecycle/usage delivery, quality and canonical source identity. The
fixture does not produce a genuine initial process-attachment observation:
actual process/active-duration derivation is certified separately by domain
regressions and the bounded canonical browser display fixture, not inferred
from the helper being alive.

The browser gate runs fresh assertions. Its screenshots are temporary test
output; retained historical `browser/` images are not recaptured evidence.
Supplemental manual local-browser inspection in the implementation checkout checked honest unavailable
states, source expansion and explicit review-timer start/stop, without
changing the wider visual design.

During development, a same-timestamp completed activity was reproduced as
incorrectly unavailable and fixed with typed/legacy/absent/out-of-window
regressions. Two native harness failures were fixture defects: the proxy
fault injector tried to parse a compressed ACK without decoding gzip, and
a deliberate old-profile mutation removed the fresh fixture's lookup.
The gzip regression fails before its repair and passes afterward; replacement
execution setup now uses a separate profile. No assertion timeout or
production authorization was relaxed.

Pinned live Codex usage does not yet have certified stable delta identity;
pinned Claude hooks do not provide a validated usage source. Those inputs
remain unavailable, not fabricated exact counts. Synthetic usage is not a
live-provider capability certificate. Cache/reasoning fields remain subsets,
not extra grand totals.

This proof does not run Terminal, AppleScript/System Events or live provider
turns, enable offline business permission in a real workspace, certify a
cross-device pilot or the full running MVP, complete discussion scheduling,
or deliver private-task ACLs, project knowledge/skills, shared business
secrets or the remaining mandatory product scope. No push, deployment or
descendant package certification is implied.
