# A02 timeout and reconnect trace

## Bounded wait

`bfb_wait_for_attention` polls committed attention state on a 100 ms cadence
until the request leaves `open`, then returns the same resolution metadata a
later `bfb_get_attention` returns, or `pending` when the 30-second bound
(`ATTENTION_WAIT_TIMEOUT_MS`) expires. Pending outcomes are never memoized:
repeating a wait with the same `request_id` re-reads committed state and is
side-effect free.

Observed: `TestWaitTimesOutPendingAndRepeatsSafely` expires a 250 ms wait as
`pending` in ~250 ms (far under the bound) and the repeated wait observes the
late answer; `TestWaitReturnsAnswerCommittedMidWait` returns an answer
committed 150 ms into the wait in ~200 ms. The harness `timeout_retry`
recording shows five pending polls followed by three identical `answered`
reads.

## Retry

A timed-out waiter simply waits again or reads later: the committed answer
is durable in D1, and every poll is an independent read. The harness answers
after five pending polls and every later read returns the identical record
(`waiter_returned_identical`).

## Disconnect and reconnect

There is no attention push transport: UI and runner surfaces poll committed
records, so there is no socket state to lose. Proven twice:

- `tools/attention/run.ts` evicts the `WorkspaceHub` Durable Object after the
  answer commits, then re-reads the identical answer, rank list, and
  observations from D1 (`reconnect_reread`).
- The Playwright reload flow signs in, answers, reloads the page, and
  re-reads the committed `answered` state with its answer text.

Offline agents fail visibly (`offline_rejected` on all three tools) instead
of queueing stale questions; after the channel returns, request and wait
succeed against committed state (`TestAttentionOfflineFailsVisibleThenReconnects`).
