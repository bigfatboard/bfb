# WP-A01 offline replay matrix

Proved by `TestJournalSurvivesRestartAndReplays` and
`TestReplayFailureMatrix` in `internal/localmcp`. Replay order per
operation: capture-proof check, expiry check, current authority check,
current policy check, version-checked execution with the original
`request_id`. All identities synthetic.

| Journaled state at replay | Disposition | Reason | Record afterwards |
| --- | --- | --- | --- |
| Online, authority current, policy current, version current | `applied` | — | `applied` with stored outcome; second replay finds nothing pending |
| Authority reports revocation epoch change | `rejected` | `revoked` | Terminal; repeats report `revoked`, never a new effect |
| Execution reached `ended` | `rejected` | `execution_ended` | Terminal; repeats report `assignment_ended` |
| Run result terminal (accepted/failed/cancelled) | `rejected` | `result_terminal` | Terminal; repeats report `capability_closed` |
| Capture time more than 24h past | `rejected` | `expired` | Terminal; repeats report `offline_rejected` |
| Current project policy forbids the tool | `rejected` | `policy_changed` | Terminal; repeats report `policy_rejected` |
| Resource version moved (`stale_version`) | `rejected` | `stale_version` | Terminal; repeats report `stale_version` |
| Payload or proof rewritten at rest | `rejected` | `capture_invalid` | Terminal; repeats report `request_rejected` |
| Transient transport failure (`internal_error`) | `retryable` | `internal_error` | Still `pending`; a later replay retries with the same `request_id` |

A whole journal file closed and reopened replays identically
(`TestJournalSurvivesRestartAndReplays`): close/reopen loses no pending
record, applied outcomes are retained, and replay never re-executes a
terminal record.
