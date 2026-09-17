// ABOUTME: Exposes previewed, approved Claude setup and doctor commands on the CLI.
// ABOUTME: Approval binds to exact proposal IDs; concurrent edits abort loudly.

package claude

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/qdis/bfb/internal/cli"
	"github.com/qdis/bfb/internal/provider"
)

// RegisterCommands adds the provider-local Claude commands. P01 mirrors this
// shape for Codex; the shared registry and root command stay untouched.
func RegisterCommands(registry *cli.Registry) {
	if err := registry.Register(cli.Command{Path: "provider setup claude", Method: "provider.setup", Summary: "Preview or apply the Claude integration", Run: runSetup}); err != nil {
		panic("duplicate provider setup command")
	}
	if err := registry.Register(cli.Command{Path: "provider doctor claude", Method: "provider.doctor", Summary: "Diagnose the Claude integration", Run: runDoctor}); err != nil {
		panic("duplicate provider doctor command")
	}
}

const maxLineLength = 400

func chunkLines(label string, data []byte) []string {
	text := strings.TrimSpace(string(data))
	if text == "" {
		return []string{label + ": <empty>"}
	}
	lines := []string{}
	for len(text) > 0 {
		size := len(text)
		if size > maxLineLength {
			size = maxLineLength
		}
		prefix := label + ": "
		if len(lines) > 0 {
			prefix = label + "+: "
		}
		lines = append(lines, prefix+text[:size])
		text = text[size:]
	}
	return lines
}

type setupFile struct {
	label  string
	path   string
	editor provider.ConfigEditor
}

func setupFiles(home, launcher string) []setupFile {
	return []setupFile{
		{label: "settings", path: SettingsPath(home), editor: SettingsEditor{Launcher: launcher}},
		{label: "mcp", path: MCPConfigPath(home), editor: MCPServerEditor{Launcher: launcher}},
	}
}

// setupDoctor verifies the published file still parses and carries the current
// BFB content. It never shells out: setup must stay hermetic and bounded.
func setupDoctor(file setupFile, launcher string) provider.Doctor {
	return func(context.Context) error {
		data, present, err := readBounded(file.path)
		if err != nil || !present {
			return provider.Failure("provider_setup_failed")
		}
		switch file.label {
		case "settings":
			if !settingsCurrent(data, launcher) {
				return provider.Failure("provider_setup_failed")
			}
		case "mcp":
			if !mcpCurrent(data, launcher) {
				return provider.Failure("provider_setup_failed")
			}
		default:
			return provider.Failure("provider_setup_failed")
		}
		return nil
	}
}

func settingsCurrent(data []byte, launcher string) bool {
	object, err := parseObject(data)
	if err != nil {
		return false
	}
	owned, err := ownedSettingsData(object)
	if err != nil {
		return false
	}
	for _, event := range HookEvents {
		handlers, _ := owned[event].([]any)
		if len(handlers) != 1 {
			return false
		}
		current, ok := handlers[0].(map[string]any)
		command, _ := current["command"].(string)
		if !ok || command != launcher || !isBFBHandler(current) {
			return false
		}
	}
	return true
}

func mcpCurrent(data []byte, launcher string) bool {
	object, err := parseObject(data)
	if err != nil {
		return false
	}
	servers, _ := object["mcpServers"].(map[string]any)
	return string(canonicalSingle(servers["bfb"])) == string(canonicalSingle(desiredServer(launcher)))
}

var approvalPattern = regexp.MustCompile(`^(sha256:[0-9a-f]{64}):(sha256:[0-9a-f]{64})$`)

func parseApprovals(args []string) ([]string, error) {
	approvals := []string{}
	for index := 0; index < len(args); index++ {
		if args[index] != "--proposal" {
			return nil, provider.Failure("invalid_request")
		}
		index++
		if index >= len(args) || !approvalPattern.MatchString(args[index]) {
			return nil, provider.Failure("invalid_request")
		}
		approvals = append(approvals, args[index])
	}
	return approvals, nil
}

func proposalKey(proposal provider.SetupProposal) string {
	return proposal.ID + ":" + proposal.ExpectedHash
}

// fileCurrent reports whether the file already carries the current BFB
// content. Unreadable or ambiguous files are never current.
func fileCurrent(file setupFile, launcher string) bool {
	data, present, err := readBounded(file.path)
	if err != nil || !present {
		return false
	}
	switch file.label {
	case "settings":
		return settingsCurrent(data, launcher)
	case "mcp":
		return mcpCurrent(data, launcher)
	default:
		return false
	}
}

