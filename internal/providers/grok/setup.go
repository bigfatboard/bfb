// ABOUTME: Owns Grok user-level hooks and MCP registration through approved setup transactions.
// ABOUTME: Preserves unrelated configuration and fails closed on drift, conflict, or failed doctor.

package grok

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/qdis/bfb/internal/provider"
)

// IngestSubcommand is the stable BFB hook pipeline fragment. Health checks
// match this fragment so launcher path moves do not read as drift; the setup
// editor matches the exact configured command.
const IngestSubcommand = "hook ingest --provider grok"

// ManagedHookEvents lists the hook events BFB subscribes. SessionStart binds
// the documented session ID; end, prompt, tool, and stop hooks report
// lifecycle telemetry. Vendor permission dialogs and compaction stay
// uninstalled: they have no bounded candidate.
func ManagedHookEvents() []string {
	return []string{"SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure"}
}

// hookTimeout bounds a BFB hook run in seconds. The ingest hook returns in
// milliseconds; the bound leaves headroom for a loaded spawn.
const hookTimeout = 10

// HookCommand builds the hook command from the stable app-owned launcher
// path. No task text, session, or path ever enters this string.
func HookCommand(launcher string) string { return launcher + " " + IngestSubcommand }

// HooksPath locates the BFB-owned user-level hooks file. Grok loads every
// JSON file under the hooks directory, so BFB owns bfb.json outright and
// never merges into foreign hook files.
func HooksPath(home string) string { return filepath.Join(home, "hooks", "bfb.json") }

// ConfigPath locates the user-level config holding MCP server registrations.
func ConfigPath(home string) string { return filepath.Join(home, "config.toml") }

// ConfigSources enumerates the Grok configuration affecting adapter behavior
// for probe fingerprinting. Absent files fingerprint as missing so later
// creation invalidates the launch plan.
func ConfigSources(home string) []provider.ConfigSource {
	return []provider.ConfigSource{{Name: "hooks", Path: HooksPath(home)}, {Name: "config", Path: ConfigPath(home)}}
}

type hookEntry struct {
	Type    string `json:"type"`
	Command string `json:"command"`
	Timeout int    `json:"timeout,omitempty"`
}

type hookGroup struct {
	Hooks []hookEntry `json:"hooks"`
}

func bfbGroup(command string) hookGroup {
	return hookGroup{Hooks: []hookEntry{{Type: "command", Command: command, Timeout: hookTimeout}}}
}

// desiredHooks renders the complete BFB-owned hooks file. Encoding is
// canonical (sorted keys, fixed indent), so re-proposals are byte-identical.
func desiredHooks(command string) ([]byte, error) {
	table := map[string][]hookGroup{}
	for _, event := range ManagedHookEvents() {
		table[event] = []hookGroup{bfbGroup(command)}
	}
	after, err := json.MarshalIndent(map[string]any{"hooks": table}, "", "  ")
	if err != nil {
		return nil, provider.Failure("provider_setup_denied")
	}
	return append(after, '\n'), nil
}

// ownedFile verifies every hook entry in the file is exactly the BFB-owned
// one. Foreign entries in BFB's own file are drift, never adopted content.
func ownedFile(raw []byte, command string) error {
	var document struct {
		Hooks map[string][]hookGroup `json:"hooks"`
	}
	if provider.DecodeJSON(raw, &document) != nil || document.Hooks == nil {
		return provider.Failure("provider_setup_denied")
	}
	if len(document.Hooks) != len(ManagedHookEvents()) {
		return provider.Failure("provider_setup_conflict")
	}
	for _, event := range ManagedHookEvents() {
		groups, ok := document.Hooks[event]
		if !ok || len(groups) != 1 || len(groups[0].Hooks) != 1 {
			return provider.Failure("provider_setup_conflict")
		}
		entry := groups[0].Hooks[0]
		if entry.Type != "command" || entry.Command != command || entry.Timeout != hookTimeout {
			return provider.Failure("provider_setup_conflict")
		}
	}
	return nil
}

