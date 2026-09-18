# WP-P01 — Codex adapter

Status: `planned`

Risk: High

Test target: `pnpm test:p01`

Evidence manifest: `docs/work-packages/evidence/WP-P01/manifest.json`

## Outcome

Codex satisfies the frozen provider lifecycle using documented stable CLI, hook, and stdio MCP surfaces while preserving interactive/headless provenance.

## Dependencies

- **Requires:** A01, A03, E01, L03, L05, L06, L07.
- **Unlocks:** D02, G01, X02.
- **Can run with:** P02; each owns only its provider-local descriptor/directory/manifest/setup/parser/fixtures and never edits a shared registry.

## Scope

- Capture a supported Codex version range on macOS and implement probe/capability manifest.
- Launch interactive Codex with stable `--cd` in the already verified working directory.
- Parse raw Codex hooks/JSONL into bounded L03 semantic candidates; L06 owns correlation validation and event envelopes.
- Install BFB user-level hooks and `bfb mcp stdio` through L03's previewed, explicitly approved, hash-CAS, atomic-write, post-doctor, and rollback transaction while semantically preserving unrelated Codex configuration.
- Register Codex through its provider-local descriptor without changing a shared provider registry.
- Bind documented `SessionStart` session ID and add only constant BFB bootstrap context.
- Model context injection separately from a safe initial-turn transport; use `waiting_user_submit` when needed.
- Implement resume, interrupt, terminate, lifecycle normalization, setup/doctor, integration hash, and drift handling.
- Normalize `codex exec --json` JSONL events/usage for retained headless behavior with provider provenance.
- Explicitly exclude experimental app-server WebSockets and app deep links from the control protocol.

## Non-goals

- Treating Codex headless events as human approval, inventing missing token counts, simulated keystrokes, or changing the shared adapter contract inside this package.

## Contracts

### Consumes

- L03 provider kit: probe/plan/resume/turn/normalize interfaces, packaged-manifest/runtime/policy capability intersection, approved setup/doctor transaction, and immediate pre-exec revalidation. L03 is done; this package changes none of its files.
- L05 launch plans as the consumer of `PlanLaunch`/`PlanResume` through the compiled registry; L05 remains blocked, so live supervision proof waits on it.
- F02 canonical typed execution configuration and diagnostic categories.
- ADR 0002 read-only discussion boundaries for headless turn planning.
- Documented Codex `0.153.4` CLI, hooks, and non-interactive JSONL surfaces, verified by bounded offline probes against the installed binary in a temporary home.

### Produces

- Provider-local Codex descriptor, tested-version manifest, adapter, hook/exec parsers, hooks.json and config.toml setup editors, and doctor checks in `internal/providers/codex`, consumable through the frozen L03 registry without shared-contract changes.
- `pnpm test:p01` and the declared redacted evidence manifest with the supported-version matrix and raw-to-candidate fixtures.

## Work plan

1. Capture real CLI/hook/MCP/JSONL fixtures for the supported version.
2. Implement provider-local registration, probe/manifest, transactional setup/doctor, and exact-checkout launch.
3. Implement session binding, normalization, resume/interrupt, and headless provenance.
4. Run common provider, integration drift, unknown-version, and no-false-result suites.

## Acceptance

- Exact-checkout interactive launch, observed session binding, MCP context, resume, and interrupt pass the common suite.
- `SessionStart` additional context does not falsely mark a turn started.
- Headless JSONL usage retains `provider_reported` provenance and does not imply acceptance.
- Unknown version/integration drift fails or degrades exactly by policy.
- A concurrent provider-config edit aborts setup, doctor failure restores the previous valid configuration, and a binary/version/integration swap before `exec` is blocked by L05.
- Stop, turn completion, session end, and process exit never submit a result.
- No adapter behavior depends on experimental app-server WebSockets.

## Evidence

