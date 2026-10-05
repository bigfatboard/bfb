// ABOUTME: Exercises daemon admission and recovery against real durable storage and a bounded cloud double.
// ABOUTME: Proves ordering, uncertain outcomes and authorization without claiming native or signing acceptance.

package agentwork

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

type workCloudDouble struct {
	t                  *testing.T
	confirmation       generated.AgentCaptureConfirmationResult
	confirmationErr    error
	confirmationReason string
	writeErr           error
	writeReason        string
	loseReply          bool
	effects            int
	sends              int
	confirmations      int
	saved              map[string][]byte
	beforeSend         func()
}

func (*workCloudDouble) Renew(context.Context, int64) error            { return nil }
func (*workCloudDouble) Open(context.Context) (*websocket.Conn, error) { return nil, runner.ErrOffline }
func (*workCloudDouble) Credential() (int64, time.Time)                { return 1, time.Time{} }
func (cloud *workCloudDouble) Request(_ context.Context, method, action string, body []byte) ([]byte, error) {
	cloud.t.Helper()
	if method != "POST" {
		cloud.t.Fatal("unbounded method", method)
	}
	if action == "work/capture-confirmation" {
		cloud.confirmations++
		if cloud.confirmationErr != nil {
			return []byte(workTestJSON(cloud.t, map[string]any{"error": cloud.confirmationReason})), cloud.confirmationErr
		}
		var request generated.AgentCaptureConfirmationRequest
		if json.Unmarshal(body, &request) != nil {
			cloud.t.Fatal("invalid confirmation request")
		}
		result := cloud.confirmation
		result.ConfirmationId = request.RequestId
		return []byte(workTestJSON(cloud.t, result)), nil
	}
	cloud.sends++
	if cloud.beforeSend != nil {
		cloud.beforeSend()
	}
	if cloud.writeErr != nil {
		return []byte(workTestJSON(cloud.t, map[string]any{"error": cloud.writeReason})), cloud.writeErr
	}
	original := body
	if action == "work/replay" {
		var replay struct {
			Original json.RawMessage `json:"original_request"`
		}
		if json.Unmarshal(body, &replay) != nil {
			cloud.t.Fatal("invalid replay")
		}
		original = replay.Original
	} else if action != "work/comment" {
		cloud.t.Fatal("unexpected action", action)
	}
	var request capturedWriteReference
	if json.Unmarshal(original, &request) != nil {
		cloud.t.Fatal("invalid original")
	}
	key, _ := agentOperationKey("agent_run.comment", request.Reference)
	result := cloud.saved[key]
	if result == nil {
		cloud.effects++
		result = []byte(workTestJSON(cloud.t, generated.AgentCommentResult{Id: workOtherID, Origin: generated.AgentEffectOrigin{
			RunId: cloud.confirmation.RunId, RunExecutionId: request.Reference.RunExecutionId,
			AssignmentGeneration: request.Reference.AssignmentGeneration, ProviderSessionId: request.Binding.ProviderSessionId,
		}}))
		cloud.saved[key] = result
	}
	if cloud.loseReply {
		cloud.loseReply = false
		return nil, runner.ErrOffline
	}
	return result, nil
}

type workServiceFixture struct {
	service *workService
	cloud   *workCloudDouble
	clock   *workTestClock
	command workCommand
	intent  journalIntent
	path    string
}

