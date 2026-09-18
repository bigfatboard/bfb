# WP-X02 — Human CLI parity

Status: `planned`

Risk: High

Test target: `pnpm test:x02`

Evidence manifest: `docs/work-packages/evidence/WP-X02/manifest.json`

> Status note: implementation, gate, and evidence are complete on this
> branch, but `Status` stays `planned` because `pnpm roadmap:check`
> rejects any status beyond `planned` while dependencies A02, A03, L05,
> L06, L07, P01, P02, V01, and V02 are not `done`. See Handoff.

## Outcome

Humans and approved scripts receive one parity-checked CLI assembled from
feature-owned commands, with a stable JSON envelope, exit codes, human
device credential separation, and explicit privilege/destructive-action
behavior.

## Dependencies

- **Requires:** A02, A03, C05, C06, C07, C08, C09, L01, L02, L03, L05, L06, L07, L08, P01, P02, V01, V02.
- **Unlocks:** G01, G02.
- **Can run with:** X03/X04 once APIs freeze.

## Scope

- Assemble login/logout/whoami; daemon; runner; checkout; provider; project; task; run; attention; and artifact command registrations supplied by their owning feature packages.
- Use the human device credential in Keychain, never runner/provider credentials.
- Finalize and enforce the shared JSON response envelope and exit-code taxonomy for every command.
- Keep human-readable output concise and stdout/stderr separated.
- Require explicit flags plus fresh-auth/step-up browser handoff for destructive or privilege-expanding operations.
- Generate help and shell completion from actual command definitions.
- Add API version/compatibility diagnostics and offline behavior per command.
- Audit web/API/CLI authorization parity and ensure feature-owned handlers remain thin service clients.

## Non-goals

- Implementing or reimplementing leaf feature behavior owned by daemon, checkout, provider, work, attention, result, or artifact packages.
- A second TUI, hidden compatibility aliases, provider credential management, automatic merge/deploy, or remote shell.

## Contracts

### Consumes

- [Human CLI credentials](../contracts/cli-credentials.md) (C05 device bootstrap, single exchange, per-request authority, credential separation, Keychain storage shape).
- [Runner identity, grants, and tokens](../contracts/runner-enrollment.md) and the runner channel (runner credentials that must never substitute).
- [Human attention workflow](../contracts/attention.md) (request/answer/resolve authority; answers grant no authority).
- [Result submission and acceptance](../contracts/results.md) (run result states; `result.cancel` semantics reused by run cancel).
- [Artifact storage](../contracts/artifacts.md) (metadata shapes; bytes stay in view grants).
- [Launch orchestration](../contracts/launch-orchestration.md) (run/execution identity; no CLI launch mutation).
- C04 workspace authorization and C03/C06 step-up proof rules (action-bound, single-use, epoch-fenced fresh proofs).

### Produces

- [Human CLI parity v1](../contracts/human-cli.md): frozen command-to-owner matrix, JSON envelope, exit-code taxonomy, credential separation, destructive-action gating, help/completion generation, version diagnostics, and per-command offline behavior.
- Server CLI mirror `handleCliHumanApi` (`apps/control-worker/src/api/cli-human.ts`) behind `resolveCliPrincipal`, reusing owning-package domain reads and commands with binding-subset enforcement pre-dispatch.
- Stable test target `pnpm test:x02`; evidence manifest `docs/work-packages/evidence/WP-X02/manifest.json`.

## Work plan

1. Inventory feature-owned command registrations against the architecture and fail on a missing or duplicate owner.
- Proved by: `TestOwnerInventoryMatchesLiveRegistry` over the production-assembled registry (`pnpm test:x02`).
2. Implement common JSON/exit/help/completion/credential/step-up assembly behavior without moving leaf logic here.
- Proved by: Go golden, separation, secret-scan, gating, and completion tests; the assembler-mutation structural test (`pnpm test:x02`).
3. Add help/completion and offline/version diagnostics.
- Proved by: generated-script coverage tests and the version/offline matrix tests (`pnpm test:x02`).
4. Run golden tests for human/JSON modes, errors, secrets, and privilege flows.
- Proved by: committed goldens, the two-isolate workerd parity harness, and the secret-scan report (`pnpm test:x02`).

## Acceptance

