# P01 setup-transaction assertions

Tested from the P01 clean commit with `pnpm test:p01`. This evidence describes
assertions, not raw provider output or personal configuration.

## hooks.json (`codex.HooksEditor`, namespace `codex.hooks`)

- Proposals install one BFB group per managed event (`SessionStart` with
  matcher `startup|resume`, plus `SessionEnd`, `Stop`, `PreToolUse`,
  `PostToolUse`, `Interrupt`) whose command is exactly
  `<launcher> hook ingest --provider codex`.
- Foreign groups, top-level keys, and descriptions are preserved; unowned
  semantics before and after are canonically identical, and setup is
  idempotent.
- A group mixing foreign and BFB hooks is left alone while the missing BFB
  group is appended, converging on re-proposal.
- Malformed JSON, duplicate keys, non-object `hooks` tables, and empty
  launcher commands are denied before any write.
- A stale proposal or competing writer fails with `provider_setup_conflict`
  under the shared inode lock; edits made during a passing or failing doctor
  stay intact with a private recovery copy.
- A failed post-write doctor restores exact prior bytes and mode, including
  original absence.

## config.toml (`codex.MCPServerEditor`, namespace `mcp_servers.bfb`)

- The editor appends exactly one owned block verified byte-for-byte against
  the real `codex mcp get --json` shape:
  `[mcp_servers.bfb]` with `command` and `args = ["mcp", "stdio"]`.
- Unrelated configuration stays byte-identical (append-only publication);
  setup is idempotent.
- An existing foreign `[mcp_servers.bfb]` table, a drifted BFB block, a
  duplicated marker, or a relative launcher path fails with conflict or
  denial instead of being adopted or overwritten.
- A failed post-write doctor restores the original absence.

## Doctor (`codex.Doctor` and per-transaction doctors)

- Version must parse as `codex-cli <semver>` and belong to the tested list,
  otherwise `provider_unsupported`.
- The hooks file must carry the BFB session binder, otherwise
  `provider_config_invalid`.
- Inline `[hooks]` tables in config.toml are reported as
  `provider_setup_conflict` drift.
- `mcp get bfb --json` must report the expected stdio command and args,
  otherwise `provider_config_invalid`.
- The environment must scope `CODEX_HOME` at the checked home; anything else
  is rejected before any check runs. No doctor path passes hook-trust or
  approval bypass flags.
