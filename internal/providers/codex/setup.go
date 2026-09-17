// ABOUTME: Owns Codex user-level hooks and MCP registration through approved setup transactions.
// ABOUTME: Preserves unrelated configuration and fails closed on drift, conflict, or failed doctor.

package codex

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
// editors match the exact configured command.
const IngestSubcommand = "hook ingest --provider codex"

// ManagedHookEvents lists the hook events BFB subscribes. SessionStart binds
// the documented session ID and adds only constant bootstrap context;
// SessionEnd, Stop, tool, and interrupt hooks report lifecycle telemetry.
func ManagedHookEvents() []string {
	return []string{"SessionStart", "SessionEnd", "Stop", "PreToolUse", "PostToolUse", "Interrupt"}
}

// managedMatcher selects when a BFB hook group fires. SessionStart binds only
// fresh and resumed sessions, never compact or clear continuations.
func managedMatcher(event string) string {
	if event == "SessionStart" {
		return "startup|resume"
	}
	return ""
}

// hookTimeout bounds a BFB hook run. End and interrupt hooks honor Codex's
// three-second maximum; the ingest hook itself returns in milliseconds.
func hookTimeout(event string) int {
	switch event {
	case "SessionEnd", "Interrupt":
		return 3
	case "PreToolUse", "PostToolUse":
		return 10
	default:
		return 30
	}
}

// HookCommand builds the hook pipeline command from the stable app-owned
// launcher path. No task text, session, or path ever enters this string.
func HookCommand(launcher string) string { return launcher + " " + IngestSubcommand }

// HooksPath locates the user-level hooks file Codex merges with config layers.
func HooksPath(home string) string { return filepath.Join(home, "hooks.json") }

// ConfigPath locates the user-level config holding MCP server registrations.
func ConfigPath(home string) string { return filepath.Join(home, "config.toml") }

// ConfigSources enumerates the Codex configuration affecting adapter behavior
// for probe fingerprinting. Absent files fingerprint as missing so later
// creation invalidates the launch plan.
func ConfigSources(home string) []provider.ConfigSource {
	return []provider.ConfigSource{{Name: "hooks", Path: HooksPath(home)}, {Name: "config", Path: ConfigPath(home)}}
}

type hookEntry struct {
	Type          string `json:"type"`
	Command       string `json:"command"`
	Timeout       int    `json:"timeout,omitempty"`
	StatusMessage string `json:"statusMessage,omitempty"`
}

type hookGroup struct {
	Matcher *string     `json:"matcher,omitempty"`
	Hooks   []hookEntry `json:"hooks"`
}

func bfbGroup(event, command string) hookGroup {
	group := hookGroup{Hooks: []hookEntry{{Type: "command", Command: command, Timeout: hookTimeout(event), StatusMessage: "BFB run telemetry"}}}
	if matcher := managedMatcher(event); matcher != "" {
		group.Matcher = &matcher
	}
	return group
}

func ownedGroup(event string, group hookGroup, command string) bool {
	if len(group.Hooks) == 0 {
		return false
	}
	matcher := ""
	if group.Matcher != nil {
		matcher = *group.Matcher
	}
	if matcher != managedMatcher(event) {
		return false
	}
	for _, entry := range group.Hooks {
		if entry.Type != "command" || entry.Command != command {
			return false
		}
	}
	return true
}

func decodeHooks(raw []byte) (map[string]json.RawMessage, error) {
	document := map[string]json.RawMessage{}
	if len(raw) == 0 {
		return document, nil
	}
	if err := provider.DecodeJSON(raw, &document); err != nil || document == nil {
		return nil, provider.Failure("provider_setup_denied")
	}
	return document, nil
}

func decodeGroups(raw json.RawMessage) ([]hookGroup, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var groups []hookGroup
	if err := provider.DecodeJSON(raw, &groups); err != nil || groups == nil {
		return nil, provider.Failure("provider_setup_denied")
	}
	return groups, nil
}

func encodeCanonical(value any) ([]byte, error) {
	after, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, provider.Failure("provider_setup_denied")
	}
	return append(after, '\n'), nil
}

// stripOwned returns the document without BFB-owned groups for semantic
// comparison. Foreign groups sharing an event stay untouched.
func stripOwned(document map[string]json.RawMessage, command string) (map[string]any, error) {
	clean := map[string]any{}
	for name, raw := range document {
		if name == "hooks" {
			continue
		}
		var value any
		if err := provider.DecodeJSON(raw, &value); err != nil {
			return nil, provider.Failure("provider_setup_denied")
		}
		clean[name] = value
	}
	events := map[string]any{}
	for _, event := range ManagedHookEvents() {
		events[event] = []hookGroup{}
	}
	if raw, ok := document["hooks"]; ok {
		var table map[string]json.RawMessage
		if err := provider.DecodeJSON(raw, &table); err != nil {
			return nil, provider.Failure("provider_setup_denied")
		}
		for event, list := range table {
			groups, err := decodeGroups(list)
			if err != nil {
				return nil, err
			}
			kept := []hookGroup{}
			for _, group := range groups {
				if !ownedGroup(event, group, command) {
					kept = append(kept, group)
				}
			}
			events[event] = kept
		}
	}
	clean["hooks"] = events
	return clean, nil
}

