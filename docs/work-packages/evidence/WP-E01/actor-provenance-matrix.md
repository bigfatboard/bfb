# WP-E01 actor/provenance matrix

Claimed workspace/project/task/run IDs in a runner submission are hints only.
Every committed envelope derives attribution server-side from the immutable
execution assignment bound to the authenticated runner.

| `capture_origin` | Committed `actor` | Committed `source` | Meaning |
| --- | --- | --- | --- |
| `runner_observed` | `{type: "runner", id: <authenticated runner>}` | `{type: "runner", id: <runner>, provider?}` | Daemon-observed runner fact (heartbeat, launch, execution, process rows) |
| `agent_reported` | `{type: "agent_run", id: <run_execution_id>}` | `{type: "runner", id: <runner>, provider?}` | Agent-run MCP report scoped to its execution |
| `hook_inbox` | `{type: "agent_run", id: <run_execution_id>}` | `{type: "runner", id: <runner>, provider?}` | Provider hook telemetry scoped to its execution |

## Enforcement

- A mismatched `claimed_workspace_id` (or project/task/run hint) still commits under the assignment-derived IDs; hints never enter the ledger.
- Rows for an execution assigned to another runner are `permanently_rejected` (`wrong_runner`); nothing commits.
- Rows for a project the runner no longer holds a grant for are `permanently_rejected` (`project_grant_revoked`); revocation is fenced per ingest.
- Unknown top-level fields and non-empty payloads fail closed-payload validation and are `permanently_rejected`; the ledger stores only the validated envelope.
- Provider on `source` is included only when the bound run profile resolves to a known provider (`claude`, `codex`, `grok`, `fake`); otherwise it is omitted, never guessed.
- `provider_session_id` passes through as an observation key. Ingest creates no provider sessions and asserts no session binding.
