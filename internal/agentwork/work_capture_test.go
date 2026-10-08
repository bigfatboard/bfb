// ABOUTME: Proves immutable capture construction preserves canonical business input and bounded permission.
// ABOUTME: Exercises scope, timing and signing failures without native callers, provider processes or network writes.

package agentwork

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func workFactoryFixture(t *testing.T) (generated.AgentCaptureConfirmationResult, []byte, *captureTiming, *workTestClock) {
	t.Helper()
	intent := workTestIntent(t, "factory", workTestID, "offline_admitted")
	var confirmation generated.AgentCaptureConfirmationResult
	if json.Unmarshal([]byte(intent.ConfirmationJSON), &confirmation) != nil {
		t.Fatal("fixture confirmation")
	}
	clock := &workTestClock{}
	timing := workFactoryTiming(t, confirmation, clock)
	return confirmation, []byte(intent.RequestJSON), timing, clock
}

func workFactoryTiming(t *testing.T, confirmation generated.AgentCaptureConfirmationResult, clock *workTestClock) *captureTiming {
	t.Helper()
	timing, err := newCaptureTiming(confirmation.ConfirmationId, clock.read)
	if err != nil {
		t.Fatal(err)
	}
	confirmed, err := time.Parse(time.RFC3339Nano, confirmation.ConfirmedAt)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := time.Parse(time.RFC3339Nano, confirmation.LeaseExpiresAt)
	if err != nil {
		t.Fatal(err)
	}
	credential, err := time.Parse(time.RFC3339Nano, confirmation.CredentialExpiresAt)
	if err != nil {
		t.Fatal(err)
	}
	if err = timing.receive(confirmation.ConfirmationId, confirmed, lease, credential); err != nil {
		t.Fatal(err)
	}
	return timing
}

// This shape-only signer stands in for the tested enrolled P-256 signer. These
// factory tests prove preparation/order, not cryptographic possession.
func workFactorySignature(context.Context, generated.AgentWorkCapture) (string, error) {
	return base64.RawURLEncoding.EncodeToString(make([]byte, 64)), nil
}

func workFactoryCapture(t *testing.T, intent journalIntent) generated.AgentWorkCapture {
	t.Helper()
	var capture generated.AgentWorkCapture
	if json.Unmarshal([]byte(intent.CaptureJSON), &capture) != nil {
		t.Fatal("capture decode")
	}
	return capture
}

func TestWorkCapturePreservesCanonicalOriginalForEveryCommand(t *testing.T) {
	for _, commandName := range []string{"agent_run.comment", "agent_run.update", "agent_run.progress", "agent_run.proposal"} {
		t.Run(commandName, func(t *testing.T) {
			confirmation, original, timing, _ := workFactoryFixture(t)
			command, _ := agentWorkCommand(commandName)
			confirmation.ConfiguredPermission = map[string]any{"allowed_tools": []string{command.tool}, "max_pending_age_seconds": 300}
			var source map[string]any
			if json.Unmarshal(original, &source) != nil {
				t.Fatal("request decode")
			}
			delete(source, "body")
			switch command.action {
			case "comment":
				source["body"] = "  original \u2028\u2029 whitespace  "
			case "update":
				source["title"] = "  title  "
				source["expected_version"] = int64(9007199254740991)
			case "progress":
				source["summary"] = "  progress  "
				source["percent"] = 10
			case "proposal":
				source["title"] = "  proposal  "
				source["parent_task_id"] = confirmation.SourceTaskId
			}
			original = []byte(workTestJSON(t, source))
			if command.action == "progress" {
				original = []byte(strings.Replace(string(original), `"percent":10`, `"percent":1.00e1`, 1))
			}
			canonical, err := protocol.CanonicalAgentWriteRequest(commandName, original)
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			intent, err := prepareWorkIntent(context.Background(), commandName, original, confirmation, timing, func(ctx context.Context, capture generated.AgentWorkCapture) (string, error) {
				calls++
				if capture.Signature != "" || capture.Operation["command_name"] != commandName || capture.Operation["operation_schema_version"] != int64(1) {
					t.Fatal("signer did not receive derived unsigned original metadata", capture)
				}
				return workFactorySignature(ctx, capture)
			})
			if err != nil || calls != 1 {
				t.Fatal("capture preparation", calls, err)
			}
			digest := sha256.Sum256([]byte(canonical))
			if intent.RequestJSON != canonical || intent.Fingerprint != hex.EncodeToString(digest[:]) || intent.AdmissionMode != "offline_admitted" {
				t.Fatal("canonical request changed", intent)
			}
			if command.action == "proposal" && (strings.Contains(intent.RequestJSON, `"priority"`) || strings.Contains(intent.RequestJSON, `"parent_task_id":null`)) {
				t.Fatal("omitted business fields filled", intent.RequestJSON)
			}
			capture := workFactoryCapture(t, intent)
			if capture.Operation["payload_hash"] != "sha256:"+intent.Fingerprint || capture.Operation["tool"] != command.tool || capture.Operation["request_id"] != source["reference"].(map[string]any)["request_id"] {
				t.Fatal("capture identity changed", capture.Operation)
			}
			if command.action == "proposal" && capture.Operation["target_task_id"] != nil {
				t.Fatal("proposal fabricated future task", capture)
			}
			if command.action == "update" && capture.Operation["expected_version"] != float64(9007199254740991) {
				t.Fatal("expected version changed", capture.Operation)
			}
		})
	}
}

