// ABOUTME: Implements thin human command handlers over the frozen server routes.
// ABOUTME: Handlers forward bounded inputs and render redacted outputs only.

package humancli

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/qdis/bfb/internal/daemon"
)

func cmdLogin(ctx context.Context, s session) *Failure {
	if failure := CheckArgv(s.args); failure != nil {
		return s.diagnose(failure)
	}
	set := s.flags("login")
	control := set.String("control-url", "", "Control Worker origin")
	if set.Parse(s.args) != nil || set.NArg() != 0 {
		return s.diagnose(fail("invalid_request", "usage: bfb login [--control-url URL]"))
	}
	if *control != "" {
		s.control = *control
	}
	client, failure := s.dial(false)
	if failure != nil {
		return s.diagnose(failure)
	}
	_, started, failure := client.Do(ctx, http.MethodPost, "/auth/device/code", map[string]any{"client_id": "bfb-cli"})
	if failure != nil {
		return s.diagnose(failure)
	}
	device, _ := started["device_code"].(string)
	userCode, _ := started["user_code"].(string)
	uri, _ := started["verification_uri"].(string)
	complete, _ := started["verification_uri_complete"].(string)
	interval := 5
	if value, ok := started["interval"].(float64); ok && value >= 1 && value <= 30 {
		interval = int(value)
	}
	if device == "" || userCode == "" {
		return s.diagnose(fail("request_failed", "the control plane answered outside the frozen surface"))
	}
	if s.json {
		return s.diagnose(s.ok(map[string]any{
			"user_code": userCode, "verification_uri": uri,
			"verification_uri_complete": complete, "interval": interval,
		}, nil))
	}
	_, _ = fmt.Fprintln(s.output, "Open "+uri+" and enter code "+userCode)
	deadline := time.Now().Add(10 * time.Minute)
	for {
		if time.Now().After(deadline) {
			return s.diagnose(fail("control_unreachable", "the device approval expired before exchange"))
		}
		select {
		case <-ctx.Done():
			return s.diagnose(fail("control_unreachable", "the device approval was cancelled"))
		case <-time.After(time.Duration(interval) * time.Second):
		}
		_, exchanged, failure := client.Do(ctx, http.MethodPost, "/api/v1/cli/exchange",
			map[string]any{"client_id": "bfb-cli", "device_code": device})
		if failure != nil {
			if failure.Code == "request_rejected" || failure.Code == "unauthenticated" {
				continue
			}
			return s.diagnose(failure)
		}
		credential, _ := exchanged["credential"].(string)
		workspace, _ := exchanged["workspace_id"].(string)
		prefix, _ := exchanged["key_prefix"].(string)
		expires, _ := exchanged["expires_at"].(string)
		if credential == "" || workspace == "" {
			return s.diagnose(fail("request_failed", "the control plane answered outside the frozen surface"))
		}
		if failure := s.store.Write(Credential{WorkspaceID: workspace, Credential: credential, KeyPrefix: prefix, ExpiresAt: expires}); failure != nil {
			return s.diagnose(failure)
		}
		return s.diagnose(s.ok(map[string]any{"workspace_id": workspace, "key_prefix": prefix, "expires_at": expires},
			[]string{"authorized workspace " + workspace + " as " + prefix}))
	}
}

func cmdLogout(ctx context.Context, s session) *Failure {
	if failure := CheckArgv(s.args); failure != nil {
		return s.diagnose(failure)
	}
	set := s.flags("logout")
	control := set.String("control-url", "", "Control Worker origin")
	if set.Parse(s.args) != nil || set.NArg() != 0 {
		return s.diagnose(fail("invalid_request", "usage: bfb logout [--control-url URL]"))
	}
	if *control != "" {
		s.control = *control
	}
	revoked := false
	if s.control != "" {
		if credential, failure := s.store.Read(); failure == nil {
			client := Client{ControlURL: s.control, Credential: credential.Credential}
			if s.client != nil {
				client = *s.client
				client.Credential = credential.Credential
			}
			if _, _, failure := client.Do(ctx, http.MethodPost, "/api/v1/cli/session/revoke", map[string]any{}); failure == nil {
				revoked = true
			} else if failure.Code != "control_unreachable" {
				_, _ = fmt.Fprintf(s.stderr, "warning: %s\n", Redact(failure.Message))
			}
		}
	}
	if failure := s.store.Delete(); failure != nil {
		return s.diagnose(failure)
	}
	data := map[string]any{"revoked": revoked, "local_forgotten": true}
	if s.json {
		return s.diagnose(s.ok(data, nil))
	}
	if revoked {
		_, _ = fmt.Fprintln(s.output, "logged out; binding revoked and credential forgotten")
		return nil
	}
	_, _ = fmt.Fprintln(s.output, "logged out locally; binding revocation did not confirm")
	return nil
}

