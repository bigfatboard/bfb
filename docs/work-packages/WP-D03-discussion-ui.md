# WP-D03 — Discussion UI and human decisions

Status: `planned`

Risk: High

Test target: `pnpm test:mvp-discussion`

Evidence manifest: `docs/work-packages/evidence/WP-D03/manifest.json`

## Outcome

A human starts a two-agent discussion from a task sheet, follows attributed
recommendations, intervenes, stops the exchange, and records a decision, all
from committed state with no terminal scraping and no inferred completion.

## Dependencies

- **Requires:** D01, D02, W01, E02.
- **Can run with:** V02, A04, X04, X01.
- **Unlocks:** none.

## Scope

- Task-sheet action starts a read-only six-turn-bounded question exchange
  between two eligible profiles on permitted runners and checkouts with a
  bounded duration, distinguishing unavailable capabilities and
  authorization.
- Discussion timeline shows attributed messages, rounds, current speaker,
  queued/acknowledged/completed delivery states, deadline, cancellation,
  failures, and ambiguous recovery.
- Human intervention, stop, and decision commands on concluded or stopped
  discussions; recommendations, evidence, agreements, disagreements, and
  open human questions stay inspectable.
- Reconnect through the E02 cursor and replay model.
- Local MVP start, stop, and health documentation.
- Full browser-to-runner smoke with valid Claude/Codex sessions.

## Non-goals

- No live multi-device session launch or provider turn execution; the MVP
  records synthetic delivery fixtures and a gated live smoke.
- No automatic implementation after agreement or human-impersonating peer text.

## Contracts

### Consumes

- `docs/contracts/discussions.md` and D01's commands and projections
  (create/list/human-view/change; human decision kinds
  `record_recommendation`, `decline`, `needs_more_context`).
- `docs/contracts/discussion-delivery.md` and D02's delivery states
  (`internal/discussion`, `tools/discussion-delivery`).
- `docs/contracts/browser-realtime.md` and E02's resync, timeline, and
  presence surfaces (`apps/web/src/realtime`).
- W01's task sheet and permission patterns (`apps/web`, `packages/ui`).
- Seeds in `tools/e2e/src/server.ts` (`/__test/d03/task`).

### Produces

- Task-sheet discussion UI (`apps/web/src/discussion/`) behind the stable
  gate `pnpm test:mvp-discussion` covering DG-01 to DG-03 as far as
  synthetic fixtures allow.
- Evidence manifest at `docs/work-packages/evidence/WP-D03/manifest.json`.
- Gated live smoke `node tools/discussion-smoke/smoke.mjs` (runs once L05
  lands with provider credentials and consent).

## Work plan

1. Add the task-sheet initiation action with eligibility and the discussion
   timeline with attributed messages, rounds, speaker, delivery states,
   deadline, cancellation, failures, and ambiguous recovery. Verify with
   `pnpm test:mvp-discussion:unit`.
2. Add human intervention, stop, and decision commands plus reconnect
   through E02 invalidations. Verify with
   `pnpm test:mvp-discussion:browser` on `BFB_E2E_PORT=4191`.
3. Document local start/stop/health, script the gated live smoke, capture
   evidence, and record proven vs pending acceptance. Verify with
   `pnpm test:mvp-discussion`, `pnpm verify`, and `pnpm worktree:check`.

## Acceptance

- DG-01 — A human starts a read-only six-turn-bounded question exchange
  between two eligible profiles; the exchange never completes the task or
  authorizes implementation; unavailable runners, checkouts, and profiles
  are actionable failures, not dead ends. A human decision references stored
  recommendations and never completes the task. Proven synthetic and
  localhost; live real-provider smoke waits on D02 plus provider credentials
  and consent (L05 done 18 September).
- DG-02 — The task sheet renders the discussion timeline with two
  attributed independent positions before any rebuttal, queued/ack/completed
  delivery, current speaker, round, deadline, cancellation, failures, and
  ambiguous recovery. Proven synthetic and localhost; live multi-device
  proof waits on D02 plus provider credentials and consent (L05 done
  18 September).
