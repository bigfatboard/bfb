// ABOUTME: Tests protected result admission and recovery against durable storage and a bounded cloud double.
// ABOUTME: Proves original identity, explicit permission, write-ahead ordering and private delivery after denial.

package agentwork

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

type resultCloudDouble struct {
	runner.RunnerConnection
	t                             *testing.T
	confirmation                  generated.AgentResultConfirmationResult
	confirmationErr               error
	confirmationReason            string
	loseReply                     bool
	sends, effects, confirmations int
	saved                         map[string][]byte
	beforeSend                    func(string)
	lastOriginal                  string
}

func (cloud *resultCloudDouble) Request(_ context.Context, method, action string, body []byte) ([]byte, error) {
	cloud.t.Helper()
	if method != "POST" {
		cloud.t.Fatal("unbounded result method", method)
	}
	if action == "work/result-confirmation" {
		cloud.confirmations++
		if cloud.confirmationErr != nil {
			return []byte(workTestJSON(cloud.t, map[string]any{"error": cloud.confirmationReason})), cloud.confirmationErr
		}
		var request generated.AgentResultConfirmationRequest
		if !protocol.DecodeWireDocument("agent-result-confirmation-request", body).OK || json.Unmarshal(body, &request) != nil {
			cloud.t.Fatal("invalid result confirmation")
		}
		value := cloud.confirmation
		value.ConfirmationId = request.RequestId
		return []byte(workTestJSON(cloud.t, value)), nil
	}
	original := body
	if action == "work/result-replay" {
		var replay struct {
			Original json.RawMessage `json:"original_request"`
		}
		if !protocol.DecodeWireDocument("agent-result-replay-request", body).OK || json.Unmarshal(body, &replay) != nil {
			cloud.t.Fatal("invalid result replay")
		}
		original = replay.Original
	} else if action != "work/result-submit" {
		cloud.t.Fatal("unexpected result action", action)
	}
	if !protocol.DecodeWireDocument("agent-result-request", original).OK {
		cloud.t.Fatal("invalid original result")
	}
	cloud.lastOriginal, _ = protocol.CanonicalAgentWriteRequest("result.submit", original)
	var request generated.AgentResultRequest
	_ = json.Unmarshal(original, &request)
	key, _ := agentOperationKey("result.submit", request.Reference)
	if cloud.beforeSend != nil {
		cloud.beforeSend(key)
	}
	cloud.sends++
	result := cloud.saved[key]
	if result == nil {
		if !cloud.confirmation.CanSubmit {
			return []byte(`{"error":"invalid_transition"}`), runner.ErrAuthorization
		}
		cloud.effects++
		result = []byte(workTestJSON(cloud.t, generated.AgentResultResult{SubmissionId: workOtherID, Version: 1, ResultState: "submitted", TaskState: "review", RunVersion: 2, TaskVersion: 2, Origin: generated.AgentEffectOrigin{
			RunId: cloud.confirmation.RunId, RunExecutionId: request.Reference.RunExecutionId, AssignmentGeneration: request.Reference.AssignmentGeneration, ProviderSessionId: request.Binding.ProviderSessionId,
		}}))
		cloud.saved[key], cloud.confirmation.CanSubmit = result, false
	}
	if cloud.loseReply {
		cloud.loseReply = false
		return nil, runner.ErrOffline
	}
	return result, nil
}

type resultServiceFixture struct {
	service   *workService
	cloud     *resultCloudDouble
	clock     *workTestClock
	input     generated.AgentResultLocalRequest
	reference generated.AgentWorkRequest
	key, path string
}

