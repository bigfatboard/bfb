// ABOUTME: Verifies fixed online artifact phases and immutable input against a bounded cloud double.
// ABOUTME: Tests explicit recovery and fresh postflight denial without granting journal or native acceptance.

package agentwork

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

type artifactCloudDouble struct {
	runner.RunnerConnection
	t        *testing.T
	original generated.AgentArtifactRequest
	result   generated.AgentArtifactResult
	stage    string
	actions  []string
	bodies   [][]byte
	uploads  int
	fault    string
	mutate   func(*generated.AgentArtifactPrepareResult)
}

func artifactPhaseFixture(t *testing.T) (*artifactCloudDouble, []byte) {
	t.Helper()
	content := []byte("  synthetic artifact\n")
	digest := sha256.Sum256(content)
	original := generated.AgentArtifactRequest{Reference: generated.AgentWorkRequest{SchemaVersion: 1, RunExecutionId: workTestID, AssignmentGeneration: 1, RequestId: "artifact-phase-001"}, Binding: generated.AgentSessionReference{ProviderSessionId: workOtherID, Provider: "fake", ObservedSessionId: "synthetic-artifact-session"}, Format: "markdown", Role: "review", DeclaredSize: int64(len(content)), ExpectedDigest: hex.EncodeToString(digest[:])}
	key, err := protocol.ArtifactOperationKey(original.Reference)
	if err != nil {
		t.Fatal(err)
	}
	result := generated.AgentArtifactResult{SchemaVersion: 1, OperationKey: key, ArtifactId: workOtherID, VersionId: workTestID, Format: original.Format, Role: original.Role, ContentHash: original.ExpectedDigest, Size: original.DeclaredSize, State: "available", AvailableAt: "2026-10-06T12:00:00Z", Origin: generated.AgentEffectOrigin{RunId: workTestID, RunExecutionId: original.Reference.RunExecutionId, AssignmentGeneration: original.Reference.AssignmentGeneration, ProviderSessionId: original.Binding.ProviderSessionId}}
	return &artifactCloudDouble{t: t, original: original, result: result, stage: "upload_required"}, content
}

func (cloud *artifactCloudDouble) Request(_ context.Context, method, action string, body []byte) ([]byte, error) {
	cloud.t.Helper()
	if method != "POST" || action != "work/artifact-prepare" && action != "work/artifact-finalize" {
		cloud.t.Fatal("unbounded publication phase", method, action)
	}
	expected, _ := json.Marshal(cloud.original)
	if !bytes.Equal(body, expected) {
		cloud.t.Fatal("original input changed between phases")
	}
	cloud.actions = append(cloud.actions, action)
	cloud.bodies = append(cloud.bodies, append([]byte(nil), body...))
	if cloud.fault == action {
		return nil, runner.ErrOffline
	}
	if action == "work/artifact-finalize" {
		return json.Marshal(cloud.result)
	}
	prepared := generated.AgentArtifactPrepareResult{SchemaVersion: 1, OperationKey: cloud.result.OperationKey, ArtifactId: cloud.result.ArtifactId, VersionId: cloud.result.VersionId, Format: cloud.result.Format, Role: cloud.result.Role, ContentHash: cloud.result.ContentHash, Size: cloud.result.Size, Origin: cloud.result.Origin, Stage: cloud.stage}
	if cloud.stage == "upload_required" {
		prepared.Upload = artifactUploadGrant{Origin: "https://artifacts.example.test", GrantID: workTestID, Secret: base64.RawURLEncoding.EncodeToString(make([]byte, 32)), ExpiresAt: "2026-10-06T12:01:00Z"}
	}
	if cloud.stage == "available" {
		prepared.AvailableAt = &cloud.result.AvailableAt
	}
	if cloud.mutate != nil {
		cloud.mutate(&prepared)
	}
	return json.Marshal(prepared)
}

func (cloud *artifactCloudDouble) UploadArtifact(_ context.Context, origin, grantID, secret string, content []byte) ([]byte, error) {
	cloud.t.Helper()
	digest := sha256.Sum256(content)
	if origin != "https://artifacts.example.test" || grantID != workTestID || len(secret) != 43 || hex.EncodeToString(digest[:]) != cloud.original.ExpectedDigest {
		cloud.t.Fatal("upload differs from prepared grant/snapshot")
	}
	cloud.uploads++
	if cloud.fault == "upload" {
		return nil, runner.ErrOffline
	}
	return []byte(`{"ok":true}`), nil
}

