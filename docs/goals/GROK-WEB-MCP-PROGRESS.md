# Grok web + remote MCP execution journal

This file is the resumable execution journal for [the Grok web/MCP goal](GROK-WEB-MCP.md). It is operational state, not acceptance proof. Work-package files own package metadata and status, ADRs own architecture decisions, evidence manifests own acceptance proof, and Git owns commit history. Reconcile this journal when they disagree.

Keep entries terse and use repository-relative paths. Do not record secrets, credentials, private task bodies, raw terminal output, or machine-local absolute paths. Only the lead agent edits this file.

## Resume checkpoint

- Goal state: `not_started`
- Branch: `not_started`
- Last observed HEAD: `not_recorded`
- Last verified commit: `not_recorded`
- Last verification command/result: `not_recorded`
- Active package: F02 — [Wire contracts and test doubles](../work-packages/WP-F02-wire-contracts.md)
- Active gate: `Ready`
- Active task: Initialize and reconcile this journal before editing implementation files.
- Worktree since observed HEAD: `unknown`
- Last verification: Confirm F01 and the baseline clean-checkout result.
- Resume here: Complete the goal's Starting point checks, then replace the initial F02 task plan below with tasks derived from its acceptance criteria.
- Active delegates: `none`
- Blocking condition: `none`
- Updated UTC: `not_recorded`

Allowed goal states are `not_started`, `active`, `blocked`, and `complete`. `blocked` is valid only when a listed stop condition remains after safe in-scope alternatives are exhausted.

`Last observed HEAD` is the commit seen before the current journal edit. `Last verified commit` is the commit to which the recorded verification command and result apply. Neither must equal the commit containing this journal. Never create a follow-up commit solely to record that commit's own SHA.

## Current package tasks

Replace these rows at each package start with bounded tasks derived from that package's acceptance criteria. These are task-level notes and never promote canonical package status.

| ID | Task | Owner | State | Verification or result |
| --- | --- | --- | --- | --- |
| F02-T01 | Reconcile F02 dependencies, contracts, status, and baseline verification | Lead | `todo` | F02 Ready prerequisites and previous checkpoint pass |
| F02-T02 | Write the dependency-aware F02 task and delegation plan | Lead | `todo` | Every task has bounded scope and an executable check |

Allowed states are `todo`, `doing`, `delegated`, `done`, and `blocked`. Keep one primary task `doing`; delegated tasks may run concurrently.

## Delegation log

| ID | Package/task | Worker or workflow | Input HEAD | Scope and path ownership | Expected result/check | State | Result and lead verification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — | — | — |

Allowed states are `dispatched`, `returned`, `integrated`, `rejected`, `failed`, and `cancelled`. A returned result remains advisory until the lead inspects it and runs the relevant verification.

## Verification log

| UTC | Package/task | Commit or worktree | Exact command or check | Outcome | Retained evidence |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — |

Record gating passes and useful failures. Use `uncommitted` for worktree results. Evidence paths are repository-relative; `—` means no retained artifact. This log does not replace a package evidence manifest.

## Blocker and decision log

| ID | First seen UTC | Package/task | Condition and investigation | State | Next action or decision required |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — |

Allowed states are `investigating`, `resolved`, and `decision_required`. A journal blocker does not change canonical package status by itself.

## Package queue and handoffs

| Package | Journal checkpoint | Tested commit | Test target | Evidence manifest | Limitations |
| --- | --- | --- | --- | --- | --- |
| [F02](../work-packages/WP-F02-wire-contracts.md) | Queued | — | Read canonical package | Read canonical package | — |
| [F03](../work-packages/WP-F03-cloud-substrate.md) | Queued | — | Read canonical package | Read canonical package | — |
| [F04](../work-packages/WP-F04-tenant-persistence.md) | Queued | — | Read canonical package | Read canonical package | — |
| [C01](../work-packages/WP-C01-command-kernel.md) | Queued | — | Read canonical package | Read canonical package | — |
| [C02](../work-packages/WP-C02-human-identity.md) | Queued | — | Read canonical package | Read canonical package | — |
| [C03](../work-packages/WP-C03-passkey-step-up.md) | Queued | — | Read canonical package | Read canonical package | — |
| [C04](../work-packages/WP-C04-workspace-authorization.md) | Queued | — | Read canonical package | Read canonical package | — |
| [C07](../work-packages/WP-C07-work-domain.md) | Queued | — | Read canonical package | Read canonical package | — |
| [C08](../work-packages/WP-C08-work-records.md) | Queued | — | Read canonical package | Read canonical package | — |
| [W01](../work-packages/WP-W01-app-shell.md) | Queued | — | Read canonical package | Read canonical package | — |
| [X03A](../work-packages/WP-X03A-remote-mcp-core.md) | Queued | — | Read canonical package | Read canonical package | — |

Mark a journal handoff complete only after the canonical package is `done`, its declared test passes from a clean checkout, its evidence manifest exists, and that manifest's tested implementation commit is recorded.
