# WP-A01 — Run-scoped local MCP and context

Status: `done`

Risk: Very high

Test target: `pnpm test:a01`

Evidence manifest: `docs/work-packages/evidence/WP-A01/runtime-manifest.json`

## Outcome

An active local provider process can use stdio MCP to read exactly its run context and perform permitted task/comment/progress/proposal actions without receiving a human, runner, or reusable cloud credential.

## Dependencies

- **Requires:** C08, E01, L01, L03, L05, L06, L08.
- **Unlocks:** A02, A03, C11, D02, L07, P01, P02, V01, X03.
- **Can run with:** E02 and W02 after the run/context contracts freeze.

## Scope

- Implement `bfb mcp stdio` with JSON-RPC stdout only and diagnostics on stderr/local logs.
- Verify peer UID, owned process ancestry/group, active immutable execution assignment/generation, and correlation before creating a provisional connection.
- While L06 has not yet bound a trusted observed provider session, permit only the explicitly safe read-only bootstrap tools needed to load context. Reject every mutation; atomically activate the full run-scoped capability only after the connection observes the matching trusted session binding.
- Create an in-memory capability bound to one stdio connection, assignment, observed session, and workspace/project/task/run. It is never reconstructed from caller-supplied IDs.
- Implement `get_context`, `get_task`, permitted `update_task`, `add_comment`, `report_progress`, and policy-limited `propose_task`.
- Record delivered immutable context version/hash/time/run and recheck current authorization on every retrieval.
- Enforce request IDs, idempotency, optimistic versions, input bounds, and caller-independent boundary derivation.
- Add a durable pending-operation journal for policy-permitted offline business mutations. Persist originating agent-run principal/grant, immutable assignment/session binding, request/idempotency key, expected resource version, bounded payload hash, local capture proof, capture/expiry times, and policy decision; replay through L08 rechecks current runner credential, epoch, run capability and policy before cached outcomes, and resource version before a new effect.
- Close capabilities on revocation, execution end, or accepted result.

## Non-goals

- Remote HTTP MCP, attention tools, result submission, artifact bytes, workspace administration, self-approval, unrestricted enumeration, or cloud Bearer [REDACTED] in the provider environment.

## Contracts

### Consumes

- C08 transport-neutral reads and commands with actor envelope, idempotency, optimistic version, context audience, proposal, and delivery contracts (`packages/domain/src/work-commands.ts`; local tools mirror their bounds and delegated-agent restrictions).
- C08 run/execution/provider-session records for assignment identity and terminal-result fences (`packages/domain/src/work-records.ts`).
- L01 daemon kernel: CLI registry and raw-stdio dispatch (`internal/cli`), user-only state directory and peer-authenticated RPC (`internal/daemon`). ADR 0004 governs the typed runtime bridge; the original isolated implementation added no daemon-chain migration.
- L03 provider kit capability ceilings for the launch-time installation identity the assignment pins.
- L05 execution supervision: immutable assignment identity, correlation token shape, owned process group, and `local_execution_assignments` state names, read through A01's adapter with L05's own structs (`docs/contracts/execution-supervisor.md`).
- L06 trusted observed-session binding, consumed exclusively through the `SessionBindingSource` interface defined in `internal/localmcp/binding.go`; production uses `JournalBindings` over L06's hook-journal reader.
- L08 runner channel client for the daemon-owned online `WorkTransport` and replay path. The `local-mcp/2` bootstrap connects authority/context/task reads and canonical binding; production writes use the separate closed version-3 lane. Protected daemon capture and current-policy replay pass integrated clean-checkout acceptance at `adbf740`.
- X03A remote MCP tool shapes and bounds as the consistency reference for the six local tools.

### Produces

- Current local MCP implementation `local-mcp/2`, defined in `docs/contracts/local-mcp.md` and [ADR 0004](../adr/0004-local-mcp-runtime-authority.md): the same stdio endpoint with daemon-owned read authority, per-item context delivery, checked cached outcomes and typed IPC. All four online writes and canonical session binding are connected under ADR 0005; version-pinned deny-by-default policy is integrated under ADR 0006. The separate closed version-3 write lane carries committed outcomes or bounded delivery/effect-certainty receipts. Protected capture, checked acknowledgements and daemon recovery pass signed-native and clean-checkout proof. Historical v1 evidence is not relabelled as current runtime proof.
- Stable test target `pnpm test:a01` and current evidence manifest `docs/work-packages/evidence/WP-A01/runtime-manifest.json`. The exact gate requires macOS development signing; non-Darwin package scheduling reports it skipped, never passed, while portable repository checks and Linux build remain required.
- `internal/localmcp`: capability, tool, journal, and stdio-server implementation with the `SessionBindingSource`, `AssignmentSource`, `AuthoritySource`, `WorkTransport`, `OfflinePolicy`, and `ReplayPolicy` interfaces downstream packages build against.
- Daemon-owned local SQLite migration `013_work_journal` (`internal/agentwork/migrations/013_work_journal.sql`) owning the A01 journal file; it shares no table with L06 hook state or the daemon migration chain. Legacy 011/012 rows are preserved and unsigned pending history is quarantined, never upgraded into signed permission. The CLI does not open the journal.

