# WP-D02 read-only and escalation negatives

## Read-only enforcement

- Fresh fake turns pin `read_only` sandbox approval `never` with the working
  directory fixed to the verified checkout; stdin carries the fixed read-only
  instruction (TestFakeTurnPlansReadOnly).
- Continuations resume the exact owned observed session and nothing else.
- A `workspace_write` config fails closed in the kit with
  `provider_discussion_unsafe` (TestWritableConfigFailsClosed).
- The real Codex 0.153.4 binary plans `exec --sandbox read-only ...
  --json` for fresh turns and `exec resume <exact-session>` for
  continuations, with no writable or always-prompt flag
  (TestCodexRealBinaryPlansReadOnlyTurn).
- Headless Claude turns fail closed on the installed Claude: the adapter
  certifies no headless turn transport (TestClaudeTurnFailsClosed).
- A full two-turn discussion leaves its checkout canary byte-identical, adds
  no files, and never places `git` in provider argv
  (TestCheckoutUntouchedByFullDiscussion).

## Peer-content escalation negatives

Eight hostile peer payloads (permission grants, tool-call JSON, shell
commands, third-participant mentions, round extension, `[DONE]`/`[DECISION]`
markers, instruction overrides) were planned against:

- Planned argv, working directory, and environment are byte-identical to the
  benign plan; no peer byte reaches argv or environment
  (TestHostilePeerCannotAlterPlan).
- Outputs carrying unknown fields (third participant, extra rounds, grants),
  references outside the frozen source set, human-only context IDs, or
  escaping file paths fail validation; attributed disagreement passes
  (TestHostilePeerCannotBecomeOutput).
- Ordinal 7, slot 2, and peer-selected capabilities are rejected by the
  scheduler and the frozen config; the unscripted turn still fails on its
  missing session, never on smuggled authority
  (TestPeerCannotExtendSchedulerOrRoster).
