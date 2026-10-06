# Isolated Claude tracked-launch candidate

This is a test-only composition, not production provider support. It permits
only experimental Claude `2.1.291` with the existing interactive,
`on_request`/`workspace_write` adapter. It adds the measured MCP handshake
surface only when real inspection finds the exact owned user hook/MCP
configuration. Headless, discussion, fork and broader permissions stay closed.
The production manifest, tested versions and doctor remain unchanged.

Preparation consumes the complete metadata-only log from the separately
approved `claude-mcp.mjs` probe. It does not execute Claude, copy authentication,
inspect session contents, or modify settings. The previous probe log did not
record its executable digest; its external protocol observations and the new
binary pin are separate facts. The runtime's normal exact-version probe must
still establish that the pinned executable is the candidate version.

```sh
node tools/provider-probe/claude-bfb.mjs --dry-run --binary /absolute/path/to/claude --probe-log /private/path/to/probe.log
node --test tools/provider-probe/claude-bfb.test.mjs
go test -race ./internal/providers/claude/testdata/pilot
```

An explicit `--build` in place of `--dry-run` reuses `buildSignedApp` with a Debug
app and the fixed test helper. It creates private state under
`/tmp/bfb-l04-l07-*/state`, adds the binary/home/metadata pin resource, reseals and
verifies the bundle, and checks the binary hash before and after. Signing can
require native Keychain consent. Building does not activate the app, helper,
provider or enrollment and never installs a service. The local
`candidate-plan.json` contains operator paths; it is not committable evidence.
Do not move or alter the bundle or pin after approved setup.

The app, foreground daemon, `__launch`, `__exec`, hooks and MCP resolve that
same signed resource state. The helper rejects alternate `--data-dir`, argument
delimiter escapes and `daemon install`. The daemon uses the same candidate
registry for real inventory, supervision and telemetry. It reuses production
commands, SQLite, runner proof/channel, native ownership and cloud authority;
it seeds no healthy inventory, enrollment, assignment or business state.
The shared candidate resolver checks the selected binary path/hash before any
inventory or preparation version probe. Candidate doctor applies the same
preflight before its separate observation and still reports the production
version as uncertified. Hooks/MCP/lifecycle do not require a matching GUI PATH.
Human CLI commands are deliberately unavailable in this helper: onboarding
and human card mutations use the real authenticated browser.

Every authority-bearing helper entry point verifies the pinned binary. The
exact user-level Claude hook invocation silently returns before input, state or
pin inspection only when every BFB execution binding is absent. Present-empty
or partial bindings remain failures. This keeps unrelated Claude sessions
independent of the pilot's state and provider version without granting access.
If an auto-update or removal invalidates the pin, even helper
`daemon status`/`daemon stop` is closed.
Recover only by SIGINT/SIGTERM to the exact foreground session/process owned
by this candidate invocation; never kill by process name, install a service,
or weaken the pin to regain lifecycle access.

Activation is a separate human/root-coordinated step. Before it, independently
review the bundle/signatures and pin, complete real human onboarding and scoped
runner enrollment, and preview/approve the existing CAS provider setup against
this helper. Preserve non-BFB settings and all existing sessions. Confirm the
private app socket/state before any launch, do not use the app's service-install
button, and resolve any duplicate-bundle LaunchServices selection explicitly.
Native Terminal consent must come through the normal human-visible BFB feature;
never through UI automation or an alternate AppleScript/System Events path.

A reviewed repair can use a separately built signed Debug bundle with the same
existing test-state directory and byte-identical candidate binding. Preserve
the original bundle, verify both signatures and unchanged provider bytes, and
stop the previous app and foreground daemon before activating the replacement.
Matching designated requirements and actual reconnect must prove that the
existing enrollment remains usable; do not rewrite Keychain ACLs or re-enroll
to hide a failed replacement. Preview any new helper path through the normal
setup transaction. Before installing user-level hooks, exercise the actual
signed helper without BFB bindings and require exit zero with no output.

The live acceptance still needs actual card Start, exact checkout/held ownership,
trusted session binding, genuine scoped MCP context, semantic event commit,
explicit business actions and same unfinished-run resume. Bound the synthetic
task and supervise its approved runtime; Stop/prose/exit cannot submit a result.
Only then may normal production support be proposed, with version-specific
fixtures and a clean exact L07 gate. This build does not certify L07 or the MVP.

`go test ./internal/providers/claude/testdata/pilot` must be selected explicitly:
Go's recursive `./...` patterns exclude `testdata` packages. The parent L07 gate
should select this suite and the Node test file when integrating this harness.
