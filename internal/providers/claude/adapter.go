// ABOUTME: Owns the Claude Code reference adapter on the frozen L03 provider kit.
// ABOUTME: Certifies only the probed 2.1.274 and 2.1.275 behavior; everything else fails closed.

package claude

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/qdis/bfb/internal/provider"
)

// ManifestVersion identifies the packaged Claude capability manifest.
const ManifestVersion = "1.0.0"

// TestedVersions lists the exact Claude Code versions this adapter certifies.
// Capability evidence never transfers between versions; any other auto-updated
// binary probes as unknown_version until its fixtures pass.
var TestedVersions = []string{"2.1.274", "2.1.275"}

// HookEvents are the Claude hook events BFB subscribes. Unmapped documented
// events (Notification, PreCompact, permission dialogs) intentionally produce
// no candidate: vendor-native permission UI is separate from BFB attention,
// and Stop/tool failure never becomes result submission.
var HookEvents = []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"}

// Capabilities lists the runtime behaviors certified for the tested version.
// Headless launch, discussion turns, fork, read-only tool boundaries and MCP
// stdio remain uncertified: the local MCP (A01) and event ledger (E01) are
// pending, so any config requiring them fails closed at plan time.
func Capabilities() []string {
	return []string{"launch.interactive", "session.requested_id", "session.resume", "session.resume.interactive", "context.session_start", "prompt.initial_constant", "hooks.session_start", "approval.on_request", "filesystem.workspace_write", "control.interrupt", "control.terminate"}
}

// Models lists the documented model aliases accepted for the tested version.
func Models() []string { return []string{"fable", "haiku", "opus", "sonnet"} }

func Descriptor() provider.Descriptor {
	return provider.Descriptor{
		Name:             "claude",
		VersionArguments: []string{"--version"},
		ParseVersion:     provider.ParseVersion("", " (Claude Code)"),
		Manifest:         provider.Manifest{Provider: "claude", Version: ManifestVersion, TestedVersions: append([]string{}, TestedVersions...), Capabilities: Capabilities(), Models: Models()},
		Adapter:          Adapter{},
	}
}

// uuidPattern gates --session-id and --resume targets. Claude also accepts
// display names for --resume, but a name search could attach the wrong
// session, so the adapter requires the UUID shape observed on this version.
var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type Adapter struct{}

func baseArguments(config configView) ([]string, error) {
	if config.Mode != "interactive" {
		return nil, provider.Failure("provider_unsupported")
	}
	if config.ApprovalPolicy != "on_request" {
		return nil, provider.Failure("provider_unsupported")
	}
	if config.FilesystemPolicy != "workspace_write" {
		return nil, provider.Failure("provider_unsupported")
	}
	// Explicit manual permission mode: prompts stay interactive and neither
	// bypassPermissions nor the dangerous-skip flag may ever appear here.
	return []string{"--model", config.Model, "--effort", config.Effort, "--permission-mode", "default"}, nil
}

type configView struct {
	Mode, Model, Effort, ApprovalPolicy, FilesystemPolicy string
}

// Inspect grants binary-level capabilities unconditionally and hook
// capabilities only when a declared user-settings file already carries a BFB
// SessionStart handler. MCP stdio stays withheld until the local MCP server
// (A01) passes a bounded startup handshake; the manifest does not offer it.
func (Adapter) Inspect(_ context.Context, installation provider.Installation) (provider.RuntimeHealth, error) {
	health := provider.RuntimeHealth{Healthy: true, IntegrationHash: installation.IntegrationHash}
	observed := []string{"launch.interactive", "session.requested_id", "session.resume", "session.resume.interactive", "prompt.initial_constant", "approval.on_request", "filesystem.workspace_write", "control.interrupt", "control.terminate"}
	for _, source := range installation.ConfigFiles {
		if source.Name != "user_settings" {
			continue
		}
		data, present, err := readBounded(source.Path)
		if err != nil {
			return provider.RuntimeHealth{}, err
		}
		if !present {
			continue
		}
		// A declared but broken integration file is unhealthy, never a
		// capability grant; doctor names the exact cause.
		object, err := parseObject(data)
		if err != nil {
			health.Healthy = false
			health.Capabilities = []string{}
			return health, nil
		}
		hooks, _ := object["hooks"].(map[string]any)
		list, _ := hooks["SessionStart"].([]any)
		for _, item := range list {
			entry, _ := item.(map[string]any)
			handlers, _ := entry["hooks"].([]any)
			for _, handler := range handlers {
				if isBFBHandler(handler) {
					observed = append(observed, "hooks.session_start", "context.session_start")
				}
			}
		}
	}
	health.Capabilities = provider.Intersection(observed, Capabilities())
	return health, nil
}

func (Adapter) Launch(input provider.LaunchInput) (provider.Invocation, error) {
	config := input.Config
	args, err := baseArguments(configView{Mode: config.Mode, Model: config.Model, Effort: config.Effort, ApprovalPolicy: config.ApprovalPolicy, FilesystemPolicy: config.FilesystemPolicy})
	if err != nil {
		return provider.Invocation{}, err
	}
	if input.RequestedSessionID != "" {
		if !uuidPattern.MatchString(input.RequestedSessionID) {
			return provider.Invocation{}, provider.Failure("provider_config_invalid")
		}
		args = append(args, "--session-id", input.RequestedSessionID)
	}
	switch config.InitialTurnTransport {
	case "provider_prompt":
		args = append(args, provider.InitialInstruction)
	case "waiting_user_submit", "none":
	default:
		return provider.Invocation{}, provider.Failure("provider_config_invalid")
	}
	return provider.Invocation{Arguments: args}, nil
}

