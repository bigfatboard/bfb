# WP-XX — Package title

Status: `planned`

Risk: Low, Medium, High, or Very high

Test target: `<stable root command or package target>`

Evidence manifest: `<stable repository-relative path>`

## Outcome

One verifiable outcome. State what a user, agent, or downstream package can do when this package is complete.

## Dependencies

- **Requires:** package IDs or `none`.
- **Unlocks:** package IDs.
- **Can run with:** package IDs that do not share unstable contracts or files.

## Scope

- Concrete deliverables owned by this package.

## Non-goals

- Work explicitly left to another package or deferred beyond v0.1.

## Contracts

### Consumes

- Frozen schema, API, command, event, or operational contract.

### Produces

- Frozen contract another package may build against.
- Stable test target and evidence-manifest path consumed by checkpoint/release automation.

## Work plan

1. Small implementation step with its verification.
2. Next step with its verification.

## Acceptance

- Observable behavior or automated test that must pass.
- Exact test command exits non-zero on every listed negative case and works from a clean checkout.

## Evidence

- Test report, fixture, screenshot, deployed smoke result, or security result indexed by the declared evidence manifest.
- Evidence path is stable, repository-relative, and contains or references commit, schema/protocol heads, environment, command, outcome, and redaction status.

## Risks and decisions

- A package-specific risk and the decision that contains it.

## Handoff

- Exact state, commands, documentation, fixtures, and known limitations the next package receives.
