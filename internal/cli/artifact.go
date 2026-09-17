// ABOUTME: Publishes artifact files through the daemon without exposing credentials.
// ABOUTME: Secrets travel in private files, never in process arguments or output.

package cli

import (
	"context"
	"flag"
	"io"
	"os"
	"strings"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

// PublishFunc sends one artifact.publish call; production passes daemon.Call.
type PublishFunc func(context.Context, daemon.Paths, string, map[string]any) (generated.LocalRpcEnvelope, error)

// RegisterArtifact adds `bfb artifact publish` with file-based credentials only.
func RegisterArtifact(registry *Registry, publish PublishFunc) {
	if publish == nil {
		panic("artifact publish function is required")
	}
	err := registry.Register(Command{
		Path:    "artifact publish",
		Method:  "artifact.publish",
		Summary: "Publish a bounded artifact file through the daemon",
		Run: func(ctx context.Context, invocation Invocation) (map[string]any, error) {
			flags := flag.NewFlagSet("artifact publish", flag.ContinueOnError)
			flags.SetOutput(io.Discard)
			control := flags.String("control-url", "", "Control Worker origin")
			artifacts := flags.String("artifacts-url", "", "Artifact Worker origin")
			workspace := flags.String("workspace", "", "Workspace ID")
			artifactID := flags.String("artifact-id", "", "Existing artifact ID for a new version")
			run := flags.String("run-id", "", "Run ID bound to the version")
			format := flags.String("format", "", "Declared format")
			role := flags.String("role", "", "Semantic role: review or log")
			file := flags.String("file", "", "Local file to publish")
			cookieFile := flags.String("cookie-file", "", "File holding the session cookie value")
			bearerFile := flags.String("bearer-file", "", "File holding a bearer credential")
			if flags.Parse(invocation.Args) != nil || flags.NArg() != 0 {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			if *control == "" || *artifacts == "" || *workspace == "" || *format == "" || *role == "" || *file == "" {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			payload := map[string]any{
				"control_url": *control, "artifacts_url": *artifacts,
				"workspace_id":    *workspace,
				"artifact_format": *format, "artifact_role": *role, "artifact_path": *file,
			}
			if *artifactID != "" {
				payload["artifact_id"] = *artifactID
			}
			if *run != "" {
				payload["run_id"] = *run
			}
			for key, path := range map[string]string{"artifact_cookie": *cookieFile, "artifact_bearer": *bearerFile} {
				if path == "" {
					continue
				}
				secret, err := readSecretFile(path)
				if err != nil {
					return nil, &daemon.Failure{Code: "invalid_request"}
				}
				payload[key] = secret
			}
			response, err := publish(ctx, invocation.Paths, "artifact.publish", payload)
			return response.Payload, err
		},
	})
	if err != nil {
		panic("duplicate artifact CLI command")
	}
}

func readSecretFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		return "", err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(content)), nil
}
