// ABOUTME: Tests artifact identity, closed metadata and current daemon delivery through the v6 socket.
// ABOUTME: Refuses credential fields and keeps retries online without cached success or a provider journal.

package localmcp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func artifactFixtureResult(t *testing.T) map[string]any {
	t.Helper()
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "protocol/fixtures/v6/local-agent-artifact-rpc.json"))
	if err != nil {
		t.Fatal(err)
	}
	var matrix struct{ Fixtures []struct{ Name, JSON string } }
	if json.Unmarshal(data, &matrix) != nil {
		t.Fatal("invalid artifact fixture matrix")
	}
	for _, entry := range matrix.Fixtures {
		if entry.Name == "agent-artifact-result-minimal" {
			var result map[string]any
			if json.Unmarshal([]byte(entry.JSON), &result) != nil {
				t.Fatal("invalid shared artifact result")
			}
			return result
		}
	}
	t.Fatal("missing artifact result fixture")
	return nil
}

func TestArtifactRPCPreservesOriginalInputAndRefusesForeignPrivateMetadata(t *testing.T) {
	for _, fault := range []string{"none", "key", "run_id", "run_execution_id", "assignment_generation", "provider_session_id", "format", "role", "artifact_id", "secret", "work_unavailable", "revoked"} {
		t.Run(fault, func(t *testing.T) {
			dir, err := os.MkdirTemp("", "bfb-artifact-rpc-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(dir) })
			paths, _ := daemon.StatePaths(dir)
			result := artifactFixtureResult(t)
			id := "01K6R7DT00AAAAAAAAAAAAAAAA"
			sessionID := "01K6R7DT00BBBBBBBBBBBBBBBB"
			reference := generated.AgentWorkRequest{SchemaVersion: 1, RunExecutionId: id, AssignmentGeneration: 1, RequestId: "artifact-rpc-001"}
			key, _ := protocol.ArtifactOperationKey(reference)
			result["operation_key"] = key
			origin := result["origin"].(map[string]any)
			origin["run_id"], origin["run_execution_id"], origin["assignment_generation"], origin["provider_session_id"] = id, id, float64(1), sessionID
			params := map[string]any{"request_id": reference.RequestId, "path": "nested/review.md", "format": result["format"], "role": result["role"]}
			if fault == "artifact_id" {
				params["artifact_id"] = "01K6R7DT00CCCCCCCCCCCCCCCC"
			}
			switch fault {
			case "key":
				result["operation_key"] = "agent:" + strings.Repeat("0", 64)
			case "run_id", "run_execution_id", "provider_session_id":
				origin[fault] = "01K6R7DT00CCCCCCCCCCCCCCCC"
			case "assignment_generation":
				origin[fault] = float64(2)
			case "format":
				result["format"] = "html"
			case "role":
				result["role"] = "log"
			case "secret":
				result["secret"] = "private-canary"
			}
			observed := make(chan map[string]any, 1)
			registry := daemon.NewRegistry()
			if err := registry.Register("mcp.v6.publish_artifact", func(_ context.Context, request daemon.Request) (map[string]any, error) {
				observed <- request.Envelope.Payload["agent_artifact_request"].(map[string]any)
				if fault == "work_unavailable" || fault == "revoked" {
					return nil, &daemon.Failure{Code: fault}
				}
				return map[string]any{"agent_artifact": result}, nil
			}); err != nil {
				t.Fatal(err)
			}
			server, err := daemon.Start(context.Background(), paths, registry)
			if err != nil {
				t.Fatal(err)
			}
			defer server.Close()
			boundary := Boundary{WorkspaceID: id, ProjectID: id, TaskID: id, RunID: id, ExecutionID: id, RunnerID: id, CheckoutID: id, Generation: 1}
			session := ConfirmedSession{ProviderSessionId: sessionID, Provider: "fake", ObservedSessionId: "synthetic-session"}
			_, err = (RPCTransport{Paths: paths, Correlation: "synthetic-correlation"}).PublishArtifact(context.Background(), boundary, &session, params, reference.RequestId)
			want := "boundary_escape"
			if fault == "none" {
				want = ""
			}
			if fault == "secret" {
				// The actual daemon refuses to encode a widened closed response.
				want = "internal_error"
			}
			if fault == "revoked" || fault == "work_unavailable" {
				want = fault
			}
			if fault == "none" && err != nil || fault != "none" && CodeOf(err) != want {
				t.Fatal("artifact response scope mismatch", fault, err)
			}
			local := <-observed
			if local["expected_binding"] == nil {
				t.Fatal("activated binding missing")
			}
			original := local["request"].(map[string]any)
			if original["path"] != params["path"] || original["format"] != params["format"] || original["role"] != params["role"] {
				t.Fatal("original metadata changed")
			}
			if fault != "artifact_id" {
				if _, present := original["artifact_id"]; present {
					t.Fatal("omitted artifact selection substituted")
				}
			}
			for _, field := range []string{"binding", "origin", "secret", "r2_key", "expected_digest", "declared_size"} {
				if _, present := original[field]; present {
					t.Fatal("private scope supplied by client", field)
				}
			}
		})
	}
}

type artifactFixtureTransport struct {
	*admissionFixtureTransport
	calls    int
	expected *ConfirmedSession
	err      error
}

func (transport *artifactFixtureTransport) PublishArtifact(_ context.Context, _ Boundary, expected *ConfirmedSession, _ map[string]any, _ string) (any, error) {
	transport.calls++
	transport.expected = expected
	return generated.AgentArtifactResult{State: "available"}, transport.err
}
func artifactFixtureHost() (*Host, *Capability, *fakeBindings, *fakeAuthority, *artifactFixtureTransport) {
	_, capability, bindings, authority, work := admissionFixtureHost()
	transport := &artifactFixtureTransport{admissionFixtureTransport: work}
	return NewHost(HostDeps{Capability: capability, Transport: transport}), capability, bindings, authority, transport
}

func TestArtifactHostAlwaysRecontactsDaemonAndNeverCachesPrivateOutcome(t *testing.T) {
	host, capability, bindings, authority, transport := artifactFixtureHost()
	params := map[string]any{"request_id": "artifact-host-001", "path": "review.md", "format": "markdown", "role": "review"}
	// No old launch poll may close a submitted-run retry. The daemon alone
	// derives fresh provisional binding and current active-run authority.
	authority.err = fail("capability_closed")
	if _, err := host.CallTool(context.Background(), "bfb_publish_artifact", params); err != nil || transport.calls != 1 || transport.expected != nil {
		t.Fatal("provisional publication used old launch authority", err)
	}
	if host.seen["artifact-host-001"].result != nil {
		t.Fatal("artifact success body memoized")
	}
	params["path"] = "same-bytes.md"
	if _, err := host.CallTool(context.Background(), "bfb_publish_artifact", params); err != nil || transport.calls != 2 {
		t.Fatal("equivalent safe path decided locally", err)
	}
	params["format"] = "html"
	transport.err = fail("request_conflict")
	if _, err := host.CallTool(context.Background(), "bfb_publish_artifact", params); CodeOf(err) != "request_conflict" || transport.calls != 3 {
		t.Fatal("canonical conflict bypassed daemon authority", err)
	}
	transport.err, authority.err = nil, nil
	if err := capability.allowWrite(context.Background()); err != nil {
		t.Fatal(err)
	}
	params["format"] = "markdown"
	if _, err := host.CallTool(context.Background(), "bfb_publish_artifact", params); err != nil || transport.expected == nil {
		t.Fatal("activated assertion lost", err)
	}
	bindings.binding.ObservedSessionID = "changed-session"
	if _, err := host.CallTool(context.Background(), "bfb_publish_artifact", params); CodeOf(err) != "session_conflict" || transport.calls != 4 {
		t.Fatal("changed trusted observation passed", err)
	}
}

func TestArtifactOfflineAndAuthorityDenialHaveNoProviderJournalFallback(t *testing.T) {
	for _, code := range []string{"work_unavailable", "revoked", "assignment_ended", "capability_closed"} {
		t.Run(code, func(t *testing.T) {
			host, capability, _, _, transport := artifactFixtureHost()
			transport.err = fail(code)
			params := map[string]any{"request_id": "artifact-unavailable-001", "path": "review.md", "format": "markdown", "role": "review"}
			if _, err := host.CallTool(context.Background(), "bfb_publish_artifact", params); CodeOf(err) != code || len(host.seen) != 0 || transport.calls != 1 {
				t.Fatal("denial became queued/success", err)
			}
			if code != "work_unavailable" && capability.State() != StateClosed {
				t.Fatal("terminal denial did not close Host")
			}
			if transport.admissionFixtureTransport.calls != 0 {
				t.Fatal("artifact used work journal lane")
			}
		})
	}
	host, _, _, authority, _ := artifactFixtureHost()
	params := map[string]any{"request_id": "artifact-cross-tool-001", "path": "review.md", "format": "markdown", "role": "review"}
	if _, err := host.CallTool(context.Background(), "bfb_publish_artifact", params); err != nil {
		t.Fatal(err)
	}
	authority.err = fail("revoked")
	if _, err := host.CallTool(context.Background(), "bfb_get_task", map[string]any{"request_id": params["request_id"]}); CodeOf(err) != "revoked" {
		t.Fatal("cross-tool conflict bypassed current authority", err)
	}
}

func TestArtifactInputRefusesUnsafePathsAndCredentialScope(t *testing.T) {
	base := map[string]any{"request_id": "artifact-input-001", "path": "nested/review.md", "format": "markdown", "role": "review"}
	if ValidateArtifactInput(base) != nil {
		t.Fatal("safe bounded input rejected")
	}
	for _, path := range []string{"", "/tmp/review.md", "../review.md", "nested/../review.md", "./review.md", "nested//review.md", "review\x00.md", strings.Repeat("x", 4097)} {
		clone := map[string]any{}
		for key, value := range base {
			clone[key] = value
		}
		clone["path"] = path
		if ValidateArtifactInput(clone) == nil {
			t.Fatal("unsafe public path accepted")
		}
	}
	for _, field := range []string{"origin", "control_url", "secret", "grant_id", "workspace_id", "run_id", "binding", "expected_digest", "declared_size", "r2_key"} {
		clone := map[string]any{}
		for key, value := range base {
			clone[key] = value
		}
		clone[field] = "private-canary"
		if ValidateArtifactInput(clone) == nil {
			t.Fatal("caller-selected authority accepted", field)
		}
	}
}
