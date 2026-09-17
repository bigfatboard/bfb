# WP-L07 capture report — Claude Code 2.1.274

Method: bounded real-CLI experiments only. Every run used an isolated `HOME`
under `/tmp`, a temporary Git working directory (never this repository), and
the ambient `DISABLE_AUTOUPDATER` setting, so no update, login, or
configuration change could touch the operator's real Claude setup. No
authenticated model turn was run: the isolated home holds no credentials, and
no prompt text was ever sent. Raw captures stay local; committed fixtures
carry scrubbed identifiers only.

## Experiments

1. `claude --version` → `2.1.274 (Claude Code)`. No home writes observed.
2. `claude doctor` in the isolated home → exit 0 offline; reports version,
   native path, disabled auto-updates, and unfetched remote state without
   touching real configuration.
3. `claude --init-only` with an exec-form `SessionStart` capture hook in
   isolated `settings.json` → the hook fired with this stdin shape
   (identifiers scrubbed):
   `session_id`, `transcript_path`, `cwd`, `hook_event_name=SessionStart`,
   `source=startup`. No `model` field was present.
4. `claude -p` with capture hooks and no credentials → failed as
   `Not logged in` after firing `SessionStart`, `UserPromptSubmit`
   (`prompt_id`, `permission_mode`, full `prompt` text), and `SessionEnd`
   (`reason=other`). Prompt text is never copied into a candidate.
5. `claude mcp add --scope user` in the isolated home → wrote the server
   entry to `~/.claude.json` (not `settings.json`) as
   `mcpServers.<name> = {type, command, args, env}`, preserving machine
   identity and unrelated keys.

## Committed fixtures

- `hook-sessionstart-startup.json`, `hook-userpromptsubmit.json`,
  `hook-sessionend-other.json`: shapes captured above, identifiers and paths
  scrubbed.
- `hook-sessionstart-{resume,fork,clear,compact}.json`,
  `hook-{pretooluse,posttooluse,posttoolusefailure,stop,stopfailure}-*.json`,
  `hook-sessionend-resume.json`: schema-derived from the documented 2.1.x
  hook reference, each labeled in-file.
- Negative fixtures: unknown event, bad source, removed reason, missing
  session, duplicate keys, out-of-pattern tool name.

## Not done here

Live tool-turn and `Stop` captures need authenticated runs; they stay pending
with the real end-to-end checkpoint (A01, E01, L05, L06). PreToolUse,
PostToolUse, PostToolUseFailure, and Stop parsing is proven against the
documented schema, not against a live turn on this version.
