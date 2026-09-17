# L06 fault-injection matrix

Implementation, gate and evidence are complete; the package stays `planned`
because L05 is not `done`. This report names the owning automated check and
the observed result for every Scope and Acceptance bullet. No terminal
transcript, correlation secret, provider payload or local path is retained.

## Session binding and races

| Fault or boundary | Observed result | Owning test |
| --- | --- | --- |
| 16 concurrent first sessions, distinct IDs | Exactly one binds; 15 quarantine with `session_conflict`; one journal row | `TestFirstSessionRaceBindsExactlyOne` |
| Duplicate SessionStart, same/new/absent source ID | Matches binding; no second session event | `TestDuplicateSessionStartMatchesBinding` |
| Competing session after bind | Quarantined; binding unchanged | `TestDuplicateSessionStartMatchesBinding` |
| Turn wins race against its own SessionStart | Binds; later SessionStart journals normally | `TestSessionScopedHooksBindAndLaterHooksMustMatch` |
| Foreign session after bind | Quarantined with `session_conflict` | `TestSessionScopedHooksBindAndLaterHooksMustMatch` |
| Concurrent first sessions across generations | One binding per generation | `TestConcurrentFirstSessionsAcrossGenerations` |
| Stable hook event redelivered | Single journal row; `duplicate` receipt | `TestSessionScopedHooksBindAndLaterHooksMustMatch` |
| Real L05 assignment through production backend | View matches immutable claim; hook binds | `TestJournalBackendReadsImmutableAssignment` |

## Validation and windows

| Fault or boundary | Observed result | Owning test |
| --- | --- | --- |
| Wrong correlation token | Rejected `correlation_rejected`; no rows | `TestHookValidationIsVisibleAndSafe` |
| Wrong assignment generation | Rejected `unknown_assignment`; no rows | `TestHookValidationIsVisibleAndSafe` |
| Provider/assignment mismatch | Rejected `provider_mismatch` before parsing | `TestHookValidationIsVisibleAndSafe` |
| Uncertified provider matching assignment | `provider_event_invalid`, nothing journaled | `TestHookValidationIsVisibleAndSafe` |
| Oversized stdin (>64 KiB) | `provider_event_invalid`, nothing stored | `TestHookValidationIsVisibleAndSafe` |
| Capture before creation / after grace end | Rejected `event_window_closed`; earlier envelopes intact | `TestFinalHookGraceReplay` |
| Capture inside grace, replayed after expiry | Accepted; uploads without the correlation secret | `TestDelayedFinalHookReplayNeedsNoCorrelationSecret` |
| Daemon-only kinds via hook path | No mapping exists; statically asserted | `TestDaemonKindsCannotPassThroughHooks` |
| Unknown provider fields | Dropped; submission payload is `{}` | `TestUnknownFieldsNeverReachCloud` |

## Crash, disk and offline inbox

| Fault or boundary | Observed result | Owning test |
| --- | --- | --- |
| Daemon store killed and reopened mid-stream | All 10 accepted events survive; sequences unique; every row wire-valid; 10 server effects | `TestDaemonKillDuringHookLosesNoAcceptedEvent` |
| Write fault (disk-full class) during ingest | `storage_failed`; no partial rows, binding or quarantine; inbox fallback imports after recovery | `TestDiskFullFailsWithoutPartialRows` |
| Daemon down at capture | Authenticated inbox file; exactly-once import; binding established | `TestInboxRoundTripAfterDaemonDown` |
| Corrupt, forged, unknown-execution captures | Quarantined with reason; `telemetry_degraded` raised; valid capture still imports; inbox drains | `TestInboxCorruptionQuarantinesVisibly` |
| Full inbox (256 files) | `inbox_full`; no silent loss | `TestInboxFullIsVisible` |
| Observation checkpoint fault | Import aborts; no journal rows | `TestObservationImportFailureRollsBack` |

## Upload and acknowledgement

| Fault or boundary | Observed result | Owning test |
| --- | --- | --- |
| Healthy transport | Accepted rows deleted; one effect per event | `TestUploadAcceptsAndDeletesOnlyFromDisposition` |
| Network death before send | Rows kept; recovery uploads once each | `TestUploadAckBoundariesKeepRowsQueued` (offline) |
| Corrupt acknowledgement body | No row deleted or quarantined; recovery succeeds | `TestUploadAckBoundariesKeepRowsQueued` (corrupt) |
| Empty disposition batch | Rows kept with backoff; recovery succeeds | `TestUploadAckBoundariesKeepRowsQueued` (empty) |
| Lost acknowledgement after server commit | Retry delivers same event IDs; one effect each | `TestKilledUploadRetriesToOneEffect` |
| `retryable` disposition | Row kept with backoff; correct row retained | `TestRetryableKeepsRowAndBacksOff` |
| `permanently_rejected` mid-batch | Exactly that row quarantines; later events upload | `TestPermanentRejectQuarantinesWithoutBlocking` |
| `already_committed` | Rows deleted without duplicate effects | `TestAlreadyCommittedDeletesWithoutDuplicateEffect` |

## Concurrency, latency and provenance

| Fault or boundary | Observed result | Owning test |
| --- | --- | --- |
| 4 concurrent runs x 25 hooks, one stream | 100 rows; unique sequences; per-run attribution intact | `TestConcurrentRunsKeepAttribution` |
| Cloud unreachable during ingest | 20 hooks journal in well under the bound; none dropped | `TestHookLatencyIndependentOfCloud` |
| 90-second heartbeat gap | Preserved as observed; no backfill | `TestObservationImportKeepsProvenance` |
| Daemon observations via import | `runner_observed` provenance; checkpoint co-committed | `TestObservationImportKeepsProvenance` |
| Two enrollments, restart | Distinct streams; sequences 1,1 then 2; no rotation | `TestStreamsArePerRunnerAndEpochStable` |
| F02 fake ingest contract | 6/6 disposition checks: accept, replay, reject, recovery | `tools/journal/run.ts`, `fake-ingest.json` |
| CLI ingest and status | `hook_status` receipt and backlog payloads validate as `local-rpc`; no secret leak | `TestHookIngestAndStatus`, `TestHookIngestRejectsBadInput` |

## Limits of this evidence

- Only the fake provider adapter normalizes hooks; real Claude/Codex/Grok hook
  shapes belong to L07/P01 and are not claimed here.
- The disk-full check injects a write fault of the same class (read-only
  connection) rather than filling the test volume byte-exactly.
- The upload transport is the F02 fake and a scripted Go double; the real E01
  ingest endpoint is not claimed.
- Real Terminal acceptance remains L05's blocker and is not claimed by this
  journal evidence.