func cmdWhoami(ctx context.Context, s session) *Failure {
	if failure := CheckArgv(s.args); failure != nil {
		return s.diagnose(failure)
	}
	set := s.flags("whoami")
	control := set.String("control-url", "", "Control Worker origin")
	if set.Parse(s.args) != nil || set.NArg() != 0 {
		return s.diagnose(fail("invalid_request", "usage: bfb whoami [--control-url URL]"))
	}
	if *control != "" {
		s.control = *control
	}
	client, failure := s.dial(true)
	if failure != nil {
		return s.diagnose(failure)
	}
	_, body, failure := client.Do(ctx, http.MethodGet, "/api/v1/cli/session", nil)
	if failure != nil {
		return s.diagnose(failure)
	}
	human, _ := body["human_id"].(string)
	workspace, _ := body["workspace_id"].(string)
	prefix, _ := body["key_prefix"].(string)
	return s.diagnose(s.ok(body, []string{
		"human " + human,
		"workspace " + workspace,
		"credential " + prefix,
	}))
}

func cmdProjectList(ctx context.Context, s session) *Failure {
	set := s.flags("project list")
	control := set.String("control-url", "", "Control Worker origin")
	limit := set.Int("limit", 50, "Page size, at most 100")
	if set.Parse(s.args) != nil || set.NArg() != 0 || *limit < 1 || *limit > 100 {
		return s.diagnose(fail("invalid_request", "usage: bfb project list [--control-url URL] [--limit N]"))
	}
	return s.get(ctx, control, "/api/v1/cli/projects?limit="+strconv.Itoa(*limit), "projects", []string{"id", "name", "slug"})
}

func cmdProjectGet(ctx context.Context, s session) *Failure {
	set := s.flags("project get")
	control := set.String("control-url", "", "Control Worker origin")
	if set.Parse(s.args) != nil || set.NArg() != 1 {
		return s.diagnose(fail("invalid_request", "usage: bfb project get [--control-url URL] PROJECT_ID"))
	}
	return s.getOne(ctx, control, "/api/v1/cli/projects/"+set.Arg(0), "project")
}

func cmdTaskList(ctx context.Context, s session) *Failure {
	set := s.flags("task list")
	control := set.String("control-url", "", "Control Worker origin")
	limit := set.Int("limit", 50, "Page size, at most 100")
	if set.Parse(s.args) != nil || set.NArg() != 0 || *limit < 1 || *limit > 100 {
		return s.diagnose(fail("invalid_request", "usage: bfb task list [--control-url URL] [--limit N]"))
	}
	return s.get(ctx, control, "/api/v1/cli/tasks?limit="+strconv.Itoa(*limit), "tasks", []string{"id", "title", "state"})
}

func cmdTaskGet(ctx context.Context, s session) *Failure {
	set := s.flags("task get")
	control := set.String("control-url", "", "Control Worker origin")
	if set.Parse(s.args) != nil || set.NArg() != 1 {
		return s.diagnose(fail("invalid_request", "usage: bfb task get [--control-url URL] TASK_ID"))
	}
	return s.getOne(ctx, control, "/api/v1/cli/tasks/"+set.Arg(0), "task")
}

func cmdTaskCreate(ctx context.Context, s session) *Failure {
	set := s.flags("task create")
	control := set.String("control-url", "", "Control Worker origin")
	project := set.String("project", "", "Project ID")
	title := set.String("title", "", "Task title")
	priority := set.String("priority", "P2", "Priority P0-P3")
	if set.Parse(s.args) != nil || set.NArg() != 0 || *project == "" || *title == "" {
		return s.diagnose(fail("invalid_request", "usage: bfb task create --project ID --title TEXT [--priority P0-P3]"))
	}
	switch *priority {
	case "P0", "P1", "P2", "P3":
	default:
		return s.diagnose(fail("invalid_request", "usage: bfb task create --project ID --title TEXT [--priority P0-P3]"))
	}
	if *control != "" {
		s.control = *control
	}
	client, failure := s.dial(true)
	if failure != nil {
		return s.diagnose(failure)
	}
	if _, failure := s.mutation(ctx, client); failure != nil {
		return s.diagnose(failure)
	}
	_, body, failure := client.Do(ctx, http.MethodPost, "/api/v1/cli/tasks", map[string]any{
		"project_id": *project, "title": *title, "priority": *priority, "request_id": daemon.NewRequestID(),
	})
	if failure != nil {
		return s.diagnose(failure)
	}
	return s.diagnose(s.ok(body, summarizeIDs(body, "result", "id")))
}

