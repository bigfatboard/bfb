// ABOUTME: Checks the declared Claude integration using the same owned configuration rules as setup.
// ABOUTME: Rejects disabled hooks, launcher drift and project-local MCP shadowing without modifying settings.

package claude

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/qdis/bfb/internal/provider"
)

func installationIntegrationCurrent(installation provider.Installation) (bool, error) {
	settingsPath, mcpPath := "", ""
	for _, source := range installation.ConfigFiles {
		switch source.Name {
		case "user_settings":
			if settingsPath != "" {
				return false, nil
			}
			settingsPath = source.Path
		case "user_mcp":
			if mcpPath != "" {
				return false, nil
			}
			mcpPath = source.Path
		}
	}
	if settingsPath == "" || mcpPath == "" || !filepath.IsAbs(settingsPath) {
		return false, nil
	}
	home := filepath.Dir(filepath.Dir(settingsPath))
	if SettingsPath(home) != settingsPath || MCPConfigPath(home) != mcpPath {
		return false, nil
	}
	// Config files do not prove which home the provider will actually load.
	// Helper reconstruction must retain this exact source home, not merely its hash.
	if !executionHomeMatches(installation.Environment, home) {
		return false, nil
	}
	settings, settingsPresent, err := readBounded(settingsPath)
	if err != nil {
		return false, err
	}
	mcp, mcpPresent, err := readBounded(mcpPath)
	if err != nil {
		return false, err
	}
	if !settingsPresent || !mcpPresent {
		return false, nil
	}
	object, err := parseObject(mcp)
	if err != nil {
		return false, nil
	}
	servers, _ := object["mcpServers"].(map[string]any)
	server, _ := servers["bfb"].(map[string]any)
	launcher, _ := server["command"].(string)
	if !filepath.IsAbs(launcher) || filepath.Clean(launcher) != launcher || !settingsCurrent(settings, launcher) || !mcpCurrent(mcp, launcher) {
		return false, nil
	}
	info, err := os.Stat(launcher)
	if err != nil || info.IsDir() || info.Mode().Perm()&0111 == 0 {
		return false, nil
	}
	// The candidate path is not authority: the original installation hash
	// must already bind that same launcher and its exact owned entries.
	hash, err := IntegrationHash(home, launcher)
	if err != nil || hash != installation.IntegrationHash {
		return false, err
	}
	return true, nil
}

func executionHomeMatches(environment []string, home string) bool {
	matched := false
	for _, entry := range environment {
		name, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if name == "CLAUDE_CONFIG_DIR" {
			return false
		}
		if name == "HOME" {
			if matched || !filepath.IsAbs(value) || filepath.Clean(value) != home {
				return false
			}
			matched = true
		}
	}
	return matched
}

func mcpProjectBindingsCurrent(object map[string]any, launcher string) bool {
	projects, present := object["projects"]
	if !present {
		return true
	}
	entries, ok := projects.(map[string]any)
	if !ok {
		return false
	}
	for _, raw := range entries {
		project, ok := raw.(map[string]any)
		if !ok {
			return false
		}
		if rawServers, present := project["mcpServers"]; present {
			servers, ok := rawServers.(map[string]any)
			if !ok {
				return false
			}
			if server, present := servers["bfb"]; present && string(canonicalSingle(server)) != string(canonicalSingle(desiredServer(launcher))) {
				return false
			}
		}
		if rawDisabled, present := project["disabledMcpServers"]; present {
			disabled, ok := rawDisabled.([]any)
			if !ok {
				return false
			}
			for _, name := range disabled {
				if name == "bfb" {
					return false
				}
			}
		}
	}
	return true
}
