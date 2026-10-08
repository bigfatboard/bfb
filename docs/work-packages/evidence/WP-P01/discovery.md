# P01 discovery probes (Codex 0.153.4)

Bounded offline probes against the installed binary in an isolated temporary
home and scratch checkout. Help output guided discovery; only the observed
behaviors below ground adapter decisions. No personal configuration was read
or written, no model was called, and no raw terminal output is retained.

- `codex --version` prints `codex-cli 0.153.4`; `codex exec --version`
  prints the matching exec banner.
- Fresh headless runs accept `-C/--cd`, `-s/--sandbox`
  (`read-only`, `workspace-write`, `danger-full-access`), `-m/--model`,
  `-c/--config`, `--json`, `--color`, and a `-` stdin prompt marker.
- `codex exec resume <id>` and `codex exec fork <id>` accept `-c`, `-m`,
  `--json`, and `-` prompts, but no `--cd`, `--sandbox`, or `--color`.
  Unknown IDs exit 1 with an unknown-thread rejection and no observed
  identity.
- The TUI (`codex`, `codex resume`, `codex fork`) accepts `--cd`,
  `--sandbox`, `--model`, `-c`, and `-a/--ask-for-approval` with the values
  `on-request` and `never`.
- `-c approval_policy` accepts `never` and `on-request`; `always`,
  `on_request`, and unknown variants are rejected during config load.
  `-c model_reasoning_effort` passes `low`/`medium`/`high` through config
  load without validation.
- `codex doctor --json` emits a redacted machine-readable report (schema
  version, codex version, per-check status) and runs without credentials.
- `codex mcp add <name> -- <command> [args]` writes a global
  `[mcp_servers.<name>]` table; `codex mcp get <name> --json` returns the
  stdio transport with command, args, env, and cwd fields. A hand-written
  block with the same shape round-trips unchanged.
- Hooks run per event with matcher groups; multiple matching hooks run
  concurrently and cannot block each other. `SessionStart` matches on
  `startup|resume|clear|compact` sources and accepts additional context
  that does not start a turn. Non-managed hooks need hash-based trust
  review; the bypass flag exists but BFB never passes it.
- `exec --json` streams JSONL with `thread.started` (thread ID),
  `turn.started`, `turn.completed` (usage with input, cached, output, and
  reasoning tokens), `turn.failed`, `item.*`, and `error` event types.