func (Adapter) Resume(input provider.ResumeInput) (provider.Invocation, error) {
	config := input.LaunchInput.Config
	args, err := baseArguments(configView{Mode: config.Mode, Model: config.Model, Effort: config.Effort, ApprovalPolicy: config.ApprovalPolicy, FilesystemPolicy: config.FilesystemPolicy})
	if err != nil {
		return provider.Invocation{}, err
	}
	if !uuidPattern.MatchString(input.Session.ObservedID) {
		return provider.Invocation{}, provider.Failure("provider_session_invalid")
	}
	// Exact observed session only: never --continue (most-recent), never a new
	// prompt argument, never --fork-session on this path.
	return provider.Invocation{Arguments: append(args, "--resume", input.Session.ObservedID)}, nil
}

// Turn stays unsupported: headless structured discussion turns have no
// certified transport on this version. Fail closed instead of inventing one.
func (Adapter) Turn(provider.TurnInput) (provider.Invocation, error) {
	return provider.Invocation{}, provider.Failure("provider_unsupported")
}

// NormalizeTurn has no headless event surface while Turn is unsupported.
func (Adapter) NormalizeTurn([]byte) (*provider.TurnEvent, error) { return nil, nil }

func (Adapter) NormalizeHook(raw []byte) (*provider.Candidate, error) { return ParseHook(raw) }

func (Adapter) Interrupt() provider.Control { return provider.Interrupt }
func (Adapter) Terminate() provider.Control { return provider.Terminate }

// HomeDir resolves the Claude home holding user-level settings. The override
// exists for tests and for previewed temporary-home transactions; the launched
// provider process never receives it.
func HomeDir() (string, error) {
	if override := os.Getenv("BFB_CLAUDE_HOME"); override != "" {
		if !filepath.IsAbs(override) {
			return "", provider.Failure("provider_path_unsafe")
		}
		return filepath.Clean(override), nil
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", provider.Failure("provider_path_unsafe")
	}
	return home, nil
}

// SettingsPath holds hooks and trust state; MCPConfigPath holds user-scope
// MCP servers. Both locations were observed against the tested version: hooks
// fire from settings.json while `mcp add --scope user` writes .claude.json.
func SettingsPath(home string) string  { return filepath.Join(home, ".claude", "settings.json") }
func MCPConfigPath(home string) string { return filepath.Join(home, ".claude.json") }

// HookCommand is the stable app-owned hook launcher invocation. Hooks use exec
// form (no shell) with the absolute bfb path plus fixed arguments; no task,
// checkout, or credential text ever enters a hook command.
func HookCommand(launcher string) (string, []string) {
	return launcher, []string{"hook", "ingest", "--provider", "claude"}
}

// TightenEnvironment passes only the enumerated interactive variables through
// to the provider process. Credentials, BFB correlation, Claude behavior
// overrides, and the test-home redirect never cross this boundary.
func TightenEnvironment(base []string) []string {
	allowed := map[string]bool{"HOME": true, "PATH": true, "TERM": true, "LANG": true, "LC_ALL": true, "LC_CTYPE": true, "TZ": true, "TMPDIR": true, "SHELL": true, "USER": true, "LOGNAME": true}
	result := []string{}
	seen := map[string]bool{}
	for _, entry := range base {
		name, _, ok := strings.Cut(entry, "=")
		if !ok || !allowed[name] || seen[name] {
			continue
		}
		seen[name] = true
		result = append(result, entry)
	}
	return result
}

// ResolveBinary finds the Claude executable without executing it.
func ResolveBinary() (string, error) {
	path, err := exec.LookPath("claude")
	if err != nil {
		return "", provider.Failure("provider_unavailable")
	}
	return path, nil
}

// Installation builds the L03 installation for setup, doctor, and tests: the
// resolved binary, the two user-level integration files, the content-derived
// integration hash, and the tightened environment.
func Installation(home, launcher string) (provider.Installation, error) {
	executable, err := ResolveBinary()
	if err != nil {
		return provider.Installation{}, err
	}
	hash, err := IntegrationHash(home, launcher)
	if err != nil {
		return provider.Installation{}, err
	}
	return provider.Installation{
		Executable:      executable,
		ConfigFiles:     []provider.ConfigSource{{Name: "user_settings", Path: SettingsPath(home)}, {Name: "user_mcp", Path: MCPConfigPath(home)}},
		IntegrationHash: hash,
		Environment:     TightenEnvironment(os.Environ()),
	}, nil
}

// ObserveVersion runs the bounded --version probe and parses the exact version.
func ObserveVersion(ctx context.Context, executable string, environment []string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	raw, err := provider.InspectCommand(ctx, provider.Installation{Executable: executable, Environment: environment}, "--version")
	if err != nil {
		return "", err
	}
	return Descriptor().ParseVersion(raw)
}

// BindSession checks a parsed SessionStart candidate against the requested
// session ID before L06 durably binds it. A competing observed ID never
// rebinds the execution; it fails with the kit's session error.
func BindSession(requested string, candidate *provider.Candidate) (string, error) {
	if candidate == nil || candidate.Kind != "session_started" || candidate.SessionID == "" {
		return "", provider.Failure("provider_event_invalid")
	}
	if requested != "" && requested != candidate.SessionID {
		return "", provider.Failure("provider_session_invalid")
	}
	return candidate.SessionID, nil
}
