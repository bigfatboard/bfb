// ABOUTME: Edits only BFB-owned Claude settings sections through L03 approved transactions.
// ABOUTME: Preserves every unowned entry semantically and refuses ambiguous configuration.

package claude

import (
	"bytes"
	"encoding/json"
	"os"

	"github.com/qdis/bfb/internal/provider"
)

const maxIntegrationBytes = 2 * 1024 * 1024

// hookArgs identifies a BFB-owned hook handler regardless of the launcher path
// so setup also repairs entries left by a moved bfb binary.
var hookArgs = []string{"hook", "ingest", "--provider", "claude"}

func appendBFB(value any, handler any) []any {
	list, _ := value.([]any)
	return append(list, handler)
}

func canonical(value any) []byte {
	data, _ := json.MarshalIndent(value, "", "  ")
	return append(data, '\n')
}

func parseObject(raw []byte) (map[string]any, error) {
	object := map[string]any{}
	if len(raw) == 0 {
		return object, nil
	}
	if err := provider.DecodeJSON(raw, &object); err != nil || object == nil {
		return nil, provider.Failure("provider_config_invalid")
	}
	return object, nil
}

func hookHandler(launcher string) map[string]any {
	args := make([]any, 0, len(hookArgs))
	for _, arg := range hookArgs {
		args = append(args, arg)
	}
	return map[string]any{"type": "command", "command": launcher, "args": args}
}

func isBFBHandler(value any) bool {
	handler, ok := value.(map[string]any)
	if !ok || handler["type"] != "command" {
		return false
	}
	command, ok := handler["command"].(string)
	if !ok || command == "" {
		return false
	}
	args, ok := handler["args"].([]any)
	if !ok || len(args) != len(hookArgs) {
		return false
	}
	for index, want := range hookArgs {
		if text, ok := args[index].(string); !ok || text != want {
			return false
		}
	}
	return true
}

// stripBFBHandlers removes BFB-owned handlers from one event entry list,
// dropping entries left without handlers. It reports the removed handlers and
// whether the list changed.
func stripBFBHandlers(list []any) ([]any, []any, error) {
	kept := []any{}
	var removed []any
	for _, item := range list {
		entry, ok := item.(map[string]any)
		if !ok {
			return nil, nil, provider.Failure("provider_config_invalid")
		}
		raw, ok := entry["hooks"].([]any)
		if !ok {
			return nil, nil, provider.Failure("provider_config_invalid")
		}
		handlers := []any{}
		for _, handler := range raw {
			if isBFBHandler(handler) {
				removed = append(removed, handler)
				continue
			}
			handlers = append(handlers, handler)
		}
		if len(handlers) == 0 {
			continue
		}
		entry["hooks"] = handlers
		kept = append(kept, entry)
	}
	return kept, removed, nil
}

// SettingsEditor owns BFB hook handlers inside the user settings file. It never
// invents, reorders, or drops an unowned entry; ambiguous hook sections fail.
type SettingsEditor struct{ Launcher string }

func (editor SettingsEditor) Prepare(before []byte) ([]byte, provider.OwnedDiff, error) {
	if editor.Launcher == "" {
		return nil, provider.OwnedDiff{}, provider.Failure("provider_config_invalid")
	}
	object, err := parseObject(before)
	if err != nil {
		return nil, provider.OwnedDiff{}, err
	}
	hooks := map[string]any{}
	if raw, ok := object["hooks"]; ok {
		hooks, ok = raw.(map[string]any)
		if !ok {
			return nil, provider.OwnedDiff{}, provider.Failure("provider_config_invalid")
		}
	}
	ownedBefore := map[string]any{}
	changed := false
	handler := hookHandler(editor.Launcher)
	for _, event := range HookEvents {
		entries := []any{}
		if raw, ok := hooks[event]; ok && raw != nil {
			var ok bool
			entries, ok = raw.([]any)
			if !ok {
				return nil, provider.OwnedDiff{}, provider.Failure("provider_config_invalid")
			}
		}
		kept, removed, err := stripBFBHandlers(entries)
		if err != nil {
			return nil, provider.OwnedDiff{}, err
		}
		for _, handler := range removed {
			ownedBefore[event] = appendBFB(ownedBefore[event], handler)
		}
		if len(removed) > 0 {
			changed = true
		}
		// Exactly one current handler already in place needs no rewrite,
		// even beside unowned entries.
		current := 0
		for _, item := range kept {
			entry, _ := item.(map[string]any)
			handlers, _ := entry["hooks"].([]any)
			for _, candidate := range handlers {
				if other, ok := candidate.(map[string]any); ok && isBFBHandler(other) && other["command"] == editor.Launcher {
					current++
				}
			}
		}
		if len(removed) == 0 && current == 1 {
			hooks[event] = kept
			continue
		}
		changed = true
		kept = append(kept, map[string]any{"hooks": []any{handler}})
		hooks[event] = kept
	}
	ownedAfter := map[string]any{}
	for _, event := range HookEvents {
		ownedAfter[event] = []any{handler}
	}
	var previous []byte
	if len(ownedBefore) == 0 {
		previous = []byte("null")
	} else {
		previous = canonical(ownedBefore)
	}
	if !changed {
		return bytes.Clone(before), provider.OwnedDiff{Namespace: "bfb.hooks", Before: previous, After: canonical(ownedAfter)}, nil
	}
	object["hooks"] = hooks
	return canonical(object), provider.OwnedDiff{Namespace: "bfb.hooks", Before: previous, After: canonical(ownedAfter)}, nil
}