func TestArtifactPhasesPreserveOriginalSelectionAndOnlyExposeFinalResult(t *testing.T) {
	for _, stage := range []string{"upload_required", "finalize_required", "available"} {
		for _, selected := range []bool{false, true} {
			t.Run(stage+map[bool]string{false: "/absent", true: "/selected"}[selected], func(t *testing.T) {
				cloud, content := artifactPhaseFixture(t)
				cloud.stage = stage
				if selected {
					cloud.original.ArtifactId = &cloud.result.ArtifactId
				}
				checks := 0
				result, err := publishArtifactSnapshot(context.Background(), cloud, cloud.original, workTestID, content, func(context.Context) error { checks++; return nil })
				if err != nil || result != cloud.result {
					t.Fatal("final projection differs", err)
				}
				wantPhases, wantChecks, wantUploads := 2, 3, 0
				if stage == "upload_required" {
					wantChecks, wantUploads = 4, 1
				}
				if stage == "available" {
					wantPhases, wantChecks = 1, 2
				}
				if len(cloud.actions) != wantPhases || checks != wantChecks || cloud.uploads != wantUploads {
					t.Fatal("wrong phase/postflight sequence", cloud.actions, checks, cloud.uploads)
				}
				encoded, _ := json.Marshal(result)
				for _, private := range []string{"upload", "secret", "origin_url", "r2_key", "path", string(content)} {
					if strings.Contains(string(encoded), private) {
						t.Fatal("private upload data in success", private)
					}
				}
			})
		}
	}
}

func TestArtifactUnavailableNeverMeansQueuedOrNoEffectAndExplicitRetryReprepares(t *testing.T) {
	for _, phase := range []string{"work/artifact-prepare", "upload", "work/artifact-finalize"} {
		t.Run(phase, func(t *testing.T) {
			cloud, content := artifactPhaseFixture(t)
			cloud.fault = phase
			result, err := publishArtifactSnapshot(context.Background(), cloud, cloud.original, workTestID, content, func(context.Context) error { return nil })
			if daemon.AsFailure(err).Code != "work_unavailable" || result.OperationKey != "" {
				t.Fatal("uncertain phase misreported", phase, err)
			}
			attempts := len(cloud.actions)
			cloud.fault, cloud.stage = "", "available"
			result, err = publishArtifactSnapshot(context.Background(), cloud, cloud.original, workTestID, content, func(context.Context) error { return nil })
			if err != nil || result != cloud.result || len(cloud.actions) != attempts+1 || cloud.actions[attempts] != "work/artifact-prepare" {
				t.Fatal("explicit retry failed canonical recovery", err)
			}
		})
	}
}

func TestArtifactPostflightDenialWithholdsCommittedPrivateBodyAndStopsRemainingPhases(t *testing.T) {
	for _, stop := range []int{1, 2, 3, 4} {
		t.Run(string(rune('0'+stop)), func(t *testing.T) {
			cloud, content := artifactPhaseFixture(t)
			checks := 0
			result, err := publishArtifactSnapshot(context.Background(), cloud, cloud.original, workTestID, content, func(context.Context) error {
				checks++
				if checks == stop {
					return &daemon.Failure{Code: "assignment_ended"}
				}
				return nil
			})
			if daemon.AsFailure(err).Code != "assignment_ended" || result.OperationKey != "" {
				t.Fatal("postflight delivered private outcome", stop, err)
			}
			want := []int{0, 1, 1, 2}[stop-1]
			if len(cloud.actions) != want {
				t.Fatal("continued after local denial", cloud.actions)
			}
		})
	}
}

func TestArtifactResponseAndSnapshotCorrelationFailClosed(t *testing.T) {
	for _, field := range []string{"key", "run", "execution", "generation", "session", "digest", "size", "format", "role", "selector", "version", "available_null", "private_upload"} {
		t.Run(field, func(t *testing.T) {
			cloud, content := artifactPhaseFixture(t)
			cloud.mutate = func(result *generated.AgentArtifactPrepareResult) {
				switch field {
				case "key":
					result.OperationKey = "agent:" + strings.Repeat("0", 64)
				case "run":
					result.Origin.RunId = workOtherID
				case "execution":
					result.Origin.RunExecutionId = workOtherID
				case "generation":
					result.Origin.AssignmentGeneration++
				case "session":
					result.Origin.ProviderSessionId = workTestID
				case "digest":
					result.ContentHash = strings.Repeat("0", 64)
				case "size":
					result.Size++
				case "format":
					result.Format = "html"
				case "role":
					result.Role = "log"
				case "selector":
					cloud.original.ArtifactId = &cloud.result.VersionId
					result.ArtifactId = cloud.result.ArtifactId
				case "version":
					result.VersionId = workOtherID
				case "available_null":
					result.Stage, result.Upload = "available", nil
				case "private_upload":
					result.Upload = map[string]any{"secret": "private-canary"}
				}
			}
			if field == "selector" {
				cloud.original.ArtifactId = &cloud.result.VersionId
			}
			result, err := publishArtifactSnapshot(context.Background(), cloud, cloud.original, workTestID, content, func(context.Context) error { return nil })
			if daemon.AsFailure(err).Code != "request_rejected" || result.OperationKey != "" {
				t.Fatal("foreign result accepted", field, err)
			}
		})
	}
	for _, changed := range [][]byte{nil, []byte("changed"), []byte("  synthetic artifact\nextra")} {
		cloud, _ := artifactPhaseFixture(t)
		if _, err := publishArtifactSnapshot(context.Background(), cloud, cloud.original, workTestID, changed, func(context.Context) error { return nil }); daemon.AsFailure(err).Code != "request_rejected" || len(cloud.actions) != 0 {
			t.Fatal("snapshot mismatch sent", err)
		}
	}
}
