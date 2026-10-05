// ABOUTME: Proves bounded write-ahead intent, claim and truthful disposition behavior.
// ABOUTME: Exercises conflicts, suspend deadlines, failed persistence and corrupt history without network effects.

package agentwork

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

const workTestID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
const workOtherID = "01ARZ3NDEKTSV4RRFFQ69G5FAW"

type workTestClock struct {
	mu  sync.Mutex
	now time.Duration
	err error
}

func (clock *workTestClock) read() (time.Duration, error) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now, clock.err
}

func (clock *workTestClock) set(now time.Duration, err error) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.now, clock.err = now, err
}

func newWorkTestJournal(t *testing.T) (*workJournal, *workTestClock, string) {
	t.Helper()
	clock := &workTestClock{}
	path := filepath.Join(t.TempDir(), "local-mcp-journal.sqlite")
	if err := os.Chmod(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	journal, err := openWorkJournal(context.Background(), path, clock.read)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = journal.close() })
	return journal, clock, path
}

func workTestJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// These fixtures satisfy the closed wire shape, not a cryptographic admission
// proof. Real enrolled-key verification belongs to the admission/replay consumer.
func workTestIntent(t *testing.T, requestID, runID, mode string) journalIntent {
	t.Helper()
	requestID = "journal-" + requestID
	permission := map[string]any{"allowed_tools": []string{"bfb_add_comment"}, "max_pending_age_seconds": 300}
	binding := generated.AgentSessionReference{ProviderSessionId: workTestID, Provider: "fake", ObservedSessionId: "fixture-session"}
	confirmation := generated.AgentCaptureConfirmationResult{
		SchemaVersion: 1, ConfirmationId: workTestID, WorkspaceId: workTestID, ProjectId: workTestID,
		SourceTaskId: workTestID, RunId: runID, RunExecutionId: runID, RunnerId: workTestID, CheckoutId: workTestID,
		RequestingHumanId: workTestID, RunnerOwnerHumanId: workTestID, AssignmentGeneration: 1, FencingGeneration: 1,
		RequestingHumanAuthorizationEpoch: 1, RunnerOwnerAuthorizationEpoch: 1, RunnerAuthorizationEpoch: 1, RunnerGrantEpoch: 1,
		SnapshotGeneration: 1, WorkspacePolicyVersion: 1, ProjectPolicyVersion: 1, RepositoryConfigVersion: 1, RunnerTokenEpoch: 0,
		PhysicalWorktreeHash: "sha256:" + strings.Repeat("a", 64), RunnerKeyThumbprint: "sha256:" + strings.Repeat("b", 64),
		SnapshotHash: "sha256:" + strings.Repeat("c", 64), SnapshotRepositoryConfigHash: "sha256:" + strings.Repeat("d", 64), ApprovedRepositoryConfigHash: "sha256:" + strings.Repeat("d", 64),
		Binding: binding, ConfiguredPermission: permission, ConfirmedAt: "2026-10-06T00:00:00.000Z", LeaseExpiresAt: "2026-10-06T00:00:45.000Z", CredentialExpiresAt: "2026-10-06T00:01:00.000Z",
	}
	reference := generated.AgentWorkRequest{SchemaVersion: 1, RunExecutionId: runID, AssignmentGeneration: 1, RequestId: requestID}
	request, err := protocol.CanonicalAgentWriteRequest("agent_run.comment", []byte(workTestJSON(t, map[string]any{"reference": reference, "binding": binding, "body": "original whitespace  "})))
	if err != nil {
		t.Fatal(err)
	}
	key, err := agentOperationKey("agent_run.comment", reference)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(request))
	fingerprint := hex.EncodeToString(digest[:])
	expires := "2026-10-06T00:05:01.000Z"
	capture := generated.AgentWorkCapture{
		SchemaVersion: 1, Confirmation: confirmation, Operation: map[string]any{
			"command_name": "agent_run.comment", "tool": "bfb_add_comment", "operation_schema_version": 1, "operation_key": key, "request_id": requestID,
			"payload_hash": "sha256:" + fingerprint, "expected_version": nil, "target_task_id": workTestID, "parent_task_id": nil,
		}, AdmissionMode: mode, AdmittedPermission: permission, CapturedAt: "2026-10-06T00:00:01.000Z", IntentExpiresAt: &expires,
		Signature: base64.RawURLEncoding.EncodeToString(make([]byte, 64)),
	}
	if mode == "online_only" {
		capture.AdmittedPermission = map[string]any{"allowed_tools": []string{}, "max_pending_age_seconds": 0}
		capture.IntentExpiresAt = nil
	}
	intent := journalIntent{key, fingerprint, "bfb_add_comment", runID, mode, request, workTestJSON(t, confirmation), workTestJSON(t, capture)}
	if err = validateJournalIntent(intent); err != nil {
		t.Fatalf("invalid fixture: %v\n%s", err, intent.CaptureJSON)
	}
	return intent
}

