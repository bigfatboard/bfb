// ABOUTME: Proves exact confirmation scope, immutable authority matching and bounded outage caching.
// ABOUTME: Exercises postflight replacement and storage denial without native execution or network mutations.

package agentwork

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

func workAuthorityClone(t *testing.T, value generated.AgentCaptureConfirmationResult) generated.AgentCaptureConfirmationResult {
	t.Helper()
	var clone generated.AgentCaptureConfirmationResult
	if json.Unmarshal([]byte(workTestJSON(t, value)), &clone) != nil {
		t.Fatal("clone confirmation")
	}
	return clone
}

func workAuthorityAlterField(t *testing.T, value *generated.AgentCaptureConfirmationResult, index int) {
	t.Helper()
	field := reflect.ValueOf(value).Elem().Field(index)
	name := reflect.TypeOf(*value).Field(index).Name
	switch field.Kind() {
	case reflect.Int64:
		field.SetInt(field.Int() + 1)
	case reflect.String:
		original := field.String()
		switch {
		case strings.HasPrefix(original, "sha256:"):
			field.SetString("sha256:" + strings.Repeat("f", 64))
		case strings.HasSuffix(original, "Z"):
			field.SetString("2026-10-06T00:02:00.000Z")
		default:
			field.SetString(workOtherID)
		}
	case reflect.Struct:
		if name != "Binding" {
			t.Fatal("unhandled confirmation struct", name)
		}
		value.Binding.ProviderSessionId = workOtherID
	case reflect.Map:
		value.ConfiguredPermission = map[string]any{"allowed_tools": []string{"bfb_propose_task"}, "max_pending_age_seconds": 300}
	default:
		t.Fatal("unhandled confirmation field", name, field.Kind())
	}
}

func TestWorkAuthorityConfirmationMatchesEveryNativeClaimField(t *testing.T) {
	f := newWorkServiceFixture(t, true)
	original := f.cloud.confirmation
	claim := claimForWorkConfirmation(original)
	if !confirmationMatchesClaim(original, claim, original.Binding) {
		t.Fatal("fixture not matching native claim")
	}
	protected := map[string]bool{
		"WorkspaceId": true, "ProjectId": true, "SourceTaskId": true, "RunId": true, "RunExecutionId": true, "RunnerId": true, "CheckoutId": true,
		"AssignmentGeneration": true, "FencingGeneration": true, "PhysicalWorktreeHash": true, "Binding": true, "SnapshotHash": true,
		"SnapshotGeneration": true, "WorkspacePolicyVersion": true, "ProjectPolicyVersion": true, "RepositoryConfigVersion": true, "SnapshotRepositoryConfigHash": true,
	}
	fields := reflect.TypeOf(original)
	for index := 0; index < fields.NumField(); index++ {
		name := fields.Field(index).Name
		t.Run(name, func(t *testing.T) {
			changed := workAuthorityClone(t, original)
			workAuthorityAlterField(t, &changed, index)
			matches := confirmationMatchesClaim(changed, claim, original.Binding)
			// Other confirmation fields are cloud/enrollment evidence, not claims
			// fabricated from the smaller native launch projection.
			if matches == protected[name] {
				t.Fatal("native claim comparison coverage", name, matches)
			}
		})
	}
	for _, field := range []string{"provider", "observed-session"} {
		t.Run(field, func(t *testing.T) {
			changed := workAuthorityClone(t, original)
			if field == "provider" {
				changed.Binding.Provider = "claude"
			} else {
				changed.Binding.ObservedSessionId = "changed-observation"
			}
			if confirmationMatchesClaim(changed, claim, original.Binding) {
				t.Fatal("trusted binding changed", field)
			}
		})
	}
}

func TestWorkAuthorityOnlyFreshnessFieldsMayRenew(t *testing.T) {
	f := newWorkServiceFixture(t, true)
	original := f.cloud.confirmation
	mutable := map[string]bool{"ConfirmationId": true, "ConfirmedAt": true, "LeaseExpiresAt": true, "CredentialExpiresAt": true, "RunnerTokenEpoch": true}
	fields := reflect.TypeOf(original)
	for index := 0; index < fields.NumField(); index++ {
		name := fields.Field(index).Name
		t.Run(name, func(t *testing.T) {
			changed := workAuthorityClone(t, original)
			workAuthorityAlterField(t, &changed, index)
			if sameCaptureAuthority(original, changed) != mutable[name] {
				t.Fatal("protected captured authority changed", name)
			}
		})
	}
	for _, field := range []string{"provider", "observed-session", "age"} {
		t.Run(field, func(t *testing.T) {
			changed := workAuthorityClone(t, original)
			switch field {
			case "provider":
				changed.Binding.Provider = "claude"
			case "observed-session":
				changed.Binding.ObservedSessionId = "changed-observation"
			case "age":
				changed.ConfiguredPermission["max_pending_age_seconds"] = 1
			}
			if sameCaptureAuthority(original, changed) {
				t.Fatal("nested authority widened", field)
			}
		})
	}
}

