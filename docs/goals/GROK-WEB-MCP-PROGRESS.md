# Grok web + remote MCP execution journal

This file is the resumable execution journal for [the Grok web/MCP goal](GROK-WEB-MCP.md). It is operational state, not acceptance proof. Work-package files own package metadata and status, ADRs own architecture decisions, evidence manifests own acceptance proof, and Git owns commit history. Reconcile this journal when they disagree.

Keep entries terse and use repository-relative paths. Do not record secrets, credentials, private task bodies, raw terminal output, or machine-local absolute paths. Only the lead agent edits this file.

## Resume checkpoint

- Goal state: `active`
- Branch: `goal/grok-web-mcp`
- Last observed HEAD: 3bd2c9eebdfdbde8912e775e551d955a29070126
- Last verified commit: none (IC-1 re-certification reopen; prior stamps are not acceptance proof)
- Last verification command/result: startup reopen hygiene in progress
- Active package: F02
- Active gate: IC-1 re-certify F02 → X03A sequence
- Active task: F02 schema parity + adversarial differential corpus
- Worktree since observed HEAD: package reopen + provider-log scrub + journal active
- Resume here: complete F02 acceptance (TS/Go parity, fractional integers, enums, bounds, uniqueness, required nested, differential adversarial corpus), then F03
- Active delegates: none
- Blocking condition: `none`
- Updated UTC: `2026-08-11T14:00:00Z`

Allowed goal states are `not_started`, `active`, `blocked`, and `complete`. `blocked` is valid only when a listed stop condition remains after safe in-scope alternatives are exhausted.

## Current package tasks

| ID | Task | Owner | State | Verification or result |
| --- | --- | --- | --- | --- |
| F02-T1 | Enumerate F02 acceptance gaps vs current TS/Go schema validators and fixtures | lead | `in_progress` | Derive failing tests from Acceptance section |
| F02-T2 | Add differential adversarial corpus (fractional int, enums, bounds, uniqueness, required nested) | lead | `planned` | TS + Go reject/accept identically |
| F02-T3 | Package tests + `pnpm verify` + independent review + new evidence | lead | `planned` | New manifest at tested commit |

## Delegation log

| ID | Package/task | Worker or workflow | Input HEAD | Scope and path ownership | Expected result/check | State | Result and lead verification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| — | none | — | — | — | — | — | IC-1 re-certification; prior delegates closed |

## Verification log

| UTC | Package/task | Commit or worktree | Exact command or check | Outcome | Retained evidence |
| --- | --- | --- | --- | --- | --- |
| 2026-08-11T14:00:00Z | startup reopen | 3bd2c9e + worktree | journal active; F01 done; F02 in_progress; F03–X03A planned; provider logs redacted | pending commit | historical evidence retained as incomplete only |

Prior verification rows from the previous “complete” stamp are superseded: they do not count as IC-1 re-certification acceptance.

## Blocker and decision log

| ID | First seen UTC | Package/task | Condition and investigation | State | Next action or decision required |
| --- | --- | --- | --- | --- | --- |
| B-ic1-reopen | 2026-08-11T14:00:00Z | IC-1 | Prior complete invalid as acceptance; reopen F02–X03A | open | Re-certify sequence with new tests and evidence |
| B-sensitive-history | 2026-08-11T14:00:00Z | X03A evidence | Raw provider logs may remain in older remote commits | open-accepted | Tip scrubbed; no force-push/history rewrite without Timo confirmation |

## Package status and handoffs

| Package | Journal checkpoint | Tested commit | Test target | Evidence manifest | Limitations |
| --- | --- | --- | --- | --- | --- |
| [F01](../work-packages/WP-F01-repository-foundation.md) | done | prior | F01 targets | historical | left done per reopen plan |
| [F02](../work-packages/WP-F02-wire-contracts.md) | in_progress | none (reopened) | `pnpm test:protocol` | historical incomplete | re-certify required |
| [F03](../work-packages/WP-F03-cloud-substrate.md) | planned | none (reopened) | `pnpm test:substrate` | historical incomplete | re-certify required |
| [F04](../work-packages/WP-F04-tenant-persistence.md) | planned | none (reopened) | `pnpm test:db` | historical incomplete | re-certify required |
| [C01](../work-packages/WP-C01-command-kernel.md) | planned | none (reopened) | `pnpm test:c01` | historical incomplete | re-certify required |
| [C02](../work-packages/WP-C02-human-identity.md) | planned | none (reopened) | `pnpm test:c02` | historical incomplete | re-certify required |
| [C03](../work-packages/WP-C03-passkey-step-up.md) | planned | none (reopened) | `pnpm test:c03` | historical incomplete | re-certify required |
| [C04](../work-packages/WP-C04-workspace-authorization.md) | planned | none (reopened) | `pnpm test:c04` | historical incomplete | re-certify required |
| [C07](../work-packages/WP-C07-work-domain.md) | planned | none (reopened) | `pnpm test:c07` | historical incomplete | re-certify required |
| [C08](../work-packages/WP-C08-work-records.md) | planned | none (reopened) | `pnpm test:c08` | historical incomplete | re-certify required |
| [W01](../work-packages/WP-W01-app-shell.md) | planned | none (reopened) | `pnpm test:w01` | historical incomplete | re-certify required |
| [X03A](../work-packages/WP-X03A-remote-mcp-core.md) | planned | none (reopened) | `pnpm test:x03a` | historical incomplete | re-certify required |

Mark a journal handoff complete only after the canonical package is `done`, its declared test passes from a clean checkout, its evidence manifest exists, and that manifest's tested implementation commit is recorded.
