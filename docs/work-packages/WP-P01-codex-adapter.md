# WP-P01 — Codex adapter

Status: `planned`

Risk: High

## Outcome

Codex satisfies the frozen provider lifecycle using documented stable CLI, hook, and stdio MCP surfaces while preserving interactive/headless provenance.

## Dependencies

- **Requires:** A01, A03, E01, L03, L05, L06, L07.
- **Unlocks:** G01, X02.
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

## Evidence and handoff

- Commit supported-version matrix, captured raw-to-candidate hook/JSONL fixtures, configuration CAS/rollback diff tests, and parity report against Claude.
- Any shared-contract problem becomes a separate amendment, not a Codex-specific shortcut.

## Risks and decisions

- Interactive hooks and headless JSONL are distinct evidence streams; normalization must not erase that distinction.
