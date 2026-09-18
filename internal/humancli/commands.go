// ABOUTME: Freezes the human command tree, its feature owners, and offline behavior.
// ABOUTME: Help and shell completion render from this table so drift fails tests.

package humancli

import (
	"fmt"
	"sort"
	"strings"
)

// Definition binds one command path to its owning feature package. The X02
// assembler owns no domain logic; Owner names the package that does.
type Definition struct {
	Path    string
	Owner   string
	Summary string
	// Destructive marks operations that need an explicit confirm flag.
	Destructive bool
	// StepUpAction names the fresh-proof action a destructive command consumes.
	StepUpAction string
	// Offline describes behavior without control-plane or daemon reachability.
	Offline string
}

// Table is the frozen command-to-owner matrix, also published in human-cli.md.
func Table() []Definition {
	return []Definition{
		{Path: "login", Owner: "C05", Summary: "Authorize this machine through the browser device flow"},
		{Path: "logout", Owner: "C05", Summary: "Revoke this machine's credential and forget it locally"},
		{Path: "whoami", Owner: "C05", Summary: "Show the human, workspace, and scopes behind this credential"},
		{Path: "daemon run", Owner: "L01", Summary: "Run the private per-user daemon", Offline: "local only"},
		{Path: "daemon status", Owner: "L01", Summary: "status the local daemon", Offline: "local only"},
		{Path: "daemon stop", Owner: "L01", Summary: "stop the local daemon", Offline: "local only"},
		{Path: "daemon logs", Owner: "L01", Summary: "Read bounded redacted diagnostics", Offline: "local only"},
		{Path: "daemon install", Owner: "L01", Summary: "Install the per-user macOS launch agent", Offline: "local only"},
		{Path: "runner enroll", Owner: "L08", Summary: "enroll a workspace runner enrollment", Offline: "local only"},
		{Path: "runner list", Owner: "L08", Summary: "list a workspace runner enrollment", Offline: "local only"},
		{Path: "runner wake", Owner: "L08", Summary: "wake a workspace runner enrollment", Offline: "local only"},
		{Path: "runner forget", Owner: "L08", Summary: "forget a workspace runner enrollment", Offline: "local only"},
		{Path: "checkout link", Owner: "L02", Summary: "Link an exact existing checkout to explicit project IDs", Offline: "local only"},
		{Path: "checkout list", Owner: "L02", Summary: "List sanitized checkout observations", Offline: "local only"},
		{Path: "checkout verify", Owner: "L02", Summary: "verify a linked checkout by ID", Offline: "local only"},
		{Path: "checkout unlink", Owner: "L02", Summary: "unlink a linked checkout by ID", Offline: "local only"},
		{Path: "provider setup claude", Owner: "L07", Summary: "Preview or apply the Claude integration", Offline: "local only"},
		{Path: "provider doctor claude", Owner: "L07", Summary: "Diagnose the Claude integration", Offline: "local only"},
		{Path: "project list", Owner: "C07", Summary: "List projects visible to this credential", Offline: "control_unreachable"},
		{Path: "project get", Owner: "C07", Summary: "Show one project by ID", Offline: "control_unreachable"},
		{Path: "task list", Owner: "C08", Summary: "List tasks across visible projects", Offline: "control_unreachable"},
		{Path: "task get", Owner: "C08", Summary: "Show one task by ID", Offline: "control_unreachable"},
		{Path: "task create", Owner: "C08", Summary: "Create one task in an explicit project", Offline: "control_unreachable"},
		{Path: "run list", Owner: "C08", Summary: "List runs for one task", Offline: "control_unreachable"},
		{Path: "run get", Owner: "C08", Summary: "Show one run by ID", Offline: "control_unreachable"},
		{Path: "run submit", Owner: "A03", Summary: "Journal one run-scoped result submission for human review", Offline: "journals pending_sync locally"},
		{Path: "run cancel", Owner: "C08", Summary: "Cancel one open run after explicit confirm and fresh proof", Destructive: true, StepUpAction: "cli:run:cancel", Offline: "control_unreachable"},
		{Path: "attention list", Owner: "A02", Summary: "List attention requests across visible projects", Offline: "control_unreachable"},
		{Path: "attention get", Owner: "A02", Summary: "Show one attention request with its history", Offline: "control_unreachable"},
		{Path: "attention answer", Owner: "A02", Summary: "Answer one attention request with an explicit version", Offline: "control_unreachable"},
		{Path: "attention resolve", Owner: "A02", Summary: "Resolve one answered request with an explicit version", Offline: "control_unreachable"},
		{Path: "hook ingest", Owner: "L06", Summary: "Ingest one bounded provider hook event", Offline: "falls back to local inbox"},
		{Path: "hook status", Owner: "L06", Summary: "Show journal backlog and telemetry state", Offline: "local only"},
		{Path: "mcp stdio", Owner: "A01", Summary: "Run the run-scoped local MCP server on stdio", Offline: "local only"},
		{Path: "artifact publish", Owner: "V01", Summary: "Publish a bounded artifact file through the daemon", Offline: "control_unreachable"},
		{Path: "artifact list", Owner: "V01", Summary: "List artifact metadata bound to one run", Offline: "control_unreachable"},
		{Path: "artifact get", Owner: "V01", Summary: "Show one artifact with its version metadata", Offline: "control_unreachable"},
		{Path: "execution recover", Owner: "L05", Summary: "Inspect and recover an absent local execution: INTENT_UUID", Offline: "local only"},
		{Path: "version", Owner: "X02", Summary: "Show client, API, and wire compatibility", Offline: "client version always; server unknown"},
		{Path: "completion bash", Owner: "X02", Summary: "Print generated bash completion", Offline: "local only"},
		{Path: "completion zsh", Owner: "X02", Summary: "Print generated zsh completion", Offline: "local only"},
		{Path: "completion fish", Owner: "X02", Summary: "Print generated fish completion", Offline: "local only"},
	}
}

