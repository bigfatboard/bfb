// ABOUTME: Publishes pinned local files through the closed online-only artifact daemon lane.
// ABOUTME: Sends no credentials or caller-selected scope and checks the bounded final provenance.

package localmcp

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

type daemonArtifactTransport interface {
	PublishArtifact(context.Context, Boundary, *ConfirmedSession, map[string]any, string) (any, error)
}

var artifactIDPattern = regexp.MustCompile(`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`)

// ValidateArtifactInput accepts only the credential-free public publication fields.
// Path is an access selector; the daemon, not this client, owns its trusted root.
func ValidateArtifactInput(params map[string]any) error {
	if params == nil {
		return fail("invalid_params")
	}
	for field := range params {
		if !allowedParams("bfb_publish_artifact")[field] {
			return fail("invalid_params")
		}
	}
	requestID, ok := params["request_id"].(string)
	if !ok || checkRequestID(requestID) != nil {
		return fail("invalid_request")
	}
	path, ok := params["path"].(string)
	if !ok || path == "" || len(path) > 4096 || !utf8.ValidString(path) || filepath.IsAbs(path) || filepath.Clean(path) != path {
		return fail("invalid_params")
	}
	for _, component := range strings.Split(path, string(filepath.Separator)) {
		if component == "" || component == "." || component == ".." {
			return fail("invalid_params")
		}
	}
	for _, character := range path {
		if unicode.IsControl(character) {
			return fail("invalid_params")
		}
	}
	format, ok := params["format"].(string)
	if !ok {
		return fail("invalid_params")
	}
	switch format {
	case "markdown", "mermaid", "diff", "svg", "png", "jpeg", "html", "log", "json":
	default:
		return fail("invalid_params")
	}
	role, ok := params["role"].(string)
	if !ok || role != "review" && role != "log" {
		return fail("invalid_params")
	}
	if value, present := params["artifact_id"]; present {
		id, ok := value.(string)
		if !ok || !artifactIDPattern.MatchString(id) {
			return fail("invalid_params")
		}
	}
	return nil
}

// PublishArtifact preserves omitted artifact selection and derives execution
// scope exclusively from the verified local boundary. The daemon binds a fresh
// CLI/provisional MCP online; an activated MCP supplies its immutable assertion.
func (transport RPCTransport) PublishArtifact(ctx context.Context, boundary Boundary, expected *ConfirmedSession, params map[string]any, requestID string) (any, error) {
	if err := ValidateArtifactInput(params); err != nil {
		return nil, err
	}
	if params["request_id"] != requestID {
		return nil, fail("invalid_request")
	}
	reference := operationReference(boundary, requestID)
	original := map[string]any{"reference": reference}
	for _, field := range []string{"path", "artifact_id", "format", "role"} {
		if value, present := params[field]; present {
			original[field] = value
		}
	}
	local := map[string]any{"request": original, "correlation": transport.Correlation}
	if expected != nil {
		local["expected_binding"] = expected
	}
	data, err := json.Marshal(local)
	if err != nil || !protocol.DecodeWireDocument("agent-artifact-local-request", data).OK {
		return nil, fail("invalid_params")
	}
	response, err := daemon.CallAgentArtifact(ctx, transport.Paths, "mcp.v6.publish_artifact", map[string]any{"agent_artifact_request": local})
	if err != nil {
		code := daemon.AsFailure(err).Code
		switch {
		case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), code == "daemon_offline", code == "runner_credential_unavailable":
			// A lost reply cannot establish that no publication phase committed.
			code = "work_unavailable"
		case code == "invalid_request":
			code = "request_rejected"
		}
		return nil, fail(code)
	}
	data, err = json.Marshal(response.Payload["agent_artifact"])
	var result generated.AgentArtifactResult
	if err != nil || !protocol.DecodeWireDocument("agent-artifact-result", data).OK || json.Unmarshal(data, &result) != nil {
		return nil, fail("request_rejected")
	}
	key, err := protocol.ArtifactOperationKey(reference)
	if err != nil || result.OperationKey != key || result.Format != params["format"] || result.Role != params["role"] ||
		result.Origin.RunId != boundary.RunID || result.Origin.RunExecutionId != boundary.ExecutionID || result.Origin.AssignmentGeneration != boundary.Generation ||
		(expected != nil && result.Origin.ProviderSessionId != expected.ProviderSessionId) ||
		(params["artifact_id"] != nil && result.ArtifactId != params["artifact_id"]) {
		return nil, fail("boundary_escape")
	}
	return result, nil
}
