// ABOUTME: Dispatches fixed private execution helpers and explicit local containment recovery.
// ABOUTME: Accepts only a local intent argument and leaves provider binding to the executable's composition root.

package cli

import (
	"context"
	"regexp"

	"github.com/qdis/bfb/internal/daemon"
)

var terminalIntentPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)

type ExecutionHandler func(context.Context, daemon.Paths, string) error

func RegisterExecution(registry *Registry, launch, execute, recover ExecutionHandler) {
	for _, entry := range []struct {
		path, method, summary string
		run                   ExecutionHandler
	}{
		{"__launch", "execution.launch", "Private fixed execution helper", launch},
		{"__exec", "execution.exec", "Private fixed execution helper", execute},
		{"execution recover", "execution.recover", "Inspect and recover an absent local execution: INTENT_UUID", recover},
	} {
		if err := registry.Register(Command{Path: entry.path, Method: entry.method, Summary: entry.summary, Run: func(ctx context.Context, invocation Invocation) (map[string]any, error) {
			if len(invocation.Args) != 1 || !terminalIntentPattern.MatchString(invocation.Args[0]) || entry.run == nil {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			return map[string]any{}, entry.run(ctx, invocation.Paths, invocation.Args[0])
		}}); err != nil {
			panic("duplicate built-in execution command")
		}
	}
}