- `docs/work-packages/evidence/WP-P01/manifest.json`: schema-conformant manifest with the tested commit, toolchains, commands, and redaction status.
- `docs/work-packages/evidence/WP-P01/version-matrix.json`: supported-version matrix for Codex `0.153.4` with per-capability evidence sources.
- `docs/work-packages/evidence/WP-P01/hook-fixtures.json`: raw hook payload to semantic-candidate fixtures (synthetic identities).
- `docs/work-packages/evidence/WP-P01/exec-fixtures.json`: `exec --json` JSONL to turn-event/usage fixtures (synthetic identities).
- `docs/work-packages/evidence/WP-P01/setup-transaction.md`: configuration CAS/rollback assertions.
- `docs/work-packages/evidence/WP-P01/parity-claude.md`: preliminary parity report against the L07 contract.
- `docs/work-packages/evidence/WP-P01/discovery.md`: bounded redacted CLI/hook/config probes behind the argv shapes.

## Risks and decisions

- Interactive hooks and headless JSONL are distinct evidence streams; normalization must not erase that distinction.

## Handoff

State: adapter, parsers, setup editors, and doctor are implemented in `internal/providers/codex` with `pnpm test:p01` passing from a clean checkout; status stays `planned` because L07 is `review` (live Claude chain pending credentials and consent). A01, A03, E01, L05, and L06 are `done` since 18 September.

Proven now (each by an automated test in `internal/providers/codex` plus committed fixtures):

- Exact-checkout interactive launch plans (`--cd`, sandbox, `--ask-for-approval`, model, effort, constant prompt only for `provider_prompt`) and `waiting_user_submit` without a prompt.
- `SessionStart` startup/resume binds the documented session ID; the bootstrap context is the constant instruction and never opens a turn; compact/clear bind nothing.
- Headless `exec --json` plans and JSONL normalization; usage candidates come only from a provider `usage` object (provider-reported by construction, never estimated); absent usage stays absent.
- Unknown versions probe as `unknown_version` and fail tracked plans; config drift fails revalidation; `approval.always` and predetermined session IDs fail closed through capability denial (0.153.4 has neither surface).
- Concurrent config edits abort setup with `provider_setup_conflict`; failed doctor restores exact prior bytes, mode, or absence; binary/config/integration swaps fail `Revalidate`.
- Stop, turn completion, session end, and process exit map only to telemetry kinds; no candidate kind can submit or accept a result.
- No argv, hook, or doctor path uses app-server WebSockets, deep links, `--last`, picker flows, or hook-trust/approval bypass flags.

Explicitly pending (A01, A03, E01, L05, and L06 are `done`; live proofs still need provider credentials and consent):

- A01: live `bfb mcp stdio` context loading through the registered server (registration shape is written and doctor-verified; no live context load is claimed).
- E01/L06: ledger envelopes, correlation validation, duplicate suppression, and upload of normalized candidates (candidates are bounded and correlation-free by design).
- A03: explicit result submission (out of scope for telemetry kinds).
- L05: live supervised launch, pre-exec revalidation at spawn, signaling, and containment using these plans.
- L07: shared live common suite and Claude reference parity (preliminary contract-level parity only).
- The end-to-end checkpoint needing the local MCP, the event ledger, and result submission stays pending.

Shared amendment (one file outside P01 ownership): `internal/provider/kit_test.go` in its own commit. L03's freeze guard forbade every real descriptor from granting capabilities until its package certifies it; P01 is that certification for Codex, so the guard now recognizes `codex` as certified while still requiring a verified manifest from it and discovery-only silence from every other real descriptor. No L03 production file, interface, or behavior changed.

Limitations: live model runs were not repeated here; the L03 `0.153.4` experiment plus bounded offline probes (version, approval values, resume/fork rejection, doctor checks, MCP TOML round-trip) ground the argv and parsing shapes. Medium/high reasoning effort pass through unvalidated by the binary at config load; an invalid value fails visibly at runtime. Resumed headless turns inherit the bound session's working root because `exec resume/fork` accept no `--cd`/`--sandbox`; BFB resumes only sessions it launched in the same verified checkout. `codex mcp get` output is trusted only for the registered command/args equality check, never copied into the ledger.