func newResultServiceFixture(t *testing.T, allowed bool) *resultServiceFixture {
	t.Helper()
	journal, clock, path := newWorkTestJournal(t)
	confirmation, original, _, _ := resultFactoryFixture(t)
	if !allowed {
		confirmation.ConfiguredPermission = map[string]any{"allow_submit_result": false, "max_pending_age_seconds": 0}
	}
	var request map[string]any
	_ = json.Unmarshal(original, &request)
	delete(request, "binding")
	var reference generated.AgentWorkRequest
	_ = json.Unmarshal([]byte(workTestJSON(t, request["reference"])), &reference)
	cloud := &resultCloudDouble{t: t, confirmation: confirmation, saved: make(map[string][]byte)}
	service := &workService{store: &daemon.Store{}, journal: journal, clock: clock.read, confirmations: make(map[string]workConfirmation), resultSign: resultFactorySignature, resultVerify: func(context.Context, generated.AgentResultCapture) error { return nil }}
	service.connection = func(string) (runner.RunnerConnection, error) { return cloud, nil }
	var common generated.AgentCaptureConfirmationResult
	_ = json.Unmarshal([]byte(workTestJSON(t, confirmation)), &common)
	claim := claimForWorkConfirmation(common)
	service.inspect = func(context.Context, generated.AgentWorkRequest, generated.AgentSessionReference) (generated.LaunchClaimResult, error) {
		return claim, nil
	}
	service.results = newResultAuthority(service.connection, service.inspect, clock.read)
	key, _ := agentOperationKey("result.submit", reference)
	f := &resultServiceFixture{service, cloud, clock, generated.AgentResultLocalRequest{Correlation: "synthetic-result", Request: request, ExpectedBinding: &confirmation.Binding}, reference, key, path}
	cloud.beforeSend = func(key string) {
		record, found, err := journal.lookup(context.Background(), key)
		if err != nil || !found || record.EverDispatched == nil || record.Intent.CaptureFamily != "agent_result" {
			t.Fatal("result network before durable marker", found, err)
		}
	}
	return f
}

func (f *resultServiceFixture) submit() (map[string]any, error) {
	return f.service.submitResult(context.Background(), f.input, f.reference, func(context.Context) error { return nil })
}

func resultServiceReceipt(t *testing.T, payload map[string]any) generated.AgentResultReceipt {
	t.Helper()
	if len(payload) != 1 || payload["agent_result_receipt"] == nil {
		t.Fatal("not a bounded result receipt", payload)
	}
	var receipt generated.AgentResultReceipt
	encoded := []byte(workTestJSON(t, payload["agent_result_receipt"]))
	if !protocol.DecodeWireDocument("agent-result-receipt", encoded).OK || json.Unmarshal(encoded, &receipt) != nil {
		t.Fatal("invalid result receipt")
	}
	return receipt
}

func (f *resultServiceFixture) newID(id string) {
	f.reference.RequestId = id
	f.input.Request["reference"] = f.reference
	f.key, _ = agentOperationKey("result.submit", f.reference)
}

func TestResultServiceSubmittedRetryKeepsOriginalIdentityAndChecksCurrentAuthority(t *testing.T) {
	f := newResultServiceFixture(t, false)
	result, err := f.submit()
	if err != nil || result["agent_result"] == nil || f.cloud.effects != 1 {
		t.Fatal(result, err, f.cloud.effects)
	}
	stored, _, _ := f.service.journal.lookup(context.Background(), f.key)
	if stored.Intent.AdmissionMode != "online_only" || stored.State != "applied" {
		t.Fatal(stored)
	}
	result, err = f.submit()
	if err != nil || result["agent_result"] == nil || f.cloud.effects != 1 || f.cloud.sends != 2 || f.cloud.confirmations != 2 {
		t.Fatal("submitted retry bypassed current authority", result, err)
	}
	f.input.Request["summary"] = "different"
	if _, err := f.submit(); daemon.AsFailure(err).Code != "request_conflict" {
		t.Fatal("fingerprint conflict lost", err)
	}
	f.cloud.confirmationErr, f.cloud.confirmationReason = runner.ErrAuthorization, "revoked"
	result, err = f.submit()
	if err != nil {
		t.Fatal(err)
	}
	receipt := resultServiceReceipt(t, result)
	if receipt.DeliveryState != "delivery_blocked" || receipt.EffectCertainty != "confirmed" || *receipt.ReasonCode != "revoked" || f.cloud.sends != 2 {
		t.Fatal("denial leaked cache/conflict", receipt)
	}
	stored, _, _ = f.service.journal.lookup(context.Background(), f.key)
	if stored.State != "applied" || stored.OutcomeJSON == "" {
		t.Fatal("denial erased effect")
	}
	f.cloud.confirmationErr = nil
	f.newID("different-result")
	if result, err := f.submit(); result != nil || daemon.AsFailure(err).Code != "invalid_transition" {
		t.Fatal("new result after submission", result, err)
	}
	if _, found, _ := f.service.journal.lookup(context.Background(), f.key); found {
		t.Fatal("ineligible result admitted")
	}
}

