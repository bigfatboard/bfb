# WP-L07 — Claude Code reference adapter

Status: `planned`

Risk: High

Test target: `pnpm test:l07`

Evidence manifest: `docs/work-packages/evidence/WP-L07/manifest.json`

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

## Contracts

### Consumes

- L03 provider kit (`done` at `32f1354`): immutable probes/plans, capability
  ceilings, exact-session `PlanResume`, semantic interrupt/terminate, bounded
  hook candidates, and the setup proposal/approval/hash-CAS/atomic/rollback
  transaction. The shared L03 contract is frozen and unchanged by this package.
- L05 local execution supervision contract (implementation `blocked`): the
  `LaunchPlan` and exact-session resume-plan shape the supervisor consumes,
  including pre-exec identity revalidation and the owned-process-group signal
  path behind adapter controls.
- L06 hook-journal boundary (`planned`): the parser returns only bounded
  semantic candidates with content-derived duplicate identities; correlation
  validation, envelopes, sequencing, and persistence stay with L06.
- F02 local-RPC diagnostics: the existing failure-code table and the
  `log_entries` payload shape; no shared schema or registry change.

### Produces

- Claude provider-local descriptor, capability manifest `1.0.0` with tested
  version `2.1.274`, and adapter (interactive launch, exact-session resume,
  interrupt/terminate, raw-hook parser, setup/doctor editors and CLI).
- `provider setup claude` / `provider doctor claude` transaction shape with
  combined proposal approval, drift/duplicate/unknown-version diagnostics, and
  an honestly unverified local-MCP startup check pending A01.
- Raw-to-candidate fixtures (captured and schema-derived) and the
  supported-version matrix consumed by G01/P01/P02/X02.
- Stable `pnpm test:l07` target and evidence-manifest path for checkpoint
  automation. P01 mirrors this package shape without touching shared contracts.

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

## Evidence

- `docs/work-packages/evidence/WP-L07/manifest.json` indexes the tested commit,
  toolchain, commands, and redaction status for this package.
- `docs/work-packages/evidence/WP-L07/version-matrix.json` records the
  supported-version matrix and per-version capability ceilings.
- `docs/work-packages/evidence/WP-L07/capture-report.md` records the bounded
  real-CLI experiments (isolated home, temporary directory) with scrubbed
  payload shapes.
- `internal/providers/claude/testdata/hook-*.json` holds the raw-to-candidate
  fixtures; `docs/work-packages/evidence/WP-L07/command-result.json` summarizes
  the gate outcomes.

## Risks and decisions

- CLI flags, trust behavior, and hook payloads are external contracts; keep real-version fixtures and fail closed on drift.
- Only `2.1.274` is certified. Any auto-updated version probes as
  `unknown_version` with no tracked capabilities until its fixtures pass.
- Headless launch, discussion turns, fork, read-only tool boundaries, and MCP
  stdio stay uncertified until A01/E01 prove the local server and ledger;
  configs requiring them fail closed at plan time.
- Only `approval.on_request` with `filesystem.workspace_write` is certified;
  broader approval mappings are unverified on this version and fail closed.
- Setup applies two sequential per-file L03 transactions (hooks, then MCP
  server). A partial apply is diagnosable via doctor and repairable by
  re-running setup; cross-file atomicity is a documented limitation.
- Rewritten files are canonicalized JSON; unowned semantics are preserved and
  proven, and already-current files are never rewritten.

## Handoff

- State: adapter, parser, setup/doctor CLI, fixtures, and evidence exist on
  this branch; `Status` stays `planned` because A01, E01, L05, and L06 are not
  `done`, so `pnpm roadmap:check` rejects anything beyond `planned`.
- Acceptance 3 (unknown version blocks tracked mode): proven. Any version
  other than `2.1.274` probes as `unknown_version` with no tracked
  capabilities; plan and doctor fail closed.
- Acceptance 4 (setup preservation, approved diff, concurrent-edit abort,
  rollback, byte-identical untouched files): proven through the L03
  transaction for both user-level files, including idempotent no-op runs.
- Acceptance 5 (replaced binary/config detected before `exec`): proven at
  the adapter layer (probe identity, `Revalidate`, integration-hash drift);
  L05's pre-exec consumption of that revalidation waits on L05.
- Acceptance 6 (duplicate hooks diagnosed, concurrent deliveries safe):
  proven. Identical deliveries share one content-derived suppression
  identity; duplicates, drift, and concurrent edits are diagnosed; the
  transaction never overwrites a concurrent edit.
- Acceptance 7 (Stop, failed tool, terminal close, process exit never
  submit/accept a result): proven. `Stop` maps to turn telemetry,
  `PostToolUseFailure` to failed/interrupted telemetry, `SessionEnd` to
  session end; the candidate type carries no result-submission field, and
  headless exit paths stay uncertified.
- Acceptance 1 (card → exact checkout → Claude opens → trusted `SessionStart`
  binds → MCP context loads → semantic events commit): pending. Adapter
  plans, hook parsing, and the `SessionStart` binding check are proven, but
  the live chain waits on L05 (launch/supervision), L06 (journal/binding),
  E01 (ingest), and A01 (MCP context).
- Acceptance 2 (resume attaches the observed session to the same unfinished
  run): pending. Exact-session resume plans and UUID binding are proven;
  the resumed execution, source-absence proof, and durable binding wait on
  L05 and L06.
- Commands: `pnpm test:l07`, `bfb provider setup claude`, `bfb provider doctor
  claude`. Doctor reports `mcp_startup_unverified` until A01 lands.
- Known limitations: rewritten config files are canonicalized (semantics
  preserved, formatting not byte-identical); settings files with comments or
  other non-strict JSON are refused; the hook launcher path is recorded, not
  hash-pinned; `--resume` and `--session-id` require UUID shape.
