# WP-P02 — Grok adapter

Status: `planned`

Risk: High

Test target: `pnpm test:p02`

Evidence manifest: `docs/work-packages/evidence/WP-P02/manifest.json`

## Outcome

Grok implements only capabilities proven by its supported CLI version and exposes explicit waiting/degraded/blocked states wherever trustworthy parity is unavailable.

## Dependencies

- **Requires:** A01, A03, E01, L03, L05, L06, L07.
- **Unlocks:** G01, X02.
- **Can run with:** P01; each owns only its provider-local descriptor/directory/manifest/setup/parser/fixtures and never edits a shared registry.

## Scope

- Run bounded discovery against the selected Grok CLI version before advertising tracked interactive support.
- Capture working-directory, hooks/session correlation, initial prompt, headless scripting, resume, interrupt, termination, and usage capabilities.
- Implement provider-local registration, probe/manifest, exact-checkout launch, and the supported raw-event-to-semantic-candidate parser/fixture suite; L06 owns correlation validation and event envelopes.
- Perform setup/doctor through L03's previewed, explicitly approved, hash-CAS, atomic-write, post-doctor, and rollback transaction while semantically preserving unrelated Grok configuration.
- Use `waiting_user_submit` when no safe initial-turn transport exists.
- Use explicit degraded/untracked or blocked state when trusted session correlation is unavailable.
- Preserve interactive/headless and provider/runner-reported provenance.
- Test provider containment and project policy allow/deny behavior.

## Non-goals

- Forced parity, terminal scraping, simulated keystrokes, guessed session IDs, or precise token telemetry without a documented/tested source.

## Contracts

### Consumes

- L03 provider kit: probe/plan/resume/turn/normalize interfaces, packaged-manifest/runtime/policy capability intersection, approved setup/doctor transaction, and immediate pre-exec revalidation. L03 is done; this package changes none of its files.
- L05 launch plans as the consumer of `PlanLaunch`/`PlanResume` through the compiled registry; L05 remains blocked, so live supervision proof waits on it.
- F02 canonical typed execution configuration and diagnostic categories.
- ADR 0002 read-only discussion boundaries for headless turn planning.
- Documented Grok `1.0.34` CLI, hooks, sandbox, MCP, and session surfaces, verified by bounded offline probes against the installed binary in a temporary home.

### Produces

- Provider-local Grok descriptor, tested-version manifest, adapter, hook parser, hooks-file and config.toml setup editors, and doctor checks in `internal/providers/grok`, consumable through the frozen L03 registry without shared-contract changes.
- `pnpm test:p02` and the declared redacted evidence manifest with the supported-version matrix and raw-to-candidate fixtures.

## Work plan

1. Capture real CLI/hook/MCP fixtures for the supported version.
2. Implement provider-local registration, probe/manifest, transactional setup/doctor, and exact-checkout launch.
3. Implement session binding, normalization, resume/interrupt, and headless provenance.
4. Run common provider, integration drift, unknown-version, and no-false-result suites.

## Acceptance

- Every advertised capability has a real captured fixture.
- Missing trusted correlation cannot leave a run silently launching; it becomes explicit degraded or blocked state.
- Exact-checkout/process-containment gates pass.
- Waiting for human first submit is displayed honestly when required.
- Missing usage stores `unavailable`, never invented precision.
- A concurrent provider-config edit aborts setup, doctor failure restores the previous valid configuration, and a binary/version/integration swap before `exec` is blocked by L05.
- Stop/process exit never submits a result.

## Evidence

- `docs/work-packages/evidence/WP-P02/manifest.json`: schema-conformant manifest with the tested commit, toolchains, commands, and redaction status.
- `docs/work-packages/evidence/WP-P02/version-matrix.json`: supported-version matrix for Grok `1.0.34` with per-capability evidence sources.
- `docs/work-packages/evidence/WP-P02/hook-fixtures.json`: raw hook payload to semantic-candidate fixtures (synthetic identities).
- `docs/work-packages/evidence/WP-P02/setup-transaction.md`: configuration CAS/rollback assertions.
- `docs/work-packages/evidence/WP-P02/parity-claude.md`: preliminary parity report against the L07 contract.
- `docs/work-packages/evidence/WP-P02/discovery.md`: bounded redacted CLI/hook/config probes behind the argv shapes.

