// ABOUTME: Tests result-specific capture eligibility, exact request bytes and bounded signing deadlines.
// ABOUTME: Exercises shared journal quotas and rejects substitution by the existing task capture family.

package agentwork

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func resultFactoryFixture(t *testing.T) (generated.AgentResultConfirmationResult, []byte, *captureTiming, *workTestClock) {
	t.Helper()
	task, original, timing, clock := workFactoryFixture(t)
	var confirmation generated.AgentResultConfirmationResult
	if json.Unmarshal([]byte(workTestJSON(t, task)), &confirmation) != nil {
		t.Fatal("confirmation conversion")
	}
	confirmation.CanSubmit = true
	confirmation.ConfiguredPermission = map[string]any{"allow_submit_result": true, "max_pending_age_seconds": 300}
	var input map[string]any
	_ = json.Unmarshal(original, &input)
	delete(input, "body")
	input["summary"], input["evidence_refs"] = "  original result \u2028 whitespace  ", []any{}
	return confirmation, []byte(workTestJSON(t, input)), timing, clock
}

func resultFactorySignature(context.Context, generated.AgentResultCapture) (string, error) {
	return base64.RawURLEncoding.EncodeToString(make([]byte, 64)), nil
}

func resultTestIntent(t *testing.T, id string) journalIntent {
	t.Helper()
	confirmation, original, timing, _ := resultFactoryFixture(t)
	var input map[string]any
	_ = json.Unmarshal(original, &input)
	input["reference"].(map[string]any)["request_id"] = "result-" + id
	intent, err := prepareResultIntent(context.Background(), []byte(workTestJSON(t, input)), confirmation, timing, resultFactorySignature)
	if err != nil {
		t.Fatal(err)
	}
	return intent
}

func TestResultCapturePreservesInputAndSeparatePolicy(t *testing.T) {
	for _, setting := range []string{"enabled", "denied", "hash_mismatch", "ineligible", "task_permission"} {
		t.Run(setting, func(t *testing.T) {
			confirmation, original, timing, _ := resultFactoryFixture(t)
			switch setting {
			case "denied":
				confirmation.ConfiguredPermission = map[string]any{"allow_submit_result": false, "max_pending_age_seconds": 0}
			case "hash_mismatch":
				confirmation.ApprovedRepositoryConfigHash = "sha256:" + strings.Repeat("e", 64)
			case "ineligible":
				confirmation.CanSubmit = false
			case "task_permission":
				confirmation.ConfiguredPermission = map[string]any{"allowed_tools": []string{"bfb_add_comment"}, "max_pending_age_seconds": 300}
			}
			calls := 0
			intent, err := prepareResultIntent(context.Background(), original, confirmation, timing, func(ctx context.Context, capture generated.AgentResultCapture) (string, error) {
				calls++
				return resultFactorySignature(ctx, capture)
			})
			if setting == "ineligible" || setting == "task_permission" {
				if err == nil || calls != 0 {
					t.Fatal("invalid authority reached signing", err, calls)
				}
				return
			}
			if err != nil || calls != 1 {
				t.Fatal(err, calls)
			}
			canonical, _ := protocol.CanonicalAgentWriteRequest("result.submit", original)
			if intent.RequestJSON != canonical || !strings.Contains(canonical, `"evidence_refs":[]`) || !strings.Contains(canonical, "  original result") {
				t.Fatal("original optional/text bytes changed")
			}
			capture := mustResultCapture(intent)
			if setting == "enabled" {
				if intent.AdmissionMode != "offline_admitted" || capture.IntentExpiresAt == nil {
					t.Fatal("result permission missing")
				}
			} else if intent.AdmissionMode != "online_only" || capture.IntentExpiresAt != nil || capture.AdmittedPermission["allow_submit_result"] != false {
				t.Fatal("result permission widened")
			}
		})
	}
}

func TestResultCaptureSigningCannotExtendDeadline(t *testing.T) {
	confirmation, original, timing, clock := resultFactoryFixture(t)
	if _, err := prepareResultIntent(context.Background(), original, confirmation, timing, func(ctx context.Context, capture generated.AgentResultCapture) (string, error) {
		clock.set(45*time.Second, nil)
		return resultFactorySignature(ctx, capture)
	}); !errors.Is(err, errCaptureTimingExpired) {
		t.Fatal("signature delay extended deadline", err)
	}
}

func TestResultJournalFamilySubstitutionAndSharedQuota(t *testing.T) {
	journal, _, _ := newWorkTestJournal(t)
	ctx := context.Background()
	result := resultTestIntent(t, "shared-quota")
	if _, _, err := journal.admit(ctx, result, false); err != nil {
		t.Fatal(err)
	}
	for index := 1; index < workRunUnresolvedLimit; index++ {
		if _, _, err := journal.admit(ctx, workTestIntent(t, fmt.Sprint(index), workTestID, "offline_admitted"), false); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := journal.admit(ctx, resultTestIntent(t, "over-capacity"), false); !errors.Is(err, errWorkQuota) {
		t.Fatal("result gained separate run quota", err)
	}
	if _, added, err := journal.admit(ctx, result, false); err != nil || added {
		t.Fatal("identical result at capacity", added, err)
	}
	result.CaptureFamily = "agent_work"
	if err := validateJournalIntent(result); err == nil {
		t.Fatal("result relabelled as task proof")
	}
	result = resultTestIntent(t, "confirmation-substitution")
	var confirmation map[string]any
	_ = json.Unmarshal([]byte(result.ConfirmationJSON), &confirmation)
	confirmation["can_submit"] = false
	result.ConfirmationJSON = workTestJSON(t, confirmation)
	if err := validateJournalIntent(result); err == nil {
		t.Fatal("capture silently lost result-only eligibility field")
	}
}
