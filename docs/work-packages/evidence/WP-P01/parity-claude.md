# P01 parity report against the Claude reference contract (preliminary)

L07 is still `planned`, so no live Claude adapter exists to compare against.
This report maps each L07 scope line to the P01 shape so the later live
parity run has a fixed checklist. Nothing here claims live cross-provider
behavior.

| L07 scope | P01 shape | Status |
| --- | --- | --- |
| Probe and capability manifest for the tested version range | `codex.Descriptor` with tested `0.153.4`, 19 capabilities, tested model | Contract match, live parity pending |
| Interactive launch in the exact checkout | `codex --cd` plans with sandbox/approval/model/effort mapping | Contract match, supervised launch pending (L05) |
| Supported headless behavior with provenance | `exec --json` plans plus JSONL normalization with provider-reported usage | Contract match, ledger integration pending (E01) |
| Resume of the observed session | Exact-ID `resume` plans, no `--last`/picker/fallback | Contract match, live session proof pending (L05) |
| Interrupt and terminate | Semantic `interrupt`/`terminate` controls, L05 owns signaling | Contract match |
| Hook normalization into bounded candidates | 11 documented hook events mapped, paths and peer text dropped | Contract match, journal correlation pending (L06) |
| Setup/doctor through the approved transaction | hooks.json and config.toml editors with CAS, atomic write, post-doctor, rollback | Proven at the transaction level |
| Integration hash and drift handling | `IntegrationID`, config fingerprinting, `Revalidate` tests | Proven at the plan level, live exec binding pending (L05) |
| Unknown-version and concurrent-edit behavior | `unknown_version` fails tracked plans; concurrent edits abort setup | Proven |
| Duplicate-hook diagnostics | Duplicate payloads normalize identically; concurrent hooks all run per Codex docs | Parser-level proof; daemon sequencing pending (L06) |
| Stop/process exit never submits a result | No result-capable candidate kind exists | Proven structurally |
| No Deep-link/app-server control dependency | Argv-wide exclusion test | Proven |

Divergences owned by Codex, not gaps in parity:

- Approval flags differ by surface (`--ask-for-approval` on the TUI,
  `-c approval_policy` on exec); `approval.always` has no Codex counterpart
  and fails closed.
- `exec resume`/`fork` accept no `--cd`/`--sandbox`, so resumed headless
  turns inherit the bound session's working root.
- No predetermined-session flag exists on the TUI, so
  `session.requested_id` is withheld.
- Codex hook trust is hash-based with review; BFB never uses the bypass
  flag and doctor fails closed on drift instead.
