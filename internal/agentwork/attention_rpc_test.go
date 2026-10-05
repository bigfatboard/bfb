// ABOUTME: Tests fixed attention dispatch registration and authority-result provenance checks.
// ABOUTME: Keeps historical execution origin readable only within the current run and preserves binding failures.

package agentwork

import (
	"reflect"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/localmcp"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func TestAttentionRegistersOnlyFixedOnlineMethods(t *testing.T) {
	registry := daemon.NewRegistry()
	if err := registerAttentionRPC(registry, nil, nil); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(registry.Methods(), []string{"mcp.v4.get_attention", "mcp.v4.request_human"}) {
		t.Fatal(registry.Methods())
	}
}

func TestAttentionOriginKeepsHistoricalExecutionWithinRun(t *testing.T) {
	reference := generated.AgentWorkRequest{RunExecutionId: "current", AssignmentGeneration: 2}
	value := generated.AgentAttentionResult{Origin: generated.AgentAttentionOrigin{RunId: "run", RunExecutionId: "origin", AssignmentGeneration: 1}}
	if err := validateAttentionOrigin(value, reference, "run", false); err != nil {
		t.Fatal(err)
	}
	if err := validateAttentionOrigin(value, reference, "foreign", false); daemon.AsFailure(err).Code != "boundary_escape" {
		t.Fatal(err)
	}
	if err := validateAttentionOrigin(value, reference, "run", true); daemon.AsFailure(err).Code != "boundary_escape" {
		t.Fatal(err)
	}
	value.Origin.RunExecutionId, value.Origin.AssignmentGeneration = "current", 2
	if err := validateAttentionOrigin(value, reference, "run", true); daemon.AsFailure(err).Code != "boundary_escape" {
		t.Fatal("unbound creation accepted", err)
	}
	value.AuthorityBinding = &generated.AgentSessionReference{Provider: "fake", ObservedSessionId: "observed", ProviderSessionId: "canonical"}
	if err := validateAttentionOrigin(value, reference, "run", true); err != nil {
		t.Fatal(err)
	}
}

func TestAttentionTrustedObservationAndFailureMapping(t *testing.T) {
	binding := &generated.AgentSessionReference{Provider: "fake", ObservedSessionId: "observed"}
	if attentionObservationMatches(binding, localmcp.SessionBinding{}) {
		t.Fatal("unobserved session accepted")
	}
	if !attentionObservationMatches(binding, localmcp.SessionBinding{Provider: "fake", ObservedSessionID: "observed"}) {
		t.Fatal("trusted identity rejected")
	}
	if attentionObservationMatches(binding, localmcp.SessionBinding{Provider: "codex", ObservedSessionID: "observed"}) {
		t.Fatal("provider mismatch accepted")
	}
	if daemon.AsFailure(attentionBindingError(localmcp.ErrSessionNotBound)).Code != "session_not_bound" {
		t.Fatal("unbound sentinel lost")
	}
	if daemon.AsFailure(attentionBindingError(&localmcp.Error{Code: "storage_failed"})).Code != "storage_failed" {
		t.Fatal("storage failure downgraded")
	}
}
