# Work-record runtime proofs

`pnpm test:c08` owns `run.ts`: real independent Workers dispatch production Hub
commands to disposable D1 and prove task/run races and immutable context history.

`pnpm test:c10` owns `privacy.ts`: production Hub creates **shared** synthetic
tasks, then test-only fixture inserts exercise dormant private policy/grant SQL
against real workerd D1. It verifies current authority, role/grant intersection,
pagination/counts, policy retention and atomic batch failure. It does not certify
private task creation, MCP/HTTP delivery, realtime, artifact access or a provider.

`pnpm test:c11` adds `delivery.ts`: staged human task selection/board/deck SQL,
exact-input command idempotency and revoked cached comment/context replies are
checked against real D1 and the production Hub behind independent Workers.
It also checks run-bound artifact metadata, conditional view-grant redemption,
measurements and review-timer permissions/cache revocation. Artifact bytes are
not uploaded to R2 by this harness. The partial metadata slice also proves
shared-only stuck-upload selection and retained-epoch denial on real D1,
including run-free workspace uploads. Human retention reads prove visible-only
canonical log parents/keys and a separate configured-system selector. Exact
upload recovery runs through the production Hub on two independent Workers;
fresh-proof target-ledger retries converge without duplicate abandonment effects.
An independent consumed live grant inserted before the real D1 batch rolls back
proof consumption, version changes, recovery ledger, outbox and audit effects.
Current-scope sentinels reject stale membership epochs even when a final composite
has no references. These bounded checks do not certify diagnostic snapshots,
audit/queue totals, other recovery kinds or private destructive retention.
The bounded artifact-audit extension dispatches all nine canonical actions
through the production Hub and checks strict reconstructed wrappers, exact
upload/view provenance, genuine run-free history and expired/consumed grants.
Hidden, misbound and malformed records do not consume visible pagination slots
or counts; hidden and unknown anchors share one denial. Independent parent
privatization and retained-epoch loss before the final read fence delivery,
including an empty page. An observed anchor separates the synthetic pagination
history from earlier probes; dispatch times come from the production Hub clock.
Other audit families and opaque positions remain uncertified.
Exact artifact-version evidence is checked
with human, originating-run and task-bound delegation ceilings, including current
scope denial. Independent source privatization before a real D1 result batch
rolls back submission, state, receipt and audit effects. Historical malformed
and duplicate-key references are omitted from
delivery without rewriting immutable rows. Mounted HTTP/MCP tests and local
assignment fixtures are separate synthetic-authority proofs. Notification fanout, final
push-endpoint selection and historical lists also run through real D1 with
shared/private parents and current preference denial; no push is contacted.
This is not a full delivery certificate: creation/sharing, private R2/browser-byte
delivery, opaque realtime positions, in-flight natural credential expiry and
the remaining matrix stay gated.

All use the checked-in ordered migrations in a disposable local harness. No
pilot enrollment, persistent local database, real user, credential or Terminal
session is touched. No extra dependencies or generated fixtures are introduced.
