# Work-record runtime proofs

`pnpm test:c08` owns `run.ts`: real independent Workers dispatch production Hub
commands to disposable D1 and prove task/run races and immutable context history.

`pnpm test:c10` owns `privacy.ts`: production Hub creates **shared** synthetic
tasks, then test-only fixture inserts exercise dormant private policy/grant SQL
against real workerd D1. It verifies current authority, role/grant intersection,
pagination/counts, policy retention and atomic batch failure. It does not certify
private task creation, MCP/HTTP delivery, realtime, artifact access or a provider.

Both use the checked-in ordered migrations in a disposable local harness. No
pilot enrollment, persistent local database, real user, credential or Terminal
session is touched. No extra dependencies or generated fixtures are introduced.
