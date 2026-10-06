# WP-L07 — Claude Code reference adapter

Status: `in_progress`

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
- Deliver the approved private-pilot runtime using persistent real Worker/D1/R2
  state and real authentication, with start/stop/health instructions. Test-login
  and disposable fixture servers are not pilot delivery.
- Keep uncertified artifact viewing/review and discussion launch disabled at
  server boundaries and visibly unavailable in the pilot UI. Preserve certified
  context, progress, attention, explicit results and artifact publication.

## Non-goals

- Claude deep links as authoritative launch, simulated keystrokes, terminal scraping, or Stop/process exit as completion.

## Contracts

### Consumes

- L03 provider kit (`done` at `32f1354`): immutable probes/plans, capability
  ceilings, exact-session `PlanResume`, semantic interrupt/terminate, bounded
  hook candidates, and the setup proposal/approval/hash-CAS/atomic/rollback
  transaction. The shared L03 contract is frozen and unchanged by this package.
- L05 local execution supervision contract (`done`): the
  `LaunchPlan` and exact-session resume-plan shape the supervisor consumes,
  including pre-exec identity revalidation and the owned-process-group signal
  path behind adapter controls.
- L06 hook-journal boundary (`done`): the parser returns only bounded
  semantic candidates with content-derived duplicate identities; correlation
  validation, envelopes, sequencing, and persistence stay with L06.
- F02 local-RPC diagnostics: the existing failure-code table and the
  `log_entries` payload shape; no shared schema or registry change.

### Produces

- Claude provider-local descriptor, capability manifest `1.0.0` with tested
  versions `2.1.274` and `2.1.275`, and adapter (interactive launch,
  exact-session resume, interrupt/terminate, raw-hook parser, setup/doctor
  editors and CLI).
- `provider setup claude` / `provider doctor claude` transaction shape with
  combined proposal approval, drift/duplicate/unknown-version diagnostics, and
  an honestly unverified local-MCP startup check: A01 is `done`, but no live
  run-scoped handshake has been exercised, so doctor still reports
  `mcp_startup_unverified`.
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

- [Pilot integration checkpoint](evidence/WP-L07/pilot-integration-checkpoint.json)
  records the passing implementation checks at `d6d854d`, retained failures and
  retries, and the still-unverified real human/provider chain. It does not
  replace the completion manifest or mark this package done.
- [Private pilot guide](../pilot.md) documents the real-auth persistent Worker
  runtime, private configuration, TLS and start/stop/health commands.
  `pnpm test:l07` now includes native MCP/runner/supervisor regression and the
  `pnpm test:pilot` configuration, server-denial and mounted first-run UI checks.
  `pnpm pilot:smoke` checks stock Worker startup and restart persistence with
  isolated synthetic bindings; `pnpm probe:claude-mcp` is a separately invoked,
  bounded live protocol experiment, not a tracked-launch acceptance substitute.
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
- Only `2.1.274` and `2.1.275` are certified. Any other auto-updated
  version probes as `unknown_version` with no tracked capabilities until its
  fixtures pass. The 2.1.275 recapture found no certified-surface change
  from 2.1.274 (identical hook key sets, config locations, and
  setup/doctor behavior); the only observed differences are `--init-only`
  missing from `--help` (the flag still works) and a login hint appended
  to the unauthenticated `-p` stderr.
- Headless launch, discussion turns, fork, read-only tool boundaries, and MCP
  stdio stay uncertified until a live Claude run exercises them (A01/E01 are
  `done`; provider credentials and consent still pending);
  configs requiring them fail closed at plan time.
- Only `approval.on_request` with `filesystem.workspace_write` is certified;
  broader approval mappings are unverified on this version and fail closed.
- Setup applies two sequential per-file L03 transactions (hooks, then MCP
  server). A partial apply is diagnosable via doctor and repairable by
  re-running setup; cross-file atomicity is a documented limitation.
- Rewritten files are canonicalized JSON; unowned semantics are preserved and
  proven, and already-current files are never rewritten.

