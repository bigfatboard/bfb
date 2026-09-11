# Early provider capability experiment

Run from the repository with the pinned Node runtime:

```sh
node tools/provider-probe/run.mjs claude
node tools/provider-probe/run.mjs codex
```

These are opt-in live experiments using the installed CLIs and their existing
native authentication. They create only synthetic sessions in a private
temporary Git repository, and do not read/copy credentials, resume personal
conversations, change global provider configuration or launch subagents. Model
calls consume the signed-in provider's usage. The script prints its private
local report directory; raw streams are not commit-ready evidence.

Only reviewed exact versions run: Claude Code `2.1.269` and Codex CLI `0.153.4`.
A version change stops before any model prompt. Each invocation has a 90-second
deadline, a five-second kill fallback and a combined 1 MiB retained-output bound.
The script preserves the CLI version and binary hash before/after.

The fixture exercises fresh input, exact resume, fork, repeated identical input,
wrong-session targeting, simultaneous use of one session, post-turn interrupt,
process loss before identity observation and after turn observation, inherited
instruction/hook/MCP canaries, and a peer request to write/escalate. Process-loss
cases are **not retried**; session initialization is not an input-delivery
acknowledgement. No observed exit, interruption or prose submits a BFB result.

Claude uses safe/restricted mode, only Read/Glob/Grep, empty strict MCP config,
disabled hooks/customization and refused native peer input. Codex uses its CLI
read-only sandbox, ignored user config/rules, disabled integration features and
fixed stdin input. Codex's host-skill-discovery suppression is an
under-development feature in this exact binary, not a stable cross-version
guarantee. Claude managed policy and complete inherited-permission isolation
also require real adapter doctor fixtures. Absent write canaries and observed
tool lists are therefore recorded as observations, not full `read_only`
certification.

## Native external delivery

The experiment deliberately withholds optional native idle/active external
delivery. Claude's documented socket guide specifies discovery/authentication
but does not establish the script message payload contract used by this kit;
the tested profile refuses inbound messages. Codex's stable CLI continuation is
not a proven native lower-authority input transport, while the new SDK external
message surface would add a runtime/transport not approved for production here.
Neither is silently replaced with user-authority queue input or an undocumented
socket payload. Their matrix entries remain `unverified`, not `supported`.

The chosen MVP fallback remains fixed-instruction, bounded attributed stdin
with exact continuation. L07/P01 must certify its full read-only boundary before
granting capabilities; D02 must provide duplicate suppression, session fencing
and ambiguous-delivery recovery regardless of native behavior. Fork support in
this experiment is not permission to attach existing personal sessions.

Primary references:

- [Claude non-interactive operation and streaming](https://code.claude.com/docs/en/headless)
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude cross-session messages and inbound controls](https://code.claude.com/docs/en/cross-session-messaging)
- [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex configuration](https://learn.chatgpt.com/docs/config-reference)

`node --test tools/provider-probe/capabilities.test.mjs` owns the report
classification fixtures. `pnpm provider:generate` owns compiled registration
aggregation; `pnpm provider:check` checks its deterministic output.
