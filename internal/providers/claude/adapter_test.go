// ABOUTME: Certifies Claude probe policy, launch/resume plans, and control mapping.
// ABOUTME: Uses only owned stub executables; never invokes the real Claude CLI.

package claude_test

import (
	"context"
	"encoding/json"
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
		Environment:     []string{"HOME=" + home},
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
	mcp, _, err := (claude.MCPServerEditor{Launcher: launcher}).Prepare(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), mcp, 0600); err != nil {
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
		if descriptor.Manifest.Version != "1.0.0" || !slices.Equal(descriptor.Manifest.TestedVersions, []string{"2.1.274", "2.1.275"}) {
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
	if !strings.Contains(joined, "--setting-sources user") {
		t.Fatal("tracked launch loads repository/local setting overrides")
	}
	if !slices.Equal(invocation.Environment, []string{"HOME=" + hooked}) {
		t.Fatal("probe installation must preserve its config home without other environment")
	}
	if invocation.Stdin != nil {
		t.Fatal("interactive launch must not carry stdin")
	}

	want := slices.Clone(probe.Capabilities)
	for _, version := range []string{"2.1.274", "2.1.275"} {
		home := t.TempDir()
		writeSettings(t, home, launcher)
		versioned := mustProbe(t, registry, installation(t, stubBinary(t, version), home, launcher))
		if versioned.Status != "healthy" || versioned.Version != version {
			t.Fatalf("version %s: unexpected probe %+v", version, versioned)
		}
		if !slices.Equal(versioned.Capabilities, want) {
			t.Fatalf("version %s: capabilities diverged: %v", version, versioned.Capabilities)
		}
		if _, err := registry.PlanLaunch(versioned, launchInput(workdir), provider.Policy{AllowedCapabilities: claude.Capabilities()}, time.Now()); err != nil {
			t.Fatalf("version %s: tracked launch refused: %v", version, err)
		}
	}
}

func TestProbeWithholdsHookCapabilitiesForIncorrectOwnedIntegration(t *testing.T) {
	for _, fault := range []string{"disabled", "duplicate", "hook_launcher", "mcp_launcher", "mcp_env", "missing_mcp", "conditional", "async", "local_mcp", "local_disabled", "wrong_pinned_launcher", "mismatched_sources", "wrong_home", "missing_home", "duplicate_home", "config_override"} {
		t.Run(fault, func(t *testing.T) {
			home, launcher := t.TempDir(), stubLauncher(t)
			writeSettings(t, home, launcher)
			settingsPath, mcpPath := claude.SettingsPath(home), claude.MCPConfigPath(home)
			settings, _ := os.ReadFile(settingsPath)
			mcp, _ := os.ReadFile(mcpPath)
			var settingObject, mcpObject map[string]any
			if err := json.Unmarshal(settings, &settingObject); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(mcp, &mcpObject); err != nil {
				t.Fatal(err)
			}
			hooks := settingObject["hooks"].(map[string]any)
			entries := hooks["SessionStart"].([]any)
			entry := entries[0].(map[string]any)
			handler := entry["hooks"].([]any)[0].(map[string]any)
			server := mcpObject["mcpServers"].(map[string]any)["bfb"].(map[string]any)
			switch fault {
			case "disabled":
				settingObject["disableAllHooks"] = true
			case "duplicate":
				hooks["SessionStart"] = append(entries, entry)
			case "hook_launcher":
				handler["command"] = stubLauncher(t)
			case "mcp_launcher":
				server["command"] = stubLauncher(t)
			case "mcp_env":
				server["env"] = map[string]any{"BFB_RUN_ID": "synthetic-untrusted-override"}
			case "conditional":
				entry["matcher"] = "never-matches-startup"
			case "async":
				handler["async"] = true
			case "local_mcp":
				mcpObject["projects"] = map[string]any{"synthetic-project": map[string]any{"mcpServers": map[string]any{"bfb": map[string]any{"type": "stdio", "command": stubLauncher(t)}}}}
			case "local_disabled":
				mcpObject["projects"] = map[string]any{"synthetic-project": map[string]any{"disabledMcpServers": []any{"bfb"}}}
			}
			settings, _ = json.Marshal(settingObject)
			mcp, _ = json.Marshal(mcpObject)
			if err := os.WriteFile(settingsPath, settings, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(mcpPath, mcp, 0600); err != nil {
				t.Fatal(err)
			}
			if fault == "missing_mcp" {
				if err := os.Remove(mcpPath); err != nil {
					t.Fatal(err)
				}
			}
			pinnedLauncher := launcher
			if fault == "wrong_pinned_launcher" {
				pinnedLauncher = stubLauncher(t)
			}
			local := installation(t, stubBinary(t, "2.1.275"), home, pinnedLauncher)
			if fault == "mismatched_sources" {
				local.ConfigFiles[1].Path = filepath.Join(t.TempDir(), ".claude.json")
			}
			switch fault {
			case "wrong_home":
				local.Environment = []string{"HOME=" + t.TempDir()}
			case "missing_home":
				local.Environment = nil
			case "duplicate_home":
				local.Environment = append(local.Environment, "HOME="+home)
			case "config_override":
				local.Environment = append(local.Environment, "CLAUDE_CONFIG_DIR="+t.TempDir())
			}
			if fault == "duplicate_home" {
				_, err := registry(t).Probe(context.Background(), "claude", local, time.Now())
				requireCode(t, err, "provider_config_invalid")
				return
			}
			probe := mustProbe(t, registry(t), local)
			for _, capability := range []string{"hooks.session_start", "context.session_start", "mcp.stdio"} {
				if slices.Contains(probe.Capabilities, capability) {
					t.Fatalf("incorrect integration granted %s", capability)
				}
			}
		})
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
	if !strings.Contains(strings.Join(argv, " "), "--setting-sources user") {
		t.Fatal("resume loads repository/local setting overrides")
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

func TestProductionAdapterNeverPromotesAutonomousPermissions(t *testing.T) {
	for _, version := range claude.TestedVersions {
		registry := registry(t)
		home, launcher := t.TempDir(), stubLauncher(t)
		writeSettings(t, home, launcher)
		probe := mustProbe(t, registry, installation(t, stubBinary(t, version), home, launcher))
		input := launchInput(t.TempDir())
		input.Config.ApprovalPolicy, input.Config.FilesystemPolicy = "never", "full_access"
		policy := provider.Policy{AllowedCapabilities: append(claude.Capabilities(), "approval.never", "filesystem.full_access")}
		_, err := registry.PlanLaunch(probe, input, policy, time.Now())
		requireCode(t, err, "provider_capability_denied")
		if _, err := (claude.Adapter{}).Launch(input); err == nil {
			t.Fatal("default adapter opted into bypass", version)
		}
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