## Work plan

1. Implement stdio host, provisional read-only state, trusted-session activation, and local process/capability verification.
2. Implement context/read tools and delivered-version recording.
3. Implement bounded write/proposal tools and the fully evidenced offline operation journal.
4. Test cross-run/process/UID/session attacks, revocation, version conflicts, startup race, and stdout purity.
5. Close the production daemon/Worker/D1 path, truthful run attribution, explicit deny-by-default offline policy and daemon-owned replay. Prove the compiled stdio binary across that path, including cached-request revocation and remote-commit/local-ack crash recovery; then re-certify the full package from a clean checkout.

### Runtime closure obligations

The [runtime acceptance map](evidence/WP-A01/runtime-acceptance.md) records passing
connected and component proof for these obligations at `adbf740`.

- Preserve the verified four-tool path through shared C08 rules: no requesting-human impersonation, original task creators unchanged, and optional progress percent/confidence retained. The online/policy checkpoint below proves this integration; capture/replay must reuse it.
- Preserve the first vertical's explicit canonical session-binding command while connecting the remaining tools. Trusted local hook binding alone is not cloud business state. Repeated exact resume is covered by real C09 attach/bind domain tests: each execution receives an immutable association with the existing canonical session, whose original execution remains unchanged. Live-provider continuation identity still requires provider certification.
- Prove the implemented scoped operation identity across online requests and replay: execution, generation, tool and original request ID identify the operation; normalized payload belongs in a separately checked fingerprint, not the identity key. The current journal replaces the legacy global raw-request-ID lookup.
- Consume the integrated version-pinned offline policy and action-bound step-up path. Daemon-owned capture must retain the authorized scope, trusted session, exact immutable policy versions, requester/runner epochs, key identity and expiry. No missing permission evidence may be reconstructed as allowed.
- Prove complete protected capture and exact observed/canonical session checks through the assembled runtime, including terminal denial versus infrastructure failure. The legacy proof is insufficient and its pending rows are quarantined; existing rows cannot acquire new permission on upgrade.
- Prove the implemented atomic upgrades, exclusive claims and checked acknowledgements beyond component tests. Cover bounded serialized draining, failed status persistence, MCP exit, daemon restart and remote-commit/local-ack loss with one canonical effect. Historical injected replay did not provide these guarantees.

These integration checks are covered by the current runtime certificate. [ADR 0005](../adr/0005-agent-work-session-and-attribution.md) defines the reviewed canonical binding, repeated-resume association, negotiated agent IPC and truthful online-write attribution. [ADR 0006](../adr/0006-daemon-owned-pending-agent-work.md) defines version-pinned offline authority, daemon-owned protected capture and truthful uncertainty/replay. Offline policy remains deny by default; permission requires explicit proof-bound policy configuration. No real workspace's permission was enabled during certification.

## Acceptance

- Wrong UID/process group/run/task/workspace/assignment/session cannot acquire/use a capability.
- Caller-supplied IDs cannot escape the derived boundary.
- Agent cannot read human-only context, promote a root proposal, administer policy, or launch another root run.
- Initial MCP startup can load context before session binding but every mutation fails until L06 commits the matching trusted binding; a competing session can never activate it.
- Offline operation either returns durable `pending_sync` or visible failure exactly by policy.
- Restarted replay preserves and validates the originating assignment/principal, capture proof, expiry, and request identity; it fails visibly after revocation, execution end, expiry, accepted result or policy change. A new effect also fails on version conflict; an authorized retry of its own committed effect returns the original outcome without reapplying version or child-count preconditions.

## Evidence