func workTestOutcome(t *testing.T, intent journalIntent) string {
	t.Helper()
	var capture generated.AgentWorkCapture
	if err := json.Unmarshal([]byte(intent.CaptureJSON), &capture); err != nil {
		t.Fatal(err)
	}
	return workTestJSON(t, map[string]any{"id": workOtherID, "origin": generated.AgentEffectOrigin{RunId: capture.Confirmation.RunId, RunExecutionId: capture.Confirmation.RunExecutionId, AssignmentGeneration: capture.Confirmation.AssignmentGeneration, ProviderSessionId: capture.Confirmation.Binding.ProviderSessionId}})
}

func TestWorkJournalAtomicOnlineAndMatchingAcknowledgement(t *testing.T) {
	journal, _, _ := newWorkTestJournal(t)
	ctx := context.Background()
	intent := workTestIntent(t, "online-first", workTestID, "online_only")
	record, added, err := journal.admit(ctx, intent, true)
	if err != nil || !added || record.Claim == nil || record.EverDispatched == nil || record.Effect != "unknown" {
		t.Fatalf("atomic dispatch: %+v %v %v", record, added, err)
	}
	claims, err := journal.claimBatch(ctx, 16)
	if err != nil || len(claims) != 0 {
		t.Fatal("online-only became autonomous", claims, err)
	}
	wrong := *record.Claim
	wrong.Token = strings.Repeat("f", 64)
	if err = journal.acknowledge(ctx, wrong, workTestOutcome(t, intent)); !errors.Is(err, errWorkClaim) {
		t.Fatal("wrong claim acknowledged", err)
	}
	if err = journal.acknowledge(ctx, *record.Claim, workTestOutcome(t, intent)); err != nil {
		t.Fatal(err)
	}
	stored, found, err := journal.lookup(ctx, intent.OperationKey)
	if err != nil || !found || stored.State != "applied" || stored.Effect != "applied" || stored.Claim != nil || stored.ReceiptJSON == "" {
		t.Fatal("success not durable", stored, found, err)
	}
	if err = journal.block(ctx, *record.Claim, "revoked"); !errors.Is(err, errWorkClaim) {
		t.Fatal("later denial rewrote applied fact", err)
	}
	if _, err = journal.db.Exec("UPDATE work_delivery SET state='blocked',effect='unknown',outcome_json=NULL,reason_code='revoked' WHERE operation_key=?", intent.OperationKey); err == nil {
		t.Fatal("applied fact rewritable")
	}
}

func TestWorkJournalRetryKeepsIdentityCaptureAndMode(t *testing.T) {
	journal, _, _ := newWorkTestJournal(t)
	ctx := context.Background()
	intent := workTestIntent(t, "repeat", workTestID, "offline_admitted")
	first, _, err := journal.admit(ctx, intent, false)
	if err != nil {
		t.Fatal(err)
	}
	retry := intent
	retry.CaptureJSON, retry.ConfirmationJSON, retry.AdmissionMode = "not replacement evidence", "", "online_only"
	record, added, err := journal.admit(ctx, retry, true)
	if err != nil || added || record.Intent != first.Intent || record.Claim != nil || record.EverDispatched != nil {
		t.Fatal("retry replaced original", record, added, err)
	}
	changed := intent
	changed.RequestJSON = strings.Replace(changed.RequestJSON, "original whitespace  ", "changed body", 1)
	canonical, err := protocol.CanonicalAgentWriteRequest("agent_run.comment", []byte(changed.RequestJSON))
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(canonical))
	changed.Fingerprint = hex.EncodeToString(digest[:])
	if _, _, err = journal.admit(ctx, changed, false); !errors.Is(err, errWorkConflict) {
		t.Fatal("changed payload not conflicting", err)
	}
	otherRun := workTestIntent(t, "repeat", workOtherID, "offline_admitted")
	if _, added, err = journal.admit(ctx, otherRun, false); err != nil || !added || otherRun.OperationKey == intent.OperationKey {
		t.Fatal("raw request identity collided across runs", added, err)
	}
}

