// ABOUTME: Resolves provider-owned local installations for both runner inventory and tracked launch.
// ABOUTME: Preserves the same integration sources and provider environment policy across signed helpers.

package providers

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/claude"
	"github.com/qdis/bfb/internal/providers/codex"
	"github.com/qdis/bfb/internal/providers/grok"
)

// LocalInstallation is compiled local discovery, never a cloud-selected path.
// Inventory and launch must probe these same setup-published sources.
func LocalInstallation(_ context.Context, name string) (provider.Installation, error) {
	switch name {
	case "claude":
		if _, err := exec.LookPath("claude"); err != nil {
			return provider.Installation{}, provider.Failure("provider_unsupported")
		}
		home, err := claude.HomeDir()
		if err != nil {
			return provider.Installation{}, err
		}
		executionHome, err := os.UserHomeDir()
		if err != nil || !filepath.IsAbs(executionHome) || filepath.Clean(executionHome) != home {
			return provider.Installation{}, provider.Failure("provider_path_unsafe")
		}
		launcher, err := os.Executable()
		if err != nil {
			return provider.Installation{}, provider.Failure("provider_unavailable")
		}
		return claude.Installation(home, launcher)
	case "codex":
		return scopedInstallation("codex", "CODEX_HOME", ".codex", codex.ConfigSources, codex.IntegrationID())
	case "grok":
		return scopedInstallation("grok", "GROK_HOME", ".grok", grok.ConfigSources, grok.IntegrationID())
	default:
		return provider.Installation{}, provider.Failure("provider_unsupported")
	}
}

// ExecutionEnvironment removes inherited BFB authority before a probe or exec.
// Claude additionally excludes credential and behavior overrides; helper
// reconstruction must not replace that policy with the ambient environment.
func ExecutionEnvironment(name string, environment []string) []string {
	if name == "claude" {
		return claude.TightenEnvironment(environment)
	}
	result := []string{}
	for _, entry := range environment {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(key, "BFB_") {
			result = append(result, entry)
		}
	}
	return result
}

func scopedInstallation(binary, homeKey, homeDot string, sources func(string) []provider.ConfigSource, integration string) (provider.Installation, error) {
	path, err := exec.LookPath(binary)
	if err != nil {
		return provider.Installation{}, provider.Failure("provider_unsupported")
	}
	home, err := scopedHome(homeKey, homeDot)
	if err != nil {
		return provider.Installation{}, err
	}
	environment := ExecutionEnvironment(binary, os.Environ())
	kept := environment[:0]
	for _, entry := range environment {
		name, _, _ := strings.Cut(entry, "=")
		if name != homeKey {
			kept = append(kept, entry)
		}
	}
	return provider.Installation{
		Executable: path, ConfigFiles: sources(home), IntegrationHash: integration,
		Environment: append(kept, homeKey+"="+home),
	}, nil
}

func scopedHome(homeKey, homeDot string) (string, error) {
	if home := os.Getenv(homeKey); home != "" {
		if !filepath.IsAbs(home) {
			return "", provider.Failure("provider_path_unsafe")
		}
		return filepath.Clean(home), nil
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", provider.Failure("provider_path_unsafe")
	}
	return filepath.Join(home, homeDot), nil
}
