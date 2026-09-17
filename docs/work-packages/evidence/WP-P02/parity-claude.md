# P02 parity report against the Claude reference contract (preliminary)

L07 is still `planned`, so no live Claude adapter exists to compare against.
This report maps each L07 scope line to the P02 shape so the later live
parity run has a fixed checklist. Nothing here claims live cross-provider
behavior.

| L07 scope | P02 shape | Status |
| --- | --- | --- |
| Probe and capability manifest for the tested version range | `grok.Descriptor` with tested `1.0.34`, 12 capabilities, tested model `grok-4.6` | Contract match, live parity pending |
| Interactive launch in the exact checkout | `grok --cwd` plans with sandbox/approval/model/effort mapping, always `waiting_user_submit` | Contract match, supervised launch pending (L05) |
| Supported headless behavior with provenance | Withheld: headless JSON shapes need a live model call; usage stays `unavailable` | Honest degradation, blocked by design |
| Resume of the observed session | Exact-UUID `--resume` plans, no `--continue`/titles/forks/fallback | Contract match, live session proof pending (L05) |
| Interrupt and terminate | Semantic `interrupt`/`terminate` controls, L05 owns signaling | Contract match |
| Hook normalization into bounded candidates | 8 documented hook events mapped, paths and tool payloads dropped | Contract match, journal correlation pending (L06) |
| Setup/doctor through the approved transaction | hooks/bfb.json and config.toml editors with CAS, atomic write, post-doctor, rollback | Proven at the transaction level |
| Integration hash and drift handling | `IntegrationID`, config fingerprinting, `Revalidate` tests | Proven at the plan level, live exec binding pending (L05) |
| Unknown-version and concurrent-edit behavior | `unknown_version` fails tracked plans; concurrent edits abort setup | Proven |
| Duplicate-hook diagnostics | Duplicate payloads normalize identically; parser drops nothing silently except documented silent events | Parser-level proof; daemon sequencing pending (L06) |
| Stop/process exit never submits a result | No result-capable candidate kind exists | Proven structurally |
| No bypass/trust control dependency | Argv-wide exclusion test (no bypass, trust, worktree, or agent flags) | Proven |

Divergences owned by Grok, not gaps in parity:

- Interactive launches carry no initial prompt: positional-prompt
  auto-submit is unverified, so every plan starts `waiting_user_submit`
  and the human submits visibly.
- `SessionStart` documents no additional-context output, so context
  injection stays withheld and fails closed.
- Requested session IDs use `--session-id` for new UUIDs only; titles and
  most-recent resume are rejected by the adapter's UUID gate.
- Approval maps to `--always-approve` (never) and default Ask
  (on_request); `approval.always` has no counterpart and fails closed.
- Filesystem maps to `--sandbox read-only`/`workspace`; unknown profiles
  refuse to start, which the adapter relies on rather than re-checks.
- BFB owns its hooks file outright instead of merging into a shared one;
  foreign content inside it is a conflict.
- `grok usage` exists as a manual diagnostic but is not an event source;
  token usage stays `unavailable`, never estimated.
