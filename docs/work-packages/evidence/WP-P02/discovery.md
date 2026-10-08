# P02 discovery probes (Grok 1.0.34)

Bounded offline probes against the installed binary in an isolated temporary
home and scratch directories. Help output and official docs guided discovery;
only the observed behaviors below ground adapter decisions. No personal
configuration was read or written, no model was called, no session was
opened, and no raw terminal output is retained.

Official documentation read for this version: the CLI reference
(`grok --cwd`, `-r/--resume`, `-s/--session-id`, `--fork-session`,
`-m/--model`, `--always-approve`, `--allow/--deny`, `--sandbox`,
`grok mcp/inspect/sessions/usage/setup`), headless scripting (`-p`,
`--output-format`, `--session-id` headless sessions, ACP via
`grok agent stdio`), hooks (user `hooks/*.json`, event table, stdin JSON
with `hookEventName`/`sessionId`/`cwd`/`workspaceRoot`, `PreToolUse` deny
contract), sandbox profiles (`off`, `workspace`, `read-only`, `strict`),
permissions (Ask default, Auto, Always-approve), the settings reference
(`GROK_HOME`, `GROK_SANDBOX`), and the models page (code uses `grok-4.6`).

- `grok --version` prints `grok 1.0.34 (<build>) [stable]`; under a bare
  temporary home the channel suffix is absent. The adapter parser accepts
  both banner shapes for the tested version only.
- `grok --cwd <dir> inspect --json` reports the requested directory in its
  `cwd` field, grounding exact-checkout `--cwd` plans.
- `grok --sandbox bogus-profile sessions list` refuses to start with exit 1
  instead of running unsandboxed, grounding the read-only/workspace profile
  mapping and its fail-closed default.
- `grok mcp add bfb -- <launcher> mcp stdio` writes a `[mcp_servers.bfb]`
  table with command, args, and enabled into the user config;
  `grok mcp list --json` returns the same command and args with
  `enabled: true`. The setup editor produces this exact shape.
- A hand-written `hooks/bfb.json` carrying the BFB `SessionStart` entry is
  discovered by `grok inspect --json` as a user hook with the exact command
  target, grounding hook-file placement and the doctor signal. User-level
  hooks need no project-trust grant.
- `sessions list` in an empty home reports no sessions; `usage` of an
  unknown session exits 1 with a not-found error. `grok usage` stays a
  manual diagnostic: it is not an event source and never feeds the ledger.
- Headless `-p` with an invalid `--session-id` and `--resume` of an unknown
  UUID both stop at sign-in inside an unauthenticated home, so CLI
  flag-validation order could not be observed. The adapter validates UUID
  shape before emitting either flag; positive session binding awaits live
  L05 proof and is not claimed here.
- `--resume` in TUI mode blocks on the terminal, so TUI-invoking probes
  were terminated rather than completed. No TUI auto-submit behavior is
  claimed, which is why interactive plans carry no prompt and start in
  `waiting_user_submit`.
- Headless `-p --output-format json|streaming-json` shapes require a live
  model call to verify, so headless launch, discussion turns, structured
  output, and fork stay withheld. Usage stays `unavailable` by construction.
