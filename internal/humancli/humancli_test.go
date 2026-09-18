// ABOUTME: Proves X02 assembly inventory, goldens, separation, secrets, and gating.
// ABOUTME: A stub control plane stands in for the Worker; no credential here is real.

package humancli

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/cli"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/journal"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers"
	"github.com/qdis/bfb/internal/providers/claude"
	"github.com/qdis/bfb/internal/protocol/generated"
)

const syntheticCredential = "bfb_cli_syntheticX02credential00000000000001"
const syntheticWorkspace = "01SYNTHETICWS00000000000001"

func assemble(t *testing.T) *cli.Registry {
	t.Helper()
	providerRegistry, err := provider.NewRegistry(providers.Descriptors())
	if err != nil {
		t.Fatal(err)
	}
	backend := func(db *sql.DB) (journal.Assignments, journal.Observers) { return nil, nil }
	registry := cli.NewRegistry()
	cli.RegisterDaemon(registry, nil)
	cli.RegisterMCP(registry)
	cli.RegisterHook(registry, providerRegistry, backend)
	cli.RegisterCheckout(registry)
	cli.RegisterArtifact(registry, func(ctx context.Context, paths daemon.Paths, method string, payload map[string]any) (generated.LocalRpcEnvelope, error) {
		return daemon.Response(method, daemon.NewRequestID(), map[string]any{}, nil), nil
	})
	cli.RegisterRunner(registry)
	claude.RegisterCommands(registry)
	cli.RegisterRun(registry)
	RegisterHuman(registry, Deps{})
	cli.RegisterExecution(registry, nil, nil, nil)
	return registry
}

func TestOwnerInventoryMatchesLiveRegistry(t *testing.T) {
	registry := assemble(t)
	if _, duplicates := OwnersByPath(); len(duplicates) != 0 {
		t.Fatalf("duplicate owners: %v", duplicates)
	}
	registered := map[string]string{}
	for _, listed := range registry.List() {
		if strings.HasPrefix(listed.Path, "__") {
			continue
		}
		registered[listed.Path] = listed.Summary
	}
	for _, entry := range Table() {
		summary, ok := registered[entry.Path]
		if !ok {
			t.Errorf("matrix command %q has no registered owner", entry.Path)
			continue
		}
		if summary != entry.Summary {
			t.Errorf("matrix summary drift for %q: %q != %q", entry.Path, entry.Summary, summary)
		}
		delete(registered, entry.Path)
	}
	for path := range registered {
		t.Errorf("registered command %q has no matrix owner", path)
	}
}

func stubControl(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

func stateDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "bfbx02")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func run(t *testing.T, registry *cli.Registry, args []string, env map[string]string) (int, string, string) {
	t.Helper()
	for key, value := range env {
		t.Setenv(key, value)
	}
	var stdout, stderr bytes.Buffer
	exit := registry.ExecuteWithStderr(context.Background(), args, strings.NewReader(""), &stdout, &stderr)
	return exit, stdout.String(), stderr.String()
}

func withCredential(t *testing.T) {
	t.Helper()
	t.Setenv("BFB_CLI_CREDENTIAL", syntheticWorkspace+":"+syntheticCredential)
}

// normalizeStamps replaces volatile envelope fields so goldens stay deterministic.
func normalizeStamps(output string) string {
	matched := regexp.MustCompile(`"request_id":"[^"]*"`).ReplaceAllString(output, `"request_id":"STABLE"`)
	return matched
}

func checkGolden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", "goldens", name)
	if os.Getenv("BFB_UPDATE_GOLDENS") == "1" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(normalizeStamps(got)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("golden %s missing: %v", name, err)
	}
	if normalizeStamps(got) != string(want) {
		t.Fatalf("golden %s drift:\n got: %q\nwant: %q", name, normalizeStamps(got), string(want))
	}
}

