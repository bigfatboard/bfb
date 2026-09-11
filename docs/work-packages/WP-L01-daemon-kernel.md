# WP-L01 — Go daemon and CLI kernel

Status: `in_progress`

Risk: High

Test target: `pnpm test:l01`

Evidence manifest: `docs/work-packages/evidence/WP-L01/manifest.json`

## Outcome

One unprivileged `bfb` binary runs a reliable per-user daemon and exposes stable local RPC, storage, logging, and CLI foundations to every macOS feature package.

## Dependencies

- **Requires:** F01, F02.
- **Unlocks:** A01, L02, L03, L04, L05, L06, L08, X02, X05.
- **Can run with:** C01–04 after F02.

## Scope

- Dispatch `daemon`, normal CLI, `hook ingest`, `mcp stdio`, and hidden `__launch` entry points without implementing their feature behavior.
- Install/run as a per-user `launchd` agent with single-instance enforcement and clean restart handling.
- Provide a mode-`0600` Unix domain socket with peer-UID validation.
- Add SQLite WAL, ordered local migrations, integrity checks, crash-safe transactions, and recovery hooks.
- Add restrictive Application Support/cache/log directories and rotating structured redacted logs.
- Add Keychain interfaces separating human credentials, per-workspace runner keys/tokens, and local-only secrets.
- Define local RPC v1 for CLI/app/hooks/MCP and stable CLI JSON/error/exit-code envelopes.
- Add a designated command-registration boundary so parallel features do not all edit the root dispatcher.

## Non-goals

- Enrollment, checkout Git logic, provider launch, cloud task CRUD, a generic plugin framework, root privileges, or remote shell behavior.

## Contracts

### Consumes

- F01 pinned Go `1.26.5`, Node `24.19.0`, pnpm `11.21.0` and platform-aware repository gates.
- F02 `bfb-wire/1` local RPC envelope, ULIDs, typed diagnostics and deterministic cross-language schema generation. Prior prerequisite gate: `pnpm test:protocol` (132 TypeScript tests and Go protocol checks passed before runtime edits).
- Local SQLite migration head starts empty. Cloud D1 migrations and IC-1 business/auth behavior are unchanged by this package.

### Produces

- Bounded newline-delimited local RPC v1 over an owner-only Unix socket; daemon status/stop methods and a leaf-handler registration boundary. Requests and responses use the canonical schema and fixed typed diagnostics; no raw internal errors escape.
- SQLite WAL kernel migration `001_kernel.sql`, checksum/foreign-database/integrity checks, atomic migration transactions and unknown-on-restart process observations. No automatic destructive corruption repair.
- Namespaced credential-store interfaces for human credentials, per-workspace runner material and local-only secrets. Signed native Keychain implementation and access-control proof remain with L08/L04; no plaintext credential fallback is introduced.
- CLI JSON uses the same RPC envelope. Exit codes: success `0`, usage/schema `2`, denied `3`, unavailable/not implemented `4`, internal/storage `5`, conflict/busy `6`.
- Per-user launchd installation without root privileges or shell interpolation, private state directories, bounded redacted rotating logs, and `pnpm test:l01` including Darwin lifecycle and Swift-to-UDS fixtures.

## Work plan

1. Build binary dispatch, local paths, socket, and daemon lifecycle.
2. Add SQLite migrations/integrity and Keychain interfaces.
3. Add RPC/CLI envelopes, logging/redaction, and restart reconciliation hooks.
4. Fault-inject duplicate daemon, migration interruption, corrupt storage, and abrupt process exit.

## Acceptance

- A second daemon cannot bind or corrupt the first.
- Another macOS user cannot access the socket or database.
- Forced termination at migration/transaction boundaries leaves recoverable state.
- Restart preserves records and reports unverified active processes as unknown until reconciled.
- Redaction fixtures containing tokens, paths, task bodies, hook payloads, and environment values leak none of them.
- `bfb daemon install/status/logs` works from a clean macOS user account.

## Evidence and handoff

- Commit Local RPC fixtures, migration/fault results, redaction report, and daemon lifecycle log.
- Feature packages add leaf handlers through the designated registration boundary.

## Risks and decisions

- Prove Swift-to-UDS and background Keychain access with a small fixture before app work expands.
- L01 proves Swift-to-UDS with a synthetic client. L08/L04 must prove the signed-component Keychain boundary before accepting enrollment; an unsigned interface test cannot certify that boundary.
- Exact pinned pure-Go SQLite driver avoids introducing a C toolchain into the distributable runner. Tests use isolated empty BFB user state, never a pre-existing personal BFB database; Darwin launchd tests report their actual account environment.
