# WP-L07 — Claude Code reference adapter

Status: `planned`

Risk: High

## Outcome

A card can open a supported Claude Code version in the exact checkout, bind the observed session through trusted hooks, load scoped context through the real local MCP, report semantic events, and end without falsely submitting a result.

## Dependencies

- **Requires:** A01, E01, L03, L05, L06.
- **Unlocks:** G01, P01, P02, X02.
- **Can run with:** W01/E02 if shared contracts are frozen.

## Scope

- Implement probe, capability manifest, interactive launch, supported headless behavior if retained, resume, interrupt, terminate, and hook normalization.
- Use documented Claude Code CLI/hooks for a selected tested version range.
- Parse Claude raw hook payloads only into the bounded L03 semantic candidate; L06 owns correlation validation and envelope creation.
- Install/update only BFB’s user-level hook/MCP configuration through L03's previewed, explicitly approved, hash-CAS, atomic-write, post-doctor, and rollback transaction.
- Use a stable app-owned hook launcher path; never rewrite project instructions or bypass hook trust.
- Bind requested vs observed provider session through `SessionStart` correlation.
- Use a constant safe initial BFB instruction where supported; otherwise expose `waiting_user_submit`.
- Register through Claude's provider-local descriptor without editing a shared provider registry.
- Implement `provider setup/doctor claude`, integration hash, drift, unknown-version, concurrent-config-edit, rollback, and duplicate-hook diagnostics.
- Capture start/turn/tool/error/Stop/resume/interrupt/session-end fixtures.

## Non-goals

- Claude deep links as authoritative launch, simulated keystrokes, terminal scraping, or Stop/process exit as completion.

## Work plan

1. Capture real supported-version CLI/hook behavior and containment fixture.
2. Implement probe/manifest/setup/doctor with semantic preservation, approved diff, concurrent-edit detection, and rollback.
3. Implement launch/session binding/normalization/resume/interrupt.
4. Run the real-Claude integration checkpoint and unknown/drift/duplicate tests after the provider-neutral fake launch checkpoint is green.

## Acceptance

- Web/fixture Start → exact checkout → Claude opens → trusted `SessionStart` binds → MCP context loads → semantic events commit.
- Resume attaches the observed session to the same unfinished run.
- Unknown/auto-updated version blocks tracked mode or requires explicit degraded policy.
- Setup semantically preserves every non-BFB Claude entry, produces no unapproved diff, aborts on a concurrent edit, and restores the previous valid configuration if doctor fails. Files/sections not rewritten remain byte-identical.
- Replacing the probed Claude executable/version or integration configuration before `exec` is detected by L05 and blocks tracked launch.
- Duplicate hooks are diagnosed and concurrent deliveries remain safe.
- Stop, failed tool, terminal close, and process exit never submit/accept a result.

## Evidence and handoff

- Commit supported-version matrix, captured raw-to-candidate fixtures, setup/CAS/rollback diff tests, and end-to-end trace.
- P01/P02 may not mutate the shared adapter contract implicitly.

## Risks and decisions

- CLI flags, trust behavior, and hook payloads are external contracts; keep real-version fixtures and fail closed on drift.
