// ABOUTME: Certifies Grok probe, launch, resume, and control plans against the kit.
// ABOUTME: Uses only an owned stub executable and temporary homes without provider credentials.

package grok_test

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
	"github.com/qdis/bfb/internal/providers/grok"
)

const stubVersion = "grok 1.0.34 (deadbeefcafe) [stable]"
const testLauncher = "/test/bin/bfb"

func hookCommand() string { return grok.HookCommand(testLauncher) }

func writeStub(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "grok")
	script := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\nprintf '%s\\n' \"$BFB_GROK_STUB_VERSION\"\nexit 0\nfi\nif [ \"$1\" = \"mcp\" ] && [ \"$2\" = \"list\" ]; then\ncat \"$BFB_GROK_STUB_MCP_LIST\"\nexit 0\nfi\nexit 1\n"
	if err := os.WriteFile(path, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeHome(t *testing.T, command string, configTOML string) string {
	t.Helper()
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Dir(grok.HooksPath(home)), 0700); err != nil {
		t.Fatal(err)
	}
	editor := grok.HooksEditor{Command: command}
	after, _, err := editor.Prepare(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(grok.HooksPath(home), after, 0600); err != nil {
		t.Fatal(err)
	}
	if configTOML != "" {
		if err := os.WriteFile(grok.ConfigPath(home), []byte(configTOML), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

func testRegistry(t *testing.T) *provider.Registry {
	t.Helper()
	registry, err := provider.NewRegistry([]provider.Descriptor{grok.Descriptor()})
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
	list := filepath.Join(home, "mcp-list.json")
	get := `[{"command":"/test/bin/bfb","args":["mcp","stdio"],"enabled":true,"name":"bfb","scope":"user"}]`
	if err := os.WriteFile(list, []byte(get), 0600); err != nil {
		t.Fatal(err)
	}
	return provider.Installation{
		Executable:      executable,
		ConfigFiles:     grok.ConfigSources(home),
		IntegrationHash: grok.IntegrationID(),
		Environment:     []string{"GROK_HOME=" + home, "BFB_GROK_STUB_VERSION=" + version, "BFB_GROK_STUB_MCP_LIST=" + list},
	}
}

func launchInput(root, mode, approval, filesystem, transport, injection string) provider.LaunchInput {
	return provider.LaunchInput{WorkingDirectory: root, Config: generated.ExecutionConfig{
		Provider: "grok", Mode: mode, Model: "grok-4.6", Effort: "high",
		ApprovalPolicy: approval, FilesystemPolicy: filesystem,
		ContextInjection: injection, InitialTurnTransport: transport,
		RequiredCapabilities: []string{"hooks.session_start", "mcp.stdio"},
	}}
}

func testPolicy() provider.Policy { return provider.Policy{AllowedCapabilities: grok.Capabilities()} }

func mustProbe(t *testing.T, registry *provider.Registry, installation provider.Installation) provider.Probe {
	t.Helper()
	probe, err := registry.Probe(context.Background(), "grok", installation, time.Now())
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
	home := writeHome(t, hookCommand(), "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	if probe.Version != "1.0.34" || probe.Status != "healthy" || probe.Provider != "grok" {
		t.Fatalf("unexpected probe: %+v", probe)
	}
	want := append([]string{}, grok.Capabilities()...)
	slices.Sort(want)
	if !slices.Equal(probe.Capabilities, want) {
		t.Fatalf("capabilities changed: %v", probe.Capabilities)
	}
}

func TestVersionParserAcceptsChannelVariance(t *testing.T) {
	for raw, want := range map[string]string{
		"grok 1.0.34 (deadbeefcafe) [stable]\n": "1.0.34",
		"grok 1.0.34 (deadbeefcafe)\n":          "1.0.34",
		"grok 1.0.25 (f7e67d6988e2) [stable]\n": "1.0.25",
	} {
		version, err := grok.Descriptor().ParseVersion([]byte(raw))
		if err != nil || version != want {
			t.Fatalf("version parser %q: %s %v", raw, version, err)
		}
	}
	for _, raw := range []string{
		"grok 1.0.34 (deadbeefcafe) [stable]\nunexpected second version\n",
		"grok 1.0.34\n",
		"grok 1.0 (deadbeefcafe) [stable]",
		"grok 1.0.34 (DEADBEEFCAFE) [stable]",
		"grok 1.0.34 (short) [stable]",
		"codex-cli 0.153.4",
		"",
	} {
		if _, err := grok.Descriptor().ParseVersion([]byte(raw)); err == nil {
			t.Fatalf("ambiguous version must fail: %q", raw)
		}
	}
}

func TestUnknownVersionFailsClosed(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, hookCommand(), "")
	registry := testRegistry(t)
	installation := testInstallationVersion(t, executable, home, "grok 9.9.9 (deadbeefcafe) [stable]")
	probe, err := registry.Probe(context.Background(), "grok", installation, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if probe.Status != "unknown_version" {
		t.Fatalf("unknown version must not be healthy: %+v", probe)
	}
	root := t.TempDir()
	_, err = registry.PlanLaunch(probe, launchInput(root, "interactive", "on_request", "workspace_write", "waiting_user_submit", "none"), testPolicy(), time.Now())
	requireCode(t, err, "provider_unsupported")
}

func TestInteractiveLaunchExactCheckout(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, hookCommand(), "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	root := t.TempDir()
	plan, err := registry.PlanLaunch(probe, launchInput(root, "interactive", "on_request", "workspace_write", "waiting_user_submit", "none"), testPolicy(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	invocation := plan.Invocation()
	want := []string{"--cwd", root, "--sandbox", "workspace", "--model", "grok-4.6", "--reasoning-effort", "high"}
	if !slices.Equal(invocation.Arguments, want) {
		t.Fatalf("unexpected interactive argv: %q", invocation.Arguments)
	}
	if plan.InitialState != "waiting_user_submit" || len(invocation.Stdin) != 0 {
		t.Fatal("waiting submit must not carry a prompt or working state")
	}
	if invocation.WorkingDirectory != root {
		t.Fatal("invocation left the verified checkout")
	}
	readonly, err := registry.PlanLaunch(probe, launchInput(root, "interactive", "on_request", "read_only", "waiting_user_submit", "none"), testPolicy(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(readonly.Invocation().Arguments, "read-only") {
		t.Fatalf("read-only policy must select the read-only sandbox: %q", readonly.Invocation().Arguments)
	}
	approved, err := registry.PlanLaunch(probe, launchInput(root, "interactive", "never", "workspace_write", "waiting_user_submit", "none"), testPolicy(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(approved.Invocation().Arguments, "--always-approve") {
		t.Fatalf("never-approval must auto-approve explicitly: %q", approved.Invocation().Arguments)
	}
}

func TestInitialPromptTransportDenied(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, hookCommand(), "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	root := t.TempDir()
	_, err := registry.PlanLaunch(probe, launchInput(root, "interactive", "on_request", "workspace_write", "provider_prompt", "none"), testPolicy(), time.Now())
	requireCode(t, err, "provider_capability_denied")
	_, err = grok.Adapter{}.Launch(launchInput(root, "interactive", "on_request", "workspace_write", "provider_prompt", "none"))
	requireCode(t, err, "provider_config_invalid")
	_, err = grok.Adapter{}.Launch(launchInput(root, "interactive", "on_request", "workspace_write", "none", "none"))
	requireCode(t, err, "provider_config_invalid")
}

func TestHeadlessFailsClosed(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, hookCommand(), "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	root := t.TempDir()
	_, err := registry.PlanLaunch(probe, launchInput(root, "headless", "never", "read_only", "provider_prompt", "none"), testPolicy(), time.Now())
	requireCode(t, err, "provider_capability_denied")
	_, err = grok.Adapter{}.Launch(launchInput(root, "headless", "never", "read_only", "provider_prompt", "none"))
	requireCode(t, err, "provider_unsupported")
}

func TestApprovalAlwaysDenied(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, hookCommand(), "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	root := t.TempDir()
	_, err := registry.PlanLaunch(probe, launchInput(root, "interactive", "always", "workspace_write", "waiting_user_submit", "none"), testPolicy(), time.Now())
	requireCode(t, err, "provider_capability_denied")
	_, err = grok.Adapter{}.Launch(launchInput(root, "interactive", "always", "workspace_write", "waiting_user_submit", "none"))
	requireCode(t, err, "provider_config_invalid")
}

func TestRequestedSessionIDRequiresUUID(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, hookCommand(), "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	root := t.TempDir()
	uuid := "123e4567-e89b-12d3-a456-426614174000"
	input := launchInput(root, "interactive", "on_request", "workspace_write", "waiting_user_submit", "none")
	input.RequestedSessionID = uuid
	plan, err := registry.PlanLaunch(probe, input, testPolicy(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	argv := plan.Invocation().Arguments
	index := slices.Index(argv, "--session-id")
	if index < 0 || argv[index+1] != uuid {
		t.Fatalf("requested UUID must bind --session-id: %q", argv)
	}
	for _, bad := range []string{"predetermined", "My Session", "--resume", "123e4567-e89b-12d3-a456-42661417400"} {
		rejected := launchInput(root, "interactive", "on_request", "workspace_write", "waiting_user_submit", "none")
		rejected.RequestedSessionID = bad
		_, err := registry.PlanLaunch(probe, rejected, testPolicy(), time.Now())
		if err == nil {
			t.Fatalf("non-UUID requested session must fail: %q", bad)
		}
	}
}

func resumeFixture(root string) provider.ResumeInput {
	input := launchInput(root, "interactive", "on_request", "workspace_write", "waiting_user_submit", "none")
	return provider.ResumeInput{LaunchInput: input, Session: provider.SessionBinding{
		Provider: "grok", ObservedID: "123e4567-e89b-12d3-a456-426614174000",
		RunID: "01J00000000000000000000002", ExecutionID: "01J00000000000000000000003", Generation: 1,
	}}
}

func TestResumeContinuesExactSession(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, hookCommand(), "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	root := t.TempDir()
	plan, err := registry.PlanResume(probe, resumeFixture(root), testPolicy(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	argv := plan.Invocation().Arguments
	want := []string{"--cwd", root, "--sandbox", "workspace", "--model", "grok-4.6", "--reasoning-effort", "high", "--resume", "123e4567-e89b-12d3-a456-426614174000"}
	if !slices.Equal(argv, want) {
		t.Fatalf("resume must name the exact session: %q", argv)
	}
	for _, banned := range []string{"--continue", "--fork-session", "--session-id"} {
		if slices.Contains(argv, banned) {
			t.Fatalf("resume selected a convenience target: %q", argv)
		}
	}
	titled := resumeFixture(root)
	titled.Session.ObservedID = "My Session"
	_, err = registry.PlanResume(probe, titled, testPolicy(), time.Now())
	requireCode(t, err, "provider_session_invalid")
	shaped := resumeFixture(root)
	shaped.Session.ObservedID = "synthetic-session"
	_, err = registry.PlanResume(probe, shaped, testPolicy(), time.Now())
	requireCode(t, err, "provider_session_invalid")
}

func TestTurnUnsupportedKeepsUsageUnavailable(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, hookCommand(), "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	root := t.TempDir()
	launch := launchInput(root, "headless", "never", "read_only", "provider_prompt", "none")
	turn := provider.TurnInput{LaunchInput: launch, TurnID: "01J00000000000000000000004"}
	_, err := registry.PlanTurn(probe, turn, testPolicy(), time.Now())
	requireCode(t, err, "provider_capability_denied")
	_, err = grok.Adapter{}.Turn(turn)
	requireCode(t, err, "provider_unsupported")
	event, err := grok.Adapter{}.NormalizeTurn([]byte(`{"type":"turn.completed"}`))
	if err != nil || event != nil {
		t.Fatal("no headless surface may normalize a turn")
	}
}

func TestInterruptTerminateMapping(t *testing.T) {
	adapter := grok.Adapter{}
	if adapter.Interrupt() != provider.Interrupt || adapter.Terminate() != provider.Terminate {
		t.Fatal("controls must stay semantic interrupt and terminate")
	}
	if adapter.Interrupt() == adapter.Terminate() {
		t.Fatal("interrupt and terminate must remain distinct requests")
	}
}

func TestNoForbiddenTransport(t *testing.T) {
	root := t.TempDir()
	vectors := [][]string{}
	launch, _ := grok.Adapter{}.Launch(launchInput(root, "interactive", "never", "read_only", "waiting_user_submit", "none"))
	vectors = append(vectors, launch.Arguments)
	requested := launchInput(root, "interactive", "on_request", "workspace_write", "waiting_user_submit", "none")
	requested.RequestedSessionID = "123e4567-e89b-12d3-a456-426614174000"
	withID, _ := grok.Adapter{}.Launch(requested)
	vectors = append(vectors, withID.Arguments)
	resumed, _ := grok.Adapter{}.Resume(resumeFixture(root))
	vectors = append(vectors, resumed.Arguments)
	vectors = append(vectors, grok.Descriptor().VersionArguments, grok.MCPListArgs(), grok.MCPAddArgs("/test/bin/bfb"))
	for _, argv := range vectors {
		for _, argument := range argv {
			lowered := strings.ToLower(argument)
			for _, banned := range []string{"bypasspermissions", "dangerously-skip-permissions", "--trust", "--continue", "--fork-session", "--worktree", "--yolo", "wss://", "ws://"} {
				if strings.Contains(lowered, banned) {
					t.Fatalf("banned transport in argv %q: %s", argv, banned)
				}
			}
		}
		if slices.Contains(argv, "--allow") || slices.Contains(argv, "--deny") || slices.Contains(argv, "--agent") {
			t.Fatalf("unreviewed permission surface in argv %q", argv)
		}
	}
}

func TestRevalidateBlocksConfigDrift(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, hookCommand(), "")
	registry := testRegistry(t)
	probe := mustProbe(t, registry, testInstallation(t, executable, home))
	root := t.TempDir()
	plan, err := registry.PlanLaunch(probe, launchInput(root, "interactive", "on_request", "workspace_write", "waiting_user_submit", "none"), testPolicy(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.Revalidate(context.Background(), plan, time.Now()); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(grok.HooksPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(grok.HooksPath(home), append(raw, ' '), 0600); err != nil {
		t.Fatal(err)
	}
	requireCode(t, registry.Revalidate(context.Background(), plan, time.Now()), "provider_changed")
}

func TestIntegrationIdentity(t *testing.T) {
	identity := grok.IntegrationID()
	if len(identity) != 71 || !strings.HasPrefix(identity, "sha256:") {
		t.Fatalf("integration identity must be a hash: %s", identity)
	}
	if identity != grok.IntegrationID() {
		t.Fatal("integration identity must be stable")
	}
}