func runSetup(ctx context.Context, invocation cli.Invocation) (map[string]any, error) {
	approvals, err := parseApprovals(invocation.Args)
	if err != nil {
		return nil, err
	}
	home, err := HomeDir()
	if err != nil {
		return nil, err
	}
	launcher, err := os.Executable()
	if err != nil {
		return nil, provider.Failure("provider_setup_failed")
	}
	// A fresh machine may not have the user-level directory yet. Only the
	// BFB-owned directory is created; existing permissions are never widened.
	if err := os.MkdirAll(filepath.Dir(SettingsPath(home)), 0700); err != nil {
		return nil, provider.Failure("provider_path_unsafe")
	}
	files := setupFiles(home, launcher)
	proposals := make([]provider.SetupProposal, 0, len(files))
	for _, file := range files {
		proposal, err := provider.ProposeSetup(file.path, file.editor)
		if err != nil {
			return nil, err
		}
		proposals = append(proposals, proposal)
	}
	lines := []string{"provider: claude", "scope: user-level claude config", "version: " + strings.Join(TestedVersions, ",")}
	if len(approvals) == 0 {
		pending := false
		for index, file := range files {
			if fileCurrent(file, launcher) {
				lines = append(lines, "target "+file.label+": current")
				continue
			}
			pending = true
			diff := proposals[index].Diff
			short := strings.TrimPrefix(proposals[index].ID, "sha256:")
			if len(short) > 12 {
				short = short[:12]
			}
			lines = append(lines, "target "+file.label+": update "+file.label+" ("+short+")")
			lines = append(lines, chunkLines("before "+file.label, diff.Before)...)
			lines = append(lines, chunkLines("after "+file.label, diff.After)...)
			lines = append(lines, "proposal "+file.label+": "+proposalKey(proposals[index]))
		}
		if !pending {
			lines = append(lines, "status: current (no unapproved diff)")
			return map[string]any{"log_entries": lines}, nil
		}
		lines = append(lines, "status: approval required (re-run with one --proposal ID:HASH per target)")
		return map[string]any{"log_entries": lines}, nil
	}
	if len(approvals) != len(files) {
		return nil, provider.Failure("provider_setup_denied")
	}
	matched := make([]bool, len(files))
	for _, approval := range approvals {
		found := false
		for index := range files {
			if !matched[index] && approval == proposalKey(proposals[index]) {
				matched[index] = true
				found = true
				break
			}
		}
		if !found {
			return nil, provider.Failure("provider_setup_conflict")
		}
	}
	for index, file := range files {
		if fileCurrent(file, launcher) {
			lines = append(lines, "target "+file.label+": already current")
			continue
		}
		approval := provider.SetupApproval{Approved: true, ProposalID: proposals[index].ID, ExpectedHash: proposals[index].ExpectedHash}
		if err := provider.ApplySetup(ctx, proposals[index], approval, setupDoctor(file, launcher)); err != nil {
			return nil, err
		}
		lines = append(lines, "applied "+file.label)
	}
	lines = append(lines, "status: applied (verify with provider doctor claude)")
	return map[string]any{"log_entries": lines}, nil
}

func runDoctor(_ context.Context, invocation cli.Invocation) (map[string]any, error) {
	if len(invocation.Args) != 0 {
		return nil, provider.Failure("invalid_request")
	}
	home, err := HomeDir()
	if err != nil {
		return nil, err
	}
	launcher, err := os.Executable()
	if err != nil {
		return nil, provider.Failure("provider_probe_failed")
	}
	report := Diagnose(home, launcher, "")
	lines := []string{"provider: claude", "version: " + report.Version}
	for _, check := range report.Checks {
		line := "check " + check.Name + ": " + string(check.Status) + " (" + check.Code + ")"
		if check.Detail != "" {
			line += " " + check.Detail
		}
		if len(line) > maxLineLength+32 {
			line = line[:maxLineLength+32]
		}
		lines = append(lines, line)
	}
	if report.Failed() {
		lines = append(lines, "status: failed")
		return map[string]any{"log_entries": lines}, doctorError(report)
	}
	lines = append(lines, "status: ok")
	return map[string]any{"log_entries": lines}, nil
}

func doctorError(report Report) error {
	for _, check := range report.Checks {
		if check.Status != CheckFailed {
			continue
		}
		switch check.Code {
		case "provider_unavailable":
			return provider.Failure("provider_unavailable")
		case "unknown_version":
			return provider.Failure("provider_unsupported")
		default:
			return provider.Failure("provider_setup_failed")
		}
	}
	return provider.Failure("provider_setup_failed")
}
