# WP-X02 — Human CLI parity

Status: `planned`

Risk: High

## Outcome

Humans and approved scripts receive one late parity-checked CLI assembled from feature-owned commands, with stable JSON, exit codes, credential separation, and explicit privilege/destructive-action behavior.

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

## Work plan

1. Inventory feature-owned command registrations against the architecture and fail on a missing or duplicate owner.
2. Implement common JSON/exit/help/completion/credential/step-up assembly behavior without moving leaf logic here.
3. Add help/completion and offline/version diagnostics.
4. Run golden tests for human/JSON modes, errors, secrets, and privilege flows.

## Acceptance

- Every documented command is registered by exactly one feature owner and has stable JSON and exit-code fixtures consumed by this parity suite.
- Credentials/secrets never appear in argv, stdout, stderr, or logs.
- Human and runner credentials cannot substitute for one another.
- Destructive/privilege-expanding action fails without explicit flag and required fresh proof.
- JSON mode emits no prose; diagnostics do not corrupt machine output.
- CLI result matches the web/API authorization result for the same human, and the parity assembler contains no domain mutation implementation.

## Evidence and handoff

- Commit command-to-owner matrix, golden outputs, shell-completion test, authorization parity report, and secret-scanning report.
- G02 packages the same binary; it does not fork CLI behavior.

## Risks and decisions

- Full parity is easy to bloat. Commands mirror product operations, not every internal table or debug endpoint.
