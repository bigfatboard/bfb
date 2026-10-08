# Result submission and acceptance v1

Owner: [A03](../work-packages/WP-A03-results.md). Gate: `pnpm test:a03`.

This contract freezes explicit result submission, human review decisions,
outdated detection, and capability revocation for runs. It extends the
run-scoped local MCP server defined in [local MCP](local-mcp.md); it does
not introduce another agent credential or a second local tool endpoint.

A03's [runtime certificate](../work-packages/evidence/WP-A03/runtime-manifest.json)
passes at `9077a085939d89d0da4709dd24cc69bdf991dee0` under
[ADR 0008](../adr/0008-protected-agent-result-submission.md). Production MCP and
CLI use the separate v5 result transport and daemon-owned protected journal.
The clean proof covers independent default-denied result policy, signatures,
shared recovery and current authorization through signed synthetic native
execution. It does not certify Terminal, live providers or remote MCP parity.

## State coupling

`run.result_state` is one of `open`, `submitted`, `changes_requested`,
`accepted`, `failed`, or `cancelled`. Terminal states are `accepted`,
`failed`, and `cancelled`. Task state moves atomically with the run inside
one WorkspaceHub command:

| Command | Run transition | Task transition |
| --- | --- | --- |
| `result.submit` | `open` → `submitted`, `changes_requested` → `submitted` | `active` → `review` |
| `result.request_changes` | `submitted` → `changes_requested` | `review` → `active` |
| `result.accept` | `submitted` → `accepted` | `review` → `done` |
| `result.fail` | `open` → `failed`, `changes_requested` → `failed` | none (task is already `active`) |
| `result.cancel` | `open` → `cancelled`, `changes_requested` → `cancelled` | none (task is already `active`) |

`fail` and `cancel` are legal only from `open` or `changes_requested`, where
the task is always `active`, so they never move the task. A changes-requested
run reopens the same run; the next submission creates a new immutable version.
No command rewrites a prior submission.

## Submission record

One immutable `result_submissions` row per version, introduced by
`0024_result_submissions`. Protected runtime policy adds
`0040_offline_result_policy` without rewriting historical snapshot bytes.

- `version`: 1-based per-run sequence, allocated as `max + 1` inside the
  serialized hub lane with a uniqueness backstop.
- `summary`: 1-2048 characters of agent-written result text.
- `limitations`: 0-2048 characters of known limitations.
  The retained MCP descriptor advertises nonempty text when supplied; MCP
  clients can omit an empty limitation. The result wire and CLI accept empty
  or omitted text with the same business meaning.
- `evidence_refs_json`: 0-20 generic evidence references (shape below).
- Git facts, when the submitter observes them: `git_branch` (1-256 chars),
  `git_commit` (40 lowercase hex characters), `git_dirty` (boolean). They are
  observations bound at submit time, never live checkout state.
- `config_snapshot_id` and `config_hash`: agents bind the exact immutable
  snapshot of their current execution; human submission uses the run's latest
  configuration snapshot. Callers never supply them.
- `submitted_by_kind` (`agent_run` or `human`) plus `submitted_by_id`
  (run ID for agents, human ID for humans), and `submitted_at` (server time).

Duplicate evidence references (same kind, ref, and version twice in one
submission) are rejected. Reviews are separate immutable `result_reviews`
rows binding run, submission version, decision (`request_changes` or
`accept`), reviewer human, optional comment (at most 2048 characters), and
server time.

## Generic evidence-reference shape

V01 and V03 extend this shape; A03 stores it opaquely and never validates a
referent's existence.

```json
{
  "kind": "artifact_version",
  "ref": "01J...",
  "version": "3",
  "hash": "sha256:..."
}
```

- `kind`: 1-64 character slug (for example `comment`, `github`,
  `external`, `log`, `artifact_version`).
- `ref`: 1-512 character bounded reference meaningful to `kind`.
- `version`: optional 1-128 character caller-observed version token.
- `hash`: optional `sha256:` hex digest of the referenced bytes.

A03 performs no existence or version check against any referent. V01 adds
immutable artifact-version validation for `artifact_version` refs and
artifact-driven outdated state; V03 consumes reviewed versions. Unknown kinds
stay opaque and can never mark a submission outdated by themselves.

## Outdated detection (computed, never mutated)

No command updates a submission. Readers compute `outdated` plus reasons:

- `superseded`: a newer version exists for the same run.
- `config_changed`: the bound `config_hash` differs from the run's latest
  configuration snapshot hash.
- `evidence_changed`: a bound ref's `version` differs from the referent's
  current version supplied through the generic version map. A03 resolves no
  referents itself; V01 supplies artifact versions through this map.

A later repository change between two submissions marks the prior version
`superseded` with visibly different bound Git facts; history is preserved.

## Authority matrix

| Action | agent_run (own run) | reviewer | member | owner |
| --- | --- | --- | --- | --- |
| `result.submit` | allowed | forbidden | allowed | allowed |
| `result.request_changes` | forbidden | allowed | allowed | allowed |
| `result.accept` | forbidden | forbidden | allowed | allowed |
| `result.fail`, `result.cancel` | forbidden | forbidden | allowed | allowed |

