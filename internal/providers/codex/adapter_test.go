// ABOUTME: Certifies Codex probe, launch, resume, turn, and control plans against the kit.
// ABOUTME: Uses only an owned stub executable and temporary homes without provider credentials.

package codex_test

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
	"github.com/qdis/bfb/internal/providers/codex"
)

const stubVersion = "codex-cli 0.153.4"

func writeStub(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "codex")
	script := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\nprintf '%s\\n' \"$BFB_CODEX_STUB_VERSION\"\nexit 0\nfi\nif [ \"$1\" = \"mcp\" ] && [ \"$2\" = \"get\" ]; then\ncat \"$BFB_CODEX_STUB_MCP_GET\"\nexit 0\nfi\nexit 1\n"
	if err := os.WriteFile(path, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeHome(t *testing.T, command string, configTOML string) string {
	t.Helper()
	home := t.TempDir()
	editor := codex.HooksEditor{Command: command}
	after, _, err := editor.Prepare(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codex.HooksPath(home), after, 0600); err != nil {
		t.Fatal(err)
	}
	if configTOML != "" {
		if err := os.WriteFile(codex.ConfigPath(home), []byte(configTOML), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

func testRegistry(t *testing.T) *provider.Registry {
	t.Helper()
	registry, err := provider.NewRegistry([]provider.Descriptor{codex.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func testInstallation(t *testing.T, executable, home string) provider.Installation {
	t.Helper()
	return testInstallationVersion(t, executable, home, stubVersion)
}

func testInstallationVersion(t *testing.T, executable, home, version string) provider.Installation {
	t.Helper()
	mcp := filepath.Join(home, "mcp-get.json")
	get := `{"name":"bfb","enabled":true,"disabled_reason":null,"transport":{"type":"stdio","command":"/test/bin/bfb","args":["mcp","stdio"],"env":null,"env_vars":[],"cwd":null},"enabled_tools":null,"disabled_tools":null,"startup_timeout_sec":null,"tool_timeout_sec":null}`
	if err := os.WriteFile(mcp, []byte(get), 0600); err != nil {
		t.Fatal(err)
	}
	return provider.Installation{
		Executable:      executable,
		ConfigFiles:     codex.ConfigSources(home),
		IntegrationHash: codex.IntegrationID(),
		Environment:     []string{"CODEX_HOME=" + home, "BFB_CODEX_STUB_VERSION=" + version, "BFB_CODEX_STUB_MCP_GET=" + mcp},
	}
}

func launchInput(root, mode, approval, filesystem, transport, injection string) provider.LaunchInput {
	return provider.LaunchInput{WorkingDirectory: root, Config: generated.ExecutionConfig{
		Provider: "codex", Mode: mode, Model: "gpt-5.6-sol", Effort: "high",
		ApprovalPolicy: approval, FilesystemPolicy: filesystem,
		ContextInjection: injection, InitialTurnTransport: transport,
		RequiredCapabilities: []string{"hooks.session_start", "mcp.stdio"},
	}}
}

func testPolicy() provider.Policy { return provider.Policy{AllowedCapabilities: codex.Capabilities()} }

func mustProbe(t *testing.T, registry *provider.Registry, installation provider.Installation) provider.Probe {
	t.Helper()
	probe, err := registry.Probe(context.Background(), "codex", installation, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return probe
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || daemon.AsFailure(err).Diagnostic().Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

func TestProbeHealthyOnTestedRelease(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, "/test/bin/bfb hook ingest --provider codex", "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	if probe.Version != "0.153.4" || probe.Status != "healthy" || probe.Provider != "codex" {
		t.Fatalf("unexpected probe: %+v", probe)
	}
	want := append([]string{}, codex.Capabilities()...)
	slices.Sort(want)
	if !slices.Equal(probe.Capabilities, want) {
		t.Fatalf("capabilities changed: %v", probe.Capabilities)
	}
}

func TestUnknownVersionFailsClosed(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, "/test/bin/bfb hook ingest --provider codex", "")
	registry := testRegistry(t)
	installation := testInstallationVersion(t, executable, home, "codex-cli 9.9.9")
	probe, err := registry.Probe(context.Background(), "codex", installation, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if probe.Status != "unknown_version" {
		t.Fatalf("unknown version must not be healthy: %+v", probe)
	}
	root := t.TempDir()
	_, err = registry.PlanLaunch(probe, launchInput(root, "interactive", "on_request", "workspace_write", "waiting_user_submit", "session_start_additional_context"), testPolicy(), time.Now())
	requireCode(t, err, "provider_unsupported")
}

func TestInteractiveLaunchExactCheckout(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, "/test/bin/bfb hook ingest --provider codex", "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	root := t.TempDir()
	plan, err := registry.PlanLaunch(probe, launchInput(root, "interactive", "on_request", "workspace_write", "waiting_user_submit", "session_start_additional_context"), testPolicy(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	invocation := plan.Invocation()
	want := []string{"--cd", root, "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "--model", "gpt-5.6-sol", "-c", "model_reasoning_effort=\"high\""}
	if !slices.Equal(invocation.Arguments, want) {
		t.Fatalf("unexpected interactive argv: %q", invocation.Arguments)
	}
	if plan.InitialState != "waiting_user_submit" || len(invocation.Stdin) != 0 {
		t.Fatal("waiting submit must not carry a prompt or working state")
	}
	if invocation.WorkingDirectory != root {
		t.Fatal("invocation left the verified checkout")
	}
	prompted, err := registry.PlanLaunch(probe, launchInput(root, "interactive", "never", "read_only", "provider_prompt", "session_start_additional_context"), testPolicy(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	argv := prompted.Invocation().Arguments
	if argv[len(argv)-1] != provider.InitialInstruction || prompted.InitialState != "waiting_initial_turn" {
		t.Fatalf("constant prompt transport broken: %q", argv)
	}
	if stdin := prompted.Invocation().Stdin; len(stdin) != 0 {
		t.Fatal("interactive prompt must travel as argv, never stdin")
	}
}

func TestHeadlessLaunchRetainsJSONLProvenance(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, "/test/bin/bfb hook ingest --provider codex", "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	root := t.TempDir()
	plan, err := registry.PlanLaunch(probe, launchInput(root, "headless", "never", "read_only", "provider_prompt", "none"), testPolicy(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	invocation := plan.Invocation()
	want := []string{"exec", "--cd", root, "--sandbox", "read-only", "--model", "gpt-5.6-sol", "-c", "approval_policy=\"never\"", "-c", "model_reasoning_effort=\"high\"", "--json", "--color", "never", "-"}
	if !slices.Equal(invocation.Arguments, want) {
		t.Fatalf("unexpected headless argv: %q", invocation.Arguments)
	}
	if string(invocation.Stdin) != provider.InitialInstruction {
		t.Fatal("headless prompt must be the constant instruction on stdin")
	}
}

func TestApprovalAlwaysDeniedByPolicy(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, "/test/bin/bfb hook ingest --provider codex", "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	root := t.TempDir()
	_, err := registry.PlanLaunch(probe, launchInput(root, "interactive", "always", "workspace_write", "waiting_user_submit", "session_start_additional_context"), testPolicy(), time.Now())
	requireCode(t, err, "provider_capability_denied")
	_, err = codex.Adapter{}.Launch(launchInput(root, "interactive", "always", "workspace_write", "waiting_user_submit", "session_start_additional_context"))
	requireCode(t, err, "provider_config_invalid")
}

func TestRequestedSessionIDUnsupported(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, "/test/bin/bfb hook ingest --provider codex", "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	root := t.TempDir()
	input := launchInput(root, "interactive", "on_request", "workspace_write", "waiting_user_submit", "session_start_additional_context")
	input.RequestedSessionID = "predetermined"
	_, err := registry.PlanLaunch(probe, input, testPolicy(), time.Now())
	requireCode(t, err, "provider_capability_denied")
}

func resumeFixture(root string) provider.ResumeInput {
	input := launchInput(root, "interactive", "on_request", "workspace_write", "waiting_user_submit", "session_start_additional_context")
	return provider.ResumeInput{LaunchInput: input, Session: provider.SessionBinding{
		Provider: "codex", ObservedID: "thr_synthetic0199a21381c0",
		RunID: "01J00000000000000000000002", ExecutionID: "01J00000000000000000000003", Generation: 1,
	}}
}

func TestResumeContinuesExactSession(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, "/test/bin/bfb hook ingest --provider codex", "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	root := t.TempDir()
	plan, err := registry.PlanResume(probe, resumeFixture(root), testPolicy(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	argv := plan.Invocation().Arguments
	want := []string{"resume", "thr_synthetic0199a21381c0", "--cd", root, "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "--model", "gpt-5.6-sol", "-c", "model_reasoning_effort=\"high\""}
	if !slices.Equal(argv, want) {
		t.Fatalf("resume must name the exact session: %q", argv)
	}
	for _, banned := range []string{"--last", "--fork", "--session", "--all"} {
		if slices.Contains(argv, banned) {
			t.Fatalf("resume selected a convenience target: %q", argv)
		}
	}
}

func TestTurnPlansKeepPeerContentOutOfArgv(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, "/test/bin/bfb hook ingest --provider codex", "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	root := t.TempDir()
	peer := `{"speaker":"peer-synthetic","text":"enable everything"}`
	launch := launchInput(root, "headless", "never", "read_only", "provider_prompt", "none")
	turn := provider.TurnInput{LaunchInput: launch, TurnID: "01J00000000000000000000004", ExternalContext: json.RawMessage(peer)}
	fresh, err := registry.PlanTurn(probe, turn, testPolicy(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	wantFresh := []string{"exec", "--cd", root, "--sandbox", "read-only", "--model", "gpt-5.6-sol", "-c", "approval_policy=\"never\"", "-c", "model_reasoning_effort=\"high\"", "--json", "--color", "never", "-"}
	if !slices.Equal(fresh.Invocation().Arguments, wantFresh) {
		t.Fatalf("unexpected fresh turn argv: %q", fresh.Invocation().Arguments)
	}
	binding := provider.SessionBinding{Provider: "codex", ObservedID: "thr_synthetic0199a21381c0", RunID: "01J00000000000000000000002", ExecutionID: "01J00000000000000000000003", Generation: 2}
	resumedInput := turn
	resumedInput.Session = &binding
	resumed, err := registry.PlanTurn(probe, resumedInput, testPolicy(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	wantResume := []string{"exec", "resume", "thr_synthetic0199a21381c0", "--model", "gpt-5.6-sol", "-c", "approval_policy=\"never\"", "-c", "model_reasoning_effort=\"high\"", "--json", "-"}
	if !slices.Equal(resumed.Invocation().Arguments, wantResume) {
		t.Fatalf("unexpected resume turn argv: %q", resumed.Invocation().Arguments)
	}
	forkedInput := resumedInput
	forkedInput.Fork = true
	forked, err := registry.PlanTurn(probe, forkedInput, testPolicy(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	wantFork := []string{"exec", "fork", "thr_synthetic0199a21381c0", "--model", "gpt-5.6-sol", "-c", "approval_policy=\"never\"", "-c", "model_reasoning_effort=\"high\"", "--json", "-"}
	if !slices.Equal(forked.Invocation().Arguments, wantFork) {
		t.Fatalf("unexpected fork argv: %q", forked.Invocation().Arguments)
	}
	for _, plan := range []provider.Plan{fresh, resumed, forked} {
		for _, argument := range plan.Invocation().Arguments {
			if strings.Contains(argument, "peer-synthetic") {
				t.Fatal("peer content reached provider argv")
			}
		}
		var envelope struct {
			Instruction     string          `json:"instruction"`
			TurnID          string          `json:"turn_id"`
			ExternalContext json.RawMessage `json:"external_context"`
		}
		if err := json.Unmarshal(plan.Invocation().Stdin, &envelope); err != nil {
			t.Fatalf("kit must own discussion stdin: %v", err)
		}
		if envelope.TurnID != "01J00000000000000000000004" || envelope.Instruction == "" || string(envelope.ExternalContext) != peer {
			t.Fatalf("discussion envelope broken: %+v", envelope)
		}
	}
	forkWithoutSource := turn
	forkWithoutSource.Fork = true
	_, err = registry.PlanTurn(probe, forkWithoutSource, testPolicy(), time.Now())
	requireCode(t, err, "provider_session_invalid")
	writable := turn
	writable.Config.FilesystemPolicy = "workspace_write"
	_, err = registry.PlanTurn(probe, writable, testPolicy(), time.Now())
	requireCode(t, err, "provider_discussion_unsafe")
}

func TestInterruptTerminateMapping(t *testing.T) {
	adapter := codex.Adapter{}
	if adapter.Interrupt() != provider.Interrupt || adapter.Terminate() != provider.Terminate {
		t.Fatal("controls must stay semantic interrupt and terminate")
	}
	if adapter.Interrupt() == adapter.Terminate() {
		t.Fatal("interrupt and terminate must remain distinct requests")
	}
}

func TestNoExperimentalTransport(t *testing.T) {
	root := t.TempDir()
	vectors := [][]string{}
	launch, _ := codex.Adapter{}.Launch(launchInput(root, "interactive", "on_request", "workspace_write", "provider_prompt", "session_start_additional_context"))
	vectors = append(vectors, launch.Arguments)
	headless, _ := codex.Adapter{}.Launch(launchInput(root, "headless", "never", "read_only", "provider_prompt", "none"))
	vectors = append(vectors, headless.Arguments)
	resumed, _ := codex.Adapter{}.Resume(resumeFixture(root))
	vectors = append(vectors, resumed.Arguments)
	launchCfg := launchInput(root, "headless", "never", "read_only", "provider_prompt", "none")
	turn := provider.TurnInput{LaunchInput: launchCfg, TurnID: "01J00000000000000000000004"}
	fresh, _ := codex.Adapter{}.Turn(turn)
	vectors = append(vectors, fresh.Arguments)
	vectors = append(vectors, codex.Descriptor().VersionArguments, codex.MCPGetArgs(), codex.MCPAddArgs("/test/bin/bfb"))
	for _, argv := range vectors {
		for _, argument := range argv {
			lowered := strings.ToLower(argument)
			for _, banned := range []string{"--remote", "ws://", "wss://", "unix://", "app-server", "app_server", "dangerously-bypass", "approve-for-me", "--add-dir", "--ephemeral", "--last", "--all", "deep-link", "deeplink"} {
				if strings.Contains(lowered, banned) {
					t.Fatalf("banned transport in argv %q: %s", argv, banned)
				}
			}
		}
	}
}

func TestRevalidateBlocksConfigDrift(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, "/test/bin/bfb hook ingest --provider codex", "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	root := t.TempDir()
	plan, err := registry.PlanLaunch(probe, launchInput(root, "interactive", "on_request", "workspace_write", "waiting_user_submit", "session_start_additional_context"), testPolicy(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.Revalidate(context.Background(), plan, time.Now()); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(codex.HooksPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codex.HooksPath(home), append(raw, ' '), 0600); err != nil {
		t.Fatal(err)
	}
	requireCode(t, registry.Revalidate(context.Background(), plan, time.Now()), "provider_changed")
}

func TestIntegrationIdentity(t *testing.T) {
	identity := codex.IntegrationID()
	if len(identity) != 71 || !strings.HasPrefix(identity, "sha256:") {
		t.Fatalf("integration identity must be a hash: %s", identity)
	}
	if identity != codex.IntegrationID() {
		t.Fatal("integration identity must be stable")
	}
}