// HooksEditor installs the BFB-owned hooks file. It owns bfb.json outright:
// foreign hook files in the same directory stay untouched, while foreign
// content inside bfb.json is a conflict, never merged or overwritten.
type HooksEditor struct{ Command string }

func (editor HooksEditor) valid() bool {
	return editor.Command != "" && len(editor.Command) <= 4096 && !strings.ContainsAny(editor.Command, "\x00\r\n")
}

// Prepare renders the hooks file with BFB groups present exactly once.
func (editor HooksEditor) Prepare(before []byte) ([]byte, provider.OwnedDiff, error) {
	if !editor.valid() {
		return nil, provider.OwnedDiff{}, provider.Failure("provider_setup_denied")
	}
	after, err := desiredHooks(editor.Command)
	if err != nil {
		return nil, provider.OwnedDiff{}, err
	}
	quote := func(raw []byte) json.RawMessage {
		if len(raw) == 0 {
			return json.RawMessage("null")
		}
		encoded, _ := json.Marshal(string(raw))
		return encoded
	}
	if len(before) == 0 {
		return after, provider.OwnedDiff{Namespace: "grok.hooks", Before: json.RawMessage("null"), After: quote(after)}, nil
	}
	if err := ownedFile(before, editor.Command); err != nil {
		return nil, provider.OwnedDiff{}, err
	}
	return after, provider.OwnedDiff{Namespace: "grok.hooks", Before: quote(before), After: quote(after)}, nil
}

// UnownedSemantics returns a constant: BFB owns this file outright, so there
// are no unowned semantics to preserve. Foreign or malformed content fails
// instead of being blessed for replacement.
func (editor HooksEditor) UnownedSemantics(raw []byte) ([]byte, error) {
	if !editor.valid() {
		return nil, provider.Failure("provider_setup_denied")
	}
	if len(raw) == 0 {
		return []byte("{}\n"), nil
	}
	if err := ownedFile(raw, editor.Command); err != nil {
		return nil, err
	}
	return []byte("{}\n"), nil
}

// hasSessionStartBinding reports whether the hooks file carries a BFB session
// binder. It matches the stable ingest fragment rather than an exact launcher
// path so signed path moves read as healthy instead of drift.
func hasSessionStartBinding(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) > 2*1024*1024 {
		return false
	}
	var document struct {
		Hooks map[string][]hookGroup `json:"hooks"`
	}
	if provider.DecodeJSON(raw, &document) != nil {
		return false
	}
	for _, group := range document.Hooks["SessionStart"] {
		for _, entry := range group.Hooks {
			if entry.Type == "command" && strings.Contains(entry.Command, IngestSubcommand) {
				return true
			}
		}
	}
	return false
}

// CheckHooks verifies the BFB session binder is installed with the exact
// configured command.
func CheckHooks(home, command string) error {
	raw, err := os.ReadFile(HooksPath(home))
	if err != nil || len(raw) > 2*1024*1024 {
		return provider.Failure("provider_config_invalid")
	}
	var document struct {
		Hooks map[string][]hookGroup `json:"hooks"`
	}
	if provider.DecodeJSON(raw, &document) != nil {
		return provider.Failure("provider_config_invalid")
	}
	for _, group := range document.Hooks["SessionStart"] {
		for _, entry := range group.Hooks {
			if entry.Type == "command" && entry.Command == command {
				return nil
			}
		}
	}
	return provider.Failure("provider_config_invalid")
}

// mcpBlockMarker labels the BFB-owned config.toml section. The block is
// always complete between the marker and its last line; anything after it
// belongs to someone else.
func mcpBlockMarker() string {
	return "# BFB-owned mcp_servers.bfb (managed by `bfb provider setup grok`; do not edit)"
}

func tomlString(value string) (string, error) {
	if value == "" || len(value) > 4096 || strings.ContainsAny(value, "\x00\r\n") {
		return "", provider.Failure("provider_setup_denied")
	}
	for _, rune := range value {
		if rune < 0x20 || rune == 0x7f {
			return "", provider.Failure("provider_setup_denied")
		}
	}
	return "\"" + strings.ReplaceAll(strings.ReplaceAll(value, "\\", "\\\\"), "\"", "\\\"") + "\"", nil
}

