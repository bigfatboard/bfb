// ABOUTME: Initiates local runner enrollment and displays its public browser approval link.
// ABOUTME: Keeps signing and renewal in the daemon and permits forgetting only a revoked enrollment.

package cli

import (
	"context"
	"flag"
	"io"

	"github.com/qdis/bfb/internal/daemon"
)

func RegisterRunner(registry *Registry) {
	for _, action := range []string{"enroll", "list", "wake", "forget"} {
		method := "runner." + action
		err := registry.Register(Command{Path: "runner " + action, Method: method, Summary: action + " a workspace runner enrollment", Run: func(ctx context.Context, invocation Invocation) (map[string]any, error) {
			payload := map[string]any{}
			if action == "enroll" {
				flags := flag.NewFlagSet("runner enroll", flag.ContinueOnError)
				flags.SetOutput(io.Discard)
				origin := flags.String("origin", "", "Canonical HTTPS app origin")
				workspace := flags.String("workspace", "", "Workspace ID")
				label := flags.String("label", "", "Path-free device label")
				if flags.Parse(invocation.Args) != nil || flags.NArg() != 0 {
					return nil, &daemon.Failure{Code: "invalid_request"}
				}
				payload = map[string]any{"app_origin": *origin, "workspace_id": *workspace, "device_label": *label}
			} else if action == "list" {
				if len(invocation.Args) != 0 {
					return nil, &daemon.Failure{Code: "invalid_request"}
				}
			} else {
				if len(invocation.Args) != 1 {
					return nil, &daemon.Failure{Code: "invalid_request"}
				}
				payload["runner_id"] = invocation.Args[0]
			}
			response, err := daemon.Call(ctx, invocation.Paths, method, payload)
			return response.Payload, err
		}})
		if err != nil {
			panic("duplicate runner CLI command")
		}
	}
}