func TestWorkJournalClaimDeadlineReclaimAndSuspend(t *testing.T) {
	journal, clock, _ := newWorkTestJournal(t)
	ctx := context.Background()
	intent := workTestIntent(t, "suspend", workTestID, "offline_admitted")
	if _, _, err := journal.admit(ctx, intent, false); err != nil {
		t.Fatal(err)
	}
	first, err := journal.claimOperation(ctx, intent.OperationKey)
	if err != nil {
		t.Fatal(err)
	}
	if err = journal.markDispatch(ctx, *first.Claim); err != nil {
		t.Fatal(err)
	}
	clock.set(30*time.Second, nil) // Simulated suspend includes every elapsed second.
	if err = journal.acknowledge(ctx, *first.Claim, workTestOutcome(t, intent)); !errors.Is(err, errWorkClaim) {
		t.Fatal("exact deadline acknowledged", err)
	}
	second, err := journal.claimOperation(ctx, intent.OperationKey)
	if err != nil || second.Claim.Token == first.Claim.Token || second.Effect != "unknown" || second.EverDispatched == nil || *second.EverDispatched != 0 {
		t.Fatal("claim refreshed history", second, err)
	}
	if err = journal.markDispatch(ctx, *second.Claim); err != nil {
		t.Fatal(err)
	}
	if err = journal.release(ctx, *first.Claim); !errors.Is(err, errWorkClaim) {
		t.Fatal("stale release accepted", err)
	}
	if err = journal.block(ctx, *second.Claim, "policy_rejected"); err != nil {
		t.Fatal(err)
	}
	stored, _, err := journal.lookup(ctx, intent.OperationKey)
	if err != nil || stored.State != "blocked" || stored.Effect != "unknown" || !strings.Contains(stored.ReceiptJSON, `"effect_certainty":"possibly_applied"`) {
		t.Fatal("uncertain denial became no effect", stored, err)
	}
}

func TestWorkJournalNeverSentDenialAndRetryRelease(t *testing.T) {
	journal, _, _ := newWorkTestJournal(t)
	ctx := context.Background()
	intent := workTestIntent(t, "never-sent", workTestID, "offline_admitted")
	if _, _, err := journal.admit(ctx, intent, false); err != nil {
		t.Fatal(err)
	}
	record, err := journal.claimOperation(ctx, intent.OperationKey)
	if err != nil {
		t.Fatal(err)
	}
	if err = journal.acknowledge(ctx, *record.Claim, workTestOutcome(t, intent)); !errors.Is(err, errWorkInvalid) {
		t.Fatal("never sent acknowledged as applied", err)
	}
	if err = journal.release(ctx, *record.Claim); err != nil {
		t.Fatal(err)
	}
	next, err := journal.claimOperation(ctx, intent.OperationKey)
	if err != nil || next.Claim.Token == record.Claim.Token {
		t.Fatal(next, err)
	}
	if err = journal.block(ctx, *next.Claim, "revoked"); err != nil {
		t.Fatal(err)
	}
	stored, _, err := journal.lookup(ctx, intent.OperationKey)
	if err != nil || stored.Effect != "never_sent" || stored.EverDispatched != nil || !strings.Contains(stored.ReceiptJSON, `"delivery_state":"rejected"`) {
		t.Fatal(stored, err)
	}
}

