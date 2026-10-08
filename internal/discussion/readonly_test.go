// ABOUTME: Proves read-only turn execution through certified adapters and the real Codex binary.
// ABOUTME: Peer content never reaches argv; the checkout stays untouched; uncertified paths fail closed.

package discussion_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/discussion"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/claude"
	"github.com/qdis/bfb/internal/providers/codex"
)

func TestFakeTurnPlansReadOnly(t *testing.T) {
	fixture := setupDiscussion(t, 3)
	request := fixture.request(0, 1, 1, true, "")
	invocation, err := fixture.planner.PlanDiscussionTurn("fake", request)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(invocation.Arguments, " ")
	if !strings.Contains(joined, "--filesystem read_only") && !strings.Contains(joined, "read_only") {
		t.Fatalf("fresh turn must pin read-only policy, got %v", invocation.Arguments)
	}
	if invocation.WorkingDirectory == "" {
		t.Fatal("plan must pin the verified checkout directory")
	}
	if len(invocation.Stdin) == 0 || !strings.Contains(string(invocation.Stdin), "read-only") {
		t.Fatal("plan stdin must carry the fixed read-only instruction")
	}
	// Continuation resumes the exact owned session and nothing else.
	resume := fixture.request(0, 3, 3, false, "synthetic-session")
	resumed, err := fixture.planner.PlanDiscussionTurn("fake", resume)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(resumed.Arguments, "synthetic-session") {
		t.Fatalf("continuation must resume the exact session, got %v", resumed.Arguments)
	}
}

func TestWritableConfigFailsClosed(t *testing.T) {
	fixture := setupDiscussion(t, 3)
	fixture.planner.Configs["fake"] = generated.ExecutionConfig{
		Provider: "fake", Mode: "headless", Model: "synthetic", Effort: "low",
		ApprovalPolicy: "never", FilesystemPolicy: "workspace_write",
		ContextInjection: "none", InitialTurnTransport: "provider_prompt",
		RequiredCapabilities: []string{"launch.headless"},
	}
	request := fixture.request(0, 1, 1, true, "")
	if _, err := fixture.planner.PlanDiscussionTurn("fake", request); err == nil || discussion.Code(err) != "provider_discussion_unsafe" {
		t.Fatalf("want provider_discussion_unsafe, got %v", err)
	}
}

