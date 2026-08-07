# WP-P02 — Grok adapter

Status: `planned`

Risk: High

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

## Work plan

1. Capture current documented/runtime behavior and decide the supported capability set.
2. Implement provider-local registration, probe/manifest, transactional setup/doctor, and exact-checkout launch.
3. Implement only supported correlation/lifecycle/headless paths.
4. Run common provider, degradation, containment, policy, and no-false-result suites.

## Acceptance

- Every advertised capability has a real captured fixture.
- Missing trusted correlation cannot leave a run silently launching; it becomes explicit degraded or blocked state.
- Exact-checkout/process-containment gates pass.
- Waiting for human first submit is displayed honestly when required.
- Missing usage stores `unavailable`, never invented precision.
- A concurrent provider-config edit aborts setup, doctor failure restores the previous valid configuration, and a binary/version/integration swap before `exec` is blocked by L05.
- Stop/process exit never submits a result.

## Evidence and handoff

- Commit capability decision, supported-version matrix, raw-to-candidate and configuration CAS/rollback fixtures, degraded-state screenshots, and parity report.
- Product UI consumes capability data, not assumptions based on provider name.

## Risks and decisions

- Full tracked interactivity may be impossible with the current CLI. That is a product limitation, not justification for an unsafe workaround.