- [Runtime certificate](evidence/WP-A01/runtime-manifest.json) records `adbf740`: clean-checkout frozen install, forced build, exact A01 (765 protocol and 413 scoped cases, Go race suites including runner signing, compiled stdio, signed native proof and one policy browser flow), full verification (2,087 TypeScript tests, Go checks and 16 Swift tests), Linux build and worktree check. The [acceptance map](evidence/WP-A01/runtime-acceptance.md) and [command results](evidence/WP-A01/runtime-command-result.json) cover complete A01 acceptance and separately record affected C07/C08/C09/L01/L08 implementation-checkout gates. They do not certify Terminal, live providers or downstream packages.
- [Online/policy checkpoint](evidence/WP-A01/online-policy-checkpoint.json) records `88fbffa`: clean-checkout exact A01 (573 protocol and 330 scoped cases, Go race suites, compiled stdio, signed native proof and policy browser flow), full verification (1,810 TypeScript tests, Go checks and 16 Swift tests), C08 real D1 races, 61 shared browser scenarios, Linux build and worktree check. It certifies all four online writes plus policy foundations, not protected capture/replay or full package acceptance.
- [Binding/comment checkpoint](evidence/WP-A01/binding-comment-checkpoint.json) records `a78be00`: frozen install, forced build, exact A01, full repository verification (1,545 TypeScript tests, Go checks and 16 Swift tests), Linux build and worktree check pass from a clean checkout. It proves canonical binding and one online attributed-write path, not the remaining writes, durable offline recovery or full package acceptance.
- [Read-slice checkpoint](evidence/WP-A01/read-slice-checkpoint.json) records the connected v2 bootstrap at `5640dcd`: exact A01, full repository verification, Linux build and worktree check passed from a clean checkout without prebuilt web assets. It explicitly marks full package acceptance incomplete and does not replace the historical manifest.
- `runtime-manifest.json` indexes the current tested commit, migration head, toolchains, commands and redaction status. The original `manifest.json` remains the unchanged historical v1 certificate.
- `inspector-transcript.jsonl` with its byte-pinned `.expected.jsonl` twin records a full stdio session (handshake, tool list, provisional reads, provisional rejection, binding, writes, proposal policy, versioned re-read, unknown method, absent tools), replayed verbatim by `TestGoldenInspectorTranscript`.
- Historical `pending-record.json` and `replay-matrix.md` preserve the original unsigned journal shape and injected replay dispositions. They are not the current P-256 capture contract or integrated replay proof and are not rewritten as current evidence.
- Historical `acceptance-matrix.md` and `command-result.json` retain their original v1 test scope. The current acceptance map and command results above supersede them for runtime acceptance.
- Evidence contains synthetic identities only: no bearer/grant secret, task body, local absolute path, environment value, or raw terminal output.

## Risks and decisions

- Provider MCP hosting can alter ancestry. Test per supported provider/version instead of weakening checks globally.
- Original interface evidence used doubles behind narrow interfaces (`SessionBindingSource`, `AssignmentSource`, `AuthoritySource`, `WorkTransport`, `ReplayPolicy`). The current certificate proves the assembled A01 runtime; focused doubles retain negative-case coverage without substituting for that connected proof.
- The A01 journal remains its own SQLite file, now at migration `013`, separate from the sequential daemon chain and L06's `009`/`010` hook state. Historical `011`/`012` rows are preserved during the daemon-owned migration; they do not inherit new permission.
- The original isolated implementation added no D1 migration: context deliveries already persist in `task_context_deliveries`, and the journal is local-only. Its recorded `0018_cli_credentials` head is historical. Runtime closure must record the actual integrated migration head and own any additive attribution/policy migration it needs.
- Local tool names keep the `bfb_` prefix shared with the remote map (`bfb_get_context`, not `get_context`) so one contract table covers both transports; the Scope short names map one-to-one.

## Handoff