type workAuthorityConnection struct {
	runner.RunnerConnection
	request func(context.Context, string, string, []byte) ([]byte, error)
}

func (connection workAuthorityConnection) Request(ctx context.Context, method, action string, body []byte) ([]byte, error) {
	return connection.request(ctx, method, action, body)
}

func workAuthorityRequest(t *testing.T, f *workServiceFixture) capturedWriteReference {
	t.Helper()
	var request capturedWriteReference
	if json.Unmarshal([]byte(f.intent.RequestJSON), &request) != nil {
		t.Fatal("request decode")
	}
	return request
}

func TestWorkAuthorityDelayedReplyRetainsOriginalSendAndReceipt(t *testing.T) {
	f := newWorkServiceFixture(t, true)
	request := workAuthorityRequest(t, f)
	var ids []string
	f.service.connection = func(string) (runner.RunnerConnection, error) {
		return workAuthorityConnection{f.cloud, func(ctx context.Context, method, action string, body []byte) ([]byte, error) {
			var input generated.AgentCaptureConfirmationRequest
			if json.Unmarshal(body, &input) != nil {
				t.Fatal("confirmation input")
			}
			ids = append(ids, input.RequestId)
			if len(ids) == 1 {
				f.clock.set(44*time.Second, nil)
			}
			return f.cloud.Request(ctx, method, action, body)
		}}, nil
	}
	first, online, err := f.service.confirmation(context.Background(), request.Reference, request.Binding, false)
	if err != nil || !online || first.timing.sent != 0 || first.timing.received != 44*time.Second {
		t.Fatal(first, online, err)
	}
	f.cloud.confirmationErr = runner.ErrOffline
	f.clock.set(44*time.Second+500*time.Millisecond, nil)
	cached, online, err := f.service.confirmation(context.Background(), request.Reference, request.Binding, true)
	if err != nil || online || cached.timing != first.timing || cached.value.ConfirmationId != first.value.ConfirmationId || len(ids) != 2 || ids[0] == ids[1] {
		t.Fatal("outage reset original anchor/identity", cached, online, ids, err)
	}
	stamp, err := cached.timing.captureTime()
	if err != nil || stamp.Format("2006-01-02T15:04:05.000Z") != "2026-10-06T00:00:00.500Z" {
		t.Fatal("capture time used send latency", stamp, err)
	}
	f.clock.set(45*time.Second, nil)
	if _, _, err = f.service.confirmation(context.Background(), request.Reference, request.Binding, true); err == nil {
		t.Fatal("delayed reply renewed strict send horizon")
	}
	if len(f.service.confirmations) != 0 || f.cloud.sends != 0 {
		t.Fatal("expired confirmation retained or business dispatched")
	}
}

func TestWorkAuthorityExactHorizonReplyAndKnownDenialsNeverCache(t *testing.T) {
	for _, kind := range []string{"late reply", "revoked", "authorization", "protocol"} {
		t.Run(kind, func(t *testing.T) {
			f := newWorkServiceFixture(t, true)
			request := workAuthorityRequest(t, f)
			if kind == "late reply" {
				f.service.connection = func(string) (runner.RunnerConnection, error) {
					return workAuthorityConnection{f.cloud, func(ctx context.Context, method, action string, body []byte) ([]byte, error) {
						f.clock.set(45*time.Second, nil)
						return f.cloud.Request(ctx, method, action, body)
					}}, nil
				}
			} else {
				if _, _, err := f.service.confirmation(context.Background(), request.Reference, request.Binding, false); err != nil {
					t.Fatal(err)
				}
				switch kind {
				case "revoked":
					f.cloud.confirmationErr = runner.ErrRevoked
				case "authorization":
					f.cloud.confirmationErr = runner.ErrAuthorization
					f.cloud.confirmationReason = "revoked"
				case "protocol":
					f.cloud.confirmationErr = runner.ErrProtocol
				}
			}
			if _, _, err := f.service.confirmation(context.Background(), request.Reference, request.Binding, true); err == nil {
				t.Fatal("late or known denied reply borrowed cache", kind)
			}
			if len(f.service.confirmations) != 0 {
				t.Fatal("known denial retained permission", kind)
			}
			f.service.connection = func(string) (runner.RunnerConnection, error) { return f.cloud, nil }
			f.cloud.confirmationErr = runner.ErrOffline
			if _, _, err := f.service.confirmation(context.Background(), request.Reference, request.Binding, true); err == nil {
				t.Fatal("outage resurrected invalidated confirmation", kind)
			}
		})
	}
}

