# X03 attack matrix

Scope: a delegated remote MCP client. Each row is an automated test in
`apps/control-worker/test/mcp-remote-parity.test.ts` (tool layer) or
`packages/domain/test/remote-parity.test.ts` (command layer), executed
against live fixtures with well-formed inputs so the denial is purely
authoritative. Owning-package denials are preserved, never weakened:
A03's `rejects delegated remote submission` still passes.

| Attack | Expected | Proven by |
| --- | --- | --- |
| Answer an attention request via delegation | `forbidden` | `attention.answer` with delegation on a live open request |
| Resolve an attention request via delegation | `forbidden` | `attention.resolve` with delegation on a live open request |
| Request changes on a submission via delegation | `forbidden` | `result.request_changes` with delegation on a live submission |
| Accept a submission via delegation | `forbidden` | `result.accept` with delegation on a live submission |
| Fail a run via delegation | `forbidden` | `result.fail` with delegation on a live submission |
| Cancel a run via delegation | `forbidden` | `result.cancel` with delegation on a live submission |
| Fail an artifact version via delegation | `request_rejected` | `artifact.mark_failed` with delegation on a live uploading version |
| Promote a root task via delegation | `forbidden` | `task.update` with `promote: true` and a current version |
| Call `bfb_answer_attention` / `bfb_resolve_attention` / `bfb_accept_result` / `bfb_approve_artifact` / `bfb_promote_task` / `bfb_admin_policy` | no successful result | `tools/call` for each unknown name through the real handler |
| Escape the project boundary on any extension tool | `isError` result, no row written | `bfb_request_human`, `bfb_submit_result`, `bfb_publish_artifact`, `bfb_finalize_artifact` against a foreign-project run |
| Escape a task-bound delegation | `isError` result, no row written | `bfb_submit_result` outside the bound task subtree |
| Mutate with a read-only delegation | `insufficient_scope` | all four mutations plus `bfb_add_comment` under `bfb:read` only |
| Reuse a revoked delegation token | HTTP 401 | `revokeDelegation`, then the next `tools/call` |
| Mint `agent_run` identity from MCP traffic | zero rows | `result_submissions` has no `agent_run` rows; `provider_sessions` stays empty after the full loop |
| Extract the upload grant secret from D1 | absent | every D1 table dump excludes the one-time secret |
| Smuggle scope or boundary changes through tool use | unchanged | `oauth_delegations` row is identical before and after mutations |
| Share idempotency across delegations | `idempotency_authority_mismatch` | same key from two isolated delegations |
| Widen authority with caller-supplied IDs | rejected | workspace/run/execution/session IDs are never accepted; `run_id` only narrows |

Human-direct and runner paths are unaffected: `submitResultCommand`
still rejects delegation (`forbidden`), `artifactHuman` still rejects
reviewers, and `updateTaskCommand` still bars delegated workflow edits.
Policy and membership administration have no MCP tool on any path; the
MCP server factory is the only production producer of delegation
envelopes, so no other transport can inherit these commands.