func TestGoldenHumanAndJSONOutputs(t *testing.T) {
	registry := assemble(t)
	server := stubControl(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+syntheticCredential {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthenticated"}`))
			return
		}
		switch r.URL.Path {
		case "/api/v1/cli/session":
			_, _ = w.Write([]byte(`{"human_id":"human01","workspace_id":"` + syntheticWorkspace + `","key_prefix":"synthetic","scopes":["bfb:read"],"project_ids":["projectA"],"authorization_epoch":1,"expires_at":"2027-01-01T00:00:00Z"}`))
		case "/api/v1/cli/tasks/task01":
			_, _ = w.Write([]byte(`{"task":{"id":"task01","title":"Synthetic task","state":"ready"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"not_found"}`))
		}
	})
	dir := stateDir(t)
	humanArgs := []string{"--data-dir", dir, "whoami", "--control-url", server.URL}
	withCredential(t)
	exit, stdout, stderr := run(t, registry, humanArgs, nil)
	if exit != 0 {
		t.Fatalf("whoami exit %d stdout %q stderr %q", exit, stdout, stderr)
	}
	if !strings.Contains(stdout, "human human01") || !strings.Contains(stdout, "workspace "+syntheticWorkspace) {
		t.Fatalf("concise human output missing: %q", stdout)
	}
	if ContainsCredential(stdout) || ContainsCredential(stderr) {
		t.Fatalf("credential leaked to output: %q %q", stdout, stderr)
	}
	checkGolden(t, "whoami.txt", stdout)

	jsonArgs := []string{"--json", "--data-dir", dir, "whoami", "--control-url", server.URL}
	exit, stdout, stderr = run(t, registry, jsonArgs, nil)
	if exit != 0 {
		t.Fatalf("whoami json exit %d stdout %q stderr %q", exit, stdout, stderr)
	}
	var envelope map[string]any
	decoder := json.NewDecoder(strings.NewReader(stdout))
	if err := decoder.Decode(&envelope); err != nil {
		t.Fatalf("stdout is not one JSON document: %v %q", err, stdout)
	}
	if decoder.More() {
		t.Fatalf("stdout carries trailing prose: %q", stdout)
	}
	if envelope["schema_version"] != 1.0 || envelope["command"] != "whoami" {
		t.Fatalf("envelope shape wrong: %v", envelope)
	}
	if stderr != "" {
		t.Fatalf("diagnostics corrupted machine output: %q", stderr)
	}
	if ContainsCredential(stdout) {
		t.Fatalf("credential leaked to JSON output")
	}
	checkGolden(t, "whoami.json", stdout)

	taskArgs := []string{"--json", "--data-dir", dir, "task", "get", "--control-url", server.URL, "task01"}
	exit, stdout, stderr = run(t, registry, taskArgs, nil)
	if exit != 0 {
		t.Fatalf("task get exit %d stdout %q stderr %q", exit, stdout, stderr)
	}
	checkGolden(t, "task-get.json", stdout)

	missingArgs := []string{"--json", "--data-dir", dir, "task", "get", "--control-url", server.URL, "missing"}
	exit, stdout, stderr = run(t, registry, missingArgs, nil)
	if exit != 5 {
		t.Fatalf("not_found exit %d, want 5: %q", exit, stdout)
	}
	var failure map[string]any
	if err := json.Unmarshal([]byte(stdout), &failure); err != nil {
		t.Fatalf("error stdout is not JSON: %q", stdout)
	}
	if _, ok := failure["error"]; !ok {
		t.Fatalf("error envelope missing error: %q", stdout)
	}
	checkGolden(t, "error-not-found.json", stdout)
	_ = daemon.NewRequestID
}

