# A02 connected attention acceptance

The clean checkout at `891fbcc33a8e0af07e2d52c2f697a5adf03f8205` passes the exact
A02 target, repository verification, affected A01/L08 targets, Linux build and
clean-worktree check. C09 also passes at that commit in the implementation
checkout. The [manifest](runtime-manifest.json) and
[command results](runtime-command-result.json) record their separate scopes.
Historical A02 evidence is retained unchanged; it is not the certificate for
this production connection.

| Contract | Evidence |
| --- | --- |
| Closed v4 negotiation with no v1/v2/v3 widening or fallback | 866 shared protocol cases, Go socket correlation/size/unsupported-method negatives and generated-contract drift checks |
| Request, authorized answer, bounded wait, resolution and identical later retrieval | Compiled stdio, development-signed daemon, possession-authenticated Worker/Hub/D1 and actual human answer/resolve APIs; MCP and signed-daemon restart |
| Fresh reads and current authority before cached creation | Domain/Worker and Go tests cover repeated read IDs, existing canonical associations despite omitted binding, true provisional reads, actual same-project foreign runs, actual resume and original record provenance |
| Nonterminal submitted runs remain usable | Real result-submit command and signed Worker-route tests prove attention creation/read/exact retry without another run/task transition; launch and task-capture eligibility remain unchanged |
| Human permission and duplicate safety | Role/project/epoch checks before cached outcomes, exact-input binding, optimistic versions and no answer overwrite; reviewer answers review but cannot answer owner-only credential requests |
| Offline and lost-response behavior | Actual post-commit reply loss, explicit identical retry, changed-input rejection after a new host, no journal rows or autonomous send across MCP exit and signed restart even with task offline permission enabled |
| Full call deadline and bounded traffic | Native unanswered call returns pending after 30 seconds and 26 real reads; a deliberately held successful response fails visibly under the existing socket timeout with no private answer; Go tests cover queue/network deadlines and late-answer withholding |
| Fresh inventory during a live wait | Actual D1 provider observation advances on the existing 20-second heartbeat with identical manifest/version; delayed-initial-sync TLS/WebSocket regression covers acknowledged and absent alive replies |
| Revocation and containment remain authoritative | Native session end, execution end, terminal result, expired/replaced lease, grant revocation and real held-lock loss deny reads/writes and withhold post-flight private delivery |
| Private-body redaction | Synthetic maximum-length question/answer canaries are absent from audit, semantic events and outbox receipts; provider subprocess receives no browser or runner credential |
| Durable UI and deterministic evidence | Three browser scenarios, real-D1 reconnect/permission/observation flow, seven evidence tests, byte-identical runtime recording and cadence, clean Git status |
| Existing task-write and runner behavior | Exact A01 signed protected-capture/recovery proof and exact L08 signed two-workspace channel/revocation/enrollment proof pass |

The first implementation native run correctly denied stale inventory. Its
root cause was a real runner scheduling gap: timing refresh from completion
could skip a heartbeat and permit a 40-second interval under a 30-second
freshness limit. The repair changes scheduling, not authorization, expiry or
rate ceilings. The clean native proof includes actual refresh during the wait.

The test uses a synthetic provider-shaped process with real kernel identity,
supervision and a held filesystem lock. It does not open Terminal, execute a
live provider turn, prove a cross-device pilot, enable a real workspace's
offline policy or certify A03/result submission. Attention remains online-only.