- 6 October runtime closure: `done` at tested commit `adbf740`. Exact A01, full verification, Linux build and worktree checks pass from a clean checkout. Native proof covers signed outage admission, MCP exit, signed-daemon restart, ordinary same-execution/fence lease renewal, autonomous replay, real marker/acknowledgement storage failures, policy/session/lock denial and uncertain expiry/revocation. Current-authority retries preserve one effect and withhold private outcomes when delivery is denied. Historical evidence stays unchanged. A02/A03 and other dependents still need their own integration/revalidation; no Terminal/live-provider, end-to-end MVP or deployment acceptance is claimed.
- 6 October online/policy checkpoint: `88fbffa` combines `4a3c21e` online writes and `c7a6150` policy foundations. Frozen install, forced build, exact A01, full verification, C08, shared browser regression, Linux build and worktree check pass in an isolated clean checkout. The bounded evidence records truthful attribution, raw-number validation before normalization, current-authority cached-result checks, same-identity response-loss recovery, immutable historical policy hashes and atomic passkey proof consumption. The next capture/replay slice is outside that tested commit. A01 stays `in_progress`; dependent holds and historical manifests remain unchanged. No Terminal, live-provider, end-to-end MVP or deployment acceptance is claimed.
- 5 October first-write checkpoint: canonical session binding and attributed comments at `a78be00` pass clean-checkout frozen install, forced TypeScript build, exact `pnpm test:a01` (509 protocol cases, 121 domain/Worker/migration/UI cases, Go race suites and the development-signed compiled stdio/daemon/Worker/Hub/D1 harness), `pnpm verify` (1,545 TypeScript tests, Go checks, 16 Swift tests), Linux build and worktree check. Affected C01/C08/C09/L06/L08 passed in the implementation checkout before the final reserved-proposal correction; the corrected schema is covered by the clean gates. Real L06 hook ingestion, lost binding/comment replies, daemon and MCP restart deduplication, fresh authenticated helper/held-lock checks and pre/post-network containment denial are covered. A committed comment remains an effect even when postflight delivery is denied. The fixture uses a synthetic supervised process and does not execute the full L05 launch path, Terminal, a PTY or a live provider. The bounded evidence does not replace the historical manifest; A01 remains `in_progress`.
- Reopened 5 October: `in_progress`. The connected v2 read slice passes the expanded exact target, including the compiled stdio binary, signed daemon, Keychain-backed runner enrollment and real Worker/WorkspaceHub/D1 context deliveries. It proves MCP-process restart deduplication, not daemon restart replay. Production writes, explicit versioned offline policy, canonical session binding and daemon replay remain incomplete, so the full Outcome and Acceptance are not met. The historical manifests below are retained unchanged; downstream packages remain held until complete runtime acceptance is re-proven. No gate or architecture boundary is waived.
- Settled 18 September: `done`. E01, L05, and L06 are `done`, and `pnpm test:a01` passed in a detached clean checkout at `c212249` (install, build, exact target with race-tested Go suites and the real-binary stdio harness, including the landed L06 session-binding merge).
- Commands: `pnpm test:a01`; `pnpm verify`; `pnpm worktree:check`. The inspector-style session replay is `TestGoldenInspectorTranscript` in `internal/localmcp`.
- L06 merge step (landed, finding 13): `JournalBindings` in `internal/localmcp/production.go` implements `ObservedBinding(ctx, ref) (SessionBinding, error)` from the hook journal's trusted observed-session record via `journal.SessionReader` (match on execution ID and assignment generation; the run ID echoes the startup-verified boundary that key determines; `ErrSessionNotBound` while unbound or malformed, storage faults propagate), and `internal/cli/mcp.go` wires it over the read-only daemon handle. No other A01 change needed; the activation race, competing-session, and provisional tests already cover the real source. Proven by `TestJournalBindings*` in `internal/localmcp/production_test.go` and `TestMCPStdioActivatesBoundSession` / `TestMCPStdioRejectsMutationWhileUnbound` in `internal/cli/mcp_test.go`.
- L05 runtime connection: `DaemonAssignments` reads L05's actual flat owned-process record and retained native-history projection. The daemon independently calls L05's `Service.CheckAgentOwnership` before dispatch and after network waits, reusing signed-helper, held-lock and containment inspection with sticky uncertainty. Kernel peer/correlation and exact L06 session checks remain separate. This is fresh bounded observation, not an atomic remote fence or an OS sandbox. The historical read fixture's wrapped process shape did not prove the actual L05 storage layout; it is corrected in this first-write fixture.
- L08 runtime closure: `internal/cli/mcp.go` uses the credential-free `RPCTransport`; `internal/agentwork` owns fixed daemon reads, binding and all four write routes with current runner connections. Reads and cached outcomes require current authority. Protected capture and daemon replay have current integrated signed-native certification; historical injected `Replay` tests alone do not prove those production paths.
- E01 merge step: confirm `task_context_deliveries` remains the delivery record of choice; no A01 change expected.
- A02/A03/V01 extend `ToolDescriptors`, `Host.CallTool`, and `validatedPayload` on this same server; they do not add a credential, endpoint, or journal.
- Known limitations: reads fail visibly offline; production offline policy denies pending mutations by default, and unsupported writes cannot become queued permission. Live provider ancestry/session behavior is not certified by synthetic native proof. The current enrolled-key signature protects immutable capture, not later local disposition history; user-only storage and its identity sentinel do not provide encryption, same-user deletion resistance or cryptographic anti-rollback. Legacy unsigned rows cannot obtain signatures retrospectively. Reserved result submission remains unsupported until A03 integration.