## Risks and decisions

- Full tracked interactivity may be impossible with the current CLI. That is a product limitation, not justification for an unsafe workaround.
- Live model runs were never attempted in this package: no prompt was sent and no session was opened. Fresh/resume identity evidence is documentation plus parser/setup proof; live hook firing and session binding await the L05 supervised-launch checkpoint.

## Handoff

State: adapter, parser, setup editors, and doctor are implemented in `internal/providers/grok` with `pnpm test:p02` passing from a clean checkout; status stays `planned` because L07 is `review` (live Claude chain pending credentials and consent). A01, A03, E01, L05, and L06 are `done` since 18 September.

Proven now (each by an automated test in `internal/providers/grok` plus committed fixtures):

- Exact-checkout interactive launch plans (`--cwd`, `--sandbox`, `--always-approve` for `never`, default Ask for `on_request`, model, effort) and `waiting_user_submit` without a prompt; `provider_prompt`, `none`, headless, and `approval.always` fail closed.
- `SessionStart` binds the documented session ID; unknown event names stay silent while known events with drifted identities fail closed; paths and tool payloads never cross into candidates.
- Requested session IDs bind `--session-id` for new UUIDs only; titles, `--continue`, and non-UUID values fail closed.
- Exact-UUID `--resume` plans with no convenience target or fork; malformed and title bindings fail closed through kit and adapter gates.
- Unknown versions probe as `unknown_version` and fail tracked plans; config drift fails revalidation; withheld headless/discussion/fork capabilities deny plans by policy.
- Concurrent config edits abort setup with `provider_setup_conflict`; failed doctor restores exact prior bytes, mode, or absence; binary/config/integration swaps fail `Revalidate`.
- Stop, turn failure, session end, and process exit map only to telemetry kinds; no candidate kind can submit or accept a result; usage stays `unavailable`, never estimated.
- No argv, hook, or doctor path uses bypass/trust/worktree/agent/allow/deny flags, titles, most-recent resume, or fork flows.

Explicitly pending (A01, A03, E01, L05, and L06 are `done`; live proofs still need provider credentials and consent):

- A01: live `bfb mcp stdio` context loading through the registered server (registration shape is written and doctor-verified; no live context load is claimed).
- E01/L06: ledger envelopes, correlation validation, duplicate suppression, and upload of normalized candidates (candidates are bounded and correlation-free by design; live hook firing is unverified).
- A03: explicit result submission (out of scope for telemetry kinds).
- L05: live supervised launch, pre-exec revalidation at spawn, signaling, and containment using these plans; positive session binding and hook-fire proof.
- L06/L07: shared live common suite and Claude reference parity (preliminary contract-level parity only); L07 recertification may re-time the parity run.
- The end-to-end checkpoint needing the local MCP, the event ledger, and result submission stays pending.

Shared amendment (one file outside P02 ownership): `internal/provider/kit_test.go` in its own commit. L03's freeze guard forbade every real descriptor from granting capabilities until its package certifies it; P02 is that certification for Grok, so the guard now recognizes `grok` as certified while still requiring a verified manifest from it and discovery-only silence from every other uncertified real descriptor. No L03 production file, interface, or behavior changed.

Limitations: live model runs were never attempted here; bounded offline probes (version banners, `--cwd` reflection, sandbox rejection, resume/session validation order, MCP TOML round-trip, hook discovery via `inspect`) ground the argv and parsing shapes. Reasoning effort passes through unvalidated by the binary at plan time; an invalid value fails visibly at runtime. The `--version` channel suffix is absent under a bare temporary home; both banner shapes parse for the tested version only. The setup caller creates the BFB-owned hooks directory before proposing, mirroring the Claude setup command.