var mcpTableHeader = regexp.MustCompile(`^\s*\[mcp_servers\.bfb\s*\]`)

// MCPServerEditor appends one BFB-owned MCP server block to the user-level
// config.toml. Append-only publication keeps every unrelated byte identical;
// an existing bfb table or a drifted BFB block fails with a conflict instead
// of being adopted or overwritten. The block matches the shape the real
// `grok mcp add` writes, verified by `grok mcp list --json`.
type MCPServerEditor struct {
	Command string
	Args    []string
}

func (editor MCPServerEditor) block() ([]string, error) {
	if !filepath.IsAbs(editor.Command) {
		return nil, provider.Failure("provider_setup_denied")
	}
	command, err := tomlString(editor.Command)
	if err != nil {
		return nil, err
	}
	if len(editor.Args) == 0 || len(editor.Args) > 16 {
		return nil, provider.Failure("provider_setup_denied")
	}
	encoded := []string{}
	for _, argument := range editor.Args {
		value, err := tomlString(argument)
		if err != nil {
			return nil, err
		}
		encoded = append(encoded, value)
	}
	return []string{mcpBlockMarker(), "[mcp_servers.bfb]", "command = " + command, "args = [" + strings.Join(encoded, ", ") + "]", "enabled = true"}, nil
}

func stripComment(line string) string {
	if index := strings.IndexByte(line, '#'); index >= 0 {
		return line[:index]
	}
	return line
}

// Prepare renders the config with the BFB server block present exactly once.
func (editor MCPServerEditor) Prepare(before []byte) ([]byte, provider.OwnedDiff, error) {
	block, err := editor.block()
	if err != nil {
		return nil, provider.OwnedDiff{}, err
	}
	if len(before) > 2*1024*1024 {
		return nil, provider.OwnedDiff{}, provider.Failure("provider_setup_denied")
	}
	lines := strings.Split(string(before), "\n")
	marker := -1
	for index, line := range lines {
		if line == mcpBlockMarker() {
			if marker >= 0 {
				return nil, provider.OwnedDiff{}, provider.Failure("provider_setup_conflict")
			}
			marker = index
		}
	}
	quote := func(lines []string) json.RawMessage {
		raw, _ := json.Marshal(strings.Join(lines, "\n"))
		return raw
	}
	if marker >= 0 {
		owned := lines[marker : marker+len(block)]
		if len(lines) < marker+len(block) || !slices.Equal(owned, block) {
			return nil, provider.OwnedDiff{}, provider.Failure("provider_setup_conflict")
		}
		return before, provider.OwnedDiff{Namespace: "mcp_servers.bfb", Before: quote(block), After: quote(block)}, nil
	}
	for _, line := range lines {
		if mcpTableHeader.MatchString(stripComment(line)) {
			return nil, provider.OwnedDiff{}, provider.Failure("provider_setup_conflict")
		}
	}
	trimmed := strings.TrimRight(string(before), "\n")
	after := strings.Join(block, "\n") + "\n"
	if trimmed != "" {
		after = trimmed + "\n\n" + after
	}
	return []byte(after), provider.OwnedDiff{Namespace: "mcp_servers.bfb", Before: json.RawMessage("null"), After: quote(block)}, nil
}

// UnownedSemantics returns the config without the BFB-owned block. A marker
// with unexpected content is drift, not semantics, and fails the comparison.
func (editor MCPServerEditor) UnownedSemantics(raw []byte) ([]byte, error) {
	block, err := editor.block()
	if err != nil {
		return nil, err
	}
	if len(raw) > 2*1024*1024 {
		return nil, provider.Failure("provider_setup_denied")
	}
	lines := strings.Split(string(raw), "\n")
	kept := []string{}
	consumed := 0
	for index := 0; index < len(lines); index++ {
		if lines[index] == mcpBlockMarker() {
			if consumed > 0 {
				return nil, provider.Failure("provider_setup_conflict")
			}
			consumed++
			rest := lines[index:]
			if len(rest) < len(block) || !slices.Equal(rest[:len(block)], block) {
				return nil, provider.Failure("provider_setup_conflict")
			}
			index += len(block) - 1
			continue
		}
		kept = append(kept, lines[index])
	}
	return []byte(strings.Join(kept, "\n")), nil
}

