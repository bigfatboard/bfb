# WP-F01 — Repository foundation

Status: `in_progress`

Risk: Medium

Test target: `pnpm verify`

Evidence manifest: `docs/work-packages/evidence/WP-F01/manifest.json`

## Outcome

A clean checkout has one documented command surface for building, formatting, testing, and validating every language in the BFB monorepo.

## Dependencies

- **Requires:** none.
- **Unlocks:** F02, F03, L01.
- **Can run with:** nothing; this establishes shared repository ownership.

## Scope

- Create the architecture’s TypeScript, Go, Swift, protocol, migration, and documentation directories without placeholder product implementations.
- Use a pinned `pnpm` workspace for TypeScript, a Go module for `bfb`, and an Xcode project for the menu-bar app.
- Define strict TypeScript, formatting/linting, unit-test, Go formatting/vet/test, Swift build/test, and documentation-link commands.
- Add CI for Linux-compatible checks plus a macOS job for Go process tests and Swift.
- Add AGPL-3.0 licensing and direct contribution/security instructions.
- Enforce the repository’s two-line `ABOUTME:` header rule for code files.
- Define version pinning and dependency-update policy; lockfiles are committed.
- Add a work-package metadata validator/generator that checks unique IDs, existing relative links, `Requires`/`Unlocks` symmetry, missing dependencies, cycles, and README index/dependency-graph drift for every package. For packages at `ready` or later, also require non-empty consumed/produced contracts and stable test/evidence paths.

## Non-goals

- Worker routes, database tables, UI components, daemon behavior, or provider integrations.
- A task runner or build framework beyond what the root commands actually need.
- Production deployment or release signing.

## Contracts

### Consumes

- The repository layout, technology decisions, and code-header rule in `ARCHITECTURE.md` and the workspace instructions.

### Produces

- Pinned TypeScript/Go/Swift toolchains, stable root bootstrap/verification commands, directory ownership, and CI entry points.
- Deterministic work-package metadata validation/generation plus the stable test/evidence-path convention used by every later package.

## Work plan

1. Scaffold the minimum repository and toolchain files; verify every empty target builds.
2. Add root commands and CI with identical local behavior.
3. Add license, contribution rules, code-header enforcement, dependency drift checks, and deterministic work-package index/graph validation.
4. Re-clone into a temporary clean directory and run the complete command set.

## Acceptance

- One documented bootstrap command installs dependencies without unpinned package resolution.
- One root verification command runs every applicable check and fails on generated or formatting drift.
- Linux CI builds web/Worker/Go-compatible targets; macOS CI builds Swift and runs process tests.
- A code file without its two `ABOUTME:` lines fails validation.
- A clean checkout contains no required machine-local configuration or secret.
- Duplicate/missing package IDs, broken links, asymmetric dependencies, dependency cycles, or README graph/index drift fail the root verification command; a package cannot enter `ready` with missing consumed/produced contracts or placeholder test/evidence paths; generated roadmap output is deterministic.

## Evidence and handoff

- Commit the clean-checkout CI run, tool versions, command matrix, roadmap validation fixture/report, and an empty-project build log.
- F02 and F03 receive stable directory ownership and root commands; they do not replace the toolchain.

## Risks and decisions

- Keep root tooling deliberately small. If a proposed orchestrator only wraps three commands, do not add it.
- Swift signing is not required for this package; unsigned CI builds must remain possible.
