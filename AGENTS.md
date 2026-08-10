# BFB agent instructions

These instructions extend the workspace-wide rules for every file in this repository.

## Work-package discipline

- Read `ARCHITECTURE.md`, `docs/work-packages/README.md`, `docs/work-packages/ACCEPTANCE.md`, and the complete active work package before editing.
- Implement one package at a time. A later package may consume only a dependency marked `done`.
- Package files are the source of truth for status, risk, dependencies, and title. The marked roadmap graph and index are generated with `pnpm roadmap:write`.
- A package is `done` only after its exact test target passes from a clean checkout and its evidence manifest is committed.
- Architecture invariant changes require an ADR in `docs/adr` before implementation.

## Repository gates

- Run `pnpm verify` before handoff. Do not skip the platform-specific checks it selects.
- Every hand-written code file starts with two lines in the language's comment syntax whose text begins `ABOUTME: `.
- Generated files and protocol fixtures must be deterministic and have an owning command documented next to their contract.
- Pin dependency and tool versions exactly. Update the lockfile in the same commit as a dependency change.
- Keep evidence bounded and redacted. Never commit secrets, private task content, raw terminal output, or local absolute paths.

## Architecture boundaries

- D1 is canonical persistence. Workspace mutations serialize through `WorkspaceHub`.
- Web, runner, CLI, and MCP transports share domain commands; none owns parallel business logic.
- Hooks report telemetry. Explicit commands create business state.
- A task, run, provider session, execution, and attention request are distinct records.
- Never infer completion, human attention, agent activity, time, or token usage from transport presence or prose.
- Cloudflare coordinates and enrolled Macs execute. Never send arbitrary shell commands or local provider credentials through the control plane.