func cmdRunList(ctx context.Context, s session) *Failure {
	set := s.flags("run list")
	control := set.String("control-url", "", "Control Worker origin")
	task := set.String("task", "", "Task ID")
	limit := set.Int("limit", 50, "Page size, at most 100")
	if set.Parse(s.args) != nil || set.NArg() != 0 || *task == "" || *limit < 1 || *limit > 100 {
		return s.diagnose(fail("invalid_request", "usage: bfb run list --task ID [--control-url URL] [--limit N]"))
	}
	return s.get(ctx, control, "/api/v1/cli/runs?task_id="+*task+"&limit="+strconv.Itoa(*limit), "runs", []string{"id", "result_state"})
}

func cmdRunGet(ctx context.Context, s session) *Failure {
	set := s.flags("run get")
	control := set.String("control-url", "", "Control Worker origin")
	if set.Parse(s.args) != nil || set.NArg() != 1 {
		return s.diagnose(fail("invalid_request", "usage: bfb run get [--control-url URL] RUN_ID"))
	}
	return s.getOne(ctx, control, "/api/v1/cli/runs/"+set.Arg(0), "run")
}

func cmdRunCancel(ctx context.Context, s session) *Failure {
	set := s.flags("run cancel")
	control := set.String("control-url", "", "Control Worker origin")
	confirm := set.String("confirm", "", "Explicit target run:RUN_ID")
	proof := set.String("step-up-proof", "", "Fresh browser step-up proof ID")
	proofFile := set.String("step-up-proof-file", "", "File holding the fresh proof ID")
	version := set.Int("expected-version", 0, "Current run resource version")
	if set.Parse(s.args) != nil || set.NArg() != 1 {
		return s.diagnose(fail("invalid_request", "usage: bfb run cancel --confirm run:RUN_ID --expected-version N (--step-up-proof ID | --step-up-proof-file PATH) RUN_ID"))
	}
	runID := set.Arg(0)
	if *confirm != "run:"+runID {
		return s.diagnose(fail("invalid_request", "cancellation requires --confirm run:"+runID))
	}
	if *version < 1 {
		return s.diagnose(fail("invalid_request", "cancellation requires --expected-version from run get"))
	}
	proofID, failure := ResolveProof(*proof, *proofFile)
	if failure != nil {
		return s.diagnose(failure)
	}
	if proofID == "" {
		gate := StepUp{Action: "cli:run:cancel", Target: "cli:run:cancel:" + runID + ":" + strconv.Itoa(*version)}
		return s.diagnose(fail("step_up_invalid", gate.Handoff()))
	}
	if *control != "" {
		s.control = *control
	}
	client, failure := s.dial(true)
	if failure != nil {
		return s.diagnose(failure)
	}
	if _, failure := s.mutation(ctx, client); failure != nil {
		return s.diagnose(failure)
	}
	_, body, failure := client.Do(ctx, http.MethodPost, "/api/v1/cli/runs/"+runID+"/cancellation", map[string]any{
		"expected_run_version": *version, "confirm": *confirm,
		"step_up_proof_id": proofID, "request_id": daemon.NewRequestID(),
	})
	if failure != nil {
		return s.diagnose(failure)
	}
	return s.diagnose(s.ok(body, []string{"run " + runID + " cancelled"}))
}

func cmdAttentionList(ctx context.Context, s session) *Failure {
	set := s.flags("attention list")
	control := set.String("control-url", "", "Control Worker origin")
	state := set.String("state", "", "Filter: open, answered, or resolved")
	limit := set.Int("limit", 50, "Page size, at most 100")
	if set.Parse(s.args) != nil || set.NArg() != 0 || *limit < 1 || *limit > 100 {
		return s.diagnose(fail("invalid_request", "usage: bfb attention list [--control-url URL] [--state STATE] [--limit N]"))
	}
	switch *state {
	case "", "open", "answered", "resolved":
	default:
		return s.diagnose(fail("invalid_request", "usage: bfb attention list [--control-url URL] [--state STATE] [--limit N]"))
	}
	path := "/api/v1/cli/attention?limit=" + strconv.Itoa(*limit)
	if *state != "" {
		path += "&state=" + *state
	}
	return s.get(ctx, control, path, "attention", []string{"id", "kind", "state"})
}

