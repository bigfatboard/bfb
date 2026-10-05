// ABOUTME: Proves the production launch installation resolves real provider sources and hashes.
// ABOUTME: Uses stub binaries and temporary homes without provider credentials or network access.

package supervisor

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers"
	"github.com/qdis/bfb/internal/providers/claude"
	"github.com/qdis/bfb/internal/providers/codex"
	"github.com/qdis/bfb/internal/providers/grok"
)

type launchInstallationCase struct {
	name, binary, version string
	homeKey               string
	writeHome             func(t *testing.T, home, launcher string)
	wantHash              func(t *testing.T, home, launcher string) string
}

func launchInstallationCases() []launchInstallationCase {
	return []launchInstallationCase{
		{
			name: "claude", binary: "claude", version: "2.1.275 (Claude Code)\n",
			homeKey: "BFB_CLAUDE_HOME",
			writeHome: func(t *testing.T, home, launcher string) {
				t.Helper()
				settings, _, err := claude.SettingsEditor{Launcher: launcher}.Prepare(nil)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.MkdirAll(filepath.Dir(claude.SettingsPath(home)), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(claude.SettingsPath(home), settings, 0600); err != nil {
					t.Fatal(err)
				}
				mcp, _, err := claude.MCPServerEditor{Launcher: launcher}.Prepare(nil)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(claude.MCPConfigPath(home), mcp, 0600); err != nil {
					t.Fatal(err)
				}
			},
			wantHash: func(t *testing.T, home, launcher string) string {
				t.Helper()
				hash, err := claude.IntegrationHash(home, launcher)
				if err != nil {
					t.Fatal(err)
				}
				return hash
			},
		},
		{
			name: "codex", binary: "codex", version: "codex-cli 0.153.4\n",
			homeKey: "CODEX_HOME",
			writeHome: func(t *testing.T, home, launcher string) {
				t.Helper()
				after, _, err := codex.HooksEditor{Command: codex.HookCommand(launcher)}.Prepare(nil)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(codex.HooksPath(home), after, 0600); err != nil {
					t.Fatal(err)
				}
			},
			wantHash: func(_ *testing.T, _, _ string) string { return codex.IntegrationID() },
		},
		{
			name: "grok", binary: "grok", version: "grok 1.0.34 (deadbeefcafe) [stable]\n",
			homeKey: "GROK_HOME",
			writeHome: func(t *testing.T, home, launcher string) {
				t.Helper()
				after, _, err := grok.HooksEditor{Command: grok.HookCommand(launcher)}.Prepare(nil)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.MkdirAll(filepath.Dir(grok.HooksPath(home)), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(grok.HooksPath(home), after, 0600); err != nil {
					t.Fatal(err)
				}
			},
			wantHash: func(_ *testing.T, _, _ string) string { return grok.IntegrationID() },
		},
	}
}

func fixtureLaunchInstallation(t *testing.T, homeKey, binary, version string, writeHome func(t *testing.T, home, launcher string)) (home, launcher string) {
	t.Helper()
	bin := t.TempDir()
	// The version is baked into the stub: the launch environment strips
	// BFB_* variables before any provider probe runs.
	script := "#!/bin/sh\nprintf '%s\\n' '" + version + "'\n"
	if err := os.WriteFile(filepath.Join(bin, binary), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	home = t.TempDir()
	t.Setenv(homeKey, home)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	launcher = executable
	writeHome(t, home, launcher)
	return home, launcher
}

func requireLaunchCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || daemon.AsFailure(err).Diagnostic().Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

func TestProductionInstallationResolvesRealSources(t *testing.T) {
	for _, tc := range launchInstallationCases() {
		t.Run(tc.name, func(t *testing.T) {
			home, launcher := fixtureLaunchInstallation(t, tc.homeKey, tc.binary, tc.version, tc.writeHome)
			installation, err := localInstallationForLaunch(context.Background(), tc.name)
			if err != nil {
				t.Fatalf("production installation failed: %v", err)
			}
			if len(installation.ConfigFiles) != 2 {
				t.Fatalf("production installation inspects no hook/MCP sources: %+v", installation.ConfigFiles)
			}
			if installation.IntegrationHash == provider.Hash(nil) {
				t.Fatal("production installation carries the empty integration hash")
			}
			if installation.IntegrationHash != tc.wantHash(t, home, launcher) {
				t.Fatalf("production installation hash %s misses the setup hash", installation.IntegrationHash)
			}
			registry, err := provider.NewRegistry(providers.Descriptors())
			if err != nil {
				t.Fatal(err)
			}
			probe, err := registry.Probe(context.Background(), tc.name, installation, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if probe.Status != "healthy" {
				t.Fatalf("production installation probes %s, want healthy", probe.Status)
			}
		})
	}
}

func TestProductionInstallationDetectsReplacedConfiguration(t *testing.T) {
	for _, tc := range launchInstallationCases() {
		t.Run(tc.name, func(t *testing.T) {
			fixtureLaunchInstallation(t, tc.homeKey, tc.binary, tc.version, tc.writeHome)
			installation, err := localInstallationForLaunch(context.Background(), tc.name)
			if err != nil {
				t.Fatalf("production installation failed: %v", err)
			}
			registry, err := provider.NewRegistry(providers.Descriptors())
			if err != nil {
				t.Fatal(err)
			}
			probe, err := registry.Probe(context.Background(), tc.name, installation, time.Now())
			if err != nil || probe.Status != "healthy" {
				t.Fatalf("production installation probes %s %v, want healthy", probe.Status, err)
			}
			if len(installation.ConfigFiles) == 0 {
				t.Fatal("production installation inspects no hook/MCP sources")
			}
			_, source, err := registry.InstallationSource(probe)
			if err != nil {
				t.Fatal(err)
			}
			// Replacing any inspected integration file between probe and exec
			// must invalidate the sealed source instead of passing silently.
			if err := os.WriteFile(installation.ConfigFiles[0].Path, append(mustRead(t, installation.ConfigFiles[0].Path), ' '), 0600); err != nil {
				t.Fatal(err)
			}
			_, err = registry.ProbeBound(context.Background(), tc.name, installation, source, time.Now())
			requireLaunchCode(t, err, "provider_changed")
		})
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestProductionInstallationRejectsUnknownOrMissingProvider(t *testing.T) {
	if _, err := localInstallationForLaunch(context.Background(), "synthetic"); err == nil {
		t.Fatal("unknown provider must fail closed")
	} else {
		requireLaunchCode(t, err, "provider_unsupported")
	}
	empty := t.TempDir()
	t.Setenv("PATH", empty)
	for _, name := range []string{"claude", "codex", "grok"} {
		if _, err := localInstallationForLaunch(context.Background(), name); err == nil {
			t.Fatalf("%s without a binary must fail closed", name)
		} else {
			requireLaunchCode(t, err, "provider_unsupported")
		}
	}
}
