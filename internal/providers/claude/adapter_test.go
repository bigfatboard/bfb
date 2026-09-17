// ABOUTME: Certifies Claude probe policy, launch/resume plans, and control mapping.
// ABOUTME: Uses only owned stub executables; never invokes the real Claude CLI.

package claude_test

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers"
	"github.com/qdis/bfb/internal/providers/claude"
)

const (
	testRunID       = "01J9Z8X1MNWT8YQ2R4S3V6K0P7"
	testExecutionID = "01J9Z8X1MNWT8YQ2R4S3V6K0Q9"
	testSessionID   = "33333333-3333-4333-8333-333333333333"
)

func stubBinary(t *testing.T, version string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho \""+version+" (Claude Code)\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func stubLauncher(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "bfb")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 4\n"), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func registry(t *testing.T) *provider.Registry {
	t.Helper()
	registry, err := provider.NewRegistry(providers.Descriptors())
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func installation(t *testing.T, binary, home, launcher string) provider.Installation {
	t.Helper()
	hash, err := claude.IntegrationHash(home, launcher)
	if err != nil {
		t.Fatal(err)
	}
	return provider.Installation{
		Executable:      binary,
		ConfigFiles:     []provider.ConfigSource{{Name: "user_settings", Path: filepath.Join(home, ".claude", "settings.json")}, {Name: "user_mcp", Path: filepath.Join(home, ".claude.json")}},
		IntegrationHash: hash,
		Environment:     []string{},
	}
}

func writeSettings(t *testing.T, home, launcher string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0700); err != nil {
		t.Fatal(err)
	}
	editor := claude.SettingsEditor{Launcher: launcher}
	after, _, err := editor.Prepare(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), after, 0600); err != nil {
		t.Fatal(err)
	}
}

func launchInput(workdir string) provider.LaunchInput {
	return provider.LaunchInput{WorkingDirectory: workdir, Config: generated.ExecutionConfig{
		Provider: "claude", Mode: "interactive", Model: "sonnet", Effort: "low",
		ApprovalPolicy: "on_request", FilesystemPolicy: "workspace_write",
		ContextInjection: "session_start_additional_context", InitialTurnTransport: "provider_prompt",
		RequiredCapabilities: []string{"hooks.session_start"},
	}}
}