- Every documented command is registered by exactly one feature owner and has stable JSON and exit-code fixtures consumed by this parity suite.
- Proved by: the frozen matrix in `docs/contracts/human-cli.md`, `internal/humancli.Table` inventory test, and committed goldens in `internal/humancli/testdata/goldens/` (`pnpm test:x02`).
- Credentials/secrets never appear in argv, stdout, stderr, or logs.
- Proved by: argv refusal tests, output redaction tests, `0600` store tests, committed secret-free goldens, and the harness secret scan over persisted rows and transcripts (`docs/work-packages/evidence/WP-X02/secret-scan-report.json`).
- Human and runner credentials cannot substitute for one another.
- Proved by: route-level confusion tests in both directions on browser, runner, MCP, and CLI surfaces (`apps/control-worker/test/cli-human.test.ts`, `tools/human-cli/run.ts`).
- Destructive/privilege-expanding action fails without explicit flag and required fresh proof.
- Proved by: confirm plus action-bound single-use proof gating for `run cancel`, tested missing/wrong/replayed cases end to end (`pnpm test:x02`).
- JSON mode emits no prose; diagnostics do not corrupt machine output.
- Proved by: single-document stdout assertions with empty stderr, and human-mode stderr separation tests (`pnpm test:x02`).
- CLI result matches the web/API authorization result for the same human, and the parity assembler contains no domain mutation implementation.
- Proved by: same-human browser/CLI deep-equal reads plus the parity report (`docs/work-packages/evidence/WP-X02/parity-report.json`), and the no-table-write structural test over `cli-human.ts`.

## Evidence

- Evidence manifest: `docs/work-packages/evidence/WP-X02/manifest.json`
  (conforms to `docs/work-packages/evidence/manifest.schema.json`).
- Contents: command result (`command-result.json`), command-to-owner matrix
  (`command-matrix.md`), golden human/JSON outputs and exit codes
  (`internal/humancli/testdata/goldens/`, consumed by `pnpm test:x02`),
  shell-completion coverage (Go completion test), authorization parity
  report (`parity-report.json`), secret-scanning report
  (`secret-scan-report.json`).
- Evidence is bounded and redacted: synthetic identities only, no secrets,
  no local absolute paths, no raw terminal output.

## Risks and decisions

- Risk: full parity bloats into every internal table and debug endpoint. Decision: the CLI mirrors product operations only (project/task/run/attention/artifact-metadata reads plus task create, attention answer/resolve, and guarded run cancel); membership, policy, launch, discussion, notification, and review-decision writes stay in the browser.
- Risk: hub commands re-resolve the member's full grant and would ignore the CLI binding subset. Decision: the CLI layer enforces the binding project subset before dispatch (reads filter, writes pre-check) and hides out-of-scope objects as `not_found`, mirroring the browser boundary; covered by scoped-credential tests.
- Risk: a second credential per human complicates the device flow. Decision: the suite mints full and project-scoped credentials through the real device flow; the product keeps C05's single-exchange guarantee per bootstrap credential.
- Risk: macOS Keychain work is not automatable in CI. Decision: the v0.1 CLI uses a portable owner-only file store with the C05 Keychain item shape frozen in the contract; the Keychain move is recorded as a limitation, not implemented.
- Risk: sibling agents own L05, D03, X01, X03, X04, V03 and the W02 test fix concurrently. Decision: X02 touches only its own files plus two additive registry integration points (`Invocation` stderr/JSON fields, `ExecuteWithStderr`, `List`); no leaf behavior was changed.

## Handoff

- State: implementation, `pnpm test:x02` gate, and evidence are complete on
  this branch at the committed hash recorded in the evidence manifest.
  `Status` is intentionally left at `planned`: `pnpm roadmap:check`
  rejects anything beyond `planned` while A02, A03, L05, L06, L07, P01,
  P02, V01, and V02 are not `done`.
- Consume: `docs/contracts/human-cli.md` (v1), `GET/POST /api/v1/cli/*`
  routes in `apps/control-worker/src/api/cli-human.ts`, the `bfb` human
  commands in `internal/humancli/`, and the parity harness in
  `tools/human-cli/run.ts`.
- G01: compose the CLI confusion matrix and golden fixtures into the
  release-gate report; the `version` and `completion` commands are
  assembly-owned and need no leaf changes.
- G02: package the same `bfb` binary; it does not fork CLI behavior. The
  macOS Keychain move for the human credential item (service `bfb-cli`,
  account `<workspace-id>`) is the one deferred platform step.
- Limitations: artifact reads are metadata only; project/task/run writes
  are the bounded set above; no offline mutation queue; provider setup and
  doctor cover Claude only until P01/P02 mirror them; no TUI.
