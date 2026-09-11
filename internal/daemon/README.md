# Local daemon kernel

Owner: [L01](../../docs/work-packages/WP-L01-daemon-kernel.md). Gate: `pnpm test:l01`.

The daemon is an unprivileged per-user process. Its default state directory is the OS user configuration directory plus `BFB` (Application Support on macOS). `--data-dir` selects a dedicated private local directory for development/testing. It is never supplied by the control plane. Directories are `0700`, state/lock/log files and the Unix socket are `0600`; unsafe ownership, public permissions and symlinked state objects fail closed. Keep the socket path shorter than 104 bytes for macOS.

## Local commands

Build with `go build -o bfb ./cmd/bfb` and run `./bfb daemon run` in a terminal, or install that binary at a stable local path and invoke `bfb daemon install`. Installation creates the per-user `com.tenira.bfb.daemon` launch agent. It does not require root, overwrite conflicting installations, or stop an existing service. `--label com.tenira.bfb.example` is available for explicitly isolated development installations.

`bfb daemon status --json`, `bfb daemon logs --lines 100 --json`, and `bfb daemon stop --json` report health, bounded diagnostics and graceful shutdown. The installed agent restarts after an unsuccessful process exit, not after a successful stop. To restart a stopped installed job, use `launchctl kickstart gui/UID/com.tenira.bfb.daemon` with the actual user ID. To unload it, use `launchctl bootout gui/UID/com.tenira.bfb.daemon`; remove only that installation's plist if uninstalling permanently. Do not delete local state as a recovery shortcut.

The kernel does not enroll a runner, open a provider, implement MCP, or accept hooks yet. Those reserved entry points fail with `not_implemented` until their owning packages register leaf handlers. A running daemon alone is not a running MVP.

## RPC and extension ownership

[Local RPC v1](../../protocol/schema/v1/local-rpc.json) is the canonical wire contract, with generated Go/TypeScript owned by `pnpm protocol:generate`. Both directions are validated against the canonical schema, including duplicate-key rejection. One newline-delimited JSON object is bounded to 64 KiB. The server limits concurrent clients to 32 and connection I/O to ten seconds. Requests carry a fresh ULID, method and `direction: request`; responses preserve the ID/method and use `direction: response`. Error text comes from fixed diagnostic codes, never an underlying OS/database error.

The server checks kernel UID/PID, and the client verifies the daemon-side UID. Same-UID access is the OS-user boundary, not run authorization; A01 must additionally validate process ancestry and execution scope for agent operations. Local RPC registration is frozen before serving. Feature packages register leaf handlers through `daemon.Registry` and `cli.Registry`; the CLI daemon command receives that configured method registry. Handlers receive the daemon-owned store through their request, must honor context cancellation, and validate their method-specific payloads. Registering an existing method fails.

`daemon.status` and `daemon.stop` accept an empty payload. Status reports process ID, daemon start time, local storage version and the number of unknown process observations. It does not infer provider activity or business completion. Stop responds before shutting down. CLI JSON uses the same envelope; exit codes are success 0, usage/schema 2, denied 3, unavailable 4, internal/storage 5, and conflict 6.

## Storage and recovery

The ordered SQL files in `migrations` are embedded into the binary. Adding a migration requires its consuming package, sequential filename and the same test gate; never edit an applied migration. The kernel uses SQLite WAL, full synchronization and foreign keys with one pooled connection. Migration names/checksums and the application ID are verified; the entire pending migration batch is transactional. Opening a foreign, corrupt, checksum-mismatched or newer database fails without replacing it.

A retained lock-file inode and advisory exclusive lock prevent two daemons owning the same state, including through aliases. The lock is acquired before storage changes or stale-socket removal. Abrupt exit releases the OS lock; restart removes only an owned socket and verifies the database. Attached process observations become `unknown` until an owning feature reconciles them. No process is killed, work accepted or checkout released based solely on daemon restart.

Diagnostics accept only defined event names, diagnostic codes, generated request IDs and timestamps. There are four bounded log files (current plus three archives, 256 KiB each). CLI reads revalidate/re-encode entries and omit unknown fields. No credential, path, task body, environment, hook payload or raw transcript is a log field.

Credential interfaces in `internal/auth` separate human, per-workspace runner-key/token and local-secret references. There is no plaintext store or dummy production Keychain implementation. L08/L04 owns native signed-component access and its proof before enrollment can succeed.

## Verification environment

The gate uses synthetic state in dedicated temporary directories. It checks real process termination/restart, atomic migration/transaction crash recovery, UID policy, restrictive OS permissions, framing, contention, redaction, unsafe files and credential namespace separation. On macOS it also compiles a Swift socket client and installs a unique per-user launchd job, then removes that exact test job/plist. These Darwin cases require a GUI login session and are not silently skipped there. They use an empty BFB state directory under the current account, not a newly created macOS account; signed Keychain and clean-machine distribution remain separate later gates.
