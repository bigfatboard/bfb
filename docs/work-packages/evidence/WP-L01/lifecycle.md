# L01 native lifecycle evidence

The clean-checkout `pnpm test:l01` gate ran on macOS 26.2 arm64 in the current GUI login session at the manifest's tested commit. An additional `go test -race -count=1` run executed every native package without test-cache reuse. This is a bounded assertion trace, not a retained terminal transcript.

`TestDaemonProcessCrashAndRestart` completed this sequence with a real freshly built binary and empty isolated state:

1. Start daemon; CLI status returns `running`.
2. Attempt a second daemon against the same state; it exits `6` with `already_running`.
3. Kill the first daemon; wait for its actual process exit.
4. Start again; CLI status returns `running` after safe stale-socket recovery.
5. Invoke CLI stop; the process exits successfully.
6. Read CLI logs; at least three bounded diagnostic entries survive the restart.

`TestLaunchdCleanBFBInstall` installed a uniquely labelled per-user launch agent, observed daemon health, checked a private plist, repeated the exact installation idempotently, rejected a different state-directory configuration without replacing the service, and rechecked health. Cleanup unloaded only the unique test service and removed its own plist. XML escaping/fixed-argument behavior passed `TestLaunchdPlistEscapesOnlyFixedArguments`.

## Deferred release-environment acceptance

These tests use empty BFB state under the existing macOS account. They do not prove installation from a genuinely clean macOS user account. Timo approved moving that specific environment check to G02 in [ADR 0003](../../../adr/0003-local-mvp-account-test-scope.md). The manifest records the revised local L01 scope as passed; the fresh-account release check remains explicitly `not_run`, not a release waiver or an equivalent proof.

The UID policy and OS permission assertions passed; a second interactive account was not used. Signed Keychain access belongs to L08/L04 and clean-machine release installation belongs to G02. No permanent daemon, enrolled runner, provider session or running MVP is claimed by these fixtures.