An agent can never accept, request changes on, fail, or cancel a result, not
even its own. A reviewer can review (comment, request changes) but cannot
submit or accept: acceptance moves the task to `done`, which reviewers
cannot do. Agent submission requires the run's current runner-authenticated
execution assignment plus a non-ended execution bound to that
assignment's execution. Current means the highest assignment generation
for the run: once a retry creates a newer generation on another runner,
the older generation's runner loses submit authority even while its old
assignment row still exists. Human submission requires owner/member role
plus project access and needs no live execution. Every mutation carries
an idempotency key. All five result commands reauthorize before stored outcomes
or fingerprint conflicts are returned. An exact authorized retry returns the
original outcome without creating a version; changed original input is rejected.
Agent retries can reconcile the original operation while the run is submitted,
but cannot create another submission until changes are requested. Terminal
state or revoked authority withholds the stored agent outcome.

Audit, workspace event and outbox projections contain bounded identifiers,
counts and states, never result summaries, limitations, evidence text, Git branch
text or review comments. Canonical submission and review records remain private
and immutable; authorized human result reads retain their full content.

## Headless-success rule

Process, session, and transport endings never submit or accept a result. The
only permitted automatic submission is unambiguous headless success, defined
as all four facts holding together:

1. The run's agent profile `execution_mode` is `headless`.
2. The execution ended with `end_reason` `process_exit`.
3. The provider exit code is `0`.
4. A trusted headless completion attestation exists for the execution.

A provider `Stop`, tool failure, terminal close, session end, non-zero exit,
interactive mode, or missing attestation never qualifies. Runner event
ingest (including `result_submitted` telemetry rows) never mutates
`run.result_state`, attention state, or execution state; only the commands
above do. No caller exists for automatic submission in v0.1: even headless
runs submit explicitly through the surfaces below until a trusted
attestation source is certified.

## Revocation and the checkout lock

Acceptance, failure, and cancellation are terminal: every run-scoped agent
capability closes and every later local MCP call fails closed. Acceptance
does not mutate checkout-lease state: a live local lock and its cloud lease stay
until verified process end or explicit local recovery. Agent submission and
reconciliation must read current lease authority; neither result nor review
commands release or rewrite `checkout_leases`.

## Surfaces

- Local MCP `bfb_submit_result` and local CLI `bfb run submit` use only
  `mcp.v5.submit_result`. The daemon verifies kernel caller, immutable startup
  assignment, native containment/held checkout lock, trusted L06 observation
  and canonical cloud binding. Activated MCP supplies a binding assertion;
  fresh CLI/provisional MCP lets the daemon derive it. No client supplies a
  capture, principal or receipt. The closed host remains denied.
- Result submission does not inherit A01 task-write permission. The separate
  `offline_agent_results` policy defaults to false/zero at workspace, project
  and repository scope; children can only tighten an explicitly enabled
  ceiling of 1–300 seconds. Complete policy changes and explicit repository
  policy use V3 proof targets binding both independent permission families.
- The daemon signs the original canonical input and result-specific cloud
  confirmation using `BFB-AGENT-RESULT-CAPTURE-V1`. Ordinary online writes still
  journal before dispatch. Offline capture additionally requires independently
  confirmed result permission in this process, within the original strict
  45-second/lease/credential horizon. Optional bounded background confirmation
  after verified session binding or fresh A01 confirmation never extends an
  existing proof's age. Restart, known denial and expiry cannot manufacture
  new capture authority.
- Journal v14 retains A01 bytes and history, adds an explicit result family,
  and shares its existing quotas. Unsigned historical result rows remain
  quarantined. Pending means not yet cloud-submitted. Only signed
  `offline_admitted` intents can drain autonomously; `online_only` intents need
  an explicit retry. Lost replies and failed acknowledgement preserve
  `possibly_applied`; current authority precedes every reconciliation and
  private response. Original request ID, input, signature and expiry never
  change during replay.
- REST work API under `/api/v1/workspaces/:workspace/runs/:run`: human
  `POST .../results` (submit), `GET .../results` (list with computed
  outdated flags), `POST .../review` (`request_changes` or `accept`),
  `POST .../failure`, `POST .../cancellation`.
- Explicitly absent: remote MCP result tools, automatic merge or deploy,
  self-acceptance, approval inheritance, and terminal-prose success
  scraping.

## Verification ownership

The A03 gate covers the transition matrix, task coupling, duplicate and
stale evidence, interactive-exit negatives, the headless-success predicate,
the revocation race with lease retention, the changes-requested cycle with
new immutable versions, idempotent retries, and the role matrix across real
Workers and D1, the Go MCP server and CLI, and browser result/review state.
The connected runtime additionally covers signed MCP/CLI outage and restart,
the result-only policy migration and proof targets, shared journal upgrade and
quotas, current-authority-before-cache, body redaction, and unaffected A01/A02
surfaces. The exact clean-checkout target is required before certification.