func (editor SettingsEditor) UnownedSemantics(raw []byte) ([]byte, error) {
	object, err := parseObject(raw)
	if err != nil {
		return nil, err
	}
	if raw, ok := object["hooks"]; ok {
		hooks, ok := raw.(map[string]any)
		if !ok {
			return nil, provider.Failure("provider_config_invalid")
		}
		for _, event := range HookEvents {
			list, ok := hooks[event].([]any)
			if !ok {
				continue
			}
			kept, _, err := stripBFBHandlers(list)
			if err != nil {
				return nil, err
			}
			if len(kept) == 0 {
				delete(hooks, event)
				continue
			}
			hooks[event] = kept
		}
		if len(hooks) == 0 {
			delete(object, "hooks")
		}
	}
	return json.Marshal(object)
}

// MCPServerEditor owns only the bfb stdio entry inside the user MCP config
// file. Machine identity, first-start markers, and other servers are unowned.
type MCPServerEditor struct{ Launcher string }

func desiredServer(launcher string) map[string]any {
	return map[string]any{"type": "stdio", "command": launcher, "args": []any{"mcp", "stdio"}, "env": map[string]any{}}
}

func (editor MCPServerEditor) Prepare(before []byte) ([]byte, provider.OwnedDiff, error) {
	if editor.Launcher == "" {
		return nil, provider.OwnedDiff{}, provider.Failure("provider_config_invalid")
	}
	object, err := parseObject(before)
	if err != nil {
		return nil, provider.OwnedDiff{}, err
	}
	servers := map[string]any{}
	if raw, ok := object["mcpServers"]; ok {
		servers, ok = raw.(map[string]any)
		if !ok {
			return nil, provider.OwnedDiff{}, provider.Failure("provider_config_invalid")
		}
	}
	desired := desiredServer(editor.Launcher)
	previous, _ := json.Marshal(servers["bfb"])
	if previous == nil {
		previous = []byte("null")
	}
	if string(canonicalSingle(servers["bfb"])) == string(canonicalSingle(desired)) {
		return bytes.Clone(before), provider.OwnedDiff{Namespace: "bfb.mcp", Before: previous, After: canonical(desired)}, nil
	}
	servers["bfb"] = desired
	object["mcpServers"] = servers
	return canonical(object), provider.OwnedDiff{Namespace: "bfb.mcp", Before: previous, After: canonical(desired)}, nil
}

func canonicalSingle(value any) []byte {
	if value == nil {
		return []byte("null")
	}
	data, _ := json.Marshal(value)
	return data
}

func (editor MCPServerEditor) UnownedSemantics(raw []byte) ([]byte, error) {
	object, err := parseObject(raw)
	if err != nil {
		return nil, err
	}
	if raw, ok := object["mcpServers"]; ok {
		servers, ok := raw.(map[string]any)
		if !ok {
			return nil, provider.Failure("provider_config_invalid")
		}
		delete(servers, "bfb")
		if len(servers) == 0 {
			delete(object, "mcpServers")
		}
	}
	return json.Marshal(object)
}

func readBounded(path string) ([]byte, bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, false, provider.Failure("provider_path_unsafe")
	}
	if len(data) > maxIntegrationBytes {
		return nil, false, provider.Failure("provider_config_invalid")
	}
	return data, true, nil
}

// ownedSettings reports the current BFB hook handlers per event. A missing
// file is absence, not an error; an unparseable file fails closed.
func ownedSettings(home string) (map[string]any, error) {
	data, present, err := readBounded(SettingsPath(home))
	if err != nil {
		return nil, err
	}
	if !present {
		return nil, nil
	}
	object, err := parseObject(data)
	if err != nil {
		return nil, err
	}
	return ownedSettingsData(object)
}

func ownedSettingsData(object map[string]any) (map[string]any, error) {
	owned := map[string]any{}
	raw, ok := object["hooks"]
	if !ok {
		return owned, nil
	}
	hooks, ok := raw.(map[string]any)
	if !ok {
		return nil, provider.Failure("provider_config_invalid")
	}
	for _, event := range HookEvents {
		rawEvent, ok := hooks[event]
		if !ok || rawEvent == nil {
			continue
		}
		list, ok := rawEvent.([]any)
		if !ok {
			return nil, provider.Failure("provider_config_invalid")
		}
		for _, item := range list {
			entry, ok := item.(map[string]any)
			if !ok {
				return nil, provider.Failure("provider_config_invalid")
			}
			handlers, ok := entry["hooks"].([]any)
			if !ok {
				return nil, provider.Failure("provider_config_invalid")
			}
			for _, handler := range handlers {
				if isBFBHandler(handler) {
					owned[event] = appendBFB(owned[event], handler)
				}
			}
		}
	}
	return owned, nil
}

func ownedMCPServer(home string) (any, error) {
	data, present, err := readBounded(MCPConfigPath(home))
	if err != nil {
		return nil, err
	}
	if !present {
		return nil, nil
	}
	object, err := parseObject(data)
	if err != nil {
		return nil, err
	}
	servers, _ := object["mcpServers"].(map[string]any)
	return servers["bfb"], nil
}

// IntegrationHash binds the packaged manifest, the launcher, and the current
// BFB-owned integration content. L05 revalidates it immediately before exec;
// any hook or MCP edit changes it and blocks tracked launch until re-setup.
func IntegrationHash(home, launcher string) (string, error) {
	if home == "" || launcher == "" {
		return "", provider.Failure("provider_config_invalid")
	}
	hooks, err := ownedSettings(home)
	if err != nil {
		return "", err
	}
	server, err := ownedMCPServer(home)
	if err != nil {
		return "", err
	}
	record := map[string]any{
		"manifest":        ManifestVersion,
		"tested_versions": append([]string{}, TestedVersions...),
		"launcher":        launcher,
		"hooks":           hooks,
		"mcp_server":      server,
	}
	return provider.Hash(canonical(record)), nil
}
