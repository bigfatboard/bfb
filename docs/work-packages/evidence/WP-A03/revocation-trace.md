# A03 revocation race trace

Scenario: one run in `submitted` with a live checkout lease, two humans race
from independent Workers against one serialized WorkspaceHub over real D1:
owner `result.accept` versus reviewer `result.request_changes` with identical
expected versions. Proven by `tools/results/run.ts` on the tested commit
("accept/changes race commits exactly one review and retains the checkout
lock"); the domain suite pins both deterministic orderings.

## Legal outcomes (exactly one commits)

- Accept wins: run `submitted` → `accepted`, task `review` → `done`, one
  `result_reviews` row with decision `accept`. The change request loses with
  `invalid_transition` (run no longer `submitted`).
- Changes win: run `submitted` → `changes_requested`, task `review` →
  `active`, one `result_reviews` row with decision `request_changes`. The
  acceptance loses with `invalid_transition` (run no longer `submitted`).

Both outcomes satisfy: exactly one `result_reviews` row for the run, exactly
one submission version (no duplicate version allocated to the loser),
`result_submissions` rows byte-identical before and after, and the
`checkout_leases` row byte-identical before and after (SELECT * equality in
both the worker harness and the domain lease-retention test).

## Capability and lock effects

- When accept wins, the terminal `accepted` state closes the run-scoped
  agent capability: every later local MCP call fails `capability_closed`
  (Go `TestSubmitResultTerminalCloses`, A01 `AuthoritySource` on
  `ResultTerminal`).
- In both outcomes the live checkout lock and its cloud lease row are
  untouched: result commands never read or write `checkout_leases`, so the
  lock survives until verified process end or explicit local recovery.
- A journaled agent submission replayed after the race resolves terminally
  (`result_terminal` when accept won) and is never applied twice (Go
  `TestSubmitResultReplayMatrix`, idempotent transport dedupe).

## What this trace does not claim

- It does not fix which side wins: hub FIFO order decides, and both orders
  are correct.
- It contains no terminal output, secrets, or local paths: all identities
  are synthetic ULIDs minted inside the harness run.