// MCPAddArgs documents the equivalent human-run grok command. Setup itself
// writes through the approved transaction, never by shelling out.
func MCPAddArgs(launcher string) []string {
	return []string{"mcp", "add", "bfb", "--scope", "user", "--", launcher, "mcp", "stdio"}
}

// MCPListArgs probes the registered servers for doctor verification.
func MCPListArgs() []string { return []string{"mcp", "list", "--json"} }

// CheckMCPServer verifies the registered stdio server still points at the
// expected launcher through the real CLI surface.
func CheckMCPServer(ctx context.Context, installation provider.Installation, command string, args []string) error {
	raw, err := provider.InspectCommand(ctx, installation, MCPListArgs()...)
	if err != nil {
		return provider.Failure("provider_config_invalid")
	}
	var servers []struct {
		Name    string   `json:"name"`
		Command string   `json:"command"`
		Args    []string `json:"args"`
		Enabled bool     `json:"enabled"`
	}
	if provider.DecodeJSON(raw, &servers) != nil {
		return provider.Failure("provider_config_invalid")
	}
	for _, server := range servers {
		if server.Name != "bfb" {
			continue
		}
		if !server.Enabled || server.Command != command || !slices.Equal(server.Args, args) {
			return provider.Failure("provider_config_invalid")
		}
		return nil
	}
	return provider.Failure("provider_config_invalid")
}

// Doctor verifies binary version, hook binding, and MCP registration. The
// environment must scope GROK_HOME at the checked home so probes cannot read
// a different profile. It never passes trust or permission-bypass flags.
func Doctor(ctx context.Context, executable, home, launcher string, environment []string) error {
	if !filepath.IsAbs(executable) || !filepath.IsAbs(home) || !filepath.IsAbs(launcher) {
		return provider.Failure("provider_path_unsafe")
	}
	if !grokHome(environment, home) {
		return provider.Failure("provider_config_invalid")
	}
	installation := provider.Installation{Executable: executable, ConfigFiles: ConfigSources(home), IntegrationHash: IntegrationID(), Environment: environment}
	if _, err := CheckVersion(ctx, installation); err != nil {
		return err
	}
	if err := CheckHooks(home, HookCommand(launcher)); err != nil {
		return err
	}
	return CheckMCPServer(ctx, installation, launcher, []string{"mcp", "stdio"})
}

// HooksDoctor is the post-write doctor for the hooks file transaction.
func HooksDoctor(executable, home, launcher string, environment []string) provider.Doctor {
	return func(ctx context.Context) error {
		if !grokHome(environment, home) {
			return provider.Failure("provider_config_invalid")
		}
		installation := provider.Installation{Executable: executable, ConfigFiles: ConfigSources(home), IntegrationHash: IntegrationID(), Environment: environment}
		if _, err := CheckVersion(ctx, installation); err != nil {
			return err
		}
		return CheckHooks(home, HookCommand(launcher))
	}
}

// MCPDoctor is the post-write doctor for the config.toml transaction.
func MCPDoctor(executable, home, launcher string, environment []string) provider.Doctor {
	return func(ctx context.Context) error {
		if !grokHome(environment, home) {
			return provider.Failure("provider_config_invalid")
		}
		installation := provider.Installation{Executable: executable, ConfigFiles: ConfigSources(home), IntegrationHash: IntegrationID(), Environment: environment}
		if _, err := CheckVersion(ctx, installation); err != nil {
			return err
		}
		return CheckMCPServer(ctx, installation, launcher, []string{"mcp", "stdio"})
	}
}