// HooksEditor installs BFB hook groups into the user-level hooks.json. It
// appends alongside foreign groups because Codex runs every matching hook;
// it never rewrites or removes configuration it does not own.
type HooksEditor struct{ Command string }

func (editor HooksEditor) valid() bool {
	return editor.Command != "" && len(editor.Command) <= 4096 && !strings.ContainsAny(editor.Command, "\x00\r\n")
}

// Prepare renders the configured file with BFB groups present exactly once.
func (editor HooksEditor) Prepare(before []byte) ([]byte, provider.OwnedDiff, error) {
	if !editor.valid() {
		return nil, provider.OwnedDiff{}, provider.Failure("provider_setup_denied")
	}
	document, err := decodeHooks(before)
	if err != nil {
		return nil, provider.OwnedDiff{}, err
	}
	var table map[string]json.RawMessage
	if raw, ok := document["hooks"]; ok {
		if err := provider.DecodeJSON(raw, &table); err != nil {
			return nil, provider.OwnedDiff{}, provider.Failure("provider_setup_denied")
		}
	} else {
		table = map[string]json.RawMessage{}
	}
	previous := map[string][]hookGroup{}
	next := map[string][]hookGroup{}
	for _, event := range ManagedHookEvents() {
		groups, err := decodeGroups(table[event])
		if err != nil {
			return nil, provider.OwnedDiff{}, err
		}
		owned := []hookGroup{}
		for _, group := range groups {
			if ownedGroup(event, group, editor.Command) {
				owned = append(owned, group)
			}
		}
		previous[event] = owned
		wanted := bfbGroup(event, editor.Command)
		if len(owned) == 0 {
			groups = append(groups, wanted)
		}
		next[event] = filterOwned(event, groups, editor.Command)
		encoded, err := json.Marshal(groups)
		if err != nil {
			return nil, provider.OwnedDiff{}, provider.Failure("provider_setup_denied")
		}
		table[event] = encoded
	}
	encoded, err := json.Marshal(table)
	if err != nil {
		return nil, provider.OwnedDiff{}, provider.Failure("provider_setup_denied")
	}
	document["hooks"] = encoded
	ordered := map[string]json.RawMessage{}
	names := []string{}
	for name := range document {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		ordered[name] = document[name]
	}
	after, err := encodeCanonical(ordered)
	if err != nil {
		return nil, provider.OwnedDiff{}, err
	}
	beforeOwned, _ := json.Marshal(previous)
	afterOwned, _ := json.Marshal(next)
	return after, provider.OwnedDiff{Namespace: "codex-hooks", Before: beforeOwned, After: afterOwned}, nil
}

func filterOwned(event string, groups []hookGroup, command string) []hookGroup {
	owned := []hookGroup{}
	for _, group := range groups {
		if ownedGroup(event, group, command) {
			owned = append(owned, group)
		}
	}
	return owned
}

