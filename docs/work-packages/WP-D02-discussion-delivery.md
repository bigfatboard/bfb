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

- D01 discussion v1 (`docs/contracts/discussions.md`); L03 certified turn plans and semantic parsers (`internal/provider`, `internal/providers`); L05 owned process/checkout guards (`docs/contracts/execution-supervisor.md`); L06 journal/dispositions (`docs/contracts/observed-session.md`, `internal/journal`); L08 authenticated runner channel (`docs/contracts/runner-channel.md`); A01 context/capability scope (`docs/contracts/local-mcp.md`); P01 and L07 certified Codex/Claude adapters (`internal/providers/codex`, `internal/providers/claude`).

### Produces

- [Discussion delivery v1](../contracts/discussion-delivery.md) with session fencing, causal message/attempt/turn IDs, recovery decisions, bounded participant output, and scheduler state.
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

## Evidence

- `docs/work-packages/evidence/WP-D02/manifest.json` indexing the tested commit, contract version, migration heads, toolchains, commands, and redaction status per the evidence manifest schema.
- `docs/work-packages/evidence/WP-D02/fencing-state.md`: ownership/fencing and delivery state diagrams.
- `docs/work-packages/evidence/WP-D02/crash-matrix.md`: the deterministic fault-injection matrix with owning test and observed result per boundary.
- `docs/work-packages/evidence/WP-D02/readonly-negatives.md`: read-only enforcement and peer-escalation negatives.
- `docs/work-packages/evidence/WP-D02/fixture-summary.md`: exact-version fixture summary (fake 1.0.0, Codex 0.153.4, Claude 2.1.275 observed).
- `docs/work-packages/evidence/WP-D02/recovery.md`: restart-recovery runtime evidence.
- `docs/work-packages/evidence/WP-D02/codex-continuation.md`: bounded real-provider experiment report (offline adapter evidence; no live model turn without consent).
- `docs/work-packages/evidence/WP-D02/command-result.json`: bounded aggregate command outcomes.

## Risks and decisions

- Native external-message delivery remains optional and capability-tested. A provider process exit is neither message acknowledgement nor task completion.
- Headless Claude turns stay unsupported: the installed Claude 2.1.275 differs from the L07-tested 2.1.274, and the adapter certifies no headless turn transport on any version. Claude delivery fails closed and visibly.
- No live model turn ran in this package: Codex credentials and explicit consent were unavailable, so real-provider evidence is the offline adapter proof (version, health, argv planning), not a transcript.

## Handoff

- Implementation, gate, and evidence are complete on this branch, but A01, L05, L06, L07, and P01 are not `done`, so this package stays `planned` per the roadmap status rule and D03 must not consume it yet.
- State: `internal/discussion` (delivery store at local migration 012, ownership/fencing, scheduler, dispatch, bounded outputs, recovery, L03 kit planner) with `go test -race ./internal/discussion/...` passing; D1 migration `0025_discussion_delivery` (covering indexes only; D01 records unchanged); contract `docs/contracts/discussion-delivery.md`.
- Commands: `pnpm test:d02`; `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build ./...`; `pnpm verify`; `pnpm worktree:check`.
- D03 consumes committed discussion messages and conclusions through D01 reads plus the delivery states named in the contract; it never interprets provider prose.
- Known limitations: live supervised launch, pre-exec revalidation at spawn, and signaling wait on L05; trusted session binding from live hooks waits on L06; run-scoped context loading waits on A01; live Codex turns and Claude parity wait on provider credentials, consent, and L07/P01 completion.