func mustProbe(t *testing.T, registry *provider.Registry, installation provider.Installation) provider.Probe {
	t.Helper()
	probe, err := registry.Probe(context.Background(), "claude", installation, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return probe
}

func TestDescriptorManifest(t *testing.T) {
	found := false
	for _, descriptor := range providers.Descriptors() {
		if descriptor.Name != "claude" {
			continue
		}
		found = true
		if descriptor.Manifest.Version != "1.0.0" || !slices.Equal(descriptor.Manifest.TestedVersions, []string{"2.1.274"}) {
			t.Fatalf("unexpected manifest %+v", descriptor.Manifest)
		}
		if descriptor.Adapter == nil {
			t.Fatal("missing adapter")
		}
	}
	if !found {
		t.Fatal("claude descriptor not aggregated")
	}
}

func TestProbeUnknownVersionBlocksTracked(t *testing.T) {
	registry := registry(t)
	home := t.TempDir()
	launcher := stubLauncher(t)
	probe := mustProbe(t, registry, installation(t, stubBinary(t, "9.9.9"), home, launcher))
	if probe.Status != "unknown_version" || len(probe.Capabilities) != 0 {
		t.Fatalf("unexpected probe %+v", probe)
	}
	_, err := registry.PlanLaunch(probe, launchInput(t.TempDir()), provider.Policy{AllowedCapabilities: claude.Capabilities()}, time.Now())
	requireCode(t, err, "provider_unsupported")
}

func TestProbeRejectsGarbageVersion(t *testing.T) {
	registry := registry(t)
	home := t.TempDir()
	_, err := registry.Probe(context.Background(), "claude", installation(t, stubBinary(t, "not-a-version"), home, stubLauncher(t)), time.Now())
	requireCode(t, err, "provider_probe_failed")
}

func TestProbeHealthyWithAndWithoutHooks(t *testing.T) {
	registry := registry(t)
	launcher := stubLauncher(t)
	workdir := t.TempDir()

	plain := t.TempDir()
	probe := mustProbe(t, registry, installation(t, stubBinary(t, "2.1.274"), plain, launcher))
	if probe.Status != "healthy" || probe.Version != "2.1.274" {
		t.Fatalf("unexpected probe %+v", probe)
	}
	if slices.Contains(probe.Capabilities, "hooks.session_start") {
		t.Fatal("hook capability granted without registered hooks")
	}
	if _, err := registry.PlanLaunch(probe, launchInput(workdir), provider.Policy{AllowedCapabilities: claude.Capabilities()}, time.Now()); err == nil {
		t.Fatal("tracked launch planned without SessionStart correlation")
	}

	hooked := t.TempDir()
	writeSettings(t, hooked, launcher)
	probe = mustProbe(t, registry, installation(t, stubBinary(t, "2.1.274"), hooked, launcher))
	for _, capability := range []string{"hooks.session_start", "context.session_start", "launch.interactive", "session.resume.interactive"} {
		if !slices.Contains(probe.Capabilities, capability) {
			t.Fatalf("missing capability %s in %v", capability, probe.Capabilities)
		}
	}
	if slices.Contains(probe.Capabilities, "mcp.stdio") {
		t.Fatal("MCP capability granted without a certified local server")
	}
	plan, err := registry.PlanLaunch(probe, launchInput(workdir), provider.Policy{AllowedCapabilities: claude.Capabilities()}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	invocation := plan.Invocation()
	for _, forbidden := range []string{"--dangerously-skip-permissions", "bypassPermissions", "-p", "--print", "--continue", "--fork-session", "--allow-dangerously-skip-permissions"} {
		if slices.Contains(invocation.Arguments, forbidden) {
			t.Fatalf("forbidden argument %s", forbidden)
		}
	}
	joined := strings.Join(invocation.Arguments, " ")
	if !strings.Contains(joined, "--model sonnet") || !strings.Contains(joined, "--permission-mode default") || !strings.Contains(joined, provider.InitialInstruction) {
		t.Fatalf("unexpected argv %v", invocation.Arguments)
	}
	if len(invocation.Environment) != 0 {
		t.Fatal("probe installation must not leak environment")
	}
	if invocation.Stdin != nil {
		t.Fatal("interactive launch must not carry stdin")
	}
}

func TestPlanLaunchVariants(t *testing.T) {
	registry := registry(t)
	launcher := stubLauncher(t)
	home := t.TempDir()
	writeSettings(t, home, launcher)
	probe := mustProbe(t, registry, installation(t, stubBinary(t, "2.1.274"), home, launcher))
	policy := provider.Policy{AllowedCapabilities: claude.Capabilities()}
	workdir := t.TempDir()

	input := launchInput(workdir)
	input.RequestedSessionID = testSessionID
	plan, err := registry.PlanLaunch(probe, input, policy, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(plan.Invocation().Arguments, "--session-id") || !slices.Contains(plan.Invocation().Arguments, testSessionID) {
		t.Fatalf("requested session missing in %v", plan.Invocation().Arguments)
	}

	input.RequestedSessionID = "not-a-uuid"
	_, err = registry.PlanLaunch(probe, input, policy, time.Now())
	requireCode(t, err, "provider_config_invalid")

	input = launchInput(workdir)
	input.Config.InitialTurnTransport = "waiting_user_submit"
	plan, err = registry.PlanLaunch(probe, input, policy, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if plan.InitialState != "waiting_user_submit" || slices.Contains(plan.Invocation().Arguments, provider.InitialInstruction) {
		t.Fatal("waiting submit must not auto-send the initial instruction")
	}

	for _, mutate := range []func(*provider.LaunchInput){
		func(input *provider.LaunchInput) { input.Config.Mode = "headless" },
		func(input *provider.LaunchInput) { input.Config.ApprovalPolicy = "never" },
		func(input *provider.LaunchInput) { input.Config.ApprovalPolicy = "always" },
		func(input *provider.LaunchInput) { input.Config.FilesystemPolicy = "read_only" },
		func(input *provider.LaunchInput) { input.Config.Model = "unlisted-model" },
	} {
		input := launchInput(workdir)
		mutate(&input)
		if _, err := registry.PlanLaunch(probe, input, policy, time.Now()); err == nil {
			t.Fatalf("uncertified config planned: %+v", input.Config)
		}
	}
}

func TestPlanResumeExactSession(t *testing.T) {
	registry := registry(t)
	launcher := stubLauncher(t)
	home := t.TempDir()
	writeSettings(t, home, launcher)
	probe := mustProbe(t, registry, installation(t, stubBinary(t, "2.1.274"), home, launcher))
	policy := provider.Policy{AllowedCapabilities: claude.Capabilities()}
	input := provider.ResumeInput{
		LaunchInput: launchInput(t.TempDir()),
		Session:     provider.SessionBinding{Provider: "claude", ObservedID: testSessionID, RunID: testRunID, ExecutionID: testExecutionID, Generation: 2},
	}
	plan, err := registry.PlanResume(probe, input, policy, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	argv := plan.Invocation().Arguments
	if !slices.Contains(argv, "--resume") || !slices.Contains(argv, testSessionID) {
		t.Fatalf("exact resume missing in %v", argv)
	}
	if slices.Contains(argv, provider.InitialInstruction) || slices.Contains(argv, "--continue") || slices.Contains(argv, "--fork-session") {
		t.Fatalf("resume must not start a new turn: %v", argv)
	}

	input.Session.ObservedID = "abc123"
	_, err = registry.PlanResume(probe, input, policy, time.Now())
	requireCode(t, err, "provider_session_invalid")

	input.Session.ObservedID = ""
	_, err = registry.PlanResume(probe, input, policy, time.Now())
	requireCode(t, err, "provider_session_invalid")
}

func TestRevalidateDetectsReplacement(t *testing.T) {
	registry := registry(t)
	launcher := stubLauncher(t)
	home := t.TempDir()
	writeSettings(t, home, launcher)
	binary := stubBinary(t, "2.1.274")
	probe := mustProbe(t, registry, installation(t, binary, home, launcher))
	plan, err := registry.PlanLaunch(probe, launchInput(t.TempDir()), provider.Policy{AllowedCapabilities: claude.Capabilities()}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("#!/bin/sh\necho \"2.1.274 (Claude Code)\"\n# replaced\n"), 0700); err != nil {
		t.Fatal(err)
	}
	requireCode(t, registry.Revalidate(context.Background(), plan, time.Now()), "provider_changed")
}

func TestRevalidateDetectsIntegrationDrift(t *testing.T) {
	registry := registry(t)
	launcher := stubLauncher(t)
	home := t.TempDir()
	writeSettings(t, home, launcher)
	binary := stubBinary(t, "2.1.274")
	before := installation(t, binary, home, launcher)
	probe := mustProbe(t, registry, before)
	if _, err := registry.PlanLaunch(probe, launchInput(t.TempDir()), provider.Policy{AllowedCapabilities: claude.Capabilities()}, time.Now()); err != nil {
		t.Fatal(err)
	}
	after := installation(t, binary, home, stubLauncher(t))
	if before.IntegrationHash == after.IntegrationHash {
		t.Fatal("launcher move kept the integration hash")
	}
}

func TestControlsAndUnsupportedTurn(t *testing.T) {
	adapter := claude.Adapter{}
	if adapter.Interrupt() != provider.Interrupt || adapter.Terminate() != provider.Terminate {
		t.Fatal("control mapping changed")
	}
	if _, err := adapter.Turn(provider.TurnInput{}); daemon.AsFailure(err).Diagnostic().Code != "provider_unsupported" {
		t.Fatalf("discussion turn must stay unsupported, got %v", err)
	}
	if event, err := adapter.NormalizeTurn([]byte(`{"kind":"message"}`)); err != nil || event != nil {
		t.Fatalf("no headless surface may normalize, got %v %v", event, err)
	}
}

func TestTightenEnvironment(t *testing.T) {
	got := claude.TightenEnvironment([]string{
		"HOME=/Users/synthetic", "PATH=/usr/bin:/bin", "TERM=xterm-256color",
		"BFB_RUN_ID=01J9Z8X1MNWT8YQ2R4S3V6K0P7", "BFB_CORRELATION_TOKEN=secret",
		"ANTHROPIC_API_KEY=secret", "CLAUDE_CODE_FOO=1", "BFB_CLAUDE_HOME=/tmp/x",
		"HOME=/Users/second", "MALFORMED",
	})
	want := []string{"HOME=/Users/synthetic", "PATH=/usr/bin:/bin", "TERM=xterm-256color"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestBindSession(t *testing.T) {
	raw := []byte(`{"session_id":"` + testSessionID + `","hook_event_name":"SessionStart","source":"startup"}`)
	candidate, err := claude.ParseHook(raw)
	if err != nil {
		t.Fatal(err)
	}
	if bound, err := claude.BindSession(testSessionID, candidate); err != nil || bound != testSessionID {
		t.Fatalf("matching bind failed: %v %s", err, bound)
	}
	if bound, err := claude.BindSession("", candidate); err != nil || bound != testSessionID {
		t.Fatalf("unrequested bind failed: %v %s", err, bound)
	}
	requireCode(t, mustBindErr("other-session", candidate), "provider_session_invalid")
	turn, err := claude.ParseHook([]byte(`{"session_id":"` + testSessionID + `","hook_event_name":"Stop"}`))
	if err != nil {
		t.Fatal(err)
	}
	requireCode(t, mustBindErr("", turn), "provider_event_invalid")
	requireCode(t, mustBindErr("", nil), "provider_event_invalid")
}

func mustBindErr(requested string, candidate *provider.Candidate) error {
	_, err := claude.BindSession(requested, candidate)
	return err
}