func TestWorkJournalFailedMarkerAndAcknowledgement(t *testing.T) {
	journal, _, _ := newWorkTestJournal(t)
	ctx := context.Background()
	intent := workTestIntent(t, "persistence", workTestID, "offline_admitted")
	if _, err := journal.db.Exec(`CREATE TRIGGER fail_marker BEFORE UPDATE ON work_delivery WHEN NEW.ever_dispatched_ns IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected storage failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := journal.admit(ctx, intent, true); !errors.Is(err, errWorkStorage) {
		t.Fatal("marker failure did not abort admission", err)
	}
	if _, found, err := journal.lookup(ctx, intent.OperationKey); err != nil || found {
		t.Fatal("partial immediate transaction survived", found, err)
	}
	if _, _, err := journal.admit(ctx, intent, false); err != nil {
		t.Fatal(err)
	}
	record, err := journal.claimOperation(ctx, intent.OperationKey)
	if err != nil {
		t.Fatal(err)
	}
	if err = journal.markDispatch(ctx, *record.Claim); !errors.Is(err, errWorkStorage) {
		t.Fatal("marker failed silently", err)
	}
	stored, _, err := journal.lookup(ctx, intent.OperationKey)
	if err != nil || stored.Effect != "never_sent" || stored.EverDispatched != nil {
		t.Fatal(stored, err)
	}
	if _, err = journal.db.Exec(`DROP TRIGGER fail_marker; CREATE TRIGGER fail_ack BEFORE UPDATE ON work_delivery WHEN NEW.state='applied' BEGIN SELECT RAISE(ABORT,'injected ack failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err = journal.markDispatch(ctx, *record.Claim); err != nil {
		t.Fatal(err)
	}
	if err = journal.acknowledge(ctx, *record.Claim, workTestOutcome(t, intent)); !errors.Is(err, errWorkStorage) {
		t.Fatal("ack failure reported applied", err)
	}
	stored, _, err = journal.lookup(ctx, intent.OperationKey)
	if err != nil || stored.Effect != "unknown" || stored.State != "open" || stored.OutcomeJSON != "" {
		t.Fatal("ack loss erased uncertainty", stored, err)
	}
	if _, err = journal.db.Exec(`DROP TRIGGER fail_ack; CREATE TRIGGER fail_block BEFORE UPDATE ON work_delivery WHEN NEW.state='blocked' BEGIN SELECT RAISE(ABORT,'injected block failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err = journal.block(ctx, *record.Claim, "revoked"); !errors.Is(err, errWorkStorage) {
		t.Fatal("blocked acknowledgement ignored", err)
	}
	stored, _, err = journal.lookup(ctx, intent.OperationKey)
	if err != nil || stored.Effect != "unknown" || stored.State != "open" {
		t.Fatal("failed rejection erased uncertainty", stored, err)
	}
}

func TestWorkJournalClockFailuresStaySticky(t *testing.T) {
	for _, test := range []struct {
		name   string
		sample time.Duration
		err    error
	}{
		{"negative", -1, nil}, {"backwards", time.Second, nil}, {"unavailable", 0, errors.New("clock unavailable")}, {"overflow", time.Duration(math.MaxInt64), nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			journal, clock, _ := newWorkTestJournal(t)
			clock.set(2*time.Second, nil)
			intent := workTestIntent(t, "clock", workTestID, "offline_admitted")
			if _, _, err := journal.admit(context.Background(), intent, true); err != nil {
				t.Fatal(err)
			}
			clock.set(test.sample, test.err)
			if _, err := journal.claimBatch(context.Background(), 1); !errors.Is(err, errWorkStorage) {
				t.Fatal("clock failure not sticky", err)
			}
			clock.set(3*time.Second, nil)
			if _, err := journal.claimBatch(context.Background(), 1); !errors.Is(err, errWorkStorage) {
				t.Fatal("failed clock recovered in same incarnation", err)
			}
		})
	}
}

func TestWorkJournalMissingDeliveryRemainsUnknown(t *testing.T) {
	journal, _, _ := newWorkTestJournal(t)
	intent := workTestIntent(t, "corrupt", workTestID, "offline_admitted")
	if _, _, err := journal.admit(context.Background(), intent, false); err != nil {
		t.Fatal(err)
	}
	if _, err := journal.db.Exec("DROP TRIGGER work_delivery_no_delete; DELETE FROM work_delivery WHERE operation_key=?", intent.OperationKey); err != nil {
		t.Fatal(err)
	}
	record, found, err := journal.lookup(context.Background(), intent.OperationKey)
	if !errors.Is(err, errWorkCorrupt) || !found || record.State != "quarantined" || record.Effect != "unknown" || record.Reason != "storage_corrupt" {
		t.Fatal("missing history fabricated certainty", record, found, err)
	}
	if _, _, err = journal.admit(context.Background(), intent, true); !errors.Is(err, errWorkCorrupt) {
		t.Fatal("corruption reset intent", err)
	}
	if _, err = journal.claimBatch(context.Background(), 1); !errors.Is(err, errWorkCorrupt) {
		t.Fatal("missing history silently skipped", err)
	}
}

func TestWorkJournalAdmissionQuotaRaceAndRepeatAtCapacity(t *testing.T) {
	journal, _, _ := newWorkTestJournal(t)
	ctx := context.Background()
	first := workTestIntent(t, "capacity-first", workTestID, "offline_admitted")
	for n := 0; n < workRunUnresolvedLimit-1; n++ {
		intent := first
		if n != 0 {
			intent = workTestIntent(t, fmt.Sprintf("capacity-%d", n), workTestID, "offline_admitted")
		}
		if _, _, err := journal.admit(ctx, intent, false); err != nil {
			t.Fatal(n, err)
		}
	}
	intents := []journalIntent{workTestIntent(t, "racer-one", workTestID, "offline_admitted"), workTestIntent(t, "racer-two", workTestID, "offline_admitted")}
	var wg sync.WaitGroup
	errorsOut := make(chan error, 2)
	for _, intent := range intents {
		wg.Add(1)
		go func() { defer wg.Done(); _, _, err := journal.admit(ctx, intent, false); errorsOut <- err }()
	}
	wg.Wait()
	close(errorsOut)
	success, quota := 0, 0
	for err := range errorsOut {
		if err == nil {
			success++
		} else if errors.Is(err, errWorkQuota) {
			quota++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || quota != 1 {
		t.Fatal("quota race", success, quota)
	}
	if _, added, err := journal.admit(ctx, first, false); err != nil || added {
		t.Fatal("repeat blocked at capacity", added, err)
	}
	changed := first
	changed.RequestJSON = strings.Replace(changed.RequestJSON, "original whitespace  ", "changed", 1)
	canonical, _ := protocol.CanonicalAgentWriteRequest("agent_run.comment", []byte(changed.RequestJSON))
	digest := sha256.Sum256([]byte(canonical))
	changed.Fingerprint = hex.EncodeToString(digest[:])
	if _, _, err := journal.admit(ctx, changed, false); !errors.Is(err, errWorkConflict) {
		t.Fatal("capacity masked conflict", err)
	}
}

func TestWorkJournalConcurrentExclusiveClaims(t *testing.T) {
	journal, _, _ := newWorkTestJournal(t)
	ctx := context.Background()
	for n := 0; n < 18; n++ {
		if _, _, err := journal.admit(ctx, workTestIntent(t, fmt.Sprintf("claim-%d", n), workTestID, "offline_admitted"), false); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	claimed := make(chan []journalRecord, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			records, err := journal.claimBatch(ctx, 16)
			if err != nil {
				t.Error(err)
			}
			claimed <- records
		}()
	}
	wg.Wait()
	close(claimed)
	seen := map[string]bool{}
	for records := range claimed {
		for _, record := range records {
			if seen[record.Intent.OperationKey] || record.Claim == nil {
				t.Fatal("claim overlap", record)
			}
			seen[record.Intent.OperationKey] = true
		}
	}
	if len(seen) != 18 {
		t.Fatal("claim loss", len(seen))
	}
	if _, err := journal.claimBatch(ctx, 17); !errors.Is(err, errWorkInvalid) {
		t.Fatal("unbounded batch accepted", err)
	}
}

func TestWorkJournalEncodedBoundsAndWrongOutcome(t *testing.T) {
	journal, _, _ := newWorkTestJournal(t)
	ctx := context.Background()
	intent := workTestIntent(t, "byte-limit", workTestID, "offline_admitted")
	intent.RequestJSON += strings.Repeat(" ", 16384-len(intent.RequestJSON))
	intent.ConfirmationJSON += strings.Repeat(" ", 4096-len(intent.ConfirmationJSON))
	intent.CaptureJSON += strings.Repeat(" ", 8192-len(intent.CaptureJSON))
	if _, _, err := journal.admit(ctx, intent, true); err != nil {
		t.Fatal("exact byte bounds denied", err)
	}
	record, _, err := journal.lookup(ctx, intent.OperationKey)
	if err != nil {
		t.Fatal(err)
	}
	wrong := strings.Replace(workTestOutcome(t, intent), workTestID, workOtherID, 1)
	if err := journal.acknowledge(ctx, *record.Claim, wrong); !errors.Is(err, errWorkInvalid) {
		t.Fatal("foreign origin accepted", err)
	}
	outcome := workTestOutcome(t, intent)
	outcome += strings.Repeat(" ", 16384-len(outcome))
	if err := journal.acknowledge(ctx, *record.Claim, outcome+" "); !errors.Is(err, errWorkInvalid) {
		t.Fatal("oversized result accepted", err)
	}
	if err := journal.acknowledge(ctx, *record.Claim, outcome); err != nil {
		t.Fatal("exact result bound denied", err)
	}
	for _, field := range []string{"request", "confirmation", "capture"} {
		bad := workTestIntent(t, "oversized-"+field, workTestID, "offline_admitted")
		switch field {
		case "request":
			bad.RequestJSON += strings.Repeat(" ", 16385-len(bad.RequestJSON))
		case "confirmation":
			bad.ConfirmationJSON += strings.Repeat(" ", 4097-len(bad.ConfirmationJSON))
		case "capture":
			bad.CaptureJSON += strings.Repeat(" ", 8193-len(bad.CaptureJSON))
		}
		if _, _, err := journal.admit(ctx, bad, false); !errors.Is(err, errWorkInvalid) {
			t.Fatal(field, "oversized evidence admitted", err)
		}
	}
}