// UnownedSemantics canonically encodes everything except BFB-owned groups so
// the setup transaction rejects any edit outside the approved diff.
func (editor HooksEditor) UnownedSemantics(raw []byte) ([]byte, error) {
	if !editor.valid() {
		return nil, provider.Failure("provider_setup_denied")
	}
	document, err := decodeHooks(raw)
	if err != nil {
		return nil, err
	}
	clean, err := stripOwned(document, editor.Command)
	if err != nil {
		return nil, err
	}
	return encodeCanonical(clean)
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
		Hooks map[string][]struct {
			Hooks []struct {
				Type    string `json:"type"`
				Command string `json:"command"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if provider.DecodeJSON(raw, &document) != nil {
		return false
	}
	for _, groups := range document.Hooks["SessionStart"] {
		for _, entry := range groups.Hooks {
			if entry.Type == "command" && strings.Contains(entry.Command, IngestSubcommand) {
				return true
			}
		}
	}
	return false
}

// mcpBlockMarker labels the BFB-owned config.toml section. The block is
// always complete between the marker and its last line; anything after it
// belongs to someone else.
func mcpBlockMarker() string {
	return "# BFB-owned mcp_servers.bfb (managed by `bfb provider setup codex`; do not edit)"
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
// of being adopted or overwritten.
type MCPServerEditor struct {
	Command string
	Args    []string
}

func (editor MCPServerEditor) block() ([]string, error) {
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
	return []string{mcpBlockMarker(), "[mcp_servers.bfb]", "command = " + command, "args = [" + strings.Join(encoded, ", ") + "]"}, nil
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

// MCPAddArgs documents the equivalent human-run codex command. Setup itself
// writes through the approved transaction, never by shelling out.
func MCPAddArgs(launcher string) []string {
	return []string{"mcp", "add", "bfb", "--", launcher, "mcp", "stdio"}
}

// MCPGetArgs probes the registered server for doctor verification.
func MCPGetArgs() []string { return []string{"mcp", "get", "bfb", "--json"} }

func codexHome(environment []string, home string) bool {
	return slices.Contains(environment, "CODEX_HOME="+home)
}

// CheckVersion verifies the executable reports a tested release.
func CheckVersion(ctx context.Context, installation provider.Installation) (string, error) {
	raw, err := provider.InspectCommand(ctx, installation, Descriptor().VersionArguments...)
	if err != nil {
		return "", err
	}
	version, err := Descriptor().ParseVersion(raw)
	if err != nil {
		return "", err
	}
	if !slices.Contains(TestedVersions, version) {
		return "", provider.Failure("provider_unsupported")
	}
	return version, nil
}

// CheckHooks verifies the BFB session binder is installed.
func CheckHooks(home, command string) error {
	raw, err := os.ReadFile(HooksPath(home))
	if err != nil || len(raw) > 2*1024*1024 {
		return provider.Failure("provider_config_invalid")
	}
	editor := HooksEditor{Command: command}
	if !editor.valid() {
		return provider.Failure("provider_setup_denied")
	}
	document, err := decodeHooks(raw)
	if err != nil {
		return err
	}
	encoded, ok := document["hooks"]
	if !ok {
		return provider.Failure("provider_config_invalid")
	}
	var table map[string]json.RawMessage
	if err := provider.DecodeJSON(encoded, &table); err != nil {
		return provider.Failure("provider_config_invalid")
	}
	groups, err := decodeGroups(table["SessionStart"])
	if err != nil {
		return err
	}
	for _, group := range groups {
		if ownedGroup("SessionStart", group, command) {
			return nil
		}
	}
	return provider.Failure("provider_config_invalid")
}

// CheckInlineHooksAbsent rejects user config that also defines inline hooks,
// which Codex would merge with a startup warning and run beside BFB hooks.
func CheckInlineHooksAbsent(home string) error {
	raw, err := os.ReadFile(ConfigPath(home))
	if err != nil {
		return nil
	}
	if len(raw) > 2*1024*1024 {
		return provider.Failure("provider_config_invalid")
	}
	for _, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(stripComment(line))
		if strings.HasPrefix(trimmed, "[hooks]") || strings.HasPrefix(trimmed, "[hooks.") {
			return provider.Failure("provider_setup_conflict")
		}
	}
	return nil
}

// CheckMCPServer verifies the registered stdio server still points at the
// expected launcher through the real CLI surface.
func CheckMCPServer(ctx context.Context, installation provider.Installation, command string, args []string) error {
	raw, err := provider.InspectCommand(ctx, installation, MCPGetArgs()...)
	if err != nil {
		return provider.Failure("provider_config_invalid")
	}
	var registration struct {
		Transport struct {
			Type    string   `json:"type"`
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"transport"`
	}
	if provider.DecodeJSON(raw, &registration) != nil {
		return provider.Failure("provider_config_invalid")
	}
	if registration.Transport.Type != "stdio" || registration.Transport.Command != command || !slices.Equal(registration.Transport.Args, args) {
		return provider.Failure("provider_config_invalid")
	}
	return nil
}

// Doctor verifies binary version, hook binding, inline-hook drift, and MCP
// registration. The environment must scope CODEX_HOME at the checked home so
// probes cannot read a different profile. It never passes bypass flags.
func Doctor(ctx context.Context, executable, home, launcher string, environment []string) error {
	if !filepath.IsAbs(executable) || !filepath.IsAbs(home) || !filepath.IsAbs(launcher) {
		return provider.Failure("provider_path_unsafe")
	}
	if !codexHome(environment, home) {
		return provider.Failure("provider_config_invalid")
	}
	installation := provider.Installation{Executable: executable, ConfigFiles: ConfigSources(home), IntegrationHash: IntegrationID(), Environment: environment}
	if _, err := CheckVersion(ctx, installation); err != nil {
		return err
	}
	if err := CheckHooks(home, HookCommand(launcher)); err != nil {
		return err
	}
	if err := CheckInlineHooksAbsent(home); err != nil {
		return err
	}
	return CheckMCPServer(ctx, installation, launcher, []string{"mcp", "stdio"})
}

// HooksDoctor is the post-write doctor for the hooks.json transaction.
func HooksDoctor(executable, home, launcher string, environment []string) provider.Doctor {
	return func(ctx context.Context) error {
		if !codexHome(environment, home) {
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
		if !codexHome(environment, home) {
			return provider.Failure("provider_config_invalid")
		}
		installation := provider.Installation{Executable: executable, ConfigFiles: ConfigSources(home), IntegrationHash: IntegrationID(), Environment: environment}
		if _, err := CheckVersion(ctx, installation); err != nil {
			return err
		}
		return CheckMCPServer(ctx, installation, launcher, []string{"mcp", "stdio"})
	}
}