func TestWorkCapturePermissionAndRepositoryHashNeverWiden(t *testing.T) {
	for _, test := range []struct {
		name         string
		tools        []string
		age          int64
		hashMismatch bool
		mode         string
	}{
		{"deny", []string{}, 0, false, "online_only"},
		{"different tool", []string{"bfb_propose_task"}, 300, false, "online_only"},
		{"exact permission", []string{"bfb_add_comment"}, 1, false, "offline_admitted"},
		{"tightened repository hash", []string{"bfb_add_comment"}, 300, true, "online_only"},
	} {
		t.Run(test.name, func(t *testing.T) {
			confirmation, original, timing, _ := workFactoryFixture(t)
			confirmation.ConfiguredPermission = map[string]any{"allowed_tools": test.tools, "max_pending_age_seconds": test.age}
			if test.hashMismatch {
				confirmation.SnapshotRepositoryConfigHash = "sha256:" + strings.Repeat("e", 64)
			}
			intent, err := prepareWorkIntent(context.Background(), "agent_run.comment", original, confirmation, timing, workFactorySignature)
			if err != nil || intent.AdmissionMode != test.mode {
				t.Fatal(intent, err)
			}
			capture := workFactoryCapture(t, intent)
			if test.mode == "online_only" {
				if capture.IntentExpiresAt != nil || capture.AdmittedPermission["max_pending_age_seconds"] != float64(0) || len(capture.AdmittedPermission["allowed_tools"].([]any)) != 0 {
					t.Fatal("online permission widened", capture)
				}
			} else if capture.IntentExpiresAt == nil || *capture.IntentExpiresAt != "2026-10-06T00:00:01.000Z" {
				t.Fatal("intent expiry not capture plus age", capture)
			}
			if capture.Confirmation.SnapshotRepositoryConfigHash != confirmation.SnapshotRepositoryConfigHash || capture.Confirmation.ApprovedRepositoryConfigHash != confirmation.ApprovedRepositoryConfigHash {
				t.Fatal("actual repository hashes replaced")
			}
		})
	}
}

func TestWorkCaptureRejectsScopeBindingAndMalformedPermissionBeforeSigning(t *testing.T) {
	for _, kind := range []string{"execution", "generation", "session", "observed-session", "provider", "proposal-parent", "unknown permission key", "missing permission age", "duplicate permission", "denied nonzero age", "unsupported tool"} {
		t.Run(kind, func(t *testing.T) {
			confirmation, original, timing, _ := workFactoryFixture(t)
			commandName := "agent_run.comment"
			var body map[string]any
			if json.Unmarshal(original, &body) != nil {
				t.Fatal("decode")
			}
			reference := body["reference"].(map[string]any)
			binding := body["binding"].(map[string]any)
			switch kind {
			case "execution":
				reference["run_execution_id"] = workOtherID
			case "generation":
				reference["assignment_generation"] = 2
			case "session":
				binding["provider_session_id"] = workOtherID
			case "observed-session":
				binding["observed_session_id"] = "another-observed"
			case "provider":
				binding["provider"] = "claude"
			case "proposal-parent":
				commandName = "agent_run.proposal"
				delete(body, "body")
				body["title"] = "proposal"
				body["parent_task_id"] = workOtherID
			case "unknown permission key":
				confirmation.ConfiguredPermission["unexpected"] = true
			case "missing permission age":
				delete(confirmation.ConfiguredPermission, "max_pending_age_seconds")
			case "duplicate permission":
				confirmation.ConfiguredPermission["allowed_tools"] = []string{"bfb_add_comment", "bfb_add_comment"}
			case "denied nonzero age":
				confirmation.ConfiguredPermission = map[string]any{"allowed_tools": []string{}, "max_pending_age_seconds": 1}
			case "unsupported tool":
				commandName = "agent_run.result"
			}
			calls := 0
			intent, err := prepareWorkIntent(context.Background(), commandName, []byte(workTestJSON(t, body)), confirmation, timing, func(context.Context, generated.AgentWorkCapture) (string, error) { calls++; return "", nil })
			if err == nil || calls != 0 || intent.OperationKey != "" {
				t.Fatal("invalid proof reached signer", kind, calls, intent, err)
			}
		})
	}
}

