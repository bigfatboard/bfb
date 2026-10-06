// ABOUTME: Publishes online artifacts from authenticated pinned local files through fixed cloud phases.
// ABOUTME: Keeps immutable byte snapshots and ephemeral grants in memory with no journal or automatic retry.

package agentwork

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/qdis/bfb/internal/checkout"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/localmcp"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
	"github.com/qdis/bfb/internal/supervisor"
)

type artifactUploadGrant struct {
	Origin    string `json:"origin"`
	GrantID   string `json:"grant_id"`
	Secret    string `json:"secret"`
	ExpiresAt string `json:"expires_at"`
}

func registerArtifactRPC(registry *daemon.Registry, service *workService) error {
	return registry.Register("mcp.v6.publish_artifact", func(ctx context.Context, request daemon.Request) (output map[string]any, failure error) {
		defer func() { service.results.invalidateOnDenial(failure) }()
		data, err := json.Marshal(request.Envelope.Payload["agent_artifact_request"])
		if err != nil || request.Envelope.SchemaVersion != 6 || len(request.Envelope.Payload) != 1 || request.Store == nil || !protocol.DecodeWireDocument("agent-artifact-local-request", data).OK {
			return nil, &daemon.Failure{Code: "invalid_request"}
		}
		var local generated.AgentArtifactLocalRequest
		var input struct {
			Reference  generated.AgentWorkRequest `json:"reference"`
			Path       string                     `json:"path"`
			ArtifactID *generated.Ulid            `json:"artifact_id"`
			Format     string                     `json:"format"`
			Role       string                     `json:"role"`
		}
		if json.Unmarshal(data, &local) != nil {
			return nil, &daemon.Failure{Code: "invalid_request"}
		}
		inner, err := json.Marshal(local.Request)
		if err != nil || json.Unmarshal(inner, &input) != nil {
			return nil, &daemon.Failure{Code: "invalid_request"}
		}
		callerInput := generated.AgentLocalRequest{Correlation: local.Correlation, Request: input.Reference}
		assignment, caller, err := localmcp.VerifyDaemonCaller(ctx, request, callerInput)
		if err != nil {
			return nil, &daemon.Failure{Code: localmcp.CodeOf(err)}
		}
		if err := service.ownership(ctx, input.Reference.RunExecutionId, input.Reference.AssignmentGeneration); err != nil {
			return nil, ownershipError(err)
		}
		peerCheck := func(ctx context.Context) error {
			currentAssignment, current, err := localmcp.VerifyDaemonCaller(ctx, request, callerInput)
			if err != nil {
				return &daemon.Failure{Code: localmcp.CodeOf(err)}
			}
			if current.StartIdentity != caller.StartIdentity || currentAssignment != assignment {
				return &daemon.Failure{Code: "peer_denied"}
			}
			return nil
		}
		binding := local.ExpectedBinding
		if binding == nil {
			confirmed, err := service.bindCurrentAgentSession(ctx, input.Reference, peerCheck)
			if err != nil {
				return nil, artifactChannelFailure(err)
			}
			binding = &confirmed
		}
		claim, err := service.inspect(ctx, input.Reference, *binding)
		if err != nil {
			return nil, err
		}
		files, err := supervisor.ReadAssignmentFiles(request.Store.Paths.Root)
		if err != nil {
			return nil, &daemon.Failure{Code: "storage_failed"}
		}
		defer files.Close()
		view, err := supervisor.NewIntentStore(request.Store.DB).JournalByExecution(ctx, input.Reference.RunExecutionId, input.Reference.AssignmentGeneration)
		if err != nil {
			return nil, ownershipError(err)
		}
		wire, err := files.Read(view.IntentID)
		if err != nil || wire.Claim.Assignment != claim.Assignment || wire.Claim.FencingGeneration != claim.FencingGeneration || wire.Claim.Specification.ConfigSnapshotHash != claim.Specification.ConfigSnapshotHash {
			return nil, &daemon.Failure{Code: "assignment_ended"}
		}
		checkoutRecord, err := checkout.NewRegistry(request.Store.DB).Get(ctx, claim.Assignment.CheckoutId)
		if err != nil || checkoutRecord.Summary.WorkspaceId != claim.Assignment.WorkspaceId || checkoutRecord.Summary.RunnerId != claim.Assignment.RunnerId || checkoutRecord.Summary.ProjectId != claim.Assignment.ProjectId || checkoutRecord.Summary.PhysicalWorktreeHash != claim.Snapshot.PhysicalWorktreeHash {
			return nil, &daemon.Failure{Code: "assignment_ended"}
		}
		channel, err := service.connection(claim.Assignment.RunnerId)
		if err != nil {
			return nil, artifactTransportFailure(err, nil)
		}
		connectionCheck, err := artifactConnectionCheck(channel, func() (runner.RunnerConnection, error) {
			return service.connection(claim.Assignment.RunnerId)
		})
		if err != nil {
			return nil, err
		}
		postflight := func(ctx context.Context) error {
			if err := connectionCheck(); err != nil {
				return err
			}
			if err := peerCheck(ctx); err != nil {
				return err
			}
			current, err := service.inspect(ctx, input.Reference, *binding)
			if err != nil {
				return err
			}
			if current.Assignment != claim.Assignment || current.FencingGeneration != claim.FencingGeneration || current.Specification.ConfigSnapshotHash != claim.Specification.ConfigSnapshotHash {
				return &daemon.Failure{Code: "assignment_ended"}
			}
			if _, err := files.ReadPreparation(wire, checkoutRecord.Location.GitRoot); err != nil {
				return &daemon.Failure{Code: "assignment_ended"}
			}
			return connectionCheck()
		}
		limit := int64(5 * 1024 * 1024)
		if input.Role == "log" {
			limit = 1024 * 1024
		}
		content, err := files.ReadArtifactSnapshot(ctx, wire, checkoutRecord.Location.GitRoot, input.Path, limit)
		if err != nil {
			if daemon.AsFailure(err).Code == "storage_failed" {
				return nil, &daemon.Failure{Code: "storage_failed"}
			}
			return nil, &daemon.Failure{Code: "request_rejected"}
		}
		defer clear(content)
		digest := sha256.Sum256(content)
		original := generated.AgentArtifactRequest{Reference: input.Reference, Binding: *binding, ArtifactId: input.ArtifactID, Format: input.Format, Role: input.Role, DeclaredSize: int64(len(content)), ExpectedDigest: hex.EncodeToString(digest[:])}
		result, err := publishArtifactSnapshot(ctx, channel, original, claim.Assignment.RunId, content, postflight)
		if err != nil {
			return nil, err
		}
		payload := map[string]any{"agent_artifact": result}
		if _, err := daemon.EncodeEnvelope(daemon.ResponseVersion(6, request.Envelope.Method, request.Envelope.RequestId, payload, nil)); err != nil {
			return nil, &daemon.Failure{Code: "request_rejected"}
		}
		return payload, nil
	})
}

