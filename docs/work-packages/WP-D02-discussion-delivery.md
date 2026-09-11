# WP-D02 — Supervised discussion delivery

Status: `planned`

Risk: Very high

Test target: `pnpm test:d02`

Evidence manifest: `docs/work-packages/evidence/WP-D02/manifest.json`

## Outcome

The enrolled Mac conducts a bounded read-only Claude/Codex exchange using owned sessions and durable correlated turn delivery, and recovers or visibly pauses after uncertainty.

## Dependencies

- **Requires:** A01, D01, L03, L05, L06, L08, P01.
- **Unlocks:** D03.
- **Can run with:** none during shared runner/storage/provider-contract changes.

## Scope

- Start fresh participant sessions and continue only their observed exact IDs using certified adapters and run-scoped context.
- Implement durable per-session ownership/fencing, local execution guards, typed dispatch attempts/acknowledgements, and bounded normalized outputs.
- Schedule independent initial positions, then sequential challenges/revisions, with three rounds/six participant turns by default. Preserve disagreements rather than inventing consensus.
- Reauthorize each dispatch and enforce deadline, stop, lost authorization, read-only tools, checkout occupancy, message/output limits, and recorded revision.
- Reconcile persisted execution/provider facts after a crash. Pause ambiguous delivery; never blindly replay an unacknowledged external effect.

## Non-goals

- Interactive-session takeover, automatic worktrees/clones, arbitrary shell/prompt argv, peer-selected capabilities, new provider runtime, or external room services.

## Contracts

### Consumes

- D01 discussion v1; L03 certified turn plans and semantic parsers; L05 owned process/checkout guards; L06 journal/dispositions; L08 authenticated runner channel; A01 context/capability scope; P01 and L07 certified Codex/Claude adapters.

### Produces

- Discussion delivery v1 with session fencing, causal message/attempt/turn IDs, recovery decisions, bounded participant output, and scheduler state.
- `pnpm test:d02` and the declared redacted exact-provider evidence manifest.

## Work plan

1. Add durable dispatch and session ownership with deterministic fake-provider fault coverage.
2. Add read-only owned-session turn execution and bounded conclusion data.
3. Exercise real Claude/Codex continuation, permission failures, cancellation, replay and process-loss boundaries.

## Acceptance

- Wrong, busy, unowned or revoked sessions cannot receive a turn. Duplicate workers cannot acquire concurrent ownership, including after restart.
- Crash before dispatch is retryable; crash after a possible provider effect reconciles or pauses visibly without blind duplicate delivery.
- Peer content cannot grant permission, invoke an unapproved tool, mutate the checkout, select a third participant, or extend the bounded scheduler.
- Cancellation/deadline/revocation prevents new turns and terminates owned work safely; process uncertainty retains guards.
- Same-checkout participants serialize; no automated Git mutation occurs.
- Both providers preserve exact session identity across turns; missing/changed/unsupported identity and malformed/oversized output fail visibly.
- Exact target passes from a clean checkout with synthetic fixtures and bounded real-provider evidence; unavailable auth or consent is reported, not replaced by fake success.

## Evidence and handoff

- Commit delivery/fencing state diagrams, crash matrix, read-only/escalation negatives, exact-version fixture summaries, and runtime recovery evidence. D03 consumes committed state rather than interpreting provider prose.

## Risks and decisions

- Native external-message delivery remains optional and capability-tested. A provider process exit is neither message acknowledgement nor task completion.