func cmdAttentionGet(ctx context.Context, s session) *Failure {
	set := s.flags("attention get")
	control := set.String("control-url", "", "Control Worker origin")
	if set.Parse(s.args) != nil || set.NArg() != 1 {
		return s.diagnose(fail("invalid_request", "usage: bfb attention get [--control-url URL] ATTENTION_ID"))
	}
	return s.getOne(ctx, control, "/api/v1/cli/attention/"+set.Arg(0), "attention")
}

func cmdAttentionAnswer(ctx context.Context, s session) *Failure {
	set := s.flags("attention answer")
	control := set.String("control-url", "", "Control Worker origin")
	answer := set.String("answer", "", "Answer text, 1-2048 chars")
	version := set.Int("expected-version", 0, "Current request version")
	if set.Parse(s.args) != nil || set.NArg() != 1 || *answer == "" || *version < 1 {
		return s.diagnose(fail("invalid_request", "usage: bfb attention answer --answer TEXT --expected-version N ID"))
	}
	if *control != "" {
		s.control = *control
	}
	client, failure := s.dial(true)
	if failure != nil {
		return s.diagnose(failure)
	}
	if _, failure := s.mutation(ctx, client); failure != nil {
		return s.diagnose(failure)
	}
	_, body, failure := client.Do(ctx, http.MethodPost, "/api/v1/cli/attention/"+set.Arg(0)+"/answer", map[string]any{
		"expected_version": *version, "answer": *answer, "request_id": daemon.NewRequestID(),
	})
	if failure != nil {
		return s.diagnose(failure)
	}
	return s.diagnose(s.ok(body, []string{"attention " + set.Arg(0) + " answered"}))
}

func cmdAttentionResolve(ctx context.Context, s session) *Failure {
	set := s.flags("attention resolve")
	control := set.String("control-url", "", "Control Worker origin")
	version := set.Int("expected-version", 0, "Current request version")
	if set.Parse(s.args) != nil || set.NArg() != 1 || *version < 1 {
		return s.diagnose(fail("invalid_request", "usage: bfb attention resolve --expected-version N ID"))
	}
	if *control != "" {
		s.control = *control
	}
	client, failure := s.dial(true)
	if failure != nil {
		return s.diagnose(failure)
	}
	if _, failure := s.mutation(ctx, client); failure != nil {
		return s.diagnose(failure)
	}
	_, body, failure := client.Do(ctx, http.MethodPost, "/api/v1/cli/attention/"+set.Arg(0)+"/resolve", map[string]any{
		"expected_version": *version, "request_id": daemon.NewRequestID(),
	})
	if failure != nil {
		return s.diagnose(failure)
	}
	return s.diagnose(s.ok(body, []string{"attention " + set.Arg(0) + " resolved"}))
}

func cmdArtifactList(ctx context.Context, s session) *Failure {
	set := s.flags("artifact list")
	control := set.String("control-url", "", "Control Worker origin")
	run := set.String("run", "", "Run ID")
	if set.Parse(s.args) != nil || set.NArg() != 0 || *run == "" {
		return s.diagnose(fail("invalid_request", "usage: bfb artifact list --run ID [--control-url URL]"))
	}
	return s.get(ctx, control, "/api/v1/cli/artifacts?run_id="+*run, "artifacts", []string{"id", "format", "role"})
}

func cmdArtifactGet(ctx context.Context, s session) *Failure {
	set := s.flags("artifact get")
	control := set.String("control-url", "", "Control Worker origin")
	if set.Parse(s.args) != nil || set.NArg() != 1 {
		return s.diagnose(fail("invalid_request", "usage: bfb artifact get [--control-url URL] ARTIFACT_ID"))
	}
	return s.getOne(ctx, control, "/api/v1/cli/artifacts/"+set.Arg(0), "artifact")
}