// OwnersByPath indexes the matrix and reports duplicates.
func OwnersByPath() (map[string]string, []string) {
	owners := map[string]string{}
	var duplicates []string
	for _, entry := range Table() {
		if _, exists := owners[entry.Path]; exists {
			duplicates = append(duplicates, entry.Path)
			continue
		}
		owners[entry.Path] = entry.Owner
	}
	sort.Strings(duplicates)
	return owners, duplicates
}

// Help renders the generated command list from the live table.
func Help() string {
	var text strings.Builder
	text.WriteString("Usage: bfb [--data-dir DIRECTORY] [--json] COMMAND\n")
	for _, entry := range Table() {
		fmt.Fprintf(&text, "  %-24s %s\n", entry.Path, entry.Summary)
	}
	return text.String()
}

// Completion renders a shell completion script enumerating the live table.
func Completion(shell string) (string, *Failure) {
	var names []string
	for _, entry := range Table() {
		names = append(names, entry.Path)
	}
	sort.Strings(names)
	switch shell {
	case "bash":
		var text strings.Builder
		text.WriteString("_bfb_complete() {\n  local cur=\"${COMP_WORDS[COMP_CWORD]}\"\n  COMPREPLY=($(compgen -W \"")
		text.WriteString(strings.Join(names, " "))
		text.WriteString("\" -- \"$cur\"))\n}\ncomplete -F _bfb_complete bfb\n")
		return text.String(), nil
	case "zsh":
		var text strings.Builder
		text.WriteString("#compdef bfb\n_bfb() {\n  local -a commands\n  commands=(\n")
		for _, name := range names {
			fmt.Fprintf(&text, "    %q\n", name)
		}
		text.WriteString("  )\n  _describe 'bfb command' commands\n}\n_bfb\n")
		return text.String(), nil
	case "fish":
		var text strings.Builder
		for _, name := range names {
			fmt.Fprintf(&text, "complete -c bfb -f -n '__fish_use_subcommand' -a %q\n", name)
		}
		return text.String(), nil
	default:
		return "", fail("invalid_request", "completion shell must be bash, zsh, or fish")
	}
}