func newWorkServiceFixture(t *testing.T, allowed bool) *workServiceFixture {
	t.Helper()
	journal, clock, path := newWorkTestJournal(t)
	intent := workTestIntent(t, "service", workTestID, "offline_admitted")
	confirmation := mustCapture(intent).Confirmation
	if !allowed {
		confirmation.ConfiguredPermission = map[string]any{"allowed_tools": []string{}, "max_pending_age_seconds": 0}
	}
	cloud := &workCloudDouble{t: t, confirmation: confirmation, saved: map[string][]byte{}}
	service := &workService{store: &daemon.Store{}, journal: journal, clock: clock.read, confirmations: map[string]workConfirmation{},
		connection: func(string) (runner.RunnerConnection, error) { return cloud, nil },
		sign: func(context.Context, generated.AgentWorkCapture) (string, error) {
			return base64.RawURLEncoding.EncodeToString(make([]byte, 64)), nil
		},
		verify: func(context.Context, generated.AgentWorkCapture) error { return nil },
	}
	claim := claimForWorkConfirmation(confirmation)
	service.inspect = func(context.Context, generated.AgentWorkRequest, generated.AgentSessionReference) (generated.LaunchClaimResult, error) {
		return claim, nil
	}
	command, _ := agentWorkCommand("agent_run.comment")
	fixture := &workServiceFixture{service, cloud, clock, command, intent, path}
	cloud.beforeSend = func() {
		record, found, err := service.journal.lookup(context.Background(), intent.OperationKey)
		if err != nil || !found || record.EverDispatched == nil {
			t.Fatal("network before durable dispatch marker", found, err)
		}
	}
	return fixture
}

func claimForWorkConfirmation(c generated.AgentCaptureConfirmationResult) generated.LaunchClaimResult {
	return generated.LaunchClaimResult{
		Assignment:    generated.ExecutionAssignment{WorkspaceId: c.WorkspaceId, ProjectId: c.ProjectId, TaskId: c.SourceTaskId, RunId: c.RunId, RunExecutionId: c.RunExecutionId, AssignmentGeneration: c.AssignmentGeneration, RunnerId: c.RunnerId, CheckoutId: c.CheckoutId},
		Specification: generated.LaunchSpecification{ConfigSnapshotHash: c.SnapshotHash}, FencingGeneration: c.FencingGeneration,
		Snapshot: generated.LaunchSnapshot{PhysicalWorktreeHash: c.PhysicalWorktreeHash, SnapshotGeneration: c.SnapshotGeneration, WorkspacePolicyVersion: c.WorkspacePolicyVersion, ProjectPolicyVersion: c.ProjectPolicyVersion, RepositoryConfigVersion: c.RepositoryConfigVersion, RepositoryConfigHash: c.SnapshotRepositoryConfigHash},
	}
}

func (f *workServiceFixture) write(ctx context.Context) (map[string]any, error) {
	return f.service.write(ctx, f.command, []byte(f.intent.RequestJSON), true, func(context.Context) error { return nil })
}

func serviceReceipt(t *testing.T, payload map[string]any) generated.AgentWorkReceipt {
	t.Helper()
	if len(payload) != 1 || payload["agent_work_receipt"] == nil {
		t.Fatal("not a bounded receipt", payload)
	}
	var receipt generated.AgentWorkReceipt
	if json.Unmarshal([]byte(workTestJSON(t, payload["agent_work_receipt"])), &receipt) != nil {
		t.Fatal("invalid receipt")
	}
	return receipt
}