func publishArtifactSnapshot(ctx context.Context, channel runner.RunnerConnection, original generated.AgentArtifactRequest, runID string, content []byte, postflight func(context.Context) error) (generated.AgentArtifactResult, error) {
	var empty generated.AgentArtifactResult
	body, err := json.Marshal(original)
	if err != nil || !protocol.DecodeWireDocument("agent-artifact-request", body).OK || postflight == nil {
		return empty, &daemon.Failure{Code: "request_rejected"}
	}
	digest := sha256.Sum256(content)
	if int64(len(content)) != original.DeclaredSize || hex.EncodeToString(digest[:]) != original.ExpectedDigest {
		return empty, &daemon.Failure{Code: "request_rejected"}
	}
	if err := postflight(ctx); err != nil {
		return empty, err
	}
	data, err := channel.Request(ctx, "POST", "work/artifact-prepare", body)
	if err != nil {
		return empty, artifactTransportFailure(err, data)
	}
	var prepared generated.AgentArtifactPrepareResult
	if !protocol.DecodeWireDocument("agent-artifact-prepare-result", data).OK || json.Unmarshal(data, &prepared) != nil || !artifactPreparedMatches(prepared, original, runID) {
		return empty, &daemon.Failure{Code: "request_rejected"}
	}
	if err := postflight(ctx); err != nil {
		return empty, err
	}
	if prepared.Stage == "available" {
		return artifactPreparedResult(prepared), nil
	}
	if prepared.Stage == "upload_required" {
		var grant artifactUploadGrant
		encoded, err := json.Marshal(prepared.Upload)
		defer clear(encoded)
		uploader, ok := channel.(runner.ArtifactUploadConnection)
		if err != nil || json.Unmarshal(encoded, &grant) != nil || !ok {
			return empty, &daemon.Failure{Code: "request_rejected"}
		}
		data, err = uploader.UploadArtifact(ctx, grant.Origin, grant.GrantID, grant.Secret, content)
		grant.Secret, prepared.Upload = "", nil
		if err != nil {
			return empty, artifactTransportFailure(err, data)
		}
		if err := postflight(ctx); err != nil {
			return empty, err
		}
	}
	// Preserve the original artifact_id selection, including omission, across
	// phases. Returned IDs are response correlation, never rewritten input.
	data, err = channel.Request(ctx, "POST", "work/artifact-finalize", body)
	if err != nil {
		return empty, artifactTransportFailure(err, data)
	}
	var result generated.AgentArtifactResult
	if !protocol.DecodeWireDocument("agent-artifact-result", data).OK || json.Unmarshal(data, &result) != nil || !artifactResultMatches(result, original, runID) || result.ArtifactId != prepared.ArtifactId || result.VersionId != prepared.VersionId {
		return empty, &daemon.Failure{Code: "request_rejected"}
	}
	if err := postflight(ctx); err != nil {
		return empty, err
	}
	return result, nil
}

