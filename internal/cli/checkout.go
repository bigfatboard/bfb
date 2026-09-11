// ABOUTME: Exposes explicit checkout link, list, verify and unlink commands as local RPC clients.
// ABOUTME: Resolves a human-supplied directory locally and renders only sanitized daemon responses.

package cli

import (
	"context"
	"flag"
	"io"
	"path/filepath"

	"github.com/qdis/bfb/internal/daemon"
)

func RegisterCheckout(registry *Registry) {
	register := func(command Command) {
		if err := registry.Register(command); err != nil {
			panic("duplicate checkout CLI command")
		}
	}
	call := func(ctx context.Context, invocation Invocation, method string, payload map[string]any) (map[string]any, error) {
		response, err := daemon.Call(ctx, invocation.Paths, method, payload)
		return response.Payload, err
	}
	register(Command{Path: "checkout link", Method: "checkout.link", Summary: "Link an exact existing checkout to explicit project IDs", Run: func(ctx context.Context, invocation Invocation) (map[string]any, error) {
		flags := flag.NewFlagSet("checkout link", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		workspace := flags.String("workspace", "", "Workspace ID")
		runner := flags.String("runner", "", "Runner ID")
		project := flags.String("project", "", "Project ID")
		label := flags.String("label", "", "Path-free display label")
		repository := flags.String("repository", "", "Expected hosted repository identity")
		subpath := flags.String("subpath", ".", "Expected project subdirectory")
		remote := flags.String("remote", "origin", "Registered remote name")
		isDefault := flags.Bool("default", false, "Select as the project default on this runner")
		if flags.Parse(invocation.Args) != nil || flags.NArg() != 1 {
			return nil, &daemon.Failure{Code: "invalid_request"}
		}
		path, err := filepath.Abs(flags.Arg(0))
		if err != nil {
			return nil, &daemon.Failure{Code: "checkout_path_unsafe"}
		}
		return call(ctx, invocation, "checkout.link", map[string]any{
			"workspace_id": *workspace, "runner_id": *runner, "project_id": *project,
			"label": *label, "repository_identity": *repository, "workspace_subpath": *subpath,
			"remote_name": *remote, "is_default": *isDefault, "local_path": path,
		})
	}})
	register(Command{Path: "checkout list", Method: "checkout.list", Summary: "List sanitized checkout observations", Run: func(ctx context.Context, invocation Invocation) (map[string]any, error) {
		flags := flag.NewFlagSet("checkout list", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		workspace := flags.String("workspace", "", "Workspace filter")
		runner := flags.String("runner", "", "Runner filter")
		project := flags.String("project", "", "Project filter")
		after := flags.String("after", "", "Checkout pagination cursor")
		limit := flags.Int("limit", 25, "Page size, at most 25")
		if flags.Parse(invocation.Args) != nil || flags.NArg() != 0 {
			return nil, &daemon.Failure{Code: "invalid_request"}
		}
		payload := map[string]any{"limit": *limit}
		for key, value := range map[string]string{"workspace_id": *workspace, "runner_id": *runner, "project_id": *project, "after_checkout_id": *after} {
			if value != "" {
				payload[key] = value
			}
		}
		return call(ctx, invocation, "checkout.list", payload)
	}})
	for _, action := range []string{"verify", "unlink"} {
		method := "checkout." + action
		register(Command{Path: "checkout " + action, Method: method, Summary: action + " a linked checkout by ID", Run: func(ctx context.Context, invocation Invocation) (map[string]any, error) {
			if len(invocation.Args) != 1 {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			return call(ctx, invocation, method, map[string]any{"checkout_id": invocation.Args[0]})
		}})
	}
}
