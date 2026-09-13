# Human-initiated discussions v1

Owner: [D01](../work-packages/WP-D01-discussion-records.md), under
[ADR 0002](../adr/0002-human-initiated-discussions.md). Implementation is in progress;
this contract is not completion evidence. Exact acceptance: `pnpm test:d01`.

## Authority and work isolation

A current, directly authenticated owner/member with project access creates a
discussion. Two distinct named profiles, their configuration versions and one
permitted runner/registered checkout per participant are frozen. C06 authorizes
the named human and project on each runner; L08 supplies path-free checkout
identity. This records permitted destinations, not launch authority, availability,
provider read-only certification or native Git evidence. D02 must reauthorize and
verify each actual dispatch. No execution, lease or runner command is created by
D01 discussion creation.

Each participant receives a fresh `purpose=discussion` run and configuration
snapshot. Existing runs migrate to `purpose=work`; purpose is immutable. Discussion
creation and terminal states never change the task's workflow, resource version,
normal work-run result or normal-work projection. Ordinary run/execution/session
commands, interactive launch/retry/control paths and current-context delivery must
reject discussion runs. Discussion conclusion is not work acceptance.

Participant authority follows C08's internal authenticated run-scoped command
convention. The participant is derived from that exact run, not an input profile
name. The initiating human's current membership, project access and original
authorization epoch remain required for participant reads and writes. A provider
acknowledgement/output also binds an already trusted observed provider-session
record to that participant run. No public route may construct run authority from
caller-supplied identifiers; A01/D02 own the authenticated execution boundary.

## Immutable bounded brief and history

Creation freezes the task's agent-visible title/context, question, expected task
version, explicit Git revision and canonical brief hash. Human-only context is
never queried into the brief. A brief exceeding 65,536 UTF-8 bytes is rejected,
not truncated. Git revision is a requested revision until D02 verifies it locally.
Subsequent agent-visible context changes are surfaced as `context_changed`; the
brief is never silently replaced. Human intervention appends explicit shared
context without editing the brief or widening read-only permissions.

The roster has exactly two participants. The default is three rounds, with one
turn per participant per round; creation may select one to three rounds. The
deadline is fixed at creation (default 900 seconds; permitted range 60–3,600).
There are at most six participant messages and twelve human interventions.
Questions/interventions are bounded to 4,096 characters; each typed participant
output is bounded to 8,192 UTF-8 bytes. The complete history remains finite.

Both initial positions are independent. A turn receives completed earlier rounds,
not the current peer's unfinished or earlier-in-the-same-round answer. Its exact
source message IDs are frozen when accepted. Participant views cannot retrieve
withheld peer content through a general discussion or current-task-context read.

## Commands and state

All mutations use the existing WorkspaceHub FIFO and atomic D1 transaction.
Inputs and outputs use strict versioned schemas. Command/event/audit receipts
contain bounded IDs, state and versions, never question, brief or message bodies.
Reads load content separately after current authorization.

- Create: persist discussion, two runs/snapshots, roster and bounded planned turns
  atomically, with no ordinary task transition.
- Read: current human/project view or the exact participant's filtered frozen
  view. A read is not a delivery acknowledgement.
- Intervene: append human-authored shared context while the discussion is active.
- Accept turn: authorize the next planned turn and freeze its causal inputs.
- Dispatch: record a delivery attempt before a possible external provider effect.
- Acknowledge: bind a trusted observed session and provider acknowledgement to the
  accepted delivery; neither process presence nor prose is acknowledgement.
- Complete turn: persist one typed recommendation and mark its exact acknowledged
  delivery and turn complete atomically. Recommendations include reasons, bounded
  evidence references, agreement/disagreement references and human questions.
- Record ambiguity/failure: retain correlated history and stop new turns. An
  ambiguous delivery is not automatically retryable.
- Cancel: an authorized human stops the discussion; no later turn is accepted.
- Conclude: after every bounded turn completes, freeze references to the final
  two attributed recommendations. Do not synthesize consensus or accept task work.
- Decide: a current authorized human records one immutable decision with explicit
  recommendation references. An agent cannot decide, create a third participant,
  extend the deadline/turn limit or authorize implementation.

Mutations require expected discussion/turn versions where they advance state.
Duplicate request keys bind the original actor, request hash and stored safe
receipt. Retries recheck current authority before returning a stored receipt;
changed input under a key fails. Concurrent and out-of-order transitions fail
without events or partial state. A terminal discussion cannot reopen. A new brief
or another exchange requires a new human-created discussion.

The domain request key is distinct from the hub transport attempt key, following
the existing C09 convention. A retry rechecks authority and returns the original
safe IDs/version without advancing discussion state. Each authorized transport
attempt is audited; repeated receipts are not additional discussion messages,
deliveries or decisions, and consumers must key business effects by their IDs.

## Verification and boundaries

The exact gate covers strict cross-language fixtures, migrated SQLite constraints,
current-authority and frozen-context negatives, ordinary work-run regressions,
duplicate/out-of-order transitions, and real D1/WorkspaceHub contention from two
independent Worker clients. Empty/previous-head migrations must converge.
The deterministic fixture owner is `pnpm discussion:fixtures`; acceptance runs
`node tools/discussions/fixtures.mjs --check` against the committed matrix.

Provider execution, session fencing/native containment, permission enforcement,
crash reconciliation and runner delivery are D02-owned. D01 tests use explicitly
synthetic trusted session records; they are not provider execution evidence.
No local L05 implementation or uncompleted package is consumed.

## Human transport

`POST /api/v1/workspaces/:workspace/tasks/:task/discussions` accepts the strict
create request. `GET` on that collection uses bounded `cursor`/`limit` pagination.
`GET /api/v1/workspaces/:workspace/discussions/:discussion` returns an authorized
human view; `POST` accepts the strict human change request. Path and body IDs must
agree. Existing browser-session and CSRF checks wrap every mutation, responses
are non-cacheable, and original request bytes reach the wire codec. There is no
public participant, dispatch or caller-selected authority endpoint in D01.

The internal catalog names are `discussion.create`, `discussion.change`,
`discussion.turn` and `discussion.conclude`. The last command permits an
authenticated participant to conclude only after all configured turns have
completed; deciding remains human-only. Human change includes the same explicit
conclusion operation. Evidence references name an agent-visible frozen context
item or a repository-relative file at the frozen Git revision. They are attributed
recommendations, not independently verified file observations.
