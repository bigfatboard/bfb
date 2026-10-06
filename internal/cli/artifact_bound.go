// ABOUTME: Sends one-shot bound artifact publication through verified local execution authority.
// ABOUTME: Rejects mixed human credentials or scope selectors and emits one safe metadata or error line.

package cli

import (
	"context"
	"encoding/json"
	"os"
	"strings"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/localmcp"
)

func boundArtifactMode(args []string) bool {
	for _, argument := range args {
		if argument == "--request-id" || strings.HasPrefix(argument, "--request-id=") {
			return true
		}
	}
	return false
}

func parseBoundArtifactArgs(args []string) (map[string]any, string, error) {
	values := map[string]any{}
	for index := 0; index < len(args); index++ {
		token := args[index]
		if !strings.HasPrefix(token, "--") {
			return nil, "", &daemon.Failure{Code: "invalid_request"}
		}
		name := strings.TrimPrefix(token, "--")
		value := ""
		if before, after, found := strings.Cut(name, "="); found {
			name, value = before, after
		} else {
			index++
			if index >= len(args) {
				return nil, "", &daemon.Failure{Code: "invalid_request"}
			}
			value = args[index]
		}
		field := ""
		switch name {
		case "request-id":
			field = "request_id"
		case "file":
			field = "path"
		case "artifact-id":
			field = "artifact_id"
		case "format", "role":
			field = name
		default:
			return nil, "", &daemon.Failure{Code: "invalid_request"}
		}
		if _, duplicate := values[field]; duplicate {
			return nil, "", &daemon.Failure{Code: "invalid_request"}
		}
		values[field] = value
	}
	if localmcp.ValidateArtifactInput(values) != nil {
		return nil, "", &daemon.Failure{Code: "invalid_request"}
	}
	return values, values["request_id"].(string), nil
}

func publishBoundArtifact(ctx context.Context, invocation Invocation) error {
	output := invocation.Output
	if output == nil {
		output = os.Stdout
	}
	write := func(value any, failure error) error {
		if json.NewEncoder(output).Encode(value) != nil {
			return &daemon.Failure{Code: "storage_failed"}
		}
		return failure
	}
	deny := func(code string) error {
		return write(map[string]any{"error": map[string]any{"code": code}}, &daemon.Failure{Code: code})
	}
	params, requestID, err := parseBoundArtifactArgs(invocation.Args)
	if err != nil {
		return deny("invalid_request")
	}
	env, err := localmcp.ParseEnv(os.Environ(), os.Getuid())
	if err != nil {
		return deny("invalid_request")
	}
	assignmentsDB := openAssignmentsReadOnly(invocation)
	if assignmentsDB != nil {
		defer assignmentsDB.Close()
	}
	boundary, err := localmcp.VerifyStartup(ctx, env, localmcp.OSInspector(), localmcp.DaemonAssignments{DB: assignmentsDB})
	if err != nil {
		return deny(localmcp.CodeOf(err))
	}
	// No activation/cache state survives this process. The daemon must derive
	// the live canonical binding and pinned file authority independently.
	transport := localmcp.RPCTransport{Paths: invocation.Paths, Correlation: env.Correlation}
	result, err := transport.PublishArtifact(ctx, boundary, nil, params, requestID)
	if err != nil {
		return deny(localmcp.CodeOf(err))
	}
	return write(result, nil)
}
