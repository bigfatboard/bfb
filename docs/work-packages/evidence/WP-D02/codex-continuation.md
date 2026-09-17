# WP-D02 bounded Codex continuation experiment

Date: 17 September 2026. Workdir: temporary directories only; the repository
was never a provider working directory.

## What ran

- Installed binary: `codex-cli 0.153.4`, matching the P01-tested adapter
  version. Temporary home with a synthetic `hooks.json` carrying the BFB
  `SessionStart` binder and an empty `config.toml`.
- Real adapter probe through the frozen L03 kit: version `0.153.4`,
  `healthy`, full tested capability set.
- Real read-only fresh-turn plan: `exec --cd <tmp> --sandbox read-only
  --model gpt-5.6-sol -c approval_policy="never" ... --json --color never -`
  with the fixed discussion instruction on stdin.
- Real exact-session continuation plan: `exec resume <observed-id> ... --json`
  with no `--cd`/`--sandbox` flags (inherits the bound session root).

Owning test: `TestCodexRealBinaryPlansReadOnlyTurn` in
`internal/discussion/readonly_test.go`. No transcript exists to redact:
planning emits argv shapes only.

## What did not run

No live model turn ran. A live `codex exec` turn needs provider credentials
and explicit human consent; neither was available in this session, so no
model was invoked and no budget was spent. This report records that boundary
precisely instead of substituting fake success: the fake-provider matrix
proves delivery and recovery logic, while live Codex continuation waits on
credentials, consent, and finished L05/L06 supervision.
