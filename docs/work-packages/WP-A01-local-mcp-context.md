# WP-A01 — Run-scoped local MCP and context

Status: `in_progress`

Risk: Very high

Test target: `pnpm test:a01`

Evidence manifest: `docs/work-packages/evidence/WP-A01/manifest.json`

## Outcome

An active local provider process can use stdio MCP to read exactly its run context and perform permitted task/comment/progress/proposal actions without receiving a human, runner, or reusable cloud credential.

## Dependencies

- **Requires:** C08, E01, L01, L03, L05, L06, L08.
- **Unlocks:** A02, A03, D02, L07, P01, P02, V01, X03.
- **Can run with:** E02 and W02 after the run/context contracts freeze.

## Scope

- Implement `bfb mcp stdio` with JSON-RPC stdout only and diagnostics on stderr/local logs.
- Verify peer UID, owned process ancestry/group, active immutable execution assignment/generation, and correlation before creating a provisional connection.
- While L06 has not yet bound a trusted observed provider session, permit only the explicitly safe read-only bootstrap tools needed to load context. Reject every mutation; atomically activate the full run-scoped capability only after the connection observes the matching trusted session binding.
- Create an in-memory capability bound to one stdio connection, assignment, observed session, and workspace/project/task/run. It is never reconstructed from caller-supplied IDs.
- Implement `get_context`, `get_task`, permitted `update_task`, `add_comment`, `report_progress`, and policy-limited `propose_task`.
- Record delivered immutable context version/hash/time/run and recheck current authorization on every retrieval.
- Enforce request IDs, idempotency, optimistic versions, input bounds, and caller-independent boundary derivation.
- Add a durable pending-operation journal for policy-permitted offline business mutations. Persist originating agent-run principal/grant, immutable assignment/session binding, request/idempotency key, expected resource version, bounded payload hash, local capture proof, capture/expiry times, and policy decision; replay through L08 rechecks current runner credential, epoch, run capability, policy, and resource version.
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
- L08 runner channel client for the daemon-owned online `WorkTransport` and replay path. The `local-mcp/2` bootstrap now connects authority/context/task reads through fixed daemon RPC and runner possession authentication. Online writes and current-policy replay remain outstanding A01 work.
- X03A remote MCP tool shapes and bounds as the consistency reference for the six local tools.

### Produces

- Current local MCP bootstrap implementation `local-mcp/2`, defined in `docs/contracts/local-mcp.md` and [ADR 0004](../adr/0004-local-mcp-runtime-authority.md): the same stdio endpoint with daemon-owned read authority, per-item context delivery, checked cached outcomes and typed IPC. Online writes, versioned offline policy, canonical session binding and restart-safe daemon replay remain incomplete. Historical v1 evidence is not full v2 runtime proof.
- Stable test target `pnpm test:a01` and evidence manifest `docs/work-packages/evidence/WP-A01/manifest.json`.
- `internal/localmcp`: capability, tool, journal, and stdio-server implementation with the `SessionBindingSource`, `AssignmentSource`, `AuthoritySource`, `WorkTransport`, `OfflinePolicy`, and `ReplayPolicy` interfaces downstream packages build against.
- Local SQLite migration `011_pending_operations` (`internal/localmcp/migrations/011_pending_operations.sql`) owning the A01 journal file; it shares no table with L06 hook state.

## Work plan

1. Implement stdio host, provisional read-only state, trusted-session activation, and local process/capability verification.
2. Implement context/read tools and delivered-version recording.
3. Implement bounded write/proposal tools and the fully evidenced offline operation journal.
4. Test cross-run/process/UID/session attacks, revocation, version conflicts, startup race, and stdout purity.
5. Close the production daemon/Worker/D1 path, truthful run attribution, explicit deny-by-default offline policy and daemon-owned replay. Prove the compiled stdio binary across that path, including cached-request revocation and remote-commit/local-ack crash recovery; then re-certify the full package from a clean checkout.

### Remaining runtime closure checks