func TestWorkAuthorityCachedOutageRechecksExactPostflightClaim(t *testing.T) {
	for _, kind := range []string{"fence", "snapshot", "repository", "native denial"} {
		t.Run(kind, func(t *testing.T) {
			f := newWorkServiceFixture(t, true)
			request := workAuthorityRequest(t, f)
			if _, _, err := f.service.confirmation(context.Background(), request.Reference, request.Binding, false); err != nil {
				t.Fatal(err)
			}
			f.cloud.confirmationErr = runner.ErrOffline
			claim := claimForWorkConfirmation(f.cloud.confirmation)
			calls := 0
			f.service.inspect = func(context.Context, generated.AgentWorkRequest, generated.AgentSessionReference) (generated.LaunchClaimResult, error) {
				calls++
				if calls == 1 {
					return claim, nil
				}
				switch kind {
				case "fence":
					claim.FencingGeneration++
				case "snapshot":
					claim.Specification.ConfigSnapshotHash = "sha256:" + strings.Repeat("f", 64)
				case "repository":
					claim.Snapshot.RepositoryConfigHash = "sha256:" + strings.Repeat("f", 64)
				case "native denial":
					return generated.LaunchClaimResult{}, &daemon.Failure{Code: "containment_unknown"}
				}
				return claim, nil
			}
			_, _, err := f.service.confirmation(context.Background(), request.Reference, request.Binding, true)
			if err == nil || len(f.service.confirmations) != 0 || calls != 2 {
				t.Fatal("postflight replacement borrowed old permission", kind, calls, err)
			}
			if kind == "native denial" && daemon.AsFailure(err).Code != "containment_unknown" {
				t.Fatal("native denial hidden as network outage", err)
			}
		})
	}
}

func TestWorkAuthorityPostSignerReplacementCannotAdmit(t *testing.T) {
	f := newWorkServiceFixture(t, true)
	claim := claimForWorkConfirmation(f.cloud.confirmation)
	f.service.inspect = func(context.Context, generated.AgentWorkRequest, generated.AgentSessionReference) (generated.LaunchClaimResult, error) {
		return claim, nil
	}
	f.service.sign = func(ctx context.Context, capture generated.AgentWorkCapture) (string, error) {
		claim.Snapshot.RepositoryConfigHash = "sha256:" + strings.Repeat("f", 64)
		return workFactorySignature(ctx, capture)
	}
	payload, err := f.write(context.Background())
	if payload != nil || daemon.AsFailure(err).Code != "assignment_ended" || f.cloud.sends != 0 {
		t.Fatal("signing wait replaced scope before admission", payload, err, f.cloud.sends)
	}
	if _, found, err := f.service.journal.lookup(context.Background(), f.intent.OperationKey); err != nil || found {
		t.Fatal("replaced native scope persisted intent", found, err)
	}
}

func TestWorkAuthorityCurrentCloudDenialPrecedesCachedFingerprintConflict(t *testing.T) {
	f := newWorkServiceFixture(t, true)
	if _, err := f.write(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.intent.RequestJSON = strings.Replace(f.intent.RequestJSON, "original whitespace  ", "changed private input", 1)
	f.cloud.confirmationErr, f.cloud.confirmationReason = runner.ErrAuthorization, "revoked"
	payload, err := f.write(context.Background())
	if payload != nil || daemon.AsFailure(err).Code != "revoked" || f.cloud.sends != 1 {
		t.Fatal("cached fingerprint preceded current authority", payload, err, f.cloud.sends)
	}
}

func TestWorkAuthorityLocalStorageFailureStopsQueuedDelivery(t *testing.T) {
	f := newWorkServiceFixture(t, true)
	f.cloud.loseReply = true
	if _, err := f.write(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.service.inspect = func(context.Context, generated.AgentWorkRequest, generated.AgentSessionReference) (generated.LaunchClaimResult, error) {
		return generated.LaunchClaimResult{}, &daemon.Failure{Code: "storage_failed"}
	}
	f.service.drain(context.Background())
	if f.service.failed == nil || f.cloud.sends != 1 {
		t.Fatal("local storage error became retryable pending state", f.service.failed, f.cloud.sends)
	}
	stored, _, err := f.service.journal.lookup(context.Background(), f.intent.OperationKey)
	if err != nil || stored.State != "open" || stored.Effect != "unknown" || stored.EverDispatched == nil {
		t.Fatal("local failure erased dispatch uncertainty", stored, err)
	}
}
