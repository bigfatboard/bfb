# P02 setup-transaction assertions

Tested from the P02 clean commit with `pnpm test:p02`. This evidence describes
assertions, not raw provider output or personal configuration.

## hooks/bfb.json (`grok.HooksEditor`, namespace `grok.hooks`)

- Grok loads every JSON file under the user hooks directory, so BFB owns
  `hooks/bfb.json` outright: the proposal renders all eight managed events
  (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure`) with exactly
  one command entry, `<launcher> hook ingest --provider grok`, each.
- Foreign hook files in the same directory stay untouched; foreign content
  inside `bfb.json` is a conflict, never merged, adopted, or overwritten.
- Unowned semantics are constant for a wholly owned file; setup is
  idempotent byte-for-byte.
- Malformed JSON, non-object `hooks` tables, missing events, extra entries,
  drifted commands or timeouts, and empty launcher commands are denied
  before any write.
- A stale proposal or competing writer fails with `provider_setup_conflict`
  under the shared inode lock.
- A failed post-write doctor restores exact prior bytes, including original
  absence. (The setup caller creates the BFB-owned hooks directory before
  proposing, mirroring the Claude setup command; existing permissions are
  never widened.)
- Health matching uses the stable ingest fragment, so a moved launcher path
  reads as healthy while `CheckHooks` still enforces the exact configured
  command.

## config.toml (`grok.MCPServerEditor`, namespace `mcp_servers.bfb`)

- The editor appends exactly one owned block verified byte-for-byte against
  the real `grok mcp list --json` shape: `[mcp_servers.bfb]` with `command`,
  `args = ["mcp", "stdio"]`, and `enabled = true`.
- Unrelated configuration stays byte-identical (append-only publication);
  setup is idempotent.
- An existing foreign `[mcp_servers.bfb]` table, a drifted BFB block, a
  duplicated marker, or a relative launcher path fails with conflict or
  denial instead of being adopted or overwritten.
- A failed post-write doctor restores the original absence.

## Doctor (`grok.Doctor` and per-transaction doctors)

- Version must parse as `grok <semver> (<build>)` with an optional channel
  suffix and belong to the tested list, otherwise `provider_unsupported`.
- The hooks file must carry the BFB session binder with the exact
  configured command, otherwise `provider_config_invalid`.
- `mcp list --json` must report an enabled `bfb` server with the expected
  stdio command and args, otherwise `provider_config_invalid`. A disabled,
  renamed, missing, or malformed registration fails the same way.
- The environment must scope `GROK_HOME` at the checked home; anything else
  is rejected before any check runs. No doctor path passes trust or
  permission-bypass flags.