## Handoff

- Active 6 October: Timo approved the Claude-first private-pilot delivery path.
  A01–A04 and V01 now have connected runtime certificates, and every L07
  dependency is `done`. The unchanged `pnpm test:l07` baseline passes before
  this integration work (1,123 protocol tests and the native race suites).
  Installed Claude `2.1.291` is signed in but remains uncertified. Current
  repairs include provider-aware inventory, helper environment preservation,
  trusted SessionStart bootstrap and actual local-MCP protocol interoperability.
  The bounded isolated `2.1.291` probe passed its real `2025-11-25` MCP handshake
  and seven exec-form hooks without widening the tested-version manifest.
  Stock Worker smoke proves trusted loopback HTTPS, denied unauthenticated
  access, exact bootstrap retry and D1/R2 persistence across restart. Real
  GitHub OAuth configuration, human login and the tracked provider chain remain
  open; the isolated smoke creates no fake human or browser session.
  A passing synthetic certificate does not prove any live acceptance below.
  Bounded BFB-owned live tests are part of the approved pilot; existing provider
  sessions, non-BFB settings, macOS consent and user authority remain protected.
- Dependency hold, 5 October: A01 is reopened for its missing production online/replay path. The adapter implementation and historical fixture acceptance are retained, but the remaining live chain is not only a credentials/consent issue. Close A01 and certify the exact installed provider version before proving live launch and resume. The dated status below is historical, not the current package state.
- Settled 18 September: `review`. A01, E01, L05, and L06 are `done`, and
  `pnpm test:l07` passed from a detached clean checkout at the commit recorded
  in the evidence manifest
  (`6e6cae81989ccb5df2b296a47c0571d6b7a7b266`): frozen install, build, and the
  exact target with the 2.1.274/2.1.275 fixture suites, as recorded in
  `docs/work-packages/evidence/WP-L07/manifest.json` and `command-result.json`.
  Acceptance 3–7 stay proven as recorded below. Acceptance 1 (live chain:
  card Start, Claude opens, trusted `SessionStart` binds, MCP context loads,
  semantic events commit) and Acceptance 2 (resume on the same run) still
  need a live Claude session: provider credentials and consent, which only
  Timo can provide. No live model turn has run; nothing live is claimed.
- Acceptance 3 (unknown version blocks tracked mode): proven. Any version
  other than `2.1.274`/`2.1.275` probes as `unknown_version` with no tracked
  capabilities; plan and doctor fail closed.
- Acceptance 4 (setup preservation, approved diff, concurrent-edit abort,
  rollback, byte-identical untouched files): proven through the L03
  transaction for both user-level files, including idempotent no-op runs.
- Acceptance 5 (replaced binary/config detected before `exec`): proven at
  the adapter layer (probe identity, `Revalidate`, integration-hash drift);
  L05 is `done` and its pre-exec consumption runs in the production daemon
  through its launch installation, which fingerprints the same hook/MCP
  sources.
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
  binds → MCP context loads → semantic events commit): adapter plans, hook
  parsing, and the `SessionStart` binding check are proven; L05
  (launch/supervision), L06 (journal/binding), and E01 (ingest) have historical
  certification. A01's production context path must first be completed, then
  the exact supported provider version must pass the live chain.
- Acceptance 2 (resume attaches the observed session to the same unfinished
  run): exact-session resume plans and UUID binding are proven; L05 and L06
  have historical certification. The assembled canonical session/continuation
  path and a resumed live execution still require proof; fixture identity checks
  do not establish that integration.
- Commands: `pnpm test:l07`, `bfb provider setup claude`, `bfb provider doctor
  claude`. Doctor reports `mcp_startup_unverified` until a live run-scoped
  handshake is exercised after A01 runtime closure and exact-version setup.
- Known limitations: rewritten config files are canonicalized (semantics
  preserved, formatting not byte-identical); settings files with comments or
  other non-strict JSON are refused; the hook launcher path is recorded, not
  hash-pinned; `--resume` and `--session-id` require UUID shape.
