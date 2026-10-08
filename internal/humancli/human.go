// ABOUTME: Registers thin human control-plane commands without domain mutation logic.
// ABOUTME: Every write forwards to a frozen server route; rendering owns stdout/stderr split.

package humancli

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/qdis/bfb/internal/cli"
	"github.com/qdis/bfb/internal/daemon"
)

// Deps supplies overridable process boundaries for tests.
type Deps struct {
	// ControlURL, when set, wins over flags and environment.
	ControlURL string
	// Client, when set, replaces HTTP construction.
	Client *Client
}

// RegisterHuman assembles the X02-owned human commands onto the shared registry.
func RegisterHuman(registry *cli.Registry, deps Deps) {
	register := func(command cli.Command) {
		if err := registry.Register(command); err != nil {
			panic("duplicate human CLI command")
		}
	}
	human := func(path, method, summary string, run func(context.Context, session) *Failure) {
		runCopy := run
		if err := registry.Register(cli.Command{
			Path: path, Method: method, Summary: summary, RawStdio: true,
			Run: func(ctx context.Context, invocation cli.Invocation) (map[string]any, error) {
				// Normalize the typed failure to an untyped nil on success so
				// dispatch never observes a non-nil error carrying nil state.
				if failure := runCopy(ctx, openSession(path, invocation, deps)); failure != nil {
					return nil, failure
				}
				return nil, nil
			},
		}); err != nil {
			panic("duplicate human CLI command")
		}
	}
	_ = register
	human("login", "cli.login", "Authorize this machine through the browser device flow", cmdLogin)
	human("logout", "cli.logout", "Revoke this machine's credential and forget it locally", cmdLogout)
	human("whoami", "cli.session", "Show the human, workspace, and scopes behind this credential", cmdWhoami)
	human("project list", "cli.projects", "List projects visible to this credential", cmdProjectList)
	human("project get", "cli.project", "Show one project by ID", cmdProjectGet)
	human("task list", "cli.tasks", "List tasks across visible projects", cmdTaskList)
	human("task get", "cli.task", "Show one task by ID", cmdTaskGet)
	human("task create", "cli.task.create", "Create one task in an explicit project", cmdTaskCreate)
	human("run list", "cli.runs", "List runs for one task", cmdRunList)
	human("run get", "cli.run", "Show one run by ID", cmdRunGet)
	human("run cancel", "cli.run.cancel", "Cancel one open run after explicit confirm and fresh proof", cmdRunCancel)
	human("attention list", "cli.attention", "List attention requests across visible projects", cmdAttentionList)
	human("attention get", "cli.attention.get", "Show one attention request with its history", cmdAttentionGet)
	human("attention answer", "cli.attention.answer", "Answer one attention request with an explicit version", cmdAttentionAnswer)
	human("attention resolve", "cli.attention.resolve", "Resolve one answered request with an explicit version", cmdAttentionResolve)
	human("artifact list", "cli.artifacts", "List artifact metadata bound to one run", cmdArtifactList)
	human("artifact get", "cli.artifact", "Show one artifact with its version metadata", cmdArtifactGet)
	human("version", "cli.version", "Show client, API, and wire compatibility", cmdVersion)
	human("completion bash", "cli.completion", "Print generated bash completion", cmdCompletion("bash"))
	human("completion zsh", "cli.completion", "Print generated zsh completion", cmdCompletion("zsh"))
	human("completion fish", "cli.completion", "Print generated fish completion", cmdCompletion("fish"))
}

// session carries one invocation's rendering and control-plane bindings.
type session struct {
	command string
	json    bool
	output  io.Writer
	stderr  io.Writer
	store   Store
	control string
	client  *Client
	args    []string
}

func openSession(command string, invocation cli.Invocation, deps Deps) session {
	output := invocation.Output
	if output == nil {
		output = os.Stdout
	}
	stderr := invocation.Stderr
	if stderr == nil {
		stderr = io.Discard
	}
	control := deps.ControlURL
	for index, arg := range invocation.Args {
		if arg == "--control-url" && index+1 < len(invocation.Args) {
			control = invocation.Args[index+1]
		}
		if value, ok := strings.CutPrefix(arg, "--control-url="); ok {
			control = value
		}
	}
	if control == "" {
		control = os.Getenv("BFB_CONTROL_URL")
	}
	return session{
		command: command, json: invocation.JSON, output: output, stderr: stderr,
		store: Store{Dir: invocation.Paths.Root}, control: control, client: deps.Client,
		args: invocation.Args,
	}
}

// ok renders a successful result: one JSON document or concise human lines.
func (s session) ok(data map[string]any, human []string) *Failure {
	if s.json {
		return renderJSON(s.output, s.command, data)
	}
	for _, line := range human {
		if ContainsCredential(line) {
			return fail("internal_error", "the local operation failed")
		}
		_, _ = fmt.Fprintln(s.output, line)
	}
	return nil
}

// diagnose reports a failure: envelope on stdout in JSON mode, concise line on stderr otherwise.
func (s session) diagnose(failure *Failure) *Failure {
	if failure == nil {
		return nil
	}
	if s.json {
		_ = renderError(s.output, s.command, failure)
		return failure
	}
	_, _ = fmt.Fprintf(s.stderr, "%s: %s\n", failure.Code, Redact(failure.Message))
	return failure
}

func renderJSON(output io.Writer, command string, data map[string]any) *Failure {
	response := Response{SchemaVersion: SchemaVersion, Command: command, RequestID: daemon.NewRequestID(), Data: data}
	if err := response.Render(output); err != nil {
		return fail("internal_error", "the local operation failed")
	}
	return nil
}

func renderError(output io.Writer, command string, failure *Failure) *Failure {
	response := Response{
		SchemaVersion: SchemaVersion, Command: command, RequestID: daemon.NewRequestID(),
		Error: &Error{Code: failure.Code, Message: Redact(failure.Message)},
	}
	if err := response.Render(output); err != nil {
		return fail("internal_error", "the local operation failed")
	}
	return failure
}

// dial builds the authenticated client, failing before any network use without a credential.
func (s session) dial(authenticated bool) (Client, *Failure) {
	if s.control == "" {
		return Client{}, fail("invalid_request", "control origin is required; pass --control-url or set BFB_CONTROL_URL")
	}
	if s.client != nil {
		return *s.client, nil
	}
	client := Client{ControlURL: s.control}
	if !authenticated {
		return client, nil
	}
	credential, failure := s.store.Read()
	if failure != nil {
		return Client{}, failure
	}
	client.Credential = credential.Credential
	return client, nil
}

// flags builds a quiet flag set over the invocation args.
func (s session) flags(name string) *flag.FlagSet {
	set := flag.NewFlagSet(name, flag.ContinueOnError)
	set.SetOutput(io.Discard)
	return set
}

// mutation guards a write with the compatibility check before dispatch.
func (s session) mutation(ctx context.Context, client Client) (ServerVersion, *Failure) {
	version, failure := client.CheckCompatible(ctx)
	if failure != nil {
		_, _ = fmt.Fprintf(s.stderr, "warning: %s\n", Redact(failure.Message))
		return version, failure
	}
	return version, nil
}
