// ABOUTME: Offers the run-scoped result submission surface to agents without an MCP transport.
// ABOUTME: Verifies the active assignment and correlation, then journals one pending_sync operation.

package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/localmcp"
)

// RegisterRun registers the run-scoped agent commands. Only `run submit`
// exists in v1: human run management stays with the API until X02 builds CLI
// parity, so this path never collides with it.
func RegisterRun(registry *Registry) {
	if err := registry.Register(Command{
		Path:     "run submit",
		Method:   "run.submit",
		Summary:  "Journal one run-scoped result submission for human review",
		RawStdio: true,
		Run: func(ctx context.Context, invocation Invocation) (map[string]any, error) {
			return nil, runSubmitStdio(ctx, invocation)
		},
	}); err != nil {
		panic("duplicate built-in run command")
	}
}

// runSubmitStdio owns standard output like the MCP server does: the frozen
// local-rpc envelope has no result-receipt shape, so this command prints
// exactly one JSON line carrying the bounded outcome. The returned error
// only sets the exit status; the precise code is always in the JSON line.
func runSubmitStdio(ctx context.Context, invocation Invocation) error {
	output := invocation.Output
	if output == nil {
		output = os.Stdout
	}
	writeLine := func(value map[string]any) {
		data, err := json.Marshal(value)
		if err != nil {
			return
		}
		_, _ = output.Write(append(data, '\n'))
	}
	params, requestID, err := parseSubmitArgs(invocation.Args)
	if err != nil {
		writeLine(map[string]any{"error": map[string]any{"code": "invalid_request"}})
		return err
	}
	env, err := localmcp.ParseEnv(os.Environ(), os.Getuid())
	if err != nil {
		writeLine(map[string]any{"error": map[string]any{"code": "invalid_request"}})
		return &daemon.Failure{Code: "invalid_request"}
	}
	_, canonical, err := localmcp.ValidateSubmitInput(params)
	if err != nil {
		code := localmcp.CodeOf(err)
		writeLine(map[string]any{"error": map[string]any{"code": code}})
		return &daemon.Failure{Code: "invalid_request"}
	}
	assignments := localmcp.DaemonAssignments{DB: openAssignmentsReadOnly(invocation)}
	journal, err := localmcp.OpenJournal(filepath.Join(invocation.Paths.Root, "local-mcp-journal.sqlite"))
	if err != nil {
		writeLine(map[string]any{"error": map[string]any{"code": "storage_failed"}})
		return &daemon.Failure{Code: "storage_failed"}
	}
	defer journal.Close()
	receipt, err := localmcp.JournalCLIResult(ctx, localmcp.CLISubmission{
		Env:         env,
		Assignments: assignments,
		Journal:     journal,
		Policy:      localmcp.DefaultOfflinePolicy{AllowPending: true},
		Canonical:   canonical,
		RequestID:   requestID,
	})
	if err != nil {
		code := localmcp.CodeOf(err)
		writeLine(map[string]any{"error": map[string]any{"code": code}})
		return &daemon.Failure{Code: cliExitCode(code)}
	}
	outcome, ok := receipt.(map[string]any)
	if !ok {
		writeLine(map[string]any{"error": map[string]any{"code": "internal_error"}})
		return &daemon.Failure{Code: "internal_error"}
	}
	writeLine(outcome)
	return nil
}

// cliExitCode maps the bounded submission failure to the closest daemon exit
// without inventing wire state: usage errors exit 2, assignment mismatches 3,
// everything operational exits 5. The exact code stays in the JSON line.
func cliExitCode(code string) string {
	switch code {
	case "invalid_request", "invalid_params", "method_not_found":
		return "invalid_request"
	case "assignment_unknown", "assignment_ended", "correlation_rejected":
		return "execution_assignment_invalid"
	default:
		return "internal_error"
	}
}

func parseSubmitArgs(args []string) (map[string]any, string, error) {
	values := make(map[string]string)
	var refs []string
	var refsJSON string
	hasRefsJSON := false
	for index := 0; index < len(args); index++ {
		token := args[index]
		if !strings.HasPrefix(token, "--") {
			return nil, "", &daemon.Failure{Code: "invalid_request"}
		}
		name := strings.TrimPrefix(token, "--")
		value := ""
		if cut, after, ok := strings.Cut(name, "="); ok {
			name, value = cut, after
		} else if name != "git-dirty" {
			index++
			if index >= len(args) {
				return nil, "", &daemon.Failure{Code: "invalid_request"}
			}
			value = args[index]
		} else {
			value = "true"
		}
		switch name {
		case "summary", "limitations", "request-id", "git-branch", "git-commit", "git-dirty",
			"evidence-refs-json":
			if _, duplicate := values[name]; duplicate {
				return nil, "", &daemon.Failure{Code: "invalid_request"}
			}
			if name == "git-dirty" {
				parsed, err := strconv.ParseBool(value)
				if err != nil {
					return nil, "", &daemon.Failure{Code: "invalid_request"}
				}
				values[name] = strconv.FormatBool(parsed)
				continue
			}
			if name == "evidence-refs-json" {
				hasRefsJSON = true
				refsJSON = value
				continue
			}
			values[name] = value
		case "evidence-ref":
			refs = append(refs, value)
		default:
			return nil, "", &daemon.Failure{Code: "invalid_request"}
		}
	}
	summary, ok := values["summary"]
	if !ok || !nonEmpty(summary) {
		return nil, "", &daemon.Failure{Code: "invalid_request"}
	}
	requestID, ok := values["request-id"]
	if !ok || len(requestID) < 8 || len(requestID) > 128 {
		return nil, "", &daemon.Failure{Code: "invalid_request"}
	}
	params := map[string]any{"summary": summary, "request_id": requestID}
	if limitations, ok := values["limitations"]; ok && strings.TrimSpace(limitations) != "" {
		params["limitations"] = limitations
	}
	if hasRefsJSON {
		var decoded []any
		if err := json.Unmarshal([]byte(refsJSON), &decoded); err != nil {
			return nil, "", &daemon.Failure{Code: "invalid_request"}
		}
		params["evidence_refs"] = decoded
	} else if len(refs) > 0 {
		encoded := make([]any, 0, len(refs))
		for _, entry := range refs {
			kind, rest, ok := strings.Cut(entry, ":")
			if !ok || kind == "" || rest == "" {
				return nil, "", &daemon.Failure{Code: "invalid_request"}
			}
			item := map[string]any{"kind": kind, "ref": rest}
			if base, version, ok := strings.Cut(rest, "@"); ok && version != "" {
				item["ref"] = base
				item["version"] = version
			}
			encoded = append(encoded, item)
		}
		params["evidence_refs"] = encoded
	}
	if branch, ok := values["git-branch"]; ok {
		params["git_branch"] = branch
	}
	if commit, ok := values["git-commit"]; ok {
		params["git_commit"] = commit
	}
	if dirty, ok := values["git-dirty"]; ok {
		params["git_dirty"] = dirty == "true"
	}
	return params, requestID, nil
}

func nonEmpty(value string) bool {
	return strings.TrimSpace(value) != ""
}