- DG-03 — An authorized human observes a six-turn exchange between Claude
  and Codex, sees Claude's final recommendation preserved even though the
  Codex rebuttal disagrees, intervenes, cancels, and records a decision at
  every step. Proven synthetic and localhost with synthetic sessions; live
  real-provider smoke waits on D02 plus provider credentials and consent
  (L05 done 18 September).
- Reconnect and resync: close and reopen renders the same committed state;
  online and offline behavior follows the existing cursor and replay model;
  no terminal scraping. Proven synthetic and localhost (browser reconnect
  trace); cross-device proof waits on D02 plus provider credentials and
  consent (L05 done 18 September).
- Negative matrix: actionable busy, offline, revoked, unsupported, and
  checkout-conflict states are explicit (never silent stuck loading).
  Proven synthetic and localhost.
- Hostile agent text renders inert (visible as text, never executed, never
  treated as a decision or completion). Proven synthetic and localhost.
- Keyboard, empty, loading, error, and narrow-layout cases pass.
  Proven synthetic and localhost.
- The exact gate passes from a clean checkout:
  `pnpm test:mvp-discussion`.

## Evidence

- `docs/work-packages/evidence/WP-D03/browser/timeline.png` — concluded
  six-turn exchange with positions, disagreements, and questions.
- `docs/work-packages/evidence/WP-D03/browser/decision.png` — recorded
  human decision distinct from recommendations; task still ready.
- `docs/work-packages/evidence/WP-D03/browser/intervention.png`,
  `cancel.png` — attributed intervention and stopped dispatch.
- `docs/work-packages/evidence/WP-D03/browser/eligibility.png`,
  `start.png`, `negative-matrix.md` — every blocking state actionable and
  a UI-started discussion at 0 of 2.
- `docs/work-packages/evidence/WP-D03/browser/narrow.png` — 360px layout
  without sideways scrolling.
- `docs/work-packages/evidence/WP-D03/browser/reconnect.png`,
  `reconnect-trace.md` — cursor invalidation refreshes committed state
  without duplication.
- `docs/work-packages/evidence/WP-D03/local-runtime.md` — local MVP
  start, stop, and health.
- Evidence path is stable and repository-relative, conforms to
  `docs/work-packages/evidence/manifest.schema.json`, and records the
  tested commit, environment, command, outcome, and redaction status.
  Screenshots and fixtures are synthetic and redacted.

## Risks and decisions

- Live real-provider turns and cross-device proof wait on D02 (planned
  pending L07 review and P01) and on provider credentials and consent;
  L05 supervised launches are certified done since 18 September. The
  smoke script runs only then; nothing is faked.
- Frozen harness time makes abuse windows accumulate across scenarios, so
  the e2e server exposes `/__test/ratelimit/reset` for per-scenario
  isolation. Abuse protection itself stays proven by the unit/worker gates;
  no browser suite asserts a rejection.
- Seeded discussions render `Deadline exceeded` against the real wall clock
  because the harness freezes domain time. Countdown math is proven by unit
  tests with an injected clock; enforcement stays proven by D02.
- E02's runner id is random per boot and may sort before W02's, so W02's
  double-submit test pins its runner explicitly instead of relying on the
  default.

## Handoff

- Run `pnpm test:mvp-discussion` (fixtures check, build, unit incl. D01
  route regression, browser on `BFB_E2E_PORT=4191`).
- Task-sheet discussions live in `apps/web/src/discussion/`:
  `api.ts` (exact D01 field builders), `presentation.ts` (eligibility,
  speaker, delivery, deadline, positions), `DiscussionPanel.tsx`,
  `DiscussionStart.tsx`, `DiscussionSection.tsx`.
- Synthetic seeds in `tools/e2e/src/server.ts` (`seedD03Discussions`,
  `/__test/d03/task`); discussion commits broadcast cursor invalidations
  in the harness like any other workspace command.
- Live smoke: `node tools/discussion-smoke/smoke.mjs` (exits 2 with the
  pending list until `BFB_LIVE_SMOKE=1` with L05, credentials, consent).
- Proven: every acceptance bullet synthetic and localhost (see Evidence).
  Pending: live real-provider smoke and cross-device proof (need D02 done
  plus provider credentials and consent; L05 done 18 September). Status
  stays `planned` until then.
