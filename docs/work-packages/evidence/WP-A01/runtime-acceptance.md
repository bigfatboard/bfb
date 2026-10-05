# A01 connected runtime acceptance

Tested commit: `adbf7403bbafb7482ff7fe6f2c4881bf139459e6`.
Exact `pnpm test:a01`, full `pnpm verify`, Linux cross-build and worktree checks
passed from a clean macOS checkout. See [command results](runtime-command-result.json)
and the [current manifest](runtime-manifest.json). The original manifest,
unsigned pending record and injected replay matrix remain historical evidence.

## Scope acceptance

| Requirement | Automated proof | Observed result |
| --- | --- | --- |
| Wrong caller, assignment or session cannot acquire/use authority | `TestVerifyPeerMaliciousMatrix`, `TestCompetingSessionNeverActivates`, `TestAgentOwnershipRejectsNativeUncertainty`, `TestNativeAgentWork` | Wrong kernel peer, correlation, generation, observed/canonical session and lost native ownership fail closed. |
| Caller IDs cannot escape the derived boundary | `TestCallerSuppliedIDsCannotEscape`; domain agent-work boundary cases; native foreign-task and owned-caller IPC attacks | No foreign task, parent, workspace or execution effects. |
| No human-only context or workflow/policy escalation | `TestWriteValidationRejects`, `TestGoldenInspectorTranscript`; domain audience/proposal cases; native bootstrap and root-proposal checks | Human-only context stays absent; forbidden lifecycle fields and root promotion fail; unsupported tools are not enabled. |
| Safe bootstrap, genuine binding and competing-session rejection | `TestProvisionalReadOnlyThenActivation`, `TestConcurrentActivationHasOneWinner`, `TestMCPStdioRejectsMutationWhileUnbound`, native L06 ingestion | Reads work provisionally; all four writes fail before trusted binding with unchanged business state; canonical binding is an explicit authenticated command. |
| Offline receipt or visible failure follows exact policy | `TestWorkServiceOutageNeedsOriginalPermissionAndFreshProcessAnchor`, `TestWorkCapturePermissionAndRepositoryHashNeverWiden`, native online-only and outage phases | Default denial grants no autonomous replay; permitted capture is signed and durable before `pending_sync`; later policy enablement cannot upgrade an old record. |
| Restarted replay retains identity and current authority | `TestWorkServiceLostReplyRestartUsesOriginalOperation`, `TestWorkServiceRevocationAndExpiryPreserveUnknown`, cloud capture suites, native recovery/denial phases | MCP exit and signed-daemon restart preserve capture/key/fingerprint; ordinary same-fence renewal permits one effect; revocation, closure, expiry, policy/version conflicts and native uncertainty deny delivery without inventing no-effect certainty. |

## Protected capture and recovery

| Invariant | Proving tests |
| --- | --- |
| Original send/receipt anchors; suspend, rollback and restart cannot extend permission | `TestCaptureTimingCountsSuspendWithoutWallClock`, `TestCaptureTimingDelayedRetryKeepsBothOriginalAnchors`, `TestCaptureTimingClockFaultsRemainSticky`, `TestWorkAuthorityDelayedReplyRetainsOriginalSendAndReceipt`, `TestWorkAuthorityExactHorizonReplyAndKnownDenialsNeverCache` |
| Exact policy versions, historical hashes and action-bound one-use proof | `offline-policy-authority.test.ts`, `offline-policy-migration.test.ts`, cloud capture policy cases; native proof-bound project tightening |
| Complete enrolled-key capture and stable business identity | `TestAgentCaptureSignsOnlyFixedEnrolledMetadata`, `TestAgentCaptureRejectsTamperingAndNoncanonicalSignature`, `TestWorkCapturePreservesCanonicalOriginalForEveryCommand`, `TestAgentOperationKeyMatchesBusinessCanonicalVectors`; cloud signed-scope/confirmation tampering cases |
| Marker before network; durable acknowledgement before success | `TestWorkServiceFailedMarkerSendsNothingAndFailedAckStaysUnknown`, `TestWorkServiceAcknowledgementSurvivesCallerCancellation`; native SQLite marker/acknowledgement fault injection |
| Effect certainty survives denied delivery | `TestWorkServicePostflightDenialKeepsDurableEffectPrivate`, `TestWorkServiceCurrentRevocationIsVisibleAfterPriorDeliveryDenial`; native postflight lock/history, uncertain expiry and revocation phases |
| Exclusive claims, quotas, recovery fairness and checked storage faults | `TestWorkJournalConcurrentExclusiveClaims`, `TestWorkJournalClaimDeadlineReclaimAndSuspend`, `TestWorkJournalAdmissionQuotaRaceAndRepeatAtCapacity`, `TestWorkServiceRecoveryCursorDoesNotStarveLaterIntent`, `TestWorkAuthorityLocalStorageFailureStopsQueuedDelivery` |
| Fresh authority before cached results, with renewal limited to freshness fields | `TestWorkAuthorityOnlyFreshnessFieldsMayRenew`; domain/Worker cached-authority cases; native ordinary same-owner lease renewal and original-result replay |
| Atomic migration and no legacy permission backfill | `TestWorkJournalLegacyMigrationPreservesAndQuarantines`, `TestWorkJournalRejectsForeignFutureAndInterruptedSchemas`, `TestWorkJournalMigrationRollbackLeavesAmbiguousIdentityClosed`, `TestWorkJournalIdentityLossReplacementAndHalfCreation`, `TestWorkJournalProcessCrash`; CLI unsupported/no-storage regressions |
| Closed versioned IPC, bounds and private-safe receipts | `TestAgentWorkNegotiationDoesNotDowngrade`, `TestAgentWorkEnvelopeKeepsVersionedShapesSeparate`, `TestAgentReceiptScopeAndClosedPrivacy`; shared protocol fixtures, raw-body/numeric cloud cases and compiled stdio assertions |

`TestNativeAgentWork` uses the compiled CLI, development-signed daemon and
supervisor, Keychain enrollment, production L06 ingestion, possession-authenticated
Worker/WorkspaceHub/D1 commands, real kernel identity and an actual held flock.
Inventory is published through the signed runner channel before authority checks.
Fault barriers act before upstream dispatch or after a real cloud commit; SQLite
triggers fail the real marker or acknowledgement write. Only the exact synthetic
fault is removed for recovery. Production request budgets are not raised; the
fixture paces requests within them.

This proves A01's typed runtime integration with a synthetic provider-shaped
process. It does not prove Terminal delivery, full L05 launch/PTY handoff, live
provider ancestry/continuation, or the end-to-end MVP. The signature protects
immutable capture, not later local disposition history or filesystem rollback.
Local state remains user-only, not encrypted or resistant to deletion by that user.
No real workspace's offline permission was enabled. Dependent packages require
their own current integration and acceptance evidence.
