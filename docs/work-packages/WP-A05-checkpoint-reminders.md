# WP-A05 — Non-executing checkpoint reminders

Status: `planned`

Risk: High

Test target: `pnpm test:a05`

Evidence manifest: `docs/work-packages/evidence/WP-A05/manifest.json`

## Outcome

An authorized human or agent sees a bounded reminder to record a BFB checkpoint
at defined points. A reminder does not report progress, publish a note, create
attention, complete work or start a provider turn.

## Dependencies

- **Requires:** C13.
- **Unlocks:** none.
- **Can run with:** provider delivery work only after the reminder contract is frozen and ownership is disjoint; no parallel context or reminder-state changes.

## Scope

- Define explicit project cadence/trigger policy and per-task reminder state,
  based on committed checkpoint/reminder records rather than inferred activity.
- Start with explicitly enabled passive retrieval; push/native delivery would
  consume X01 and needs separate completion, not a hidden package dependency.
- Include constant guidance and currently applicable reminders in authorized
  context retrieval; expose on-demand human reminder settings/state in Work Map.
- Support dedupe, suppression, acknowledgement, expiry and offline/reconnect
  behavior with immutable source identity and current access checks.
- Describe shared progress versus author-private checkpoint destinations; neither
  acknowledgement nor a generic tool call constitutes a checkpoint.
- Export a non-executing provider-integration contract for the separate lane.

## Non-goals

Hook installation, provider adapter changes, automatic prompt/turn injection,
agent-to-agent delivery, new launch/resume behavior, automatic publication,
presence-based progress and collecting raw tool inputs or transcripts.

## Contracts

### Consumes

- C13 immutable base/project context and current-authority composition.
- C11 distinct shared progress and author-private checkpoints, A01 explicit
  business commands, and W03 on-demand controls through C13's dependencies.
- Existing telemetry-only hook boundary; hooks are not business command writers.

### Produces

- A versioned policy/state/context contract with finite cadence, source identity,
  acknowledgement/suppression/expiry and a non-executing integration payload.
- Shared policy/reminder commands and reserved owning target/manifest path.
  Future provider delivery retains separate acceptance and is not implied here.

## Work plan

1. Freeze defaults/bounds, eligible explicit triggers, source dedupe, visibility,
   acknowledgement and offline behavior before `ready`.
2. Implement canonical policy/state and useful authorized reads through the Hub;
   test time boundaries with a deterministic clock and exact retries.
3. Add context guidance and on-demand controls; verify current access, both themes
   and denied/stale/loading states without touching provider processes.
4. Certify the owning clean target and full verification; hand the separate lane
   only the frozen non-executing integration contract.

## Acceptance

- Configured cadence yields one applicable reminder per frozen source identity;
  retries/reconnect do not multiply it. Suppressed, acknowledged and expired
  reminders follow the exact contract, including at clock boundaries.
- A new explicit checkpoint satisfies only the applicable policy/source; private
  checkpoints remain owner/origin-scoped and never become shared reminder content.
- Revoked or narrower credentials receive no forbidden reminder/body/count/cache.
  Offline delivery never executes a delayed provider turn after reconnect.
- Ack, dismiss, context reads, transport presence and generic hooks create no
  progress, result, attention or publication record and launch no local process.
- Constant guidance names explicit commands and truthful unavailable paths;
  the default item action budget and keyboard/light/dark behavior remain intact.

## Evidence

Not run. Future evidence covers deterministic cadence/source/clock matrices,
canonical effects, current-authority delivery and compiled presentation, with
no raw hook input, private notes or claimed live provider delivery.

## Risks and decisions

Reminders can become noise or false progress. Before `ready`, choose the finite
cadence, eligible explicit sources, owner/origin scope and suppression/ack policy.
Provider wake/injection is excluded even if the integration receives a reminder.

## Handoff

Planned; existing launch bootstrap and telemetry hooks are not checkpoint
reminders. No provider hook or installer is modified by this package plan.