func TestResultServiceLostReplyRestartUsesExactSignedIntent(t *testing.T) {
	f := newResultServiceFixture(t, true)
	f.cloud.loseReply = true
	result, err := f.submit()
	if err != nil {
		t.Fatal(err)
	}
	receipt := resultServiceReceipt(t, result)
	if receipt.DeliveryState != "pending_sync" || receipt.EffectCertainty != "possibly_applied" || f.cloud.effects != 1 {
		t.Fatal(receipt)
	}
	stored, _, _ := f.service.journal.lookup(context.Background(), f.key)
	capture, original := stored.Intent.CaptureJSON, stored.Intent.RequestJSON
	if err := f.service.journal.close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openWorkJournal(context.Background(), f.path, f.clock.read)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.close() })
	f.service.journal = reopened
	f.service.results.invalidate()
	f.cloud.beforeSend = nil
	f.cloud.confirmation.RunnerTokenEpoch++
	f.service.drain(context.Background())
	stored, _, err = reopened.lookup(context.Background(), f.key)
	if err != nil || stored.State != "applied" || stored.Intent.CaptureJSON != capture || f.cloud.lastOriginal != original || !strings.Contains(f.cloud.lastOriginal, `"evidence_refs":[]`) || f.cloud.effects != 1 || f.cloud.sends != 2 {
		t.Fatal("restart changed original or duplicated effect", stored.State, err)
	}
}