func TestWorkCaptureMissingAndChangedTimingRequiresFreshAnchor(t *testing.T) {
	for _, kind := range []string{"nil", "missing receipt", "different identity", "changed confirmation", "changed lease", "changed credential"} {
		t.Run(kind, func(t *testing.T) {
			confirmation, original, timing, clock := workFactoryFixture(t)
			switch kind {
			case "nil":
				timing = nil
			case "missing receipt":
				var err error
				timing, err = newCaptureTiming(confirmation.ConfirmationId, clock.read)
				if err != nil {
					t.Fatal(err)
				}
			case "different identity":
				confirmation.ConfirmationId = workOtherID
			case "changed confirmation":
				confirmation.ConfirmedAt = "2026-10-06T00:00:00.001Z"
			case "changed lease":
				confirmation.LeaseExpiresAt = "2026-10-06T00:00:44.999Z"
			case "changed credential":
				confirmation.CredentialExpiresAt = "2026-10-06T00:00:59.999Z"
			}
			calls := 0
			_, err := prepareWorkIntent(context.Background(), "agent_run.comment", original, confirmation, timing, func(context.Context, generated.AgentWorkCapture) (string, error) { calls++; return "", nil })
			if err == nil || calls != 0 {
				t.Fatal("invented timing permitted signing", calls, err)
			}
		})
	}
}

func TestWorkCaptureCeilsMillisecondsAndRejectsSigningWaitExpiry(t *testing.T) {
	for _, test := range []struct {
		name          string
		before, after time.Duration
		age           int64
		deny          bool
	}{
		{"ceil", time.Nanosecond, time.Nanosecond, 300, false},
		{"inside horizon", 0, 45*time.Second - time.Millisecond, 300, false},
		{"exact horizon", 0, 45 * time.Second, 300, true},
		{"suspend", 0, time.Hour, 300, true},
		{"inside short intent", 0, time.Second - time.Millisecond, 1, false},
		{"exact intent expiry", 0, time.Second, 1, true},
		{"ceil crosses intent expiry", 0, time.Second - time.Millisecond + time.Nanosecond, 1, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			confirmation, original, timing, clock := workFactoryFixture(t)
			confirmation.ConfiguredPermission["max_pending_age_seconds"] = test.age
			clock.set(test.before, nil)
			calls := 0
			intent, err := prepareWorkIntent(context.Background(), "agent_run.comment", original, confirmation, timing, func(ctx context.Context, capture generated.AgentWorkCapture) (string, error) {
				calls++
				clock.set(test.after, nil)
				return workFactorySignature(ctx, capture)
			})
			if calls != 1 {
				t.Fatal("not testing signer wait", calls, err)
			}
			if test.deny {
				if !errors.Is(err, errCaptureTimingExpired) || intent.OperationKey != "" {
					t.Fatal("post-sign expiry admitted", intent, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if test.name == "ceil" && workFactoryCapture(t, intent).CapturedAt != "2026-10-06T00:00:00.001Z" {
				t.Fatal("capture not canonical conservative milliseconds", intent.CaptureJSON)
			}
		})
	}
}

func TestWorkCaptureClockFaultsAndSignerFailuresNeverReturnIntent(t *testing.T) {
	for _, kind := range []string{"signer error", "invalid signature", "signature padding", "negative sample", "clock regression", "clock unavailable"} {
		t.Run(kind, func(t *testing.T) {
			confirmation, original, timing, clock := workFactoryFixture(t)
			clock.set(time.Second, nil)
			signerError := errors.New("signer unavailable")
			intent, err := prepareWorkIntent(context.Background(), "agent_run.comment", original, confirmation, timing, func(ctx context.Context, capture generated.AgentWorkCapture) (string, error) {
				switch kind {
				case "signer error":
					return "", signerError
				case "invalid signature":
					return "not a signature", nil
				case "signature padding":
					signature, _ := workFactorySignature(ctx, capture)
					return signature + "==", nil
				case "negative sample":
					clock.set(-1, nil)
				case "clock regression":
					clock.set(0, nil)
				case "clock unavailable":
					clock.set(time.Second, errCaptureClockUnavailable)
				}
				return workFactorySignature(ctx, capture)
			})
			if err == nil || intent.OperationKey != "" {
				t.Fatal("failed signer/clock produced intent", intent, err)
			}
			if kind == "signer error" && !errors.Is(err, signerError) {
				t.Fatal("signer failure hidden", err)
			}
			if strings.HasPrefix(kind, "clock") || kind == "negative sample" {
				clock.set(2*time.Second, nil)
				if _, err = timing.captureTime(); err == nil {
					t.Fatal("clock failure permission recovered")
				}
			}
		})
	}
}