func cmdVersion(ctx context.Context, s session) *Failure {
	if failure := CheckArgv(s.args); failure != nil {
		return s.diagnose(failure)
	}
	set := s.flags("version")
	control := set.String("control-url", "", "Control Worker origin")
	if set.Parse(s.args) != nil || set.NArg() != 0 {
		return s.diagnose(fail("invalid_request", "usage: bfb version [--control-url URL]"))
	}
	if *control != "" {
		s.control = *control
	}
	data := map[string]any{"client_version": ClientVersion, "wire_protocol": WireProtocol}
	lines := []string{"bfb " + ClientVersion}
	if s.control != "" {
		client, _ := s.dial(false)
		if version, failure := client.Version(ctx); failure != nil {
			_, _ = fmt.Fprintf(s.stderr, "warning: server version unknown: %s\n", Redact(failure.Message))
			data["server"] = "unknown"
			lines = append(lines, "server unknown")
		} else {
			data["api_version"] = version.APIVersion
			data["cli_min_version"] = version.CLIMinVersion
			lines = append(lines, "server api "+version.APIVersion)
			if major(version.APIVersion) != major(MinAPIVersion) {
				_, _ = fmt.Fprintf(s.stderr, "warning: server API %s is outside supported major %s\n", version.APIVersion, MinAPIVersion)
			}
		}
	}
	return s.diagnose(s.ok(data, lines))
}

func cmdCompletion(shell string) func(context.Context, session) *Failure {
	return func(_ context.Context, s session) *Failure {
		if failure := CheckArgv(s.args); failure != nil {
			return s.diagnose(failure)
		}
		set := s.flags("completion " + shell)
		control := set.String("control-url", "", "Control Worker origin")
		if set.Parse(s.args) != nil || set.NArg() != 0 {
			return s.diagnose(fail("invalid_request", "usage: bfb completion "+shell))
		}
		if *control != "" {
			s.control = *control
		}
		script, failure := Completion(shell)
		if failure != nil {
			return s.diagnose(failure)
		}
		if s.json {
			return s.diagnose(s.ok(map[string]any{"shell": shell, "script": script}, nil))
		}
		_, _ = fmt.Fprint(s.output, script)
		return nil
	}
}

// get runs an authenticated collection read and renders one line per entry.
func (s session) get(ctx context.Context, control *string, path, key string, fields []string) *Failure {
	if failure := CheckArgv(s.args); failure != nil {
		return s.diagnose(failure)
	}
	if *control != "" {
		s.control = *control
	}
	client, failure := s.dial(true)
	if failure != nil {
		return s.diagnose(failure)
	}
	_, body, failure := client.Do(ctx, http.MethodGet, path, nil)
	if failure != nil {
		return s.diagnose(failure)
	}
	entries, _ := body[key].([]any)
	var lines []string
	for _, entry := range entries {
		item, _ := entry.(map[string]any)
		parts := make([]string, 0, len(fields))
		for _, field := range fields {
			parts = append(parts, stringify(item[field]))
		}
		lines = append(lines, joinNonEmpty(parts))
	}
	sort.Strings(lines)
	return s.diagnose(s.ok(body, lines))
}

// getOne runs an authenticated single-object read.
func (s session) getOne(ctx context.Context, control *string, path, key string) *Failure {
	if failure := CheckArgv(s.args); failure != nil {
		return s.diagnose(failure)
	}
	if *control != "" {
		s.control = *control
	}
	client, failure := s.dial(true)
	if failure != nil {
		return s.diagnose(failure)
	}
	_, body, failure := client.Do(ctx, http.MethodGet, path, nil)
	if failure != nil {
		return s.diagnose(failure)
	}
	item, _ := body[key].(map[string]any)
	return s.diagnose(s.ok(body, []string{summarize(item)}))
}

func stringify(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(typed)
	default:
		return ""
	}
}

func joinNonEmpty(parts []string) string {
	var kept []string
	for _, part := range parts {
		if part != "" {
			kept = append(kept, part)
		}
	}
	return join(kept, " ")
}

func join(parts []string, separator string) string {
	out := ""
	for index, part := range parts {
		if index > 0 {
			out += separator
		}
		out += part
	}
	return out
}

func summarize(item map[string]any) string {
	id := stringify(item["id"])
	if title, ok := item["title"].(string); ok && title != "" {
		return id + " " + title
	}
	if kind, ok := item["kind"].(string); ok && kind != "" {
		return id + " " + kind
	}
	return id
}

func summarizeIDs(body map[string]any, keys ...string) []string {
	current := body
	for _, key := range keys {
		next, _ := current[key].(map[string]any)
		if next == nil {
			return []string{}
		}
		current = next
	}
	if id, ok := current["id"].(string); ok {
		return []string{"created " + id}
	}
	return []string{}
}
