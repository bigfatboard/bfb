# WP-A01 acceptance matrix

Tested implementation: `e58f395016035ccc41ce858d4e067af5933bca80`.
Every row below names the automated test that proves it; all run under
`pnpm test:a01` (Go race detector plus the real-binary stdio harness).
Synthetic identities only; no row uses a live provider, cloud state, or
another package's unfinished store.

## Scope acceptance

| Acceptance bullet | Proving test | Observed result |
| --- | --- | --- |
| Wrong UID/process group/run/task/workspace/assignment/session cannot acquire/use a capability | `TestVerifyPeerMaliciousMatrix`, `TestStartupRaceFailsVisibleAndPure` | `peer_denied`, `assignment_unknown`, `assignment_ended`, `correlation_rejected`; unknown assignment fails the handshake visibly on pure stdout |
| Caller-supplied IDs cannot escape the derived boundary | `TestCallerSuppliedIDsCannotEscape` | Foreign task/project/parent IDs return `boundary_escape` with zero transport effects, in every capability state |
| No human-only context, root promotion, policy admin, or second run | `TestWriteValidationRejects`, `TestGoldenInspectorTranscript` frames 10/13 | Workflow/routing fields rejected as `invalid_params`; root proposals rejected by policy; attention/result/artifact tools return `not_implemented`; task view carries agent-visible fields only |
| Bootstrap reads before binding, mutations fail until the trusted binding lands, competitor never activates | `TestProvisionalReadOnlyThenActivation`, `TestCompetingSessionNeverActivates`, `TestConcurrentActivationHasOneWinner`, stdio purity session | Provisional `get_task`/`get_context` succeed; writes return `session_not_bound`; 16 concurrent writers activate once with 16 effects; a second session gets `session_conflict` |
| Offline returns durable `pending_sync` or visible failure exactly by policy | `TestOfflineJournalingAndPolicy`, harness unknown-assignment case | Reads fail `offline_rejected`; writes journal with full evidence fields; policy-off and journal-less hosts fail visibly; repeats return the same outcome without duplicating |
| Restarted replay validates origin, proof, expiry, identity; fails visibly on revocation, end, expiry, terminal result, policy change, version conflict | `TestJournalSurvivesRestartAndReplays`, `TestReplayFailureMatrix` | Close/reopen preserves records; success applies once with transport-side idempotency; revocation/end/expiry/terminal/policy/version/tamper become terminal rejections; transient failures stay `retryable` and pending |

## Cross-cutting proofs

| Property | Proving test |
| --- | --- |
| Stdout purity (every line JSON-RPC, diagnostics on stderr, no leaks) | `TestStdoutPurityAndSessionFlow`, harness purity assertions on the real binary |
| Startup race (assignment not yet active) | `TestStartupRaceFailsVisibleAndPure`, harness unknown-execution case |
| Version conflicts and request idempotency | `TestVersionConflictAndIdempotency` (`stale_version`; one effect per `request_id`) |
| Input bounds mirror C08 | `TestWriteValidationRejects` (title/body/priority/percent/request-id rules) |
| Capability closes on revocation, execution end, accepted result | `TestRevocationExecutionEndAndTerminalResultClose` (sticky close) |
| Environment discipline (ten scoped values, bearer refusal) | `TestParseEnvAcceptsScopedValues`, `TestParseEnvRefusesBearerMaterial`, `TestParseEnvRejectsMalformed`, harness bearer case |
| Journal migration head | `TestJournalMigrationAndBounds` (`PRAGMA user_version = 11`) |
| Contract determinism | `TestGoldenInspectorTranscript` (byte-pinned stdio transcript) |
