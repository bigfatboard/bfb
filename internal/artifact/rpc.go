// ABOUTME: Registers the daemon artifact publication leaf against the typed client.
// ABOUTME: Credentials arrive over the user-only socket and never enter diagnostics.

package artifact

import (
	"context"
	"net/http"
	"time"

	"github.com/qdis/bfb/internal/daemon"
)

func requestFields(payload map[string]any, required, optional []string) bool {
	allowed := map[string]bool{}
	for _, key := range append(append([]string{}, required...), optional...) {
		allowed[key] = true
	}
	for _, key := range required {
		if payload[key] == nil {
			return false
		}
	}
	for key := range payload {
		if !allowed[key] {
			return false
		}
	}
	return true
}

func stringField(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return value
}

// RegisterRPC exposes artifact.publish on the daemon. The daemon reads the
// file locally and drives create, upload, and finalize; the caller selects
// bytes and metadata but never an R2 key.
func RegisterRPC(methods *daemon.Registry) error {
	return methods.Register("artifact.publish", func(ctx context.Context, request daemon.Request) (map[string]any, error) {
		payload := map[string]any{}
		if request.Envelope.Payload != nil {
			for key, value := range request.Envelope.Payload {
				payload[key] = value
			}
		}
		if !requestFields(payload,
			[]string{"control_url", "artifacts_url", "workspace_id", "artifact_format", "artifact_role", "artifact_path"},
			[]string{"artifact_id", "run_id", "artifact_cookie", "artifact_bearer"}) {
			return nil, &daemon.Failure{Code: "invalid_request"}
		}
		client := &Client{
			ControlURL:   stringField(payload, "control_url"),
			ArtifactsURL: stringField(payload, "artifacts_url"),
			HTTP:         &http.Client{Timeout: 60 * time.Second},
			Auth: Auth{
				Cookie: stringField(payload, "artifact_cookie"),
				Bearer: stringField(payload, "artifact_bearer"),
			},
		}
		published, err := client.PublishFile(ctx, Params{
			WorkspaceID: stringField(payload, "workspace_id"),
			ArtifactID:  stringField(payload, "artifact_id"),
			RunID:       stringField(payload, "run_id"),
			Format:      stringField(payload, "artifact_format"),
			Role:        stringField(payload, "artifact_role"),
		}, stringField(payload, "artifact_path"))
		if err != nil {
			return nil, mapFailure(err)
		}
		return map[string]any{
			"artifact_id":   published.ArtifactID,
			"version_id":    published.VersionID,
			"content_hash":  published.ContentHash,
			"artifact_size": published.Size,
			"r2_key":        published.R2Key,
		}, nil
	})
}

func mapFailure(err error) error {
	failure, ok := err.(*Error)
	if !ok {
		return &daemon.Failure{Code: "internal_error"}
	}
	switch failure.Code {
	case "invalid_request":
		return &daemon.Failure{Code: "invalid_request"}
	case "unauthorized", "request_rejected":
		return &daemon.Failure{Code: "peer_denied"}
	case "too_large", "upload_rejected", "upload_conflict":
		return &daemon.Failure{Code: "invalid_request"}
	default:
		return &daemon.Failure{Code: "internal_error"}
	}
}
