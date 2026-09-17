# Remote MCP parity extensions v1

Owner: [X03](../work-packages/WP-X03-remote-mcp.md). Gate: `pnpm test:x03`.

This contract extends the X03A seven-tool map to twelve tools without
changing the X03A transport, OAuth model, or scopes. It consumes the
A02 attention, A03 result, and V01 artifact records and state machines
through X03-owned hub commands; the owning-package commands keep
rejecting delegation, so their negative gates stay green.

## Tool map v2

X03A v1 tools are unchanged: `bfb_list_projects`, `bfb_list_tasks`,
`bfb_get_task`, `bfb_get_context`, `bfb_add_comment`,
`bfb_report_progress`, `bfb_propose_task`.

| Tool | Scope | Input | Effect |
| --- | --- | --- | --- |
| `bfb_request_human` | `bfb:task:write` | `run_id`, `kind`, `question` 1-2,048, `reference_kind?`/`reference_id?` as a pair, `blocking`, `request_id` | Files an open attention request for the run via `attention.request.delegation`. The authorizing human is recorded as requester. |
| `bfb_get_attention` | `bfb:read` | `attention_id` | Returns one in-boundary attention record. Cross-project IDs report `not_found`. |
| `bfb_submit_result` | `bfb:task:write` | `run_id`, `summary` 1-2,048, `limitations?`, `evidence_refs?` (0-20 generic refs), `git_branch?`, `git_commit?`, `git_dirty?`, `request_id` | Submits an immutable result via `result.submit.delegation`. Records the authorizing human as submitter. |
| `bfb_publish_artifact` | `bfb:task:write` | `artifact_id?`, `run_id` required, `format`, `role`, `declared_size`, `expected_digest`, `request_id` | Starts publication via `artifact.create_version.delegation` and returns the one-time upload grant secret once. |
| `bfb_finalize_artifact` | `bfb:task:write` | `version_id`, `content_hash`, `size`, `request_id` | Completes publication via `artifact.finalize_version.delegation` after the Artifact Worker verifies the bytes. |

Every mutation returns its committed idempotent outcome directly and
carries `request_id` as the hub idempotency key. Creation and
finalization reject replays (`replay: "reject"`), matching V01: a retry
mints a fresh key. No tool accepts workspace, execution, session, or
assignment IDs; `run_id` and `task_id` narrow the delegation boundary
only. There is no remote wait primitive: clients re-read
`bfb_get_attention` instead of holding a Worker request open.

## Delegation rules

- Membership, project access, scope, resource boundary, and
  authorization epoch are re-evaluated inside every command. Revocation,
  expiry, or an epoch bump fails the next call before any effect.
- Attention requests bind the named run (non-terminal result) and that
  run's latest execution assignment for waiter context. Runs without an
  execution assignment cannot take delegated requests.
- Result submission requires an owner/member sponsor and an active
  task; the submitter is `human` with the authorizing human's ID. A
  delegated client never mints `agent_run` identity, and the optional
  client-reported provider label stays metadata on the delegation.
- Artifact publication always binds an in-boundary run. Run-less
  artifacts stay human-only on both creation and finalization, because
  no project boundary can be proven for them.
- The grant secret is minted by the calling tool and travels only in
  the tool result. D1 keeps the secret hash; idempotency records, audit
  rows, logs, and evidence never contain the secret.
- Byte upload stays on the deployment Artifact Worker
  (`PUT /upload/:grantId`, bearer secret) between `bfb_publish_artifact`
  and `bfb_finalize_artifact`. The MCP body limit never carries bytes.
- No new OAuth scopes. Reads use `bfb:read`; all four mutations use the
  existing `bfb:task:write`. Existing tokens neither gain nor lose
  authority; a read-only delegation reads attention but cannot mutate.

## Explicitly absent

Answering or resolving attention, requesting changes, accepting,
failing, or cancelling results, failing artifact versions, promoting
tasks, and every form of workspace, policy, membership, runner, launch,
measurement, discussion, GitHub, or credential administration. None has
a tool; the corresponding hub commands reject delegation envelopes, and
the X03 gate attacks each path. There is no persistent MCP session
state: every request builds a fresh server, and idempotency lives in
the hub lane, never in transport memory.

## Verification ownership

The X03 gate covers tool-to-command parity against the A02/A03/V01
bounds, boundary escapes, scope negatives, revocation before the next
call, secret hygiene across D1, cross-delegation idempotency isolation,
catalogued hub dispatch, the twelve-tool browser flow, and the full
attack matrix. X03A's routing, delegation, revocation, abuse-control,
and credential-confusion suites run unchanged inside `pnpm test:x03`.
G01 treats this surface as a separate adversarial target.