func artifactPreparedMatches(result generated.AgentArtifactPrepareResult, input generated.AgentArtifactRequest, runID string) bool {
	return artifactResultMatches(artifactPreparedResult(result), input, runID)
}

func artifactResultMatches(result generated.AgentArtifactResult, input generated.AgentArtifactRequest, runID string) bool {
	key, err := protocol.ArtifactOperationKey(input.Reference)
	return err == nil && result.OperationKey == key && result.Format == input.Format && result.Role == input.Role && result.ContentHash == input.ExpectedDigest && result.Size == input.DeclaredSize &&
		result.Origin.RunId == runID && result.Origin.RunExecutionId == input.Reference.RunExecutionId && result.Origin.AssignmentGeneration == input.Reference.AssignmentGeneration && result.Origin.ProviderSessionId == input.Binding.ProviderSessionId &&
		(input.ArtifactId == nil || result.ArtifactId == *input.ArtifactId)
}

func artifactPreparedResult(input generated.AgentArtifactPrepareResult) generated.AgentArtifactResult {
	result := generated.AgentArtifactResult{SchemaVersion: 1, OperationKey: input.OperationKey, ArtifactId: input.ArtifactId, VersionId: input.VersionId, Format: input.Format, Role: input.Role, ContentHash: input.ContentHash, Size: input.Size, Origin: input.Origin, State: "available"}
	if input.AvailableAt != nil {
		result.AvailableAt = *input.AvailableAt
	}
	return result
}

func artifactChannelFailure(err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || daemon.AsFailure(err).Code == "offline_rejected" || daemon.AsFailure(err).Code == "runner_credential_unavailable" {
		// Unavailable is deliberately not a statement that no cloud effect happened.
		return &daemon.Failure{Code: "work_unavailable"}
	}
	return err
}

func artifactTransportFailure(err error, data []byte) error {
	if errors.Is(err, runner.ErrAuthorization) {
		var denial struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &denial) == nil && denial.Error == "request_conflict" {
			return &daemon.Failure{Code: "request_conflict"}
		}
	}
	return artifactChannelFailure(channelError(err, data))
}

func artifactConnectionCheck(channel runner.RunnerConnection, current func() (runner.RunnerConnection, error)) (func() error, error) {
	guarded, ok := channel.(runner.ArtifactAuthorityConnection)
	if !ok || current == nil {
		return nil, &daemon.Failure{Code: "work_unavailable"}
	}
	expected, err := guarded.ArtifactAuthority()
	if err != nil {
		return nil, artifactTransportFailure(err, nil)
	}
	return func() error {
		observed, err := guarded.ArtifactAuthority()
		if err != nil {
			return artifactTransportFailure(err, nil)
		}
		if observed != expected {
			return &daemon.Failure{Code: "revoked"}
		}
		live, err := current()
		if err != nil {
			return artifactTransportFailure(err, nil)
		}
		liveGuarded, ok := live.(runner.ArtifactAuthorityConnection)
		if !ok {
			return &daemon.Failure{Code: "work_unavailable"}
		}
		observed, err = liveGuarded.ArtifactAuthority()
		if err != nil {
			return artifactTransportFailure(err, nil)
		}
		if observed != expected {
			return &daemon.Failure{Code: "work_unavailable"}
		}
		return nil
	}, nil
}
