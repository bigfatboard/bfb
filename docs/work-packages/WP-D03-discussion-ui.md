# WP-D03 — Discussion UI and human decisions

Status: `planned`

Risk: High

Test target: `pnpm test:mvp-discussion`

Evidence manifest: `docs/work-packages/evidence/WP-D03/manifest.json`

## Outcome

A human starts a two-agent discussion from a task, follows and intervenes in the exchange, reconnects safely, and records a decision with recommendations and disagreements intact.

## Dependencies

- **Requires:** D01, D02, E02, W01.
- **Unlocks:** none.
- **Can run with:** none until discussion commands and delivery projections freeze.

## Scope

- Task-sheet action for the question, two eligible profiles, permitted runner/checkouts and bounded duration; distinguish unavailable capabilities and authorization.
- Render attributed messages, rounds/current speaker, queued/acknowledged/completed delivery, deadline, cancellation, failures and ambiguous recovery.
- Human intervention, stop and decision commands; recommendations, evidence, agreements, disagreements and open human questions.
- Reconnect via the existing cursor/replay model; no terminal scraping or inferred completion.
- Local MVP start/stop/health documentation and full browser-to-runner smoke with Claude/Codex.

## Non-goals

- Automatic implementation after agreement, human-impersonating peer text, live-session invitations, artifact suite, or production deployment.

## Contracts

### Consumes

- D01 discussion commands/projections; D02 bounded delivery state; E02 reconnect/replay; W01 authenticated task-sheet and permission patterns.

### Produces

- Accessible task-linked discussion surface and integration gate `pnpm test:mvp-discussion` for DG-01–DG-03.
- Declared evidence manifest and reproducible local runtime instructions with separately stated provider/auth/device limitations.

## Work plan

1. Add initiation and participant/checkout eligibility, then the discussion timeline and controls.
2. Add human decision and explicit follow-up links without implicit work transitions.
3. Verify browser reconnect, permission/failure rendering, hostile content, keyboard access, and a running local real-provider flow.

## Acceptance

- Human creates and observes a six-turn-bounded read-only Claude/Codex exchange, closes/reopens the browser and sees the same committed state.
- Busy/offline/revoked/unsupported participants and checkout conflicts are actionable, not stuck loading or false activity.
- Intervention is attributed to the actual human; cancel/deadline prevents further dispatch and recovery uncertainty remains visible.
- Rendered agent text is inert. Recommendations and human decisions cannot impersonate one another or complete the issue.
- Keyboard, empty/loading/error and narrow-layout cases pass; independent initial positions and disagreements remain inspectable.
- Full local stack and runner are left running and smoke-tested; cross-device and real-provider proof are distinguished from synthetic/localhost checks.
- Exact target passes from a clean checkout and the redacted evidence manifest is committed.

## Evidence and handoff

- Browser captures, state assertions, reconnect/negative matrix, real-provider versions and local smoke result indexed by the manifest. All deferred v0.1 packages remain visibly unfinished.

## Risks and decisions

- Long model turns need honest delivery state and bounded cancellation; prose and transport presence are never authoritative progress signals.