- Shared C08 write rules currently accept human/delegation actors. Add truthful run authorship to task/comment/proposal persistence and projections before exposing runner-authenticated writes; do not impersonate the requesting human. Preserve the advertised progress percent/confidence fields rather than silently dropping them.
- Define an explicit checked canonical session-binding command. Local trusted hook binding is not a cloud business-state mutation, and a provider's session-tree identity must not be assumed equal to its exact continuation target. Exact resume creates a new execution/generation for an existing provider session; its binding must not invent another vendor session or require that session's original execution to equal every resumed execution. Derive provider identity from the pinned launch snapshot, not a mutable profile.
- Keep cloud operation identity stable across online requests and replay: execution, generation, tool and original request ID identify the operation; normalized payload belongs in a separately checked fingerprint, not the identity key. Replace the journal's global raw-request-ID lookup before production use.
- Add explicit versioned offline permission to the existing policy ceiling/tightening model and bind policy updates to their step-up proof. Daemon-owned capture must retain the authorized scope, trusted session, policy versions, requester/runner epochs, key identity and expiry. No missing permission evidence may be reconstructed as allowed.
- The legacy capture proof omits authority-bearing fields and replay does not verify the observed session. Protect and recheck the complete capture; distinguish terminal denial from infrastructure failure. Existing rows without sufficient evidence must not acquire new permission on upgrade.
- Make journal upgrades and terminal acknowledgements crash-safe. The existing batch selector is not an exclusive claim, and replay ignores status-write failures. Prove bounded serialized draining, failed status persistence, MCP exit, daemon restart and remote-commit/local-ack loss with one canonical effect.

These are required integration checks, not completed acceptance. [ADR 0005](../adr/0005-agent-work-session-and-attribution.md) defines the reviewed canonical binding, repeated-resume association, negotiated agent IPC and truthful online-write attribution. [ADR 0006](../adr/0006-daemon-owned-pending-agent-work.md) defines version-pinned offline authority, daemon-owned protected capture and truthful uncertainty/replay. Production offline policy remains deny until the complete path is implemented and proven; neither decision permits unconditional pending operations.

## Acceptance

- Wrong UID/process group/run/task/workspace/assignment/session cannot acquire/use a capability.
- Caller-supplied IDs cannot escape the derived boundary.
- Agent cannot read human-only context, promote a root proposal, administer policy, or launch another root run.
- Initial MCP startup can load context before session binding but every mutation fails until L06 commits the matching trusted binding; a competing session can never activate it.
- Offline operation either returns durable `pending_sync` or visible failure exactly by policy.
- Restarted replay preserves and validates the originating assignment/principal, capture proof, expiry, and request identity; it fails visibly after revocation, execution end, expiry, accepted result, policy change, or version conflict.

## Evidence

- [Read-slice checkpoint](evidence/WP-A01/read-slice-checkpoint.json) records the connected v2 bootstrap at `5640dcd`: exact A01, full repository verification, Linux build and worktree check passed from a clean checkout without prebuilt web assets. It explicitly marks full package acceptance incomplete and does not replace the historical manifest.
- `docs/work-packages/evidence/WP-A01/manifest.json` indexes the tested commit, migration heads, toolchains, commands, and redaction status per the evidence manifest schema.
- `inspector-transcript.jsonl` with its byte-pinned `.expected.jsonl` twin records a full stdio session (handshake, tool list, provisional reads, provisional rejection, binding, writes, proposal policy, versioned re-read, unknown method, absent tools), replayed verbatim by `TestGoldenInspectorTranscript`.
- `pending-record.json` shows one journaled operation with every required evidence field; `replay-matrix.md` tabulates the replay dispositions.
- `acceptance-matrix.md` maps each Acceptance bullet to its proving test; `command-result.json` records the `pnpm test:a01`, `pnpm verify`, `pnpm worktree:check`, Linux cross-build, and clean-checkout gate outcomes.
- Evidence contains synthetic identities only: no bearer/grant secret, task body, local absolute path, environment value, or raw terminal output.

## Risks and decisions