func TestWorkServiceWriteAheadOnlineAndAuthorizedRetry(t *testing.T) {
	f := newWorkServiceFixture(t, false)
	result, err := f.write(context.Background())
	if err != nil || result["agent_comment"] == nil || f.cloud.effects != 1 {
		t.Fatal(result, err, f.cloud.effects)
	}
	record, _, err := f.service.journal.lookup(context.Background(), f.intent.OperationKey)
	if err != nil || record.Intent.AdmissionMode != "online_only" || record.State != "applied" {
		t.Fatal(record, err)
	}
	result, err = f.write(context.Background())
	if err != nil || result["agent_comment"] == nil || f.cloud.effects != 1 || f.cloud.sends != 2 || f.cloud.confirmations != 2 {
		t.Fatal("retry used local cache", result, err)
	}
	f.cloud.confirmationErr, f.cloud.confirmationReason = runner.ErrAuthorization, "revoked"
	result, err = f.write(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	receipt := serviceReceipt(t, result)
	if receipt.DeliveryState != "delivery_blocked" || receipt.EffectCertainty != "confirmed" || *receipt.ReasonCode != "revoked" || f.cloud.sends != 2 {
		t.Fatal(receipt, f.cloud.sends)
	}
	record, _, _ = f.service.journal.lookup(context.Background(), f.intent.OperationKey)
	if record.State != "applied" || record.OutcomeJSON == "" {
		t.Fatal("revocation erased known effect")
	}
}

func TestWorkServiceLostReplyRestartUsesOriginalOperation(t *testing.T) {
	f := newWorkServiceFixture(t, true)
	f.cloud.loseReply = true
	result, err := f.write(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	receipt := serviceReceipt(t, result)
	if receipt.DeliveryState != "pending_sync" || receipt.EffectCertainty != "possibly_applied" || f.cloud.effects != 1 {
		t.Fatal(receipt)
	}
	stored, _, _ := f.service.journal.lookup(context.Background(), f.intent.OperationKey)
	originalCapture := stored.Intent.CaptureJSON
	if err := f.service.journal.close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openWorkJournal(context.Background(), f.path, f.clock.read)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.close() })
	f.service.journal = reopened
	clear(f.service.confirmations)
	f.cloud.confirmation.RunnerTokenEpoch++
	f.cloud.confirmation.ConfirmedAt = "2026-10-06T00:00:02.000Z"
	f.cloud.confirmation.LeaseExpiresAt = "2026-10-06T00:00:47.000Z"
	f.service.drain(context.Background())
	stored, _, err = reopened.lookup(context.Background(), f.intent.OperationKey)
	if err != nil || stored.State != "applied" || stored.Intent.CaptureJSON != originalCapture || f.cloud.effects != 1 || f.cloud.sends != 2 {
		t.Fatal(stored.State, f.cloud.effects, f.cloud.sends, err)
	}
}