// TestCodexRealBinaryPlansReadOnlyTurn probes the installed Codex through the
// real adapter in a temporary home. It runs no model, needs no credential,
// and never touches the repository: version, health, and argv planning only.
func TestCodexRealBinaryPlansReadOnlyTurn(t *testing.T) {
	binary, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("codex binary unavailable; real-provider planning unproven")
	}
	raw, err := exec.Command(binary, "--version").Output()
	if err != nil {
		t.Skipf("codex version probe failed: %v", err)
	}
	version, err := codex.Descriptor().ParseVersion(raw)
	if err != nil || version != "0.153.4" {
		t.Skipf("codex version %q is not the tested 0.153.4; planning unproven", version)
	}
	home := t.TempDir()
	hooks := `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/usr/local/bin/bfb hook ingest --provider codex"}]}]}}`
	if err := os.WriteFile(codex.HooksPath(home), []byte(hooks), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codex.ConfigPath(home), []byte(""), 0600); err != nil {
		t.Fatal(err)
	}
	registry, err := provider.NewRegistry([]provider.Descriptor{codex.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	installation := provider.Installation{
		Executable:      binary,
		ConfigFiles:     codex.ConfigSources(home),
		IntegrationHash: codex.IntegrationID(),
		Environment:     []string{},
	}
	probe, err := registry.Probe(context.Background(), "codex", installation, time.Now())
	if err != nil {
		t.Fatalf("real codex 0.153.4 must probe: %v", err)
	}
	workdir := t.TempDir()
	planner := &discussion.KitPlanner{
		Registry: registry,
		Probes:   map[string]provider.Probe{"codex": probe},
		Policy:   provider.Policy{AllowedCapabilities: codex.Capabilities()},
		Configs: map[string]generated.ExecutionConfig{
			"codex": {
				Provider: "codex", Mode: "headless", Model: "gpt-5.6-sol", Effort: "low",
				ApprovalPolicy: "never", FilesystemPolicy: "read_only",
				ContextInjection: "none", InitialTurnTransport: "provider_prompt",
				RequiredCapabilities: []string{"launch.headless"},
			},
		},
		Now: time.Now,
	}
	fresh := discussion.TurnRequest{
		DiscussionID: uid(800), TurnID: uid(801), DeliveryID: uid(802),
		Slot: 0, Ordinal: 1, Provider: "codex", WorkingDir: workdir,
		RunID: uid(803), ExecutionID: uid(804), Generation: 1, Fresh: true,
		ExternalContext: []byte(`{"brief":"synthetic","peer":[]}`),
		Worker:          "worker-one", Fencing: 1, IdempotencyKey: uid(805),
	}
	invocation, err := planner.PlanDiscussionTurn("codex", fresh)
	if err != nil {
		t.Fatalf("real codex must plan a read-only turn: %v", err)
	}
	argv := strings.Join(invocation.Arguments, " ")
	for _, want := range []string{"exec", "--sandbox", "read-only", "--json", "gpt-5.6-sol"} {
		if !strings.Contains(argv, want) {
			t.Fatalf("codex argv must pin %q, got %v", want, invocation.Arguments)
		}
	}
	if strings.Contains(argv, "workspace-write") || strings.Contains(argv, "always") {
		t.Fatalf("codex argv must stay read-only, got %v", invocation.Arguments)
	}
	continued := fresh
	continued.Fresh = false
	continued.Ordinal = 3
	continued.ObservedSession = "synthetic-session"
	resumed, err := planner.PlanDiscussionTurn("codex", continued)
	if err != nil {
		t.Fatalf("real codex must plan exact-session continuation: %v", err)
	}
	if !slices.Contains(resumed.Arguments, "synthetic-session") {
		t.Fatalf("codex continuation must resume the exact session, got %v", resumed.Arguments)
	}
}

// TestClaudeTurnFailsClosed proves the installed Claude cannot take a
// headless discussion turn: whatever its version, Turn stays unsupported and
// planning fails visibly instead of inventing a transport.
func TestClaudeTurnFailsClosed(t *testing.T) {
	binary, err := exec.LookPath("claude")
	if err != nil {
		t.Skip("claude binary unavailable; fail-closed path unproven")
	}
	home := t.TempDir()
	if err := os.MkdirAll(home+"/.claude", 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(home+"/.claude/settings.json", []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(home+"/.claude.json", []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	registry, err := provider.NewRegistry([]provider.Descriptor{claude.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	installation, err := claude.Installation(home, "/usr/local/bin/bfb")
	if err != nil {
		t.Fatal(err)
	}
	installation.Executable = binary
	probe, err := registry.Probe(context.Background(), "claude", installation, time.Now())
	if err != nil {
		t.Skipf("claude probe failed in temporary home: %v", err)
	}
	planner := &discussion.KitPlanner{
		Registry: registry,
		Probes:   map[string]provider.Probe{"claude": probe},
		Policy:   provider.Policy{AllowedCapabilities: claude.Capabilities()},
		Configs: map[string]generated.ExecutionConfig{
			"claude": {
				Provider: "claude", Mode: "headless", Model: "sonnet", Effort: "low",
				ApprovalPolicy: "never", FilesystemPolicy: "read_only",
				ContextInjection: "none", InitialTurnTransport: "provider_prompt",
				RequiredCapabilities: []string{"launch.headless"},
			},
		},
		Now: time.Now,
	}
	request := discussion.TurnRequest{
		DiscussionID: uid(810), TurnID: uid(811), DeliveryID: uid(812),
		Slot: 0, Ordinal: 1, Provider: "claude", WorkingDir: t.TempDir(),
		RunID: uid(813), ExecutionID: uid(814), Generation: 1, Fresh: true,
		ExternalContext: []byte(`{"brief":"synthetic","peer":[]}`),
		Worker:          "worker-one", Fencing: 1, IdempotencyKey: uid(815),
	}
	if _, err := planner.PlanDiscussionTurn("claude", request); err == nil {
		t.Fatal("claude headless turns must fail closed")
	}
}

func TestCheckoutUntouchedByFullDiscussion(t *testing.T) {
	ctx := context.Background()
	fixture := setupDiscussion(t, 1)
	canary := filepath.Join(fixture.workdir, "CANARY")
	if err := os.WriteFile(canary, []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, turn := range []struct {
		slot, ordinal, key int
		fresh              bool
		session            string
	}{
		{0, 1, 1, true, ""},
		{1, 2, 2, true, ""},
	} {
		session := "synthetic-session-a"
		if turn.slot == 1 {
			session = "synthetic-session-b"
		}
		fixture.runner.byOrdinal[turn.ordinal] = scriptedTurn{session: session, output: validOutput("position")}
		request := fixture.request(turn.slot, turn.ordinal, turn.key, turn.fresh, turn.session)
		if err := discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, request, nil, map[string]bool{}, "sha256:"+"c", nowAt(10+turn.ordinal)); err != nil {
			t.Fatal(err)
		}
		for _, invocation := range fixture.runner.seen {
			for _, argument := range invocation.Arguments {
				if argument == "git" || strings.Contains(argument, "git ") {
					t.Fatalf("delivery must never invoke git, got %v", invocation.Arguments)
				}
			}
		}
	}
	raw, err := os.ReadFile(canary)
	if err != nil || string(raw) != "untouched" {
		t.Fatalf("checkout canary must survive the discussion, got %q %v", raw, err)
	}
	entries, err := os.ReadDir(fixture.workdir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("checkout must gain no files, got %v %v", entries, err)
	}
}