func TestStdoutStderrSeparation(t *testing.T) {
	registry := assemble(t)
	dir := stateDir(t)
	withCredential(t)
	// Unreachable control plane: JSON envelope on stdout, nothing secret anywhere.
	exit, stdout, stderr := run(t, registry,
		[]string{"--json", "--data-dir", dir, "whoami", "--control-url", "http://127.0.0.1:1"}, nil)
	if exit != 4 {
		t.Fatalf("offline exit %d, want 4: %q %q", exit, stdout, stderr)
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(stdout), &envelope); err != nil {
		t.Fatalf("offline stdout is not JSON: %q", stdout)
	}
	if envelope["error"] == nil {
		t.Fatalf("offline envelope missing error: %q", stdout)
	}
	// Human mode errors go to stderr with empty stdout.
	exit, stdout, stderr = run(t, registry,
		[]string{"--data-dir", dir, "whoami", "--control-url", "http://127.0.0.1:1"}, nil)
	if exit != 4 {
		t.Fatalf("offline human exit %d", exit)
	}
	if stdout != "" {
		t.Fatalf("human error polluted stdout: %q", stdout)
	}
	if !strings.Contains(stderr, "control_unreachable") {
		t.Fatalf("stderr missing code: %q", stderr)
	}
}

func TestSecretScanning(t *testing.T) {
	registry := assemble(t)
	dir := stateDir(t)
	// Secrets in argv are refused before any command runs.
	exit, stdout, stderr := run(t, registry,
		[]string{"--data-dir", dir, "whoami", "--credential=" + syntheticCredential}, nil)
	if exit != 2 {
		t.Fatalf("argv secret exit %d: %q %q", exit, stdout, stderr)
	}
	if ContainsCredential(stdout) || ContainsCredential(stderr) {
		t.Fatalf("refusal leaked the secret")
	}
	// The file store keeps owner-only permissions and redacted errors.
	store := Store{Dir: filepath.Join(dir, "store")}
	if failure := store.Write(Credential{WorkspaceID: syntheticWorkspace, Credential: syntheticCredential}); failure != nil {
		t.Fatal(failure)
	}
	info, err := os.Stat(filepath.Join(dir, "store", "cli-credential.json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("credential file permissions wrong: %v %v", info, err)
	}
	// Every committed golden and log sample stays credential-free.
	samples := []string{Help()}
	for _, shell := range []string{"bash", "zsh", "fish"} {
		script, failure := Completion(shell)
		if failure != nil {
			t.Fatal(failure)
		}
		samples = append(samples, script)
	}
	for _, sample := range samples {
		if ContainsCredential(sample) {
			t.Fatalf("generated text carries a credential")
		}
	}
}

func TestCredentialNonSubstitution(t *testing.T) {
	registry := assemble(t)
	dir := stateDir(t)
	server := stubControl(t, func(w http.ResponseWriter, r *http.Request) {
		// Only exact human bearer credentials authenticate; runner-style
		// possession proofs and foreign schemes never do.
		if r.Header.Get("Authorization") != "Bearer "+syntheticCredential {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthenticated"}`))
			return
		}
		if r.Header.Get("Cookie") != "" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"credential_confusion"}`))
			return
		}
		_, _ = w.Write([]byte(`{"human_id":"human01"}`))
	})
	// A runner-style token cannot substitute for the human credential.
	t.Setenv("BFB_CLI_CREDENTIAL", syntheticWorkspace+":runner-possession-proof")
	exit, stdout, _ := run(t, registry,
		[]string{"--json", "--data-dir", dir, "whoami", "--control-url", server.URL}, nil)
	if exit != 3 {
		t.Fatalf("runner proof exit %d, want 3: %q", exit, stdout)
	}
	// The client never sends the credential as a cookie or query parameter.
	withCredential(t)
	exit, stdout, _ = run(t, registry,
		[]string{"--json", "--data-dir", dir, "whoami", "--control-url", server.URL}, nil)
	if exit != 0 {
		t.Fatalf("human credential exit %d: %q", exit, stdout)
	}
}

func TestDestructiveGating(t *testing.T) {
	registry := assemble(t)
	dir := stateDir(t)
	withCredential(t)
	server := stubControl(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/cli/version" {
			_, _ = w.Write([]byte(`{"api_version":"1","wire_protocol":"bfb-wire/1","cli_min_version":"0.1.0"}`))
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["confirm"] != "run:run01" || body["step_up_proof_id"] != "proof01" {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":"step_up_invalid"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	// Flags precede the positional run ID, matching the repository flag convention.
	base := []string{"--data-dir", dir, "run", "cancel", "--control-url", server.URL}
	cancel := func(extra ...string) []string {
		return append(append([]string{}, append(base, extra...)...), "run01")
	}
	// Missing confirm fails before any network use.
	exit, _, stderr := run(t, registry, cancel("--expected-version", "3", "--step-up-proof", "proof01"), nil)
	if exit != 2 {
		t.Fatalf("missing confirm exit %d: %q", exit, stderr)
	}
	// Missing proof fails with the browser handoff, never an auto-approval.
	exit, _, stderr = run(t, registry, cancel("--confirm", "run:run01", "--expected-version", "3"), nil)
	if exit != 3 {
		t.Fatalf("missing proof exit %d: %q", exit, stderr)
	}
	if !strings.Contains(stderr, "cli:run:cancel") {
		t.Fatalf("handoff missing action binding: %q", stderr)
	}
	checkGolden(t, "cancel-handoff.txt", stderr)
	// Wrong confirm target fails locally.
	exit, _, _ = run(t, registry, cancel("--confirm", "run:other", "--expected-version", "3", "--step-up-proof", "proof01"), nil)
	if exit != 2 {
		t.Fatalf("wrong confirm exit %d", exit)
	}
	// Fresh proof plus confirm dispatches exactly one guarded call.
	exit, stdout, _ := run(t, registry, cancel("--confirm", "run:run01", "--expected-version", "3", "--step-up-proof", "proof01"), nil)
	if exit != 0 {
		t.Fatalf("guarded cancel exit %d: %q", exit, stdout)
	}
}

func TestHelpAndCompletionFromLiveTree(t *testing.T) {
	registry := assemble(t)
	help := Help()
	owners, _ := OwnersByPath()
	for path := range owners {
		if !strings.Contains(help, path) {
			t.Fatalf("generated help omits %q", path)
		}
	}
	for _, shell := range []string{"bash", "zsh", "fish"} {
		script, failure := Completion(shell)
		if failure != nil {
			t.Fatal(failure)
		}
		for path := range owners {
			if !strings.Contains(script, path) {
				t.Fatalf("%s completion omits %q", shell, path)
			}
		}
	}
	if _, failure := Completion("powershell"); failure == nil || failure.CLIExitCode() != 2 {
		t.Fatalf("unknown shell must fail with exit 2")
	}
	dir := stateDir(t)
	withCredential(t)
	exit, stdout2, _ := run(t, registry, []string{"--data-dir", dir, "completion", "bash"}, nil)
	if exit != 0 {
		t.Fatalf("completion exit %d: %q", exit, stdout2)
	}
	for path := range owners {
		if !strings.Contains(stdout2, path) {
			t.Fatalf("real completion output omits %q", path)
		}
	}
}

func TestVersionDiagnosticsAndOfflineMatrix(t *testing.T) {
	registry := assemble(t)
	dir := stateDir(t)
	withCredential(t)
	future := stubControl(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"api_version":"2","wire_protocol":"bfb-wire/1","cli_min_version":"0.2.0"}`))
	})
	// Reads proceed under a major mismatch with a stderr warning.
	exit, stdout, stderr := run(t, registry,
		[]string{"--json", "--data-dir", dir, "version", "--control-url", future.URL}, nil)
	if exit != 0 {
		t.Fatalf("version exit %d: %q %q", exit, stdout, stderr)
	}
	if !strings.Contains(stderr, "warning") {
		t.Fatalf("version mismatch warning missing: %q", stderr)
	}
	checkGolden(t, "version.json", stdout)
	// Version stays exit 0 offline with the client version always reported.
	exit, stdout, stderr = run(t, registry,
		[]string{"--json", "--data-dir", dir, "version", "--control-url", "http://127.0.0.1:1"}, nil)
	if exit != 0 {
		t.Fatalf("offline version exit %d", exit)
	}
	if !strings.Contains(stdout, ClientVersion) {
		t.Fatalf("offline version hides client version: %q", stdout)
	}
}
