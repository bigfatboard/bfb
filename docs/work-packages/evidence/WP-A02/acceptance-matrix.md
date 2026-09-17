# A02 acceptance matrix

Each Acceptance bullet maps to automated tests. All fixtures are synthetic;
no provider executes and no human-only context leaves the test boundary.

| Acceptance | Proving test |
| --- | --- |
| Agent requests attention, permitted human answers, current waiter returns, and later retrieval returns identical resolution metadata | `packages/domain/test/attention.test.ts` answers/resolves and rereads identical records; `internal/localmcp/attention_test.go` `TestWaitReturnsAnswerCommittedMidWait`; `tools/attention/run.ts` `waiter_pending_polls` → `answered` → `waiter_returned_identical`; route test rereads the answered record with observations |
| Wait returns pending within 30 seconds and can be repeated safely | `TestWaitTimesOutPendingAndRepeatsSafely` (250 ms deadline returns pending well under the bound; same `request_id` re-reads and observes the late answer); harness `timeout_retry` (five pending polls, then identical repeated reads) |
| Reviewer can answer a clarification/review request but cannot satisfy an owner-only policy/credential approval | Domain permission test (reviewer/member `forbidden` on credential, owner allowed); route test 403 on credential for reviewer; Playwright reviewer flow answers review and is rejected on credential; `permission_matrix.md` |
| Duplicate answer attempts do not overwrite the committed response silently | Domain duplicate test (`already_answered`, answer/by/version kept); route test 409 carries the committed record; harness `duplicate_rejected` |
| An answer survives disconnect and is not dependent on WebSocket delivery | Harness evicts the hub Durable Object and re-reads the identical answer from D1; Playwright reload flow re-reads the committed answer; UI and waiter both poll committed records (`timeout-reconnect-trace.md`) |
| Native provider permission remains visibly separate | `NATIVE_PERMISSION_NOTICE` asserted in `apps/web/test/attention.test.ts` and visible in the Playwright owner flow; contract freezes the separation; answers grant no authority (domain no-grant test) |

Negative cases also covered: unknown/foreign execution (`request_rejected`),
terminal run (`invalid_transition`), stale version, early resolve,
cross-project hidden reads (`not_found`/empty), revoked epoch
(`stale_authorization`), revoked capability (`revoked` then sticky
`capability_closed`), provisional mutation (`session_not_bound`), offline
tools (`offline_rejected`), oversized/empty/malformed inputs, and run-boundary
confusion on `get_attention` (`not_found`).