- Provider MCP hosting can alter ancestry. Test per supported provider/version instead of weakening checks globally.
- Original interface evidence used doubles behind narrow interfaces (`SessionBindingSource`, `AssignmentSource`, `AuthoritySource`, `WorkTransport`, `ReplayPolicy`). L05/L06/E01 are now certified dependencies; the remaining A01 production connections must be proven with the actual assembled runtime, not inferred from those doubles.
- The A01 journal is its own SQLite file with migration `011`, not a daemon-chain migration, because the daemon chain applies strictly sequentially and `009`/`010` belong to L06's in-flight hook journal. A future consolidation may fold the journal into the daemon database without changing the record shape.
- The original isolated implementation added no D1 migration: context deliveries already persist in `task_context_deliveries`, and the journal is local-only. Its recorded `0018_cli_credentials` head is historical. Runtime closure must record the actual integrated migration head and own any additive attribution/policy migration it needs.
- Local tool names keep the `bfb_` prefix shared with the remote map (`bfb_get_context`, not `get_context`) so one contract table covers both transports; the Scope short names map one-to-one.

## Handoff

- Reopened 5 October: `in_progress`. The connected v2 read slice passes the expanded exact target, including the compiled stdio binary, signed daemon, Keychain-backed runner enrollment and real Worker/WorkspaceHub/D1 context deliveries. It proves MCP-process restart deduplication, not daemon restart replay. Production writes, explicit versioned offline policy, canonical session binding and daemon replay remain incomplete, so the full Outcome and Acceptance are not met. The historical manifests below are retained unchanged; downstream packages remain held until complete runtime acceptance is re-proven. No gate or architecture boundary is waived.
- Settled 18 September: `done`. E01, L05, and L06 are `done`, and `pnpm test:a01` passed in a detached clean checkout at `c212249` (install, build, exact target with race-tested Go suites and the real-binary stdio harness, including the landed L06 session-binding merge).
- Commands: `pnpm test:a01`; `pnpm verify`; `pnpm worktree:check`. The inspector-style session replay is `TestGoldenInspectorTranscript` in `internal/localmcp`.
- L06 merge step (landed, finding 13): `JournalBindings` in `internal/localmcp/production.go` implements `ObservedBinding(ctx, ref) (SessionBinding, error)` from the hook journal's trusted observed-session record via `journal.SessionReader` (match on execution ID and assignment generation; the run ID echoes the startup-verified boundary that key determines; `ErrSessionNotBound` while unbound or malformed, storage faults propagate), and `internal/cli/mcp.go` wires it over the read-only daemon handle. No other A01 change needed; the activation race, competing-session, and provisional tests already cover the real source. Proven by `TestJournalBindings*` in `internal/localmcp/production_test.go` and `TestMCPStdioActivatesBoundSession` / `TestMCPStdioRejectsMutationWhileUnbound` in `internal/cli/mcp_test.go`.
- L05 merge step: replace `DaemonAssignments` with an exported L05 assignment reader returning the same `AssignmentRecord` fields (identity, correlation, supervisor/owned-group evidence, active states). Until then the adapter reads only stable L05 columns and the mirrored PID/group/start-identity subset, and `inspect_linux.go`/`inspect_darwin.go` mirror L05's start-identity formats; localmcp stays a leaf package so L05 test binaries never form an import cycle through the CLI. The peer-verification order and malicious-process suite are unchanged.
- L08 runtime closure: `internal/cli/mcp.go` now uses the credential-free `RPCTransport`; `internal/agentwork` owns fixed daemon read routes and current runner connections. Reads record actual per-item deliveries and recheck current authority even before cached responses. Connect version-checked writes, explicit current-policy authorization and daemon replay next; the existing injected `Replay` tests do not prove those production paths.
- E01 merge step: confirm `task_context_deliveries` remains the delivery record of choice; no A01 change expected.
- A02/A03/V01 extend `ToolDescriptors`, `Host.CallTool`, and `validatedPayload` on this same server; they do not add a credential, endpoint, or journal.
- Known limitations: reads fail visibly offline; production offline policy denies pending mutations by default, and unsupported writes cannot become queued permission. Live provider ancestry/session behavior is not certified by the synthetic native read proof. The journal's capture proof is tamper-evident, not tamper-proof against a same-user attacker who can rewrite the file and recompute it — the file stays user-only (`0600`) like other daemon state. Daemon-owned capture and replay still need integration proof.
