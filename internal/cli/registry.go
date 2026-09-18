// ABOUTME: Registers CLI leaf commands without duplicating their domain implementations.
// ABOUTME: Routes fixed command paths and renders canonical JSON responses or concise human output.

package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

type Invocation struct {
	Paths  daemon.Paths
	Args   []string
	Input  io.Reader
	Output io.Writer
	// JSON mirrors the global --json flag for raw-stdio commands that own
	// their framing. Stderr carries their diagnostics; nil discards.
	JSON   bool
	Stderr io.Writer
}

type Handler func(context.Context, Invocation) (map[string]any, error)

type Command struct {
	Path, Method, Summary string
	Run                   Handler
	// RawStdio skips response rendering so the handler owns standard output
	// framing. Only bfb mcp stdio and bfb run submit use it; every other
	// command renders the frozen local-rpc envelope.
	RawStdio bool
}

type Registry struct{ commands map[string]Command }

func NewRegistry() *Registry { return &Registry{commands: map[string]Command{}} }

// ListedCommand exposes one registered path for assembly inventory checks.
type ListedCommand struct{ Path, Method, Summary string }

// List returns the registered commands in stable order.
func (r *Registry) List() []ListedCommand {
	listed := make([]ListedCommand, 0, len(r.commands))
	for path, command := range r.commands {
		listed = append(listed, ListedCommand{Path: path, Method: command.Method, Summary: command.Summary})
	}
	sort.Slice(listed, func(i, j int) bool { return listed[i].Path < listed[j].Path })
	return listed
}

func (r *Registry) Register(command Command) error {
	if command.Path == "" || command.Method == "" || command.Run == nil || r.commands[command.Path].Run != nil {
		return &daemon.Failure{Code: "invalid_request"}
	}
	if _, err := daemon.EncodeEnvelope(daemon.Response(command.Method, daemon.NewRequestID(), nil, nil)); err != nil {
		return err
	}
	r.commands[command.Path] = command
	return nil
}

func (r *Registry) Execute(ctx context.Context, args []string, input io.Reader, output io.Writer) int {
	return r.ExecuteWithStderr(ctx, args, input, output, nil)
}

// ExecuteWithStderr runs dispatch with a separate diagnostic stream for
// raw-stdio commands. Existing rendered commands keep writing to output.
func (r *Registry) ExecuteWithStderr(ctx context.Context, args []string, input io.Reader, output io.Writer, stderr io.Writer) int {
	jsonOutput := false
	dataDir := ""
	var words []string
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "--json":
			jsonOutput = true
		case "--data-dir":
			index++
			if index >= len(args) || dataDir != "" {
				return render(output, true, daemon.Response("cli.error", daemon.NewRequestID(), nil, &daemon.Failure{Code: "invalid_request"}))
			}
			dataDir = args[index]
		case "--":
			words = append(words, args[index+1:]...)
			index = len(args)
		default:
			words = append(words, args[index])
		}
	}
	if len(words) == 0 || (len(words) == 1 && (words[0] == "help" || words[0] == "--help")) {
		paths := make([]string, 0, len(r.commands))
		for path := range r.commands {
			if !strings.HasPrefix(path, "__") {
				paths = append(paths, path)
			}
		}
		sort.Strings(paths)
		methods := make([]string, 0, len(paths))
		if !jsonOutput {
			_, _ = fmt.Fprintln(output, "Usage: bfb [--data-dir DIRECTORY] [--json] COMMAND")
		}
		for _, path := range paths {
			methods = append(methods, r.commands[path].Method)
			if !jsonOutput {
				_, _ = fmt.Fprintf(output, "  %-18s %s\n", path, r.commands[path].Summary)
			}
		}
		if jsonOutput {
			return render(output, true, daemon.Response("cli.help", daemon.NewRequestID(), map[string]any{"methods": methods}, nil))
		}
		return 0
	}
	paths, err := daemon.StatePaths(dataDir)
	if err != nil {
		return render(output, jsonOutput, daemon.Response("cli.error", daemon.NewRequestID(), nil, err))
	}
	for length := len(words); length > 0; length-- {
		if command, ok := r.commands[strings.Join(words[:length], " ")]; ok {
			invocation := Invocation{Paths: paths, Args: words[length:], Input: input, Output: output, JSON: jsonOutput, Stderr: stderr}
			if command.RawStdio {
				_, runErr := command.Run(ctx, invocation)
				var coder interface{ CLIExitCode() int }
				if errors.As(runErr, &coder) {
					return coder.CLIExitCode()
				}
				return daemon.ExitCode(runErr)
			}
			payload, runErr := command.Run(ctx, invocation)
			return render(output, jsonOutput, daemon.Response(command.Method, daemon.NewRequestID(), payload, runErr))
		}
	}
	return render(output, jsonOutput, daemon.Response("cli.error", daemon.NewRequestID(), nil, &daemon.Failure{Code: "unknown_method"}))
}

func render(output io.Writer, jsonOutput bool, envelope generated.LocalRpcEnvelope) int {
	data, err := daemon.EncodeEnvelope(envelope)
	if err != nil {
		envelope = daemon.Response("cli.error", daemon.NewRequestID(), nil, &daemon.Failure{Code: "internal_error"})
		data, _ = daemon.EncodeEnvelope(envelope)
	}
	if jsonOutput {
		if _, err := output.Write(data); err != nil {
			return 5
		}
	} else if envelope.Error != nil {
		_, _ = fmt.Fprintf(output, "%s: %s\n", envelope.Error.Code, envelope.Error.Message)
	} else if entries, ok := envelope.Payload["log_entries"].([]string); ok {
		for _, entry := range entries {
			_, _ = fmt.Fprintln(output, entry)
		}
	} else {
		_ = json.NewEncoder(output).Encode(envelope.Payload)
	}
	if envelope.Error != nil {
		return daemon.ExitCode(&daemon.Failure{Code: envelope.Error.Code})
	}
	return 0
}
