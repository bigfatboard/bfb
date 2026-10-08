// ABOUTME: Exposes artifact publication as a run-scoped MCP tool definition and handler.
// ABOUTME: A01 registers this tool; argument paths stay scoped by the registering server.

package artifact

import (
	"bytes"
	"context"
	"encoding/json"
)

// ToolName is the stable MCP tool name A01 registers for run-scoped publishing.
const ToolName = "bfb_publish_artifact"

// ToolDefinition returns the MCP tool descriptor A01 registers on its local
// server. The handler below implements the call; this package owns no transport.
func ToolDefinition() map[string]any {
	return map[string]any{
		"name":        ToolName,
		"description": "Publish bounded review bytes or a compressed log chunk as an immutable artifact version.",
		"inputSchema": map[string]any{
			"type":                 "object",
			"additionalProperties": false,
			"required":             []string{"workspace_id", "format", "role", "path"},
			"properties": map[string]any{
				"workspace_id": map[string]any{"type": "string", "description": "Workspace ID that owns the artifact."},
				"artifact_id":  map[string]any{"type": "string", "description": "Existing artifact ID for a new version; omit to create one."},
				"run_id":       map[string]any{"type": "string", "description": "Run ID bound to the version; required for log chunks."},
				"format": map[string]any{
					"type": "string",
					"enum": []string{"markdown", "mermaid", "diff", "svg", "png", "jpeg", "html", "log", "json"},
				},
				"role": map[string]any{
					"type":        "string",
					"enum":        []string{"review", "log"},
					"description": "review is bounded to 5 MiB; log is a compressed chunk bounded to 1 MiB.",
				},
				"path": map[string]any{"type": "string", "description": "Local file path read by the daemon; scoped by the registering server."},
			},
		},
	}
}

type toolArgs struct {
	WorkspaceID string `json:"workspace_id"`
	ArtifactID  string `json:"artifact_id"`
	RunID       string `json:"run_id"`
	Format      string `json:"format"`
	Role        string `json:"role"`
	Path        string `json:"path"`
}

// InvokePublish runs the tool call against a configured client and returns the
// published version as JSON. Unknown fields are rejected; paths are passed to
// PublishFile, so A01 must scope them to the calling run before registering.
func (c *Client) InvokePublish(ctx context.Context, rawArgs []byte) ([]byte, error) {
	var args toolArgs
	decoder := json.NewDecoder(bytes.NewReader(rawArgs))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&args); err != nil {
		return nil, &Error{Code: "invalid_request", Message: "artifact tool arguments are invalid"}
	}
	if args.WorkspaceID == "" || args.Path == "" {
		return nil, &Error{Code: "invalid_request", Message: "artifact tool arguments are invalid"}
	}
	published, err := c.PublishFile(ctx, Params{
		WorkspaceID: args.WorkspaceID,
		ArtifactID:  args.ArtifactID,
		RunID:       args.RunID,
		Format:      args.Format,
		Role:        args.Role,
	}, args.Path)
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{
		"artifact_id":  published.ArtifactID,
		"version_id":   published.VersionID,
		"content_hash": published.ContentHash,
		"size":         published.Size,
		"r2_key":       published.R2Key,
	})
}