func TestWorkServiceOutageNeedsOriginalPermissionAndFreshProcessAnchor(t *testing.T) {
	for _, allowed := range []bool{false, true} {
		t.Run(map[bool]string{false: "deny", true: "allowed"}[allowed], func(t *testing.T) {
			f := newWorkServiceFixture(t, allowed)
			var request capturedWriteReference
			_ = json.Unmarshal([]byte(f.intent.RequestJSON), &request)
			if _, _, err := f.service.confirmation(context.Background(), request.Reference, request.Binding, false); err != nil {
				t.Fatal(err)
			}
			f.cloud.confirmationErr = runner.ErrOffline
			result, err := f.write(context.Background())
			if !allowed {
				if err == nil || result != nil {
					t.Fatal("deny acquired offline permission")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				receipt := serviceReceipt(t, result)
				if receipt.DeliveryState != "pending_sync" || receipt.EffectCertainty != "not_attempted" {
					t.Fatal(receipt)
				}
			}
			if f.cloud.sends != 0 {
				t.Fatal("dispatched while known offline")
			}
			clear(f.service.confirmations)
			f.intent.RequestJSON = strings.Replace(f.intent.RequestJSON, "journal-service", "journal-after-restart", 1)
			if result, err = f.write(context.Background()); err == nil || result != nil {
				t.Fatal("restart invented capture anchor")
			}
		})
	}
}

func TestWorkServiceRevocationAndExpiryPreserveUnknown(t *testing.T) {
	for _, reason := range []string{"revoked", "intent_expired", "policy_rejected"} {
		t.Run(reason, func(t *testing.T) {
			f := newWorkServiceFixture(t, true)
			f.cloud.loseReply = true
			if _, err := f.write(context.Background()); err != nil {
				t.Fatal(err)
			}
			switch reason {
			case "revoked":
				f.cloud.confirmationErr, f.cloud.confirmationReason = runner.ErrAuthorization, reason
			case "intent_expired":
				f.cloud.confirmation.ConfirmedAt = "2026-10-06T00:06:00.000Z"
				f.cloud.confirmation.LeaseExpiresAt = "2026-10-06T00:06:45.000Z"
				f.cloud.confirmation.CredentialExpiresAt = "2026-10-06T00:07:00.000Z"
			case "policy_rejected":
				f.cloud.confirmation.RunnerGrantEpoch++
			}
			result, err := f.write(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			receipt := serviceReceipt(t, result)
			if receipt.DeliveryState != "delivery_blocked" || receipt.EffectCertainty != "possibly_applied" || *receipt.ReasonCode != reason || f.cloud.sends != 1 {
				t.Fatal(receipt, f.cloud.sends)
			}
		})
	}
}

func TestWorkServiceFailedMarkerSendsNothingAndFailedAckStaysUnknown(t *testing.T) {
	for _, marker := range []bool{true, false} {
		t.Run(map[bool]string{true: "marker", false: "ack"}[marker], func(t *testing.T) {
			f := newWorkServiceFixture(t, true)
			statement := "CREATE TRIGGER fail_write BEFORE UPDATE ON work_delivery WHEN NEW.ever_dispatched_ns IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected'); END"
			if !marker {
				statement = "CREATE TRIGGER fail_write BEFORE UPDATE ON work_delivery WHEN NEW.state='applied' BEGIN SELECT RAISE(ABORT,'injected'); END"
			}
			if _, err := f.service.journal.db.Exec(statement); err != nil {
				t.Fatal(err)
			}
			if result, err := f.write(context.Background()); result != nil || daemon.AsFailure(err).Code != "storage_failed" {
				t.Fatal(result, err)
			}
			if marker && f.cloud.sends != 0 || !marker && f.cloud.effects != 1 {
				t.Fatal("storage ordering", f.cloud.sends, f.cloud.effects)
			}
			if !marker {
				record, _, err := f.service.journal.lookup(context.Background(), f.intent.OperationKey)
				if err != nil || record.Effect != "unknown" || record.State != "open" {
					t.Fatal(record, err)
				}
			}
			if !errors.Is(f.service.failed, errWorkStorage) {
				t.Fatal("storage failure did not stop drain")
			}
		})
	}
}

func TestWorkServiceVerificationInfrastructureDoesNotBecomeTerminalDenial(t *testing.T) {
	for _, storage := range []bool{false, true} {
		t.Run(map[bool]string{false: "offline", true: "storage"}[storage], func(t *testing.T) {
			f := newWorkServiceFixture(t, true)
			f.cloud.loseReply = true
			if _, err := f.write(context.Background()); err != nil {
				t.Fatal(err)
			}
			f.service.verify = func(context.Context, generated.AgentWorkCapture) error {
				if storage {
					return errors.New("synthetic enrollment storage error")
				}
				return runner.ErrOffline
			}
			result, err := f.write(context.Background())
			if storage {
				if daemon.AsFailure(err).Code != "storage_failed" || result != nil || f.service.failed == nil {
					t.Fatal(result, err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				receipt := serviceReceipt(t, result)
				if receipt.DeliveryState != "pending_sync" || receipt.EffectCertainty != "possibly_applied" || receipt.ReasonCode != nil {
					t.Fatal(receipt)
				}
			}
			record, _, err := f.service.journal.lookup(context.Background(), f.intent.OperationKey)
			if err != nil || record.State != "open" || record.Effect != "unknown" || f.cloud.sends != 1 {
				t.Fatal(record, err)
			}
		})
	}
}

func TestWorkServiceLegacyWritesKeepTypedDenials(t *testing.T) {
	for _, reason := range []string{"stale_version", "revoked", "session_conflict"} {
		t.Run(reason, func(t *testing.T) {
			f := newWorkServiceFixture(t, false)
			f.cloud.writeErr, f.cloud.writeReason = runner.ErrAuthorization, reason
			result, err := f.service.write(context.Background(), f.command, []byte(f.intent.RequestJSON), false, func(context.Context) error { return nil })
			if result != nil || daemon.AsFailure(err).Code != reason {
				t.Fatal("legacy denial became offline", result, err)
			}
			record, _, err := f.service.journal.lookup(context.Background(), f.intent.OperationKey)
			if err != nil || record.State != "blocked" || record.Effect != "unknown" {
				t.Fatal(record, err)
			}
		})
	}
}

func TestWorkServiceAcknowledgementSurvivesCallerCancellation(t *testing.T) {
	f := newWorkServiceFixture(t, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.cloud.beforeSend = cancel
	_, _ = f.write(ctx)
	record, _, err := f.service.journal.lookup(context.Background(), f.intent.OperationKey)
	if err != nil || record.State != "applied" || record.Effect != "applied" {
		t.Fatal("lost durable acknowledgement on MCP exit", record, err)
	}
}

func TestWorkServicePostflightDenialKeepsDurableEffectPrivate(t *testing.T) {
	f := newWorkServiceFixture(t, false)
	f.cloud.beforeSend = func() {
		f.service.inspect = func(context.Context, generated.AgentWorkRequest, generated.AgentSessionReference) (generated.LaunchClaimResult, error) {
			return generated.LaunchClaimResult{}, &daemon.Failure{Code: "assignment_ended"}
		}
	}
	result, err := f.write(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	receipt := serviceReceipt(t, result)
	if receipt.DeliveryState != "delivery_blocked" || receipt.EffectCertainty != "confirmed" || *receipt.ReasonCode != "assignment_ended" {
		t.Fatal(receipt)
	}
	record, _, err := f.service.journal.lookup(context.Background(), f.intent.OperationKey)
	if err != nil || record.State != "applied" || record.OutcomeJSON == "" {
		t.Fatal("denial erased durable effect", record, err)
	}
}

func TestWorkServiceRecoveryCursorDoesNotStarveLaterIntent(t *testing.T) {
	f := newWorkServiceFixture(t, true)
	for _, id := range []string{"cursor-first", "cursor-second"} {
		if _, _, err := f.service.journal.admit(context.Background(), workTestIntent(t, id, workTestID, "offline_admitted"), false); err != nil {
			t.Fatal(err)
		}
	}
	f.cloud.confirmationErr = runner.ErrOffline
	var attempts []string
	f.service.verify = func(_ context.Context, capture generated.AgentWorkCapture) error {
		attempts = append(attempts, capture.Operation["operation_key"].(string))
		return nil
	}
	f.service.drain(context.Background())
	f.service.drain(context.Background())
	if len(attempts) != 2 || attempts[0] == attempts[1] {
		t.Fatal("first unavailable intent starved the next", attempts)
	}
	f.service.drain(context.Background())
	if f.service.afterKey != "" {
		t.Fatal("exhausted cursor did not reset")
	}
	f.service.drain(context.Background())
	if len(attempts) != 3 || attempts[2] != attempts[0] {
		t.Fatal("cursor did not wrap", attempts)
	}
}

func TestWorkServiceCurrentRevocationIsVisibleAfterPriorDeliveryDenial(t *testing.T) {
	f := newWorkServiceFixture(t, false)
	f.cloud.writeErr, f.cloud.writeReason = runner.ErrAuthorization, "stale_version"
	if _, err := f.write(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.service.verify = func(context.Context, generated.AgentWorkCapture) error { return runner.ErrRevoked }
	result, err := f.write(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	receipt := serviceReceipt(t, result)
	if receipt.ReasonCode == nil || *receipt.ReasonCode != "revoked" || receipt.EffectCertainty != "possibly_applied" {
		t.Fatal(receipt)
	}
	record, _, err := f.service.journal.lookup(context.Background(), f.intent.OperationKey)
	if err != nil || record.Reason != "stale_version" || record.State != "blocked" {
		t.Fatal("current denial rewrote historical disposition", record, err)
	}
}
