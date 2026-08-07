# WP-L01 — Go daemon and CLI kernel

Status: `planned`

Risk: High

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
