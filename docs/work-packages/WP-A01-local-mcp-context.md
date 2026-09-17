# WP-A01 — Run-scoped local MCP and context

Status: `planned`

Risk: Very high

Test target: `pnpm test:a01`

Evidence manifest: `docs/work-packages/evidence/WP-A01/manifest.json`

> Status note: implementation, the exact gate, and the evidence below are
> complete on this branch, but E01, L05, and L06 are not `done`, so
> `pnpm roadmap:check` rejects any status beyond `planned`. This package
> stays `planned` until those dependencies complete; nothing downstream may
> consume it yet.

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
- L01 daemon kernel: CLI registry and raw-stdio dispatch (`internal/cli`), user-only state directory (`internal/daemon`); no daemon RPC or migration-chain changes.
- L03 provider kit capability ceilings for the launch-time installation identity the assignment pins.
- L05 execution supervision: immutable assignment identity, correlation token shape, owned process group, and `local_execution_assignments` state names, read through A01's adapter with L05's own structs (`docs/contracts/execution-supervisor.md`).
- L06 trusted observed-session binding, consumed exclusively through the `SessionBindingSource` interface defined in `internal/localmcp/binding.go` and tested with a double until L06 plugs in its hook-journal reader.
- L08 runner channel client as the future online `WorkTransport` and replay path; until then `OfflineTransport` provides the specified offline behavior.
- X03A remote MCP tool shapes and bounds as the consistency reference for the six local tools.

### Produces

- Local MCP tool contract `local-mcp/1`, frozen in `docs/contracts/local-mcp.md`: stdio JSON-RPC transport, process-verification order, provisional/activated/closed capability states, the six-tool map with bounds, boundary-derivation and idempotency rules, pending-journal fields and replay order, error codes, and the `SessionBindingSource` plug-in signature.
- Stable test target `pnpm test:a01` and evidence manifest `docs/work-packages/evidence/WP-A01/manifest.json`.
- `internal/localmcp`: capability, tool, journal, and stdio-server implementation with the `SessionBindingSource`, `AssignmentSource`, `AuthoritySource`, `WorkTransport`, `OfflinePolicy`, and `ReplayPolicy` interfaces downstream packages build against.
- Local SQLite migration `011_pending_operations` (`internal/localmcp/migrations/011_pending_operations.sql`) owning the A01 journal file; it shares no table with L06 hook state.

## Work plan

1. Implement stdio host, provisional read-only state, trusted-session activation, and local process/capability verification.
2. Implement context/read tools and delivered-version recording.
3. Implement bounded write/proposal tools and the fully evidenced offline operation journal.
4. Test cross-run/process/UID/session attacks, revocation, version conflicts, startup race, and stdout purity.

## Acceptance

- Wrong UID/process group/run/task/workspace/assignment/session cannot acquire/use a capability.
- Caller-supplied IDs cannot escape the derived boundary.
- Agent cannot read human-only context, promote a root proposal, administer policy, or launch another root run.
- Initial MCP startup can load context before session binding but every mutation fails until L06 commits the matching trusted binding; a competing session can never activate it.
- Offline operation either returns durable `pending_sync` or visible failure exactly by policy.
- Restarted replay preserves and validates the originating assignment/principal, capture proof, expiry, and request identity; it fails visibly after revocation, execution end, expiry, accepted result, policy change, or version conflict.

## Evidence

- `docs/work-packages/evidence/WP-A01/manifest.json` indexes the tested commit, migration heads, toolchains, commands, and redaction status per the evidence manifest schema.
- `inspector-transcript.jsonl` with its byte-pinned `.expected.jsonl` twin records a full stdio session (handshake, tool list, provisional reads, provisional rejection, binding, writes, proposal policy, versioned re-read, unknown method, absent tools), replayed verbatim by `TestGoldenInspectorTranscript`.
- `pending-record.json` shows one journaled operation with every required evidence field; `replay-matrix.md` tabulates the replay dispositions.
- `acceptance-matrix.md` maps each Acceptance bullet to its proving test; `command-result.json` records the `pnpm test:a01`, `pnpm verify`, `pnpm worktree:check`, Linux cross-build, and clean-checkout gate outcomes.
- Evidence contains synthetic identities only: no bearer/grant secret, task body, local absolute path, environment value, or raw terminal output.

## Risks and decisions

- Provider MCP hosting can alter ancestry. Test per supported provider/version instead of weakening checks globally.
- L05/L06/E01 are in flight in sibling worktrees: A01 proves their touchpoints with doubles behind narrow interfaces (`SessionBindingSource`, `AssignmentSource`, `AuthoritySource`, `WorkTransport`, `ReplayPolicy`) rather than consuming unfinished stores. The Handoff names each merge step.
- The A01 journal is its own SQLite file with migration `011`, not a daemon-chain migration, because the daemon chain applies strictly sequentially and `009`/`010` belong to L06's in-flight hook journal. A future consolidation may fold the journal into the daemon database without changing the record shape.
- No D1 migration: context deliveries already persist in `task_context_deliveries`, and the journal is local-only. D1 head stays `0018_cli_credentials`.
- Local tool names keep the `bfb_` prefix shared with the remote map (`bfb_get_context`, not `get_context`) so one contract table covers both transports; the Scope short names map one-to-one.

## Handoff

- State: implementation, `pnpm test:a01`, `pnpm verify`, `pnpm worktree:check`, `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build ./...`, and the clean-checkout gate pass at the evidence commit. Status stays `planned` pending E01, L05, L06.
- Commands: `pnpm test:a01`; `pnpm verify`; `pnpm worktree:check`. The inspector-style session replay is `TestGoldenInspectorTranscript` in `internal/localmcp`.
- L06 merge step: implement `ObservedBinding(ctx, ref) (SessionBinding, error)` from the hook journal's trusted observed-session record (match on execution ID, assignment generation, run ID; return `ErrSessionNotBound` while unbound) and replace `ProvisionalBindings` in `internal/cli/mcp.go`. No other A01 change needed; the activation race, competing-session, and provisional tests already cover the real source.
- L05 merge step: replace `DaemonAssignments` with an exported L05 assignment reader returning the same `AssignmentRecord` fields (identity, correlation, supervisor/owned-group evidence, active states). Until then the adapter reads only stable L05 columns and the mirrored PID/group/start-identity subset, and `inspect_linux.go`/`inspect_darwin.go` mirror L05's start-identity formats; localmcp stays a leaf package so L05 test binaries never form an import cycle through the CLI. The peer-verification order and malicious-process suite are unchanged.
- L08 merge step: implement `WorkTransport` (reads with delivery recording, version-checked writes, per-call epoch/capability rechecks, request-id idempotency) over the runner channel client, replace `OfflineTransport` in `internal/cli/mcp.go`, and implement `ReplayPolicy.CurrentAllow` from current project policy. `Replay` already rechecks credential, epoch, capability, policy, and version in the specified order.
- E01 merge step: confirm `task_context_deliveries` remains the delivery record of choice; no A01 change expected.
- A02/A03/V01 extend `ToolDescriptors`, `Host.CallTool`, and `validatedPayload` on this same server; they do not add a credential, endpoint, or journal.
- Known limitations: production reads fail visibly offline until the L08 transport plugs in; cloud revocation/terminal-result rechecks ride on the transport until then (local liveness is rechecked every call); the journal's capture proof is tamper-evident, not tamper-proof against a same-user attacker who can rewrite the file and recompute it — the file stays user-only (`0600`) like other daemon state.