func TestResultServiceOfflineAdmissionNeedsSeparateFreshProof(t *testing.T) {
	for _, mode := range []string{"allowed", "denied", "no_result_proof", "restart", "expired"} {
		t.Run(mode, func(t *testing.T) {
			f := newResultServiceFixture(t, mode != "denied")
			if mode != "no_result_proof" {
				if _, _, err := f.service.results.confirm(context.Background(), f.reference, *f.input.ExpectedBinding, false); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "restart" {
				f.service.results.invalidate()
			}
			if mode == "expired" {
				f.clock.set(45_000_000_000, nil)
			}
			f.cloud.confirmationErr = runner.ErrOffline
			result, err := f.submit()
			if mode == "allowed" {
				if err != nil {
					t.Fatal(err)
				}
				receipt := resultServiceReceipt(t, result)
				if receipt.DeliveryState != "pending_sync" || receipt.EffectCertainty != "not_attempted" {
					t.Fatal(receipt)
				}
			} else {
				if err == nil || result != nil {
					t.Fatal("unconfirmed capture admitted", result, err)
				}
				if _, found, _ := f.service.journal.lookup(context.Background(), f.key); found {
					t.Fatal("unconfirmed row exists")
				}
			}
			if f.cloud.sends != 0 {
				t.Fatal("known offline sent business input")
			}
		})
	}
}

func TestResultServiceOnlineOnlyNeverDrainsAutonomously(t *testing.T) {
	f := newResultServiceFixture(t, false)
	f.cloud.loseReply = true
	if _, err := f.submit(); err != nil {
		t.Fatal(err)
	}
	f.service.drain(context.Background())
	if f.cloud.sends != 1 || f.cloud.confirmations != 1 {
		t.Fatal("online-only retry became autonomous", f.cloud.sends, f.cloud.confirmations)
	}
	if result, err := f.submit(); err != nil || result["agent_result"] == nil || f.cloud.effects != 1 {
		t.Fatal(result, err)
	}
}

func TestResultServiceUnknownEffectRemainsUnknownAfterDenial(t *testing.T) {
	for _, reason := range []string{"revoked", "intent_expired", "policy_rejected"} {
		t.Run(reason, func(t *testing.T) {
			f := newResultServiceFixture(t, true)
			f.cloud.loseReply = true
			if _, err := f.submit(); err != nil {
				t.Fatal(err)
			}
			switch reason {
			case "revoked":
				f.cloud.confirmationErr, f.cloud.confirmationReason = runner.ErrAuthorization, reason
			case "policy_rejected":
				f.cloud.confirmation.RunnerGrantEpoch++
			case "intent_expired":
				f.cloud.confirmation.ConfirmedAt = "2026-10-06T00:06:00.000Z"
				f.cloud.confirmation.LeaseExpiresAt = "2026-10-06T00:06:45.000Z"
				f.cloud.confirmation.CredentialExpiresAt = "2026-10-06T00:07:00.000Z"
			}
			result, err := f.submit()
			if err != nil {
				t.Fatal(err)
			}
			receipt := resultServiceReceipt(t, result)
			if receipt.DeliveryState != "delivery_blocked" || receipt.EffectCertainty != "possibly_applied" || *receipt.ReasonCode != reason || f.cloud.sends != 1 {
				t.Fatal(receipt, f.cloud.sends)
			}
		})
	}
}

func TestResultServiceMarkerAndAcknowledgementFailuresStayTruthful(t *testing.T) {
	for _, marker := range []bool{true, false} {
		t.Run(map[bool]string{true: "marker", false: "ack"}[marker], func(t *testing.T) {
			f := newResultServiceFixture(t, true)
			statement := "CREATE TRIGGER fail_result BEFORE UPDATE ON work_delivery WHEN NEW.ever_dispatched_ns IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected'); END"
			if !marker {
				statement = "CREATE TRIGGER fail_result BEFORE UPDATE ON work_delivery WHEN NEW.state='applied' BEGIN SELECT RAISE(ABORT,'injected'); END"
			}
			if _, err := f.service.journal.db.Exec(statement); err != nil {
				t.Fatal(err)
			}
			if result, err := f.submit(); result != nil || daemon.AsFailure(err).Code != "storage_failed" {
				t.Fatal(result, err)
			}
			if marker && f.cloud.sends != 0 || !marker && f.cloud.effects != 1 {
				t.Fatal("storage ordering", f.cloud.sends, f.cloud.effects)
			}
			if !marker {
				record, _, err := f.service.journal.lookup(context.Background(), f.key)
				if err != nil || record.Effect != "unknown" || record.State != "open" {
					t.Fatal(record, err)
				}
			}
			if !errors.Is(f.service.failed, errWorkStorage) {
				t.Fatal("storage failure did not stop service")
			}
		})
	}
}

func TestResultServiceDenialDuringSigningOrDeliveryCannotLeak(t *testing.T) {
	for _, phase := range []string{"signing", "delivery"} {
		t.Run(phase, func(t *testing.T) {
			f := newResultServiceFixture(t, false)
			if phase == "signing" {
				f.service.resultSign = func(ctx context.Context, capture generated.AgentResultCapture) (string, error) {
					f.service.results.invalidate()
					return resultFactorySignature(ctx, capture)
				}
			} else {
				f.cloud.beforeSend = func(string) { f.service.results.invalidate() }
			}
			result, err := f.submit()
			if phase == "signing" {
				if result != nil || daemon.AsFailure(err).Code != "capture_invalid" || f.cloud.sends != 0 {
					t.Fatal(result, err)
				}
				if _, found, _ := f.service.journal.lookup(context.Background(), f.key); found {
					t.Fatal("denied capture journaled")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				receipt := resultServiceReceipt(t, result)
				if receipt.DeliveryState != "delivery_blocked" || receipt.EffectCertainty != "confirmed" || *receipt.ReasonCode != "work_unavailable" {
					t.Fatal(receipt)
				}
			}
		})
	}
}
